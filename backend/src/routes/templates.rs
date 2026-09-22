//! Template-id-scoped endpoints (SPEC-CLOUD.md §4) — distinct from
//! `routes::videos`' `/api/videos/{id}/template`, which stays the
//! video-owner's private get/put/delete flow. These are the cross-user
//! surface: a template reachable by its own id, visible to anyone once its
//! creator opts it into the global library.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as AxPath, Query, Request, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tower::ServiceExt;
use tower_http::services::ServeFile;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::db;
use crate::error::AppError;
use crate::models::{LibrarySort, PublicTemplate, TemplatePayload};
use crate::paths;
use crate::state::AppState;

/// `GET /api/templates/{id}` (and the list endpoint below)'s response — a
/// public template's payload plus the bits a cross-user viewer needs that
/// aren't in `TemplatePayload` itself: attribution, use count, when it was
/// saved, and where to fetch the actual clip media (never a stored/derived
/// URL the way R2 objects are — these are local-disk files, served by the
/// two routes below).
#[derive(Debug, Serialize)]
pub struct TemplateResponse {
    id: String,
    is_public: bool,
    use_count: i64,
    owner_handle: Option<String>,
    saved_at: String,
    clip_url: String,
    thumbnail_url: String,
    #[serde(flatten)]
    payload: TemplatePayload,
}

fn to_response(template: PublicTemplate) -> Result<TemplateResponse, AppError> {
    let payload: TemplatePayload = serde_json::from_str(&template.payload_json)?;
    Ok(TemplateResponse {
        clip_url: format!("/api/templates/{}/clip", template.id),
        thumbnail_url: format!("/api/templates/{}/thumbnail", template.id),
        id: template.id,
        is_public: template.is_public,
        use_count: template.use_count,
        owner_handle: template.owner_handle,
        saved_at: template.saved_at,
        payload,
    })
}

pub async fn get_template(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<TemplateResponse>, AppError> {
    let template = db::get_public_template(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(to_response(template)?))
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    q: Option<String>,
    #[serde(default)]
    sort: LibrarySort,
}

/// `GET /api/templates` (SPEC-CLOUD.md §8) — the global library's template
/// half, no auth required. Mirrors `routes::gifs::list_library`.
pub async fn list_templates(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<TemplateResponse>>, AppError> {
    let templates = db::list_public_templates(&state.pool, query.q.as_deref(), query.sort).await?;
    let responses = templates.into_iter().map(to_response).collect::<Result<Vec<_>, _>>()?;
    Ok(Json(responses))
}

/// Streams the template's self-contained clip (SPEC-CLOUD.md §4) — same
/// `ServeFile` pattern as `videos::get_video_file`, so Range requests work
/// for a `<video>` preview. Local-disk only (not yet S3-backed, same
/// "local disk for now" scope cut as saving a template in the first
/// place) — visible only once its creator has made it public.
pub async fn get_template_clip(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    request: Request,
) -> Result<Response, AppError> {
    let template = db::get_public_template(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    let template_uuid = Uuid::parse_str(&template.id)?;
    let clip_path = paths::template_clip_path(&state.config.video_dir, &template_uuid);

    // ServeFile's Service is Infallible — see `get_video_file`'s comment.
    let response = ServeFile::new(clip_path).oneshot(request).await.unwrap();
    Ok(response.into_response())
}

/// The clip's first frame (SPEC-CLOUD.md §4), generated once at save time —
/// unlike a video's thumbnail this is never regenerated on the fly, since a
/// missing one here would mean the save-time pipeline itself failed, not
/// just an evictable local cache miss.
pub async fn get_template_thumbnail(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Response, AppError> {
    let template = db::get_public_template(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    let template_uuid = Uuid::parse_str(&template.id)?;
    let thumb_path = paths::template_thumbnail_path(&state.config.video_dir, &template_uuid);

    let bytes = tokio::fs::read(&thumb_path).await.map_err(|_| AppError::NotFound)?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response())
}

#[derive(Debug, Deserialize)]
pub struct SetTemplatePublicRequest {
    is_public: bool,
}

#[derive(Debug, Serialize)]
pub struct TemplateVisibilityResponse {
    id: String,
    is_public: bool,
    use_count: i64,
}

/// `PATCH /api/templates/{id}` — the one enforcement point SPEC-CLOUD.md §4
/// calls out explicitly: "a non-creator's request is rejected with 403."
/// Existence isn't secret here the way a private gif/video's is (the
/// template may legitimately be public), so this looks the row up by any
/// visibility first, then 403s a non-owner rather than 404ing — the only
/// place in this app that does.
pub async fn set_template_public(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
    Json(body): Json<SetTemplatePublicRequest>,
) -> Result<Json<TemplateVisibilityResponse>, AppError> {
    let template = db::get_template_by_id(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    if template.user_id != user.id {
        return Err(AppError::Forbidden("not the creator of this template".to_string()));
    }
    let updated = db::set_template_public(&state.pool, &id, &user.id, body.is_public)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(TemplateVisibilityResponse {
        id: updated.id,
        is_public: updated.is_public,
        use_count: updated.use_count,
    }))
}
