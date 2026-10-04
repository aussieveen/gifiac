use std::convert::Infallible;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as AxPath, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

use crate::ass::generate_ass;
use crate::auth::CurrentUser;
use crate::db;
use crate::error::AppError;
use crate::exports::{self, ExportEvent};
use crate::lambda_jobs;
use crate::models::{ExportFormat, ExportJobContext, ExportRequest, TemplateExportRequest, TemplatePayload};
use crate::paths;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct ExportAccepted {
    export_id: String,
}

pub async fn create_export(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Json(mut request): Json<ExportRequest>,
) -> Result<(StatusCode, Json<ExportAccepted>), AppError> {
    request.name = request.name.trim().to_string();
    if request.name.is_empty() {
        return Err(AppError::BadRequest("name must not be empty".to_string()));
    }
    if request.gif_range_end <= request.gif_range_start {
        return Err(AppError::BadRequest(
            "gif_range_end must be after gif_range_start".to_string(),
        ));
    }
    if request.save_as_template {
        request.template_name = request.template_name.map(|n| n.trim().to_string());
        if request.template_name.as_deref().is_none_or(str::is_empty) {
            return Err(AppError::BadRequest(
                "template_name is required when save_as_template is true".to_string(),
            ));
        }
    }

    let video = db::get_video(&state.pool, &request.video_id, &user.id)
        .await?
        .ok_or(AppError::NotFound)?;
    // The one place the ingest/export split (wayfinder gifiac#32)
    // actually needs a runtime check: the export pipeline requires real
    // dimensions/duration, which don't exist until the ingest Lambda's
    // callback backfills them.
    let (Some(duration), Some(width), Some(height)) = (video.duration_seconds, video.width, video.height) else {
        return Err(AppError::BadRequest(
            "video is still being processed, try again shortly".to_string(),
        ));
    };
    let _ = duration; // not needed below, but destructured for the single combined check

    let export_id = Uuid::new_v4();
    let clip_duration = request.gif_range_end - request.gif_range_start;
    let (output_width, output_height) = crate::scale::scaled_dimensions(width, height);
    let ass_content = generate_ass(
        &request.captions,
        request.gif_range_start,
        request.gif_range_end,
        output_width,
        output_height,
    );
    let source_key = paths::video_object_key(&Uuid::parse_str(&video.id)?, &video.extension);

    let context = ExportJobContext::Video {
        video_id: video.id.clone(),
        owner_id: user.id.clone(),
        request: request.clone(),
    };
    start_export_job(&state, export_id, &context, &source_key, &ass_content, request.gif_range_start, clip_duration).await?;

    Ok((
        StatusCode::ACCEPTED,
        Json(ExportAccepted {
            export_id: export_id.to_string(),
        }),
    ))
}

/// `POST /api/templates/{id}/exports` — flow B, starting a new GIF from a
/// template (own or someone else's public one). `db::get_template_for_use`
/// is the entire authorization check: a private template the caller
/// doesn't own simply doesn't resolve, 404, same as a nonexistent id —
/// there's no separate range/dimension validation needed because
/// `TemplateExportRequest` doesn't carry those fields at all (see its doc
/// comment); the pipeline always derives them from the template's own
/// saved row.
pub async fn create_template_export(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
    Json(mut request): Json<TemplateExportRequest>,
) -> Result<(StatusCode, Json<ExportAccepted>), AppError> {
    request.name = request.name.trim().to_string();
    if request.name.is_empty() {
        return Err(AppError::BadRequest("name must not be empty".to_string()));
    }

    let template = db::get_template_for_use(&state.pool, &id, &user.id)
        .await?
        .ok_or(AppError::NotFound)?;
    let payload: TemplatePayload = serde_json::from_str(&template.payload_json).map_err(anyhow::Error::from)?;
    let clip_duration = payload.gif_range_end - payload.gif_range_start;
    let template_uuid = Uuid::parse_str(&template.id)?;

    let export_id = Uuid::new_v4();
    let ass_content = generate_ass(&request.captions, 0.0, clip_duration, payload.width, payload.height);
    let source_key = paths::template_clip_object_key(&template_uuid);

    let context = ExportJobContext::Template {
        template_id: template.id.clone(),
        owner_id: user.id.clone(),
        request: request.clone(),
    };
    start_export_job(&state, export_id, &context, &source_key, &ass_content, 0.0, clip_duration).await?;

    Ok((
        StatusCode::ACCEPTED,
        Json(ExportAccepted {
            export_id: export_id.to_string(),
        }),
    ))
}

