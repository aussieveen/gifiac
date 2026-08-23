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
            gif_range_start: 0.0,
            gif_range_end: probe.duration_seconds,
            width: result.width,
            height: result.height,
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
