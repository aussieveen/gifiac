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
use crate::exports::{self, ExportEvent};
use crate::models::{ExportRequest, TemplateExportRequest};
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
        exports::run_export_job(&job_state, export_id, video, request, &owner_id, tx).await;
        job_state.export_jobs.lock().unwrap().remove(&export_id);
    });

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

    let export_id = Uuid::new_v4();
    let (tx, _rx) = broadcast::channel(32);
    state.export_jobs.lock().unwrap().insert(export_id, tx.clone());

    let owner_id = user.id.clone();
    let job_state = state.clone();
    tokio::spawn(async move {
        exports::run_template_export_job(&job_state, export_id, template, request, &owner_id, tx).await;
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