/// Shared by both export entry points: inserts the DB job row (with
/// `request_json` stashed for the callback-driven finalize step, gifiac#32),
/// registers a broadcast channel, and fires off all 3 per-format Lambda
/// invocations. Fire-and-forget past this point — the only way either
/// caller learns the outcome is via `export_progress`'s SSE stream,
/// matching the pre-Lambda pipeline's "broadcast-only outcome" contract.
async fn start_export_job(
    state: &Arc<AppState>,
    export_id: Uuid,
    context: &ExportJobContext,
    source_key: &str,
    ass_content: &str,
    range_start: f64,
    clip_duration: f64,
) -> Result<(), AppError> {
    let request_json = serde_json::to_string(context).map_err(anyhow::Error::from)?;
    let now = chrono::Utc::now().to_rfc3339();
    db::insert_export_job(&state.pool, &export_id.to_string(), &request_json, &now).await?;

    let (tx, _rx) = broadcast::channel(32);
    state.export_jobs.lock().unwrap().insert(export_id, tx);

    for format in [ExportFormat::Gif, ExportFormat::Mp4, ExportFormat::Webm] {
        let output_key = match format {
            ExportFormat::Gif => paths::gif_object_key(&export_id),
            ExportFormat::Mp4 => paths::mp4_object_key(&export_id),
            ExportFormat::Webm => paths::webm_object_key(&export_id),
        };
        if let Err(err) = lambda_jobs::invoke_export(state, export_id, format, source_key, ass_content, range_start, clip_duration, &output_key).await
        {
            tracing::error!(export_id = %export_id, format = format.as_str(), error = ?err, "failed to invoke export lambda");
        }
    }

    Ok(())
}

pub async fn export_progress(
    State(state): State<Arc<AppState>>,
    _current_user: CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let uuid = Uuid::parse_str(&id).map_err(|_| AppError::NotFound)?;
    let job = db::get_export_job(&state.pool, &id).await?.ok_or(AppError::NotFound)?;

    if exports::is_terminal_status(&job.gif_status) {
        let event = if exports::export_job_failed(&job) {
            Some(ExportEvent::Failed {
                message: job.gif_error.unwrap_or_else(|| "export failed".to_string()),
            })
        } else {
            // gif succeeded and is terminal, so its `gifs` row should
            // already exist from `handle_gif_terminal` — but if a client
            // reconnects in the brief window between gif's status write
            // and that row's insert, fall through and subscribe live
            // instead of 404ing; `Complete` will arrive momentarily.
            db::get_gif_unscoped(&state.pool, &id).await?.map(|gif| ExportEvent::Complete { gif: Box::new(gif) })
        };
        if let Some(event) = event {
            let stream = futures_util::stream::once(async move { Ok(to_sse_event(&event)) });
            return Ok(Sse::new(stream.boxed()).keep_alive(KeepAlive::default()));
        }
    }

    let rx = {
        let mut jobs = state.export_jobs.lock().unwrap();
        jobs.entry(uuid).or_insert_with(|| broadcast::channel(32).0).subscribe()
    };
    let stream = BroadcastStream::new(rx).filter_map(|msg| async move { msg.ok().map(|event| Ok(to_sse_event(&event))) });

    Ok(Sse::new(stream.boxed()).keep_alive(KeepAlive::default()))
}

fn to_sse_event(event: &ExportEvent) -> Event {
    match event {
        ExportEvent::Progress { format, percent } => Event::default()
            .event("progress")
            .data(serde_json::json!({ "format": format, "percent": percent }).to_string()),
        ExportEvent::FormatDone { format } => Event::default()
            .event("format_done")
            .data(serde_json::json!({ "format": format }).to_string()),
        ExportEvent::FormatFailed { format, message } => Event::default()
            .event("format_failed")
            .data(serde_json::json!({ "format": format, "message": message }).to_string()),
        ExportEvent::Complete { gif } => Event::default()
            .event("complete")
            .data(serde_json::to_string(gif).unwrap_or_default()),
        ExportEvent::Failed { message } => Event::default()
            .event("error")
            .data(serde_json::json!({ "message": message }).to_string()),
    }
}
