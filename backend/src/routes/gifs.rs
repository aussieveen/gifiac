//! Archive endpoints per SPEC.md §5/§8: list/search, fetch one (for
//! viewing or re-editing), rename, delete, and bulk import (§7) — deletion
//! removes both the SQLite row and all three R2 objects for that GIF.

use std::path::Path;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Multipart, Path as AxPath, Query, State};
use axum::http::StatusCode;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::ass::generate_ass;
use crate::auth::CurrentUser;
use crate::db;
use crate::error::AppError;
use crate::exports::{ExportEvent, transcode_and_upload};
use crate::models::{Gif, NewGif};
use crate::paths;
use crate::state::AppState;
use crate::storage::Storage;

/// `Gif` plus its derived, never-stored R2 URLs (SPEC.md §9: "URLs are
/// derived, never stored") — what the archive UI needs to preview, link,
/// and download a GIF without separately re-deriving the key convention.
/// For a linked GIF (SPEC.md §13), `gif_url` is the external URL itself
/// and there's no MP4/WebM — those stay `None`.
#[derive(Debug, Serialize)]
pub struct GifResponse {
    #[serde(flatten)]
    gif: Gif,
    gif_url: String,
    mp4_url: Option<String>,
    webm_url: Option<String>,
}

fn with_urls(gif: Gif, storage: &Storage) -> Result<GifResponse, AppError> {
    if let Some(external_url) = gif.external_url.clone() {
        return Ok(GifResponse {
            gif_url: external_url,
            mp4_url: None,
            webm_url: None,
            gif,
        });
    }
    let uuid = Uuid::parse_str(&gif.id)?;
    Ok(GifResponse {
        gif_url: storage.public_url(&paths::gif_object_key(&uuid)),
        mp4_url: Some(storage.public_url(&paths::mp4_object_key(&uuid))),
        webm_url: Some(storage.public_url(&paths::webm_object_key(&uuid))),
        gif,
    })
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    q: Option<String>,
}

pub async fn list_gifs(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<GifResponse>>, AppError> {
    let gifs = db::list_gifs(&state.pool, &user.id, query.q.as_deref()).await?;
    let responses = gifs
        .into_iter()
        .map(|gif| with_urls(gif, &state.storage))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(responses))
}

pub async fn get_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<GifResponse>, AppError> {
    let gif = db::get_gif(&state.pool, &id, &user.id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(with_urls(gif, &state.storage)?))
}

#[derive(Debug, Deserialize)]
pub struct PatchGifRequest {
    name: Option<String>,
    is_one_off: Option<bool>,
}

/// `PATCH /api/gifs/{id}` (SPEC.md §5/§8): both fields are independently
/// optional — a request can rename, toggle the one-off flag, or both in
/// one call. At least one must be present, otherwise there's nothing to
/// update and the client likely made a mistake.
pub async fn rename_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
    Json(request): Json<PatchGifRequest>,
) -> Result<Json<GifResponse>, AppError> {
    if request.name.is_none() && request.is_one_off.is_none() {
        return Err(AppError::BadRequest(
            "expected at least one of name or is_one_off".to_string(),
        ));
    }

    let mut gif = db::get_gif(&state.pool, &id, &user.id).await?.ok_or(AppError::NotFound)?;

    if let Some(name) = request.name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::BadRequest("name must not be empty".to_string()));
        }
        gif = db::rename_gif(&state.pool, &id, &user.id, &name)
            .await?
            .ok_or(AppError::NotFound)?;
    }

    if let Some(is_one_off) = request.is_one_off {
        gif = db::set_gif_one_off(&state.pool, &id, &user.id, is_one_off)
            .await?
            .ok_or(AppError::NotFound)?;
    }

    Ok(Json(with_urls(gif, &state.storage)?))
}

