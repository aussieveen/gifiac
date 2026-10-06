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
use crate::auth::{CurrentUser, OptionalCurrentUser};
use crate::db;
use crate::error::AppError;
use crate::exports::{ExportEvent, transcode_and_upload};
use crate::models::{Gif, LibrarySort, NewGif};
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
    /// The linked-gif poster frame (SPEC's "disable gif autoplay"
    /// preference) — only ever `Some` once `gif.thumbnail_status` is
    /// `"ready"`; still `pending`, `failed`, or absent (a non-linked gif,
    /// which needs no thumbnail at all — mp4/webm cover it) all read as
    /// `None` here, and the frontend falls back to showing the live
    /// animating gif for those.
    thumbnail_url: Option<String>,
    /// SPEC-CLOUD.md §14: per-viewer, not a property of the gif row itself
    /// — the caller supplies it rather than `with_urls` computing it, so
    /// every call site stays explicit about whose favourite state this is.
    is_favourited: bool,
    /// Per-viewer, like `is_favourited`: whether "Remix this GIF" should
    /// show. `true` only when `gif.template_id` is set and that template
    /// is still accessible to the current viewer (public, or owned by
    /// them) — computed server-side (`db::is_template_remixable`/
    /// `db::remixable_template_ids`) so it disappears cleanly the moment
    /// the underlying template is deleted or made private, rather than
    /// relying on the frontend to notice.
    template_remixable: bool,
}

pub(crate) fn with_urls(gif: Gif, storage: &Storage, is_favourited: bool, template_remixable: bool) -> Result<GifResponse, AppError> {
    if let Some(external_url) = gif.external_url.clone() {
        let thumbnail_url = if gif.thumbnail_status.as_deref() == Some("ready") {
            let uuid = Uuid::parse_str(&gif.id)?;
            Some(storage.public_url(&paths::thumbnail_object_key(&uuid)))
        } else {
            None
        };
        return Ok(GifResponse {
            gif_url: external_url,
            mp4_url: None,
            webm_url: None,
            thumbnail_url,
            is_favourited,
            template_remixable,
            gif,
        });
    }
    let uuid = Uuid::parse_str(&gif.id)?;
    Ok(GifResponse {
        gif_url: storage.public_url(&paths::gif_object_key(&uuid)),
        mp4_url: Some(storage.public_url(&paths::mp4_object_key(&uuid))),
        webm_url: Some(storage.public_url(&paths::webm_object_key(&uuid))),
        thumbnail_url: None,
        is_favourited,
        template_remixable,
        gif,
    })
}

/// `with_urls`, plus a fresh per-viewer favourite-status lookup — the
/// common shape behind every single-gif response that doesn't already
/// know the answer up front (unlike `favourite_gif`/`unfavourite_gif`,
/// which just toggled it and know the result without a query).
async fn viewer_response(state: &AppState, viewer_id: &str, gif: Gif) -> Result<GifResponse, AppError> {
    let is_favourited = db::is_favourited(&state.pool, viewer_id, &gif.id).await?;
    let template_remixable = db::is_template_remixable(&state.pool, gif.template_id.as_deref(), viewer_id).await?;
    with_urls(gif, &state.storage, is_favourited, template_remixable)
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    q: Option<String>,
    /// Only meaningful for `list_library` (SPEC-CLOUD.md §8) — `list_gifs`
    /// (owner-scoped) ignores it, since that endpoint was never speced to
    /// sort by use, only `is_one_off` then recency.
    #[serde(default)]
    sort: LibrarySort,
}

