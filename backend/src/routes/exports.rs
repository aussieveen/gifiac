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

use crate::auth::CurrentUser;
use crate::db;
use crate::error::AppError;
use crate::exports::{self, ExportEvent, ExportSource};
use crate::models::{ExportRequest, TemplatePayload};
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

    // SPEC-CLOUD.md §4: exactly one of the two — a video-based export
    // (today's flow, owner-scoped) or a template-based one (the new
    // cross-user "use this template" flow, no video at all involved).
    // Cloned out (rather than matched by reference) so the template
    // branch below is free to mutate `request.captions` without fighting
    // a live borrow from the match scrutinee.
    let source = match (request.video_id.clone(), request.template_id.clone()) {
        (Some(video_id), None) => {
            let video = db::get_video(&state.pool, &video_id, &user.id)
                .await?
                .ok_or(AppError::NotFound)?;
            ExportSource::Video(video)
        }
        (None, Some(template_id)) => {
            // "Loading a template to pre-fill an export has no ownership
            // check, only the usual public-sharing check" (§4) — the same
            // query `GET /api/templates/{id}` uses, so both enforce the
            // exact same visibility rule.
            let template = db::get_public_template(&state.pool, &template_id)
                .await?
                .ok_or(AppError::NotFound)?;
            let payload: TemplatePayload = serde_json::from_str(&template.payload_json)?;
            request.captions = exports::normalize_locked_captions(request.captions, &payload.captions);
            // "Use" is starting the export (§8), independent of whether
            // the background pipeline below later succeeds.
            db::increment_template_use_count(&state.pool, &template_id).await?;
            ExportSource::Template {
                id: template_id,
                payload,
            }
        }
        _ => {
            return Err(AppError::BadRequest(
                "expected exactly one of video_id or template_id".to_string(),
            ));
        }
    };

    let export_id = Uuid::new_v4();
    let (tx, _rx) = broadcast::channel(32);
    state
        .export_jobs
        .lock()
        .unwrap()
        .insert(export_id, tx.clone());

    // Captured before spawning — this is a detached background task with
    // no request to re-extract `CurrentUser` from later (SPEC-CLOUD.md
    // §3: the resulting `gifs` row still needs an owner).
    let owner_id = user.id.clone();
    let job_state = state.clone();
    tokio::spawn(async move {
        exports::run_export_job(&job_state, export_id, source, request, &owner_id, tx).await;
        job_state.export_jobs.lock().unwrap().remove(&export_id);
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(ExportAccepted {
            export_id: export_id.to_string(),
        }),
    ))
}

pub async fn export_progress(
    State(state): State<Arc<AppState>>,
    _current_user: CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let uuid = Uuid::parse_str(&id).map_err(|_| AppError::NotFound)?;

    let rx = {
        let jobs = state.export_jobs.lock().unwrap();
        jobs.get(&uuid).ok_or(AppError::NotFound)?.subscribe()
    };

    let stream = BroadcastStream::new(rx)
        .filter_map(|msg| async move { msg.ok().map(|event| Ok(to_sse_event(&event))) });

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn to_sse_event(event: &ExportEvent) -> Event {
    match event {
        ExportEvent::Progress { stage, percent } => Event::default()
            .event(*stage)
            .data(serde_json::json!({ "percent": percent }).to_string()),
        ExportEvent::Complete { gif } => Event::default()
            .event("complete")
            .data(serde_json::to_string(gif).unwrap_or_default()),
        ExportEvent::Failed { message } => Event::default()
            .event("error")
            .data(serde_json::json!({ "message": message }).to_string()),
    }
}
