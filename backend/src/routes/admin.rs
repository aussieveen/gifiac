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
use crate::models::{AdminActionView, AdminTemplateView};
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
        .map(|gif| with_urls(gif, &state.storage, false, false))
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
    Ok(Json(with_urls(gif, &state.storage, false, false)?))
}

/// Deletes a user and everything they own (SPEC-CLOUD.md §11 called this
/// out of scope entirely — it no longer is). Self-delete is blocked: with
/// exactly one admin account and no recovery path if it deletes itself,
/// there's no scenario where this is intentional rather than a slip.
///
/// Gif/mp4/webm objects in R2 are deliberately left alone so a deleted
/// user's existing shared/embedded gif links keep resolving — see
/// `db::admin_delete_user`'s doc comment. Template and video assets have
/// no such external link to protect, so those ARE cleaned up here, same
/// as `routes::videos::delete_template_assets`/`delete_video_and_its_assets`
/// already do for the owner-initiated versions of these deletes.
pub async fn delete_user(
    State(state): State<Arc<AppState>>,
    AdminUser(admin): AdminUser,
    AxPath(id): AxPath<String>,
) -> Result<StatusCode, AppError> {
    if id == admin.id {
        return Err(AppError::Conflict("cannot delete your own account".to_string()));
    }

    let target = db::get_user(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    let now = chrono::Utc::now().to_rfc3339();
    let deletion = db::admin_delete_user(&state.pool, &target, &admin.id, &now).await?;

    for (video_id, extension) in deletion.video_assets {
        if let Err(err) = state
            .source_storage
            .delete_object(&paths::video_object_key(&video_id, &extension))
            .await
        {
            tracing::warn!(id = %video_id, error = %err, "failed to remove object storage copy of deleted user's video");
        }
        for key in [
            paths::video_thumbnail_object_key(&video_id),
            paths::video_filmstrip_object_key(&video_id),
        ] {
            if let Err(err) = state.source_storage.delete_object(&key).await {
                tracing::warn!(id = %video_id, %key, error = %err, "failed to remove object storage copy of deleted user's video asset");
            }
        }
        for path in [
            paths::video_path(&state.config.video_dir, &video_id, &extension),
            paths::thumbnail_path(&state.config.video_dir, &video_id),
            paths::filmstrip_sprite_path(&state.config.video_dir, &video_id),
        ] {
            if let Err(err) = tokio::fs::remove_file(&path).await
                && err.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(path = %path.display(), error = %err, "failed to remove file for deleted user's video");
            }
        }
    }

    for template_id in deletion.template_ids {
        crate::routes::videos::delete_template_assets(&state, &template_id).await;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/admin/actions` — the audit trail (migration
/// `0020_admin_actions.sql`). No filtering/pagination yet: this exists so
/// an admin action leaves *some* visible trace, not to be a full log
/// browser.
pub async fn list_actions(
    State(state): State<Arc<AppState>>,
    AdminUser(_admin): AdminUser,
) -> Result<Json<Vec<AdminActionView>>, AppError> {
    Ok(Json(db::list_admin_actions(&state.pool, 100).await?))
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
        crate::routes::videos::delete_template_assets(&state, &template_uuid).await;
    }

    Ok(StatusCode::NO_CONTENT)
}
