//! Archive endpoints per SPEC.md §5/§8: list/search, fetch one (for
//! viewing or re-editing), rename, and delete — deletion removes both the
//! SQLite row and all three R2 objects for that GIF.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db;
use crate::error::AppError;
use crate::models::Gif;
use crate::paths;
use crate::state::AppState;
use crate::storage::Storage;

/// `Gif` plus its derived, never-stored R2 URLs (SPEC.md §9: "URLs are
/// derived, never stored") — what the archive UI needs to preview, link,
/// and download a GIF without separately re-deriving the key convention.
#[derive(Debug, Serialize)]
pub struct GifResponse {
    #[serde(flatten)]
    gif: Gif,
    gif_url: String,
    mp4_url: String,
    webm_url: String,
}

fn with_urls(gif: Gif, storage: &Storage) -> Result<GifResponse, AppError> {
    let uuid = Uuid::parse_str(&gif.id)?;
    Ok(GifResponse {
        gif_url: storage.public_url(&paths::gif_object_key(&uuid)),
        mp4_url: storage.public_url(&paths::mp4_object_key(&uuid)),
        webm_url: storage.public_url(&paths::webm_object_key(&uuid)),
        gif,
    })
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    q: Option<String>,
}

pub async fn list_gifs(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<GifResponse>>, AppError> {
    let gifs = db::list_gifs(&state.pool, query.q.as_deref()).await?;
    let responses = gifs
        .into_iter()
        .map(|gif| with_urls(gif, &state.storage))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(responses))
}

pub async fn get_gif(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<GifResponse>, AppError> {
    let gif = db::get_gif(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(with_urls(gif, &state.storage)?))
}

#[derive(Debug, Deserialize)]
pub struct RenameGifRequest {
    name: String,
}

pub async fn rename_gif(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Json(request): Json<RenameGifRequest>,
) -> Result<Json<GifResponse>, AppError> {
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name must not be empty".to_string()));
    }
    let gif = db::rename_gif(&state.pool, &id, &name)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(with_urls(gif, &state.storage)?))
}

/// Removes the SQLite row first, then best-effort deletes all three R2
/// objects — if an object was never fully uploaded (unlikely, but not
/// impossible after a crash mid-export) a missing-object delete from the
/// S3-compatible API is a no-op, not an error, so this doesn't need to
/// distinguish "already gone" from "successfully removed".
pub async fn delete_gif(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<StatusCode, AppError> {
    let deleted = db::delete_gif(&state.pool, &id).await?;
    if !deleted {
        return Err(AppError::NotFound);
    }

    let uuid = Uuid::parse_str(&id)?;
    for key in [
        paths::gif_object_key(&uuid),
        paths::mp4_object_key(&uuid),
        paths::webm_object_key(&uuid),
    ] {
        state.storage.delete_object(&key).await?;
    }

    Ok(StatusCode::NO_CONTENT)
}
