//! Callback endpoints the ingest/export Lambda functions POST to
//! (wayfinder gifiac#32) — `bin/ingest_lambda.rs`/`bin/export_lambda.rs`
//! are the other half of this contract. Mounted outside the normal
//! `CurrentUser`-based auth (Lambda has no user session); a shared
//! bearer token is the only auth, checked by `verify_callback_token`.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::db;
use crate::error::AppError;
use crate::exports::{self, ExportEvent};
use crate::ingest::IngestEvent;
use crate::models::ExportFormat;
use crate::state::AppState;

fn verify_callback_token(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    let matches: bool = token.as_bytes().ct_eq(state.lambda_config.callback_token.as_bytes()).into();
    if matches { Ok(()) } else { Err(AppError::Unauthorized) }
}

#[derive(Debug, Deserialize)]
struct ProbeCallback {
    duration_seconds: f64,
    width: i64,
    height: i64,
}

#[derive(Debug, Deserialize)]
pub struct IngestCallback {
    job_id: String,
    stage: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    probe: Option<ProbeCallback>,
}

pub async fn ingest_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<IngestCallback>,
) -> Result<StatusCode, AppError> {
    verify_callback_token(&state, &headers)?;

    let now = chrono::Utc::now().to_rfc3339();
    let updated = db::update_ingest_stage(&state.pool, &body.job_id, &body.stage, body.error.as_deref(), &now).await?;
    if !updated {
        tracing::warn!(job_id = %body.job_id, stage = %body.stage, "dropped late ingest callback, job already terminal");
        return Ok(StatusCode::OK);
    }

    let job = db::get_ingest_job(&state.pool, &body.job_id).await?.ok_or(AppError::NotFound)?;
    if let Some(probe) = &body.probe {
        db::fill_in_video_probe(&state.pool, &job.video_id, probe.duration_seconds, probe.width, probe.height).await?;
    }

    let Ok(job_uuid) = Uuid::parse_str(&body.job_id) else {
        return Ok(StatusCode::OK);
    };
    let event = match body.stage.as_str() {
        "complete" => {
            let video = db::get_video_unscoped(&state.pool, &job.video_id).await?.ok_or(AppError::NotFound)?;
            Some(IngestEvent::Complete { video: Box::new(video) })
        }
        "failed" | "timed_out" => Some(IngestEvent::Failed {
            message: body.error.clone().unwrap_or_else(|| "ingest failed".to_string()),
        }),
        stage => Some(IngestEvent::Stage { stage: stage.to_string() }),
    };
    if let Some(event) = event {
        let terminal = matches!(body.stage.as_str(), "complete" | "failed" | "timed_out");
        let tx = if terminal {
            state.ingest_jobs.lock().unwrap().remove(&job_uuid)
        } else {
            state.ingest_jobs.lock().unwrap().get(&job_uuid).cloned()
        };
        if let Some(tx) = tx {
            let _ = tx.send(event);
        }
    }

    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
pub struct ExportCallback {
    job_id: String,
    format: String,
    status: String,
    percent: i32,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    width: Option<i64>,
    #[serde(default)]
    height: Option<i64>,
}

pub async fn export_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ExportCallback>,
) -> Result<StatusCode, AppError> {
    verify_callback_token(&state, &headers)?;

    let format: ExportFormat = body.format.parse().map_err(AppError::Internal)?;
    let now = chrono::Utc::now().to_rfc3339();
    let updated =
        db::update_export_format_status(&state.pool, &body.job_id, format, &body.status, body.percent, body.error.as_deref(), &now).await?;
    if !updated {
        tracing::warn!(job_id = %body.job_id, format = %body.format, "dropped late export callback, job already terminal");
        return Ok(StatusCode::OK);
    }

    if format == ExportFormat::Gif
        && let (Some(width), Some(height)) = (body.width, body.height)
    {
        db::set_export_job_gif_dimensions(&state.pool, &body.job_id, width, height).await?;
    }

    let Ok(job_uuid) = Uuid::parse_str(&body.job_id) else {
        return Ok(StatusCode::OK);
    };
    let tx = state.export_jobs.lock().unwrap().get(&job_uuid).cloned();
    if let Some(tx) = &tx {
        let event = match body.status.as_str() {
            "done" => ExportEvent::FormatDone { format },
            "failed" | "timed_out" => ExportEvent::FormatFailed {
                format,
                message: body.error.clone().unwrap_or_else(|| "encode failed".to_string()),
            },
            _ => ExportEvent::Progress {
                format,
                percent: body.percent.clamp(0, 100) as u8,
            },
        };
        let _ = tx.send(event);
    }

    let job = db::get_export_job(&state.pool, &body.job_id).await?.ok_or(AppError::NotFound)?;
    if exports::export_job_is_terminal(&job) {
        if exports::export_job_failed(&job) {
            if let Some(tx) = &tx {
                let _ = tx.send(ExportEvent::Failed {
                    message: job.gif_error.clone().unwrap_or_else(|| "export failed".to_string()),
                });
            }
            state.export_jobs.lock().unwrap().remove(&job_uuid);
        } else if let Err(err) = exports::finalize_export_job(&state, &job).await {
            tracing::error!(job_id = %body.job_id, error = ?err, "failed to finalize export job");
        }
    }

    Ok(StatusCode::OK)
}

