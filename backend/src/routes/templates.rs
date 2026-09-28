//! Public templates (pass 2, narrower than the sharing layer
//! `0008_template_sharing.sql` added and `0010_remove_template_sharing.sql`
//! removed — see `0016_public_templates.sql`). This module is the "use a
//! template" surface: browsing your own/others' templates, viewing one's
//! detail, renaming/publishing/deleting your own, and serving a template's
//! self-contained clip/thumbnail/filmstrip. `routes::videos` still owns
//! flow A (a video's own save/overwrite-in-place template, video-id-scoped)
//! — this module never touches a `videos` row at all.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as AxPath, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::ServeFile;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::db;
use crate::error::AppError;
use crate::filmstrip_layout::compute_filmstrip_layout;
use crate::models::{FilmstripMeta, PatchTemplateRequest, Template, TemplateDetail, TemplatePayload, TemplateSummary};
use crate::state::AppState;
use crate::template_assets::{self, TemplateAssetKind};

/// Owner-scoped lookup, 404 on mismatch — same shape as
/// `routes::videos::load_video`. Backs the owner-only actions: rename,
/// publish toggle, delete.
async fn load_own_template(state: &AppState, id: &str, owner_id: &str) -> Result<Template, AppError> {
    let template = db::get_template_by_id(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if template.user_id != owner_id {
        return Err(AppError::NotFound);
    }
    Ok(template)
}

/// Public-or-owned lookup, 404 otherwise — every flow-B read goes through
/// this (see `db::get_template_for_use`'s doc comment).
async fn load_usable_template(state: &AppState, id: &str, viewer_id: &str) -> Result<Template, AppError> {
    db::get_template_for_use(&state.pool, id, viewer_id).await?.ok_or(AppError::NotFound)
}

fn to_detail(t: Template, viewer_id: &str, owner_handle: Option<String>) -> Result<TemplateDetail, AppError> {
    let payload: TemplatePayload = serde_json::from_str(&t.payload_json)?;
    // `payload.captions` are stored in the *source video's* absolute
    // timeline (flow A's own `GET /api/videos/{id}/template` re-fill needs
    // them that way, against the full untrimmed video) — but the clip this
    // template actually serves (`get_clip`) is a self-contained file that
    // was trimmed to start at 0 (`routes::videos::save_template`'s
    // `ffmpeg::trim_video` call). Rebasing here, at the flow-B read edge,
    // is what keeps the two timelines from disagreeing — without this the
    // captions showed `gif_range_start` seconds later than they should,
    // both in the flow-B editor and in the burned-in export (which just
    // forwards whatever `TemplateExportRequest.captions` the editor sent).
    let mut captions = payload.captions;
    for caption in &mut captions {
        caption.start_time -= payload.gif_range_start;
        caption.end_time -= payload.gif_range_start;
    }
    Ok(TemplateDetail {
        is_own: t.user_id == viewer_id,
        id: t.id,
        name: t.name,
        is_public: t.is_public,
        saved_at: t.saved_at,
        duration_seconds: payload.gif_range_end - payload.gif_range_start,
        width: payload.width,
        height: payload.height,
        captions,
        owner_handle,
    })
}

pub async fn list_mine(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Vec<TemplateSummary>>, AppError> {
    Ok(Json(db::get_template_summaries_owned(&state.pool, &user.id).await?))
}

pub async fn list_others(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Vec<TemplateSummary>>, AppError> {
    Ok(Json(db::get_public_template_summaries(&state.pool, &user.id).await?))
}

pub async fn get_one(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<TemplateDetail>, AppError> {
    let template = load_usable_template(&state, &id, &user.id).await?;
    let owner_handle = if template.user_id == user.id {
        None
    } else {
        db::get_user(&state.pool, &template.user_id).await?.and_then(|u| u.handle)
    };
    Ok(Json(to_detail(template, &user.id, owner_handle)?))
}

/// `PATCH /api/templates/{id}` — owner-only, lightweight rename/publish
/// toggle (see `PatchTemplateRequest`'s doc comment: deliberately doesn't
/// touch `payload_json` or the clip/thumbnail/filmstrip assets).
pub async fn patch_one(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
    Json(request): Json<PatchTemplateRequest>,
) -> Result<Json<TemplateDetail>, AppError> {
    if request.name.is_none() && request.is_public.is_none() {
        return Err(AppError::BadRequest("expected at least one of name or is_public".to_string()));
    }
    load_own_template(&state, &id, &user.id).await?;

    let mut template = db::get_template_by_id(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    if let Some(name) = request.name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::BadRequest("name must not be empty".to_string()));
        }
        template = db::rename_template(&state.pool, &id, &user.id, &name).await?.ok_or(AppError::NotFound)?;
    }
    if let Some(is_public) = request.is_public {
        template = db::set_template_public(&state.pool, &id, &user.id, is_public)
            .await?
            .ok_or(AppError::NotFound)?;
    }

    Ok(Json(to_detail(template, &user.id, None)?))
}

/// `DELETE /api/templates/{id}` — owner-only, by the template's own id.
/// Shares its asset cleanup with `routes::admin::delete_template`.
pub async fn delete_one(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<StatusCode, AppError> {
    load_own_template(&state, &id, &user.id).await?;
    let deleted = db::delete_template_by_id(&state.pool, &id, &user.id).await?;
    if !deleted {
        return Err(AppError::NotFound);
    }
    if let Ok(template_uuid) = Uuid::parse_str(&id) {
        crate::routes::videos::delete_template_assets(&state, &template_uuid).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_clip(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
    request: Request,
) -> Result<Response, AppError> {
    let template = load_usable_template(&state, &id, &user.id).await?;
    let uuid = Uuid::parse_str(&template.id)?;
    let clip_path = template_assets::ensure_on_disk(&state, &uuid, TemplateAssetKind::Clip)
        .await
        .map_err(AppError::Internal)?;
    // Range support (via `ServeFile`) is why this needs to be an actual
    // service call, not a plain byte read — the flow-B editor plays this
    // in a `<video>` element, same as `routes::videos::get_video_file`.
    let response = ServeFile::new(clip_path).oneshot(request).await.unwrap();
    Ok(response.into_response())
}

pub async fn get_thumbnail(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Response, AppError> {
    let template = load_usable_template(&state, &id, &user.id).await?;
    let uuid = Uuid::parse_str(&template.id)?;
    let path = template_assets::ensure_on_disk(&state, &uuid, TemplateAssetKind::Thumbnail)
        .await
        .map_err(AppError::Internal)?;
    let bytes = tokio::fs::read(&path).await.map_err(|_| AppError::NotFound)?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response())
}

pub async fn get_filmstrip_image(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Response, AppError> {
    let template = load_usable_template(&state, &id, &user.id).await?;
    let uuid = Uuid::parse_str(&template.id)?;
    let path = template_assets::ensure_on_disk(&state, &uuid, TemplateAssetKind::Filmstrip)
        .await
        .map_err(AppError::Internal)?;
    let bytes = tokio::fs::read(&path).await.map_err(|_| AppError::NotFound)?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response())
}

/// The flow-B editor's filmstrip layout — same shape
/// `routes::videos::get_filmstrip_meta` returns for a video, computed from
/// the template's own locked duration/width/height (already the trimmed
/// clip's own dimensions, not the source video's).
pub async fn get_filmstrip_meta(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<FilmstripMeta>, AppError> {
    let template = load_usable_template(&state, &id, &user.id).await?;
    let payload: TemplatePayload = serde_json::from_str(&template.payload_json)?;
    let duration = payload.gif_range_end - payload.gif_range_start;
    let layout = compute_filmstrip_layout(duration, payload.width, payload.height);

    Ok(Json(FilmstripMeta {
        frame_count: layout.frame_count,
        cols: layout.cols,
        rows: layout.rows,
        frame_width: layout.frame_width,
        frame_height: layout.frame_height,
        interval: layout.interval.seconds(),
        image_url: format!("/api/templates/{id}/filmstrip.jpg"),
    }))
}