pub async fn list_gifs(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<GifResponse>>, AppError> {
    let gifs = db::list_gifs(&state.pool, &user.id, query.q.as_deref()).await?;
    let favourited = db::list_favourite_gif_ids(&state.pool, &user.id).await?;
    let template_ids: Vec<String> = gifs.iter().filter_map(|g| g.template_id.clone()).collect();
    let remixable = db::remixable_template_ids(&state.pool, &template_ids, Some(&user.id)).await?;
    let responses = gifs
        .into_iter()
        .map(|gif| {
            let is_favourited = favourited.contains(&gif.id);
            let template_remixable = gif.template_id.as_deref().is_some_and(|id| remixable.contains(id));
            with_urls(gif, &state.storage, is_favourited, template_remixable)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(responses))
}

pub async fn get_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<GifResponse>, AppError> {
    let gif = db::get_gif(&state.pool, &id, &user.id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(viewer_response(&state, &user.id, gif).await?))
}

#[derive(Debug, Deserialize)]
pub struct PatchGifRequest {
    name: Option<String>,
    is_one_off: Option<bool>,
    is_public: Option<bool>,
}

/// `PATCH /api/gifs/{id}` (SPEC.md §5/§8, SPEC-CLOUD.md §4/§8): fields are
/// independently optional — a request can rename, toggle the one-off
/// flag, toggle public sharing, or any combination in one call. At least
/// one must be present, otherwise there's nothing to update and the
/// client likely made a mistake.
pub async fn rename_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
    Json(request): Json<PatchGifRequest>,
) -> Result<Json<GifResponse>, AppError> {
    if request.name.is_none() && request.is_one_off.is_none() && request.is_public.is_none() {
        return Err(AppError::BadRequest(
            "expected at least one of name, is_one_off, or is_public".to_string(),
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

    if let Some(is_public) = request.is_public {
        gif = db::set_gif_public(&state.pool, &id, &user.id, is_public)
            .await?
            .ok_or(AppError::NotFound)?;
    }

    Ok(Json(viewer_response(&state, &user.id, gif).await?))
}

/// `POST /api/gifs/{id}/use` (SPEC-CLOUD.md §8): copy-link, copy-embed, and
/// download all fire this — no dedup, auth required, no ownership/
/// visibility check (see `db::increment_gif_use_count`). Returns the
/// updated row so the frontend can update its local count without a
/// separate re-fetch.
pub async fn use_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<GifResponse>, AppError> {
    let gif = db::increment_gif_use_count(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(viewer_response(&state, &user.id, gif).await?))
}

/// `POST /api/gifs/{id}/favourite` (SPEC-CLOUD.md §14) — idempotent save.
/// Enforced server-side, not just a hidden client-side heart: a gif that's
/// neither public nor owned by the caller 404s, the same treatment
/// `db::get_gif`'s owner-scoped lookup already gives an invisible
/// resource, so as not to confirm a private gif's existence.
pub async fn favourite_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<GifResponse>, AppError> {
    let gif = db::get_favouritable_gif(&state.pool, &id, &user.id)
        .await?
        .ok_or(AppError::NotFound)?;
    db::add_favourite(&state.pool, &user.id, &id, &Utc::now().to_rfc3339()).await?;
    let template_remixable = db::is_template_remixable(&state.pool, gif.template_id.as_deref(), &user.id).await?;
    Ok(Json(with_urls(gif, &state.storage, true, template_remixable)?))
}

/// `DELETE /api/gifs/{id}/favourite` (SPEC-CLOUD.md §14) — idempotent
/// remove. Visibility is conditional, not skipped: if the caller already
/// has a favourite row for this id, they've proven prior legitimate
/// knowledge of it, so the lookup goes unscoped (`admin_get_gif`) — that's
/// what lets removing your own bookmark keep working even for a gif its
/// owner has since made private. Otherwise (nothing to remove) it falls
/// back to the same visibility rule `favourite_gif` enforces, so a no-op
/// unfavourite can't be used to probe an arbitrary private gif's
/// existence/details.
pub async fn unfavourite_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<GifResponse>, AppError> {
    let gif = if db::is_favourited(&state.pool, &user.id, &id).await? {
        db::admin_get_gif(&state.pool, &id).await?.ok_or(AppError::NotFound)?
    } else {
        db::get_favouritable_gif(&state.pool, &id, &user.id)
            .await?
            .ok_or(AppError::NotFound)?
    };
    db::remove_favourite(&state.pool, &user.id, &id).await?;
    let template_remixable = db::is_template_remixable(&state.pool, gif.template_id.as_deref(), &user.id).await?;
    Ok(Json(with_urls(gif, &state.storage, false, template_remixable)?))
}

/// `GET /api/favourites` (SPEC-CLOUD.md §14) — the caller's saved gifs, in
/// the same attributed shape `GET /api/library` returns (a saved gif may
/// be the caller's own or someone else's).
pub async fn list_favourites(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Vec<LibraryEntry>>, AppError> {
    let gifs = db::list_favourite_gifs(&state.pool, &user.id).await?;
    let template_ids: Vec<String> = gifs.iter().filter_map(|g| g.template_id.clone()).collect();
    let remixable = db::remixable_template_ids(&state.pool, &template_ids, Some(&user.id)).await?;
    let entries = gifs
        .into_iter()
        .map(|public_gif| {
            let owner_handle = public_gif.owner_handle.clone();
            let owner_slug = public_gif.owner_slug.clone();
            let template_remixable = public_gif.template_id.as_deref().is_some_and(|id| remixable.contains(id));
            // Every row here is, by definition, one of the caller's own
            // favourites — no lookup needed, unlike list_library's mixed
            // viewer-relative state.
            with_urls(public_gif.into(), &state.storage, true, template_remixable)
                .map(|gif| LibraryEntry { gif, owner_handle, owner_slug })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(entries))
}

/// `GET /api/library` (SPEC-CLOUD.md §8) — the global library, no auth
/// required. Every user's public gifs, newest first, with attribution.
#[derive(Debug, Serialize)]
pub struct LibraryEntry {
    #[serde(flatten)]
    gif: GifResponse,
    owner_handle: Option<String>,
    // The owner's real slug (migration 0012) — the frontend must use this
    // to build the attribution link rather than deriving one from
    // `owner_handle`, since a collision suffix can make the two diverge.
    owner_slug: Option<String>,
}

/// Auth-optional (SPEC-CLOUD.md §14): a logged-out visitor still browses
/// the library freely, they just get `is_favourited: false` on every
/// item — favouriting itself still requires signing in, enforced by
/// `favourite_gif` requiring a real `CurrentUser`.
pub async fn list_library(
    State(state): State<Arc<AppState>>,
    OptionalCurrentUser(viewer): OptionalCurrentUser,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<LibraryEntry>>, AppError> {
    let viewer_id = viewer.as_ref().map(|CurrentUser(user)| user.id.as_str());
    let favourited = db::favourited_ids_for_viewer(&state.pool, viewer_id).await?;
    let gifs = db::list_public_gifs(&state.pool, query.q.as_deref(), query.sort).await?;
    let template_ids: Vec<String> = gifs.iter().filter_map(|g| g.template_id.clone()).collect();
    let remixable = db::remixable_template_ids(&state.pool, &template_ids, viewer_id).await?;
    let entries = gifs
        .into_iter()
        .map(|public_gif| {
            let owner_handle = public_gif.owner_handle.clone();
            let owner_slug = public_gif.owner_slug.clone();
            let is_favourited = favourited.contains(&public_gif.id);
            let template_remixable = public_gif.template_id.as_deref().is_some_and(|id| remixable.contains(id));
            with_urls(public_gif.into(), &state.storage, is_favourited, template_remixable)
                .map(|gif| LibraryEntry { gif, owner_handle, owner_slug })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(entries))
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
    #[serde(default)]
    is_public: bool,
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
        is_public: request.is_public,
        user_id: user.id,
        template_id: None,
    };
    let gif = db::insert_gif(&state.pool, &new_gif, &Utc::now().to_rfc3339()).await?;

    // Fire-and-forget: the gif is already usable (the frontend just shows
    // the live animating `<img>` until this lands) — see the "disable gif
    // autoplay" preference design decision not to block gif creation on a
    // third-party server's reliability/speed.
    let (pool, storage, http_client) = (state.pool.clone(), state.storage.clone(), state.http_client.clone());
    let (gif_id, external_url) = (gif.id.clone(), gif.external_url.clone().expect("just-linked gif has external_url"));
    tokio::spawn(async move {
        if let Err(err) = crate::thumbnails::generate_and_store(&pool, &storage, &http_client, &gif_id, &external_url).await
        {
            tracing::error!(gif_id, error = ?err, "thumbnail generation task failed");
        }
    });

    Ok((StatusCode::CREATED, Json(with_urls(gif, &state.storage, false, false)?)))
}

#[derive(Debug, Deserialize)]
pub struct CheckLinkRequest {
    url: String,
}

/// What the Import GIFs modal's "From links" row needs to render a
/// "Looks good · WxH · size" line without yet creating a gif — the same
/// facts `link_gif` would otherwise only learn (and discard) at creation
/// time.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckLinkResponse {
    width: u32,
    height: u32,
    size_bytes: u64,
}

/// `POST /api/gifs/check-link`: the server-side half of validating a
/// pasted URL before committing it (CORS rules out doing this from the
/// browser) — confirms it's reachable, actually a GIF (not just an
/// `image/*`, and not a video misfiled as one), under the upload size
/// ceiling, and not already in the caller's own library. Never creates a
/// row; `link_gif` does that once the row is "Add"ed.
pub async fn check_link(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Json(request): Json<CheckLinkRequest>,
) -> Result<Json<CheckLinkResponse>, AppError> {
    let url = request.url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::BadRequest("url must not be empty".to_string()));
    }

    let existing_urls = db::list_external_urls_for_user(&state.pool, &user.id).await?;
    let normalized = crate::link_check::normalize_url(&url);
    if existing_urls.iter().any(|existing| crate::link_check::normalize_url(existing) == normalized) {
        return Err(AppError::BadRequest("That GIF is already in your library.".to_string()));
    }

    match crate::link_check::check_gif_link(&state.http_client, &url).await {
        Ok(info) => Ok(Json(CheckLinkResponse {
            width: info.width,
            height: info.height,
            size_bytes: info.size_bytes,
        })),
        Err(crate::link_check::GifLinkError::Unreachable) => Err(AppError::BadRequest("Couldn't reach that link.".to_string())),
        Err(crate::link_check::GifLinkError::Video) => Err(AppError::BadRequest(
            "That's a video, not a GIF. To caption a video, use New GIF instead.".to_string(),
        )),
        Err(crate::link_check::GifLinkError::NotAGif) => Err(AppError::BadRequest(
            "That link isn't a GIF. Use the direct link to the .gif file.".to_string(),
        )),
    }
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
    // The Import GIFs modal's Upload tab sends one file per request, plus
    // this optional text field carrying the row's (possibly user-edited)
    // name — set once by whichever "name" field precedes the next "files"
    // field it belongs to, then consumed. A legacy multi-file batch
    // request with no "name" field falls back to the derived name below,
    // same as before.
    let mut custom_name: Option<String> = None;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        if field.name() == Some("name") {
            let text = field.text().await.map_err(|e| AppError::BadRequest(e.to_string()))?;
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                custom_name = Some(trimmed.to_string());
            }
            continue;
        }

        let original_filename = field
            .file_name()
            .map(str::to_string)
            .unwrap_or_else(|| "import".to_string());
        let name = custom_name.take().unwrap_or_else(|| {
            Path::new(&original_filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("import")
                .to_string()
        });

        let tmp_dir = tempfile::tempdir()?;
        let source_path = tmp_dir.path().join("source");
        let mut file = tokio::fs::File::create(&source_path).await?;
        let mut bytes_written: usize = 0;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?
        {
            bytes_written += chunk.len();
            if bytes_written > crate::MAX_GIF_BYTES {
                return Err(AppError::BadRequest(format!(
                    "That's too big. GIFs can be up to {}MB.",
                    crate::MAX_GIF_BYTES / (1024 * 1024)
                )));
            }
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
            is_public: false,
            user_id: user.id.clone(),
            template_id: None,
        };
        let gif = db::insert_gif(&state.pool, &new_gif, &Utc::now().to_rfc3339()).await?;
        created.push(with_urls(gif, &state.storage, false, false)?);
    }

    if created.is_empty() {
        return Err(AppError::BadRequest(
            "expected at least one file".to_string(),
        ));
    }

    Ok((StatusCode::CREATED, Json(created)))
}