/// Removes the SQLite row first, then best-effort deletes all three R2
/// objects — if an object was never fully uploaded (unlikely, but not
/// impossible after a crash mid-export) a missing-object delete from the
/// S3-compatible API is a no-op, not an error, so this doesn't need to
/// distinguish "already gone" from "successfully removed". A linked GIF
/// (SPEC.md §13) has no R2 objects at all — that step is skipped for it.
pub async fn delete_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<StatusCode, AppError> {
    let gif = db::get_gif(&state.pool, &id, &user.id).await?.ok_or(AppError::NotFound)?;
    let deleted = db::delete_gif(&state.pool, &id, &user.id).await?;
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

#[derive(Debug, Deserialize)]
pub struct LinkGifRequest {
    url: String,
    name: String,
}

/// SPEC.md §13: creates a linked GIF — a pure hotlink to a third-party
/// URL, never downloaded or re-hosted on R2. Synchronous, like `POST
/// /api/videos`'s FFmpeg probe: the URL sanity check runs inline, since
/// there's no real processing pipeline behind this to background.
pub async fn link_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Json(request): Json<LinkGifRequest>,
) -> Result<(StatusCode, Json<GifResponse>), AppError> {
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name must not be empty".to_string()));
    }
    let url = request.url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::BadRequest("url must not be empty".to_string()));
    }

    crate::link_check::check_linkable(&state.http_client, &url)
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?;

    let new_gif = NewGif {
        id: Uuid::new_v4().to_string(),
        video_id: None,
        name,
        caption_text: String::new(),
        captions_json: None,
        gif_range_start: None,
        gif_range_end: None,
        width: None,
        height: None,
        external_url: Some(url),
        user_id: user.id,
    };
    let gif = db::insert_gif(&state.pool, &new_gif, &Utc::now().to_rfc3339()).await?;
    Ok((StatusCode::CREATED, Json(with_urls(gif, &state.storage)?)))
}

/// Bulk import (SPEC.md §7): each multipart field is one file, run through
/// the *same* transcode-then-upload sequence as an export — filling in
/// whichever of GIF/MP4/WebM the source didn't already have — but with an
/// empty caption list (`generate_ass(&[], ...)` is a valid, harmless
/// no-caption skeleton) burned in over the full clip, no gif range to
/// choose. `video_id`/`captions_json` stay `None` and `caption_text` stays
/// empty, matching how the archive/re-edit UI is meant to tell an import
/// apart from a real export — there's no source `videos` row to re-edit
/// against.
pub async fn import_gifs(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Vec<GifResponse>>), AppError> {
    let mut created = Vec::new();

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        let original_filename = field
            .file_name()
            .map(str::to_string)
            .unwrap_or_else(|| "import".to_string());
        let name = Path::new(&original_filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("import")
            .to_string();

        let tmp_dir = tempfile::tempdir()?;
        let source_path = tmp_dir.path().join("source");
        let mut file = tokio::fs::File::create(&source_path).await?;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?
        {
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file);

        // A probe failure is the client's fault (not a real media file) —
        // 400, same as a bad `POST /api/videos` upload — rather than the
        // 500 a downstream pipeline failure gets below.
        let probe_path = source_path.clone();
        let probe_result =
            tokio::task::spawn_blocking(move || crate::ffmpeg::probe_video(&probe_path))
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
        let probe = match probe_result {
            Ok(probe) => probe,
            Err(err) => {
                return Err(AppError::BadRequest(format!(
                    "failed to probe {original_filename}: {err}"
                )));
            }
        };

        let (output_width, output_height) =
            crate::scale::scaled_dimensions(probe.width, probe.height);
        let ass = generate_ass(&[], 0.0, probe.duration_seconds, output_width, output_height);

        let id = Uuid::new_v4();
        let result = transcode_and_upload(
            &state,
            id,
            &source_path,
            &ass,
            0.0,
            probe.duration_seconds,
            &|_: ExportEvent| {},
        )
        .await
        .map_err(AppError::Internal)?;

        let new_gif = NewGif {
            id: id.to_string(),
            video_id: None,
            name,
            caption_text: String::new(),
            captions_json: None,
            gif_range_start: Some(0.0),
            gif_range_end: Some(probe.duration_seconds),
            width: Some(result.width),
            height: Some(result.height),
            external_url: None,
            user_id: user.id.clone(),
        };
        let gif = db::insert_gif(&state.pool, &new_gif, &Utc::now().to_rfc3339()).await?;
        created.push(with_urls(gif, &state.storage)?);
    }

    if created.is_empty() {
        return Err(AppError::BadRequest(
            "expected at least one file".to_string(),
        ));
    }

    Ok((StatusCode::CREATED, Json(created)))
}
