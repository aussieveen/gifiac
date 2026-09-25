//! Owner-only admin area (SPEC-CLOUD.md §7): every route here is gated by
//! the `AdminUser` extractor, not `CurrentUser` — a non-admin gets a 403,
//! not a 404, since these routes' existence isn't secret.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as AxPath, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AdminUser;
use crate::db;
use crate::error::AppError;
use crate::models::AdminTemplateView;
use crate::paths;
use crate::state::AppState;

use super::gifs::{GifResponse, with_urls};

pub async fn list_users(
    State(state): State<Arc<AppState>>,
    AdminUser(_admin): AdminUser,
) -> Result<Json<Vec<crate::models::AdminUserView>>, AppError> {
    Ok(Json(db::admin_list_users(&state.pool).await?))
}

#[derive(Debug, Deserialize)]
pub struct SetUserDisabledRequest {
    disabled: bool,
}

#[derive(Debug, Serialize)]
pub struct UserDisabledResponse {
    id: String,
    disabled: bool,
}

/// SPEC-CLOUD.md §7: "disable only revokes the user's sessions and blocks
/// further login/creation — it does not touch their existing public
/// gifs/templates." Re-enabling is the same endpoint with `disabled:
/// false` — not itself in the spec, but a one-way admin action with no
/// undo is a worse operational tool for the same cost to build.
pub async fn set_user_disabled(
    State(state): State<Arc<AppState>>,
    AdminUser(_admin): AdminUser,
    AxPath(id): AxPath<String>,
    Json(body): Json<SetUserDisabledRequest>,
) -> Result<Json<UserDisabledResponse>, AppError> {
    let updated = db::set_user_disabled(&state.pool, &id, body.disabled)
        .await?
        .ok_or(AppError::NotFound)?;
    if body.disabled {
        db::delete_sessions_for_user(&state.pool, &id).await?;
    }
    Ok(Json(UserDisabledResponse {
        id: updated.id,
        disabled: updated.disabled,
    }))
}

pub async fn list_user_gifs(
    State(state): State<Arc<AppState>>,
    AdminUser(_admin): AdminUser,
    AxPath(user_id): AxPath<String>,
) -> Result<Json<Vec<GifResponse>>, AppError> {
    let gifs = db::admin_list_gifs_by_user(&state.pool, &user_id).await?;
    let responses = gifs
        .into_iter()
        .map(|gif| with_urls(gif, &state.storage, false))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(responses))
}

pub async fn list_user_templates(
    State(state): State<Arc<AppState>>,
    AdminUser(_admin): AdminUser,
    AxPath(user_id): AxPath<String>,
) -> Result<Json<Vec<AdminTemplateView>>, AppError> {
    let templates = db::admin_list_templates_by_user(&state.pool, &user_id).await?;
    Ok(Json(templates.into_iter().map(Into::into).collect()))
}

/// Admin-scoped equivalent of `routes::gifs::delete_gif` — same row
/// lookup + best-effort R2 cleanup, just with no owner filter.
pub async fn delete_gif(
    State(state): State<Arc<AppState>>,
    AdminUser(_admin): AdminUser,
    AxPath(id): AxPath<String>,
) -> Result<StatusCode, AppError> {
    let gif = db::admin_get_gif(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    let deleted = db::admin_delete_gif(&state.pool, &id).await?;
    if !deleted {
        return Err(AppError::NotFound);
    }

    if !gif.is_linked() {
        let uuid = Uuid::parse_str(&id)?;
        for key in [
            paths::gif_object_key(&uuid),
            paths::mp4_object_key(&uuid),
            paths::webm_object_key(&uuid),
        ] {
            state.storage.delete_object(&key).await?;
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn unpublish_gif(
    State(state): State<Arc<AppState>>,
    AdminUser(_admin): AdminUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<GifResponse>, AppError> {
    let gif = db::admin_unpublish_gif(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(with_urls(gif, &state.storage, false)?))
}

/// Admin-scoped equivalent of `routes::videos::delete_template`'s cleanup —
/// deletes by the template's own id (that route is video-id-scoped, for
/// the owner's video-nested flow) with no owner filter.
pub async fn delete_template(
    State(state): State<Arc<AppState>>,
    AdminUser(_admin): AdminUser,
    AxPath(id): AxPath<String>,
) -> Result<StatusCode, AppError> {
    db::get_template_by_id(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    let deleted = db::admin_delete_template(&state.pool, &id).await?;
    if !deleted {
        return Err(AppError::NotFound);
    }

    if let Ok(template_uuid) = Uuid::parse_str(&id) {
        let clip_path = paths::template_clip_path(&state.config.video_dir, &template_uuid);
        let thumb_path = paths::template_thumbnail_path(&state.config.video_dir, &template_uuid);
        let filmstrip_path = paths::template_filmstrip_path(&state.config.video_dir, &template_uuid);
        for path in [clip_path, thumb_path, filmstrip_path] {
            if let Err(err) = tokio::fs::remove_file(&path).await
                && err.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(path = %path.display(), error = %err, "failed to remove file for admin-deleted template");
            }
        }
    }

    Ok(StatusCode::NO_CONTENT)
}
