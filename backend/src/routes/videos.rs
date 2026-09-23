use std::path::Path;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Multipart, Path as AxPath, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::db;
use crate::error::AppError;
use crate::ffmpeg;
use crate::filmstrip_layout::compute_filmstrip_layout;
use crate::models::{FilmstripMeta, NewVideo, TemplatePayload, Video, VideoListItem};
use crate::paths;
use crate::source_video;
use crate::state::AppState;

/// Looks up a video by its (string) path-param id, scoped to `owner_id`
/// (SPEC-CLOUD.md §3) — another user's video simply doesn't resolve, the
/// same `NotFound` path as a nonexistent id, rather than a separate
/// Forbidden response that would leak whether the id exists at all. Also
/// parses the id as a UUID along the way so callers that need it for path
/// derivation don't have to parse it a second time.
async fn load_video(state: &AppState, id: &str, owner_id: &str) -> Result<(Uuid, Video), AppError> {
    let uuid = Uuid::parse_str(id).map_err(|_| AppError::NotFound)?;
    let video = db::get_video(&state.pool, id, owner_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok((uuid, video))
}

/// Best-effort removal of a partially-written upload after probing or
/// thumbnailing fails, so failed uploads don't accumulate as orphan files.
async fn remove_partial_upload(video_path: &std::path::Path, reason: &str) {
    if let Err(err) = tokio::fs::remove_file(video_path).await {
        tracing::warn!(
            path = %video_path.display(),
            %reason,
            error = %err,
            "failed to clean up partial upload"
        );
    }
}

pub async fn upload_video(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Video>), AppError> {
    let mut field = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
        .ok_or_else(|| AppError::BadRequest("expected a multipart file field".to_string()))?;

    let original_filename = field
        .file_name()
        .map(str::to_string)
        .unwrap_or_else(|| "upload".to_string());

    let extension = Path::new(&original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .filter(|e| !e.is_empty())
        .ok_or_else(|| AppError::BadRequest("filename must have an extension".to_string()))?;

    let id = Uuid::new_v4();
    tokio::fs::create_dir_all(&state.config.video_dir).await?;
    let video_path = paths::video_path(&state.config.video_dir, &id, &extension);

    let mut file = tokio::fs::File::create(&video_path).await?;
    let mut file_size: u64 = 0;
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        file_size += chunk.len() as u64;
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);

    let probe_path = video_path.clone();
    let probe_result = tokio::task::spawn_blocking(move || ffmpeg::probe_video(&probe_path))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;

    let probe = match probe_result {
        Ok(probe) => probe,
        Err(err) => {
            remove_partial_upload(&video_path, "ffmpeg probe failed").await;
            return Err(AppError::BadRequest(format!(
                "failed to probe uploaded video: {err}"
            )));
        }
    };

    let thumb_path = paths::thumbnail_path(&state.config.video_dir, &id);
    if let Err(err) =
        ffmpeg::generate_thumbnail(&video_path, &thumb_path, probe.duration_seconds).await
    {
        remove_partial_upload(&video_path, "thumbnail generation failed").await;
        return Err(AppError::Internal(anyhow::anyhow!(
            "failed to generate thumbnail: {err}"
        )));
    }

    // SPEC-CLOUD.md §6: the video's persistent home is the private S3
    // bucket, not local disk — pushed here, then the local copy is
    // deleted; a later read re-fetches it on demand (see
    // `source_video::ensure_on_disk`). The thumbnail stays local (small,
    // regenerable from the video if it's ever missing — see
    // `get_thumbnail`).
    // Content type doesn't matter functionally here — nothing serves this
    // object directly to a browser (playback always proxies through
    // `GET /api/videos/{id}/file`, which derives its own content type from
    // the local file) — but the source can be any video container, not
    // just mp4, so a generic type is more honest than guessing wrong.
    if let Err(err) = state
        .source_storage
        .upload_file(
            &paths::video_object_key(&id, &extension),
            &video_path,
            "application/octet-stream",
        )
        .await
    {
        remove_partial_upload(&video_path, "uploading to source video storage failed").await;
        remove_partial_upload(&thumb_path, "uploading to source video storage failed").await;
        return Err(AppError::Internal(anyhow::anyhow!(
            "failed to upload video to object storage: {err}"
        )));
    }
    if let Err(err) = tokio::fs::remove_file(&video_path).await {
        tracing::warn!(path = %video_path.display(), error = %err, "failed to remove local copy after uploading to object storage");
    }

    let new_video = NewVideo {
        id: id.to_string(),
        original_filename,
        extension,
        file_size_bytes: file_size as i64,
        duration_seconds: probe.duration_seconds,
        width: probe.width,
        height: probe.height,
        user_id: user.id,
    };

    let uploaded_at = Utc::now().to_rfc3339();
    let video = db::insert_video(&state.pool, &new_video, &uploaded_at).await?;

    Ok((StatusCode::CREATED, Json(video)))
}

pub async fn list_videos(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Vec<VideoListItem>>, AppError> {
    let videos = db::list_videos(&state.pool, &user.id).await?;
    Ok(Json(videos))
}

pub async fn get_video(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<Video>, AppError> {
    let (_, video) = load_video(&state, &id, &user.id).await?;
    Ok(Json(video))
}

/// Generate-if-missing, same pattern `get_filmstrip_image` already uses
/// for its sprite — the thumbnail is cheap to regenerate from the source
/// video and was never itself pushed to S3, so it isn't guaranteed to
/// survive an instance replacement the way the video it's derived from is
/// (SPEC-CLOUD.md §6).
pub async fn get_thumbnail(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Response, AppError> {
    let (uuid, video) = load_video(&state, &id, &user.id).await?;

    let thumb_path = paths::thumbnail_path(&state.config.video_dir, &uuid);
    if !tokio::fs::try_exists(&thumb_path).await.unwrap_or(false) {
        let video_path = source_video::ensure_on_disk(&state, &uuid, &video.extension)
            .await
            .map_err(AppError::Internal)?;
        ffmpeg::generate_thumbnail(&video_path, &thumb_path, video.duration_seconds)
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to regenerate thumbnail: {e}")))?;
    }

    let bytes = tokio::fs::read(&thumb_path)
        .await
        .map_err(|_| AppError::NotFound)?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response())
}

/// Streams the raw source video, delegating to `tower_http`'s `ServeFile`
/// so HTTP Range requests work (required for smooth seeking in an HTML5
/// `<video>` element — the caption editor's live preview plays this
/// directly, per the "play the clip with captions to line up timing"
/// feature). SPEC-CLOUD.md §6: the video's persistent home is a private
/// S3 bucket, not local disk — `ensure_on_disk` re-fetches it if this
/// instance doesn't already have a local copy cached.
pub async fn get_video_file(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
    request: Request,
) -> Result<Response, AppError> {
    let (uuid, video) = load_video(&state, &id, &user.id).await?;
    let video_path = source_video::ensure_on_disk(&state, &uuid, &video.extension)
        .await
        .map_err(AppError::Internal)?;

    // ServeFile's Service is Infallible — a missing/unreadable file
    // produces a 404/500 *response*, not an Err, so `.unwrap()` here can
    // never actually panic.
    let response = ServeFile::new(video_path).oneshot(request).await.unwrap();
    Ok(response.into_response())
}

pub async fn get_filmstrip_meta(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<FilmstripMeta>, AppError> {
    let (_, video) = load_video(&state, &id, &user.id).await?;
    let layout = compute_filmstrip_layout(video.duration_seconds, video.width, video.height);

    Ok(Json(FilmstripMeta {
        frame_count: layout.frame_count,
        cols: layout.cols,
        rows: layout.rows,
        frame_width: layout.frame_width,
        frame_height: layout.frame_height,
        interval: layout.interval.seconds(),
        image_url: format!("/api/videos/{id}/filmstrip.jpg"),
    }))
}

/// SPEC.md §12's original guard ("no GIFs were made from it") was already
/// replaced by SPEC-CLOUD.md §4/§6 — a video can be deleted freely
/// regardless of GIFs or a saved template made from it. A template is a
/// self-contained clipped asset (M3) that doesn't depend on the source
/// video continuing to exist (`templates.video_id` is nullable, `ON
/// DELETE SET NULL` — migration `0006_template_video_id_nullable.sql`),
/// so deleting the video can't orphan or break it.
pub async fn delete_video(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<StatusCode, AppError> {
    delete_video_and_its_assets(&state, &id, &user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Shared by the route above and `exports::run_pipeline`'s post-export
/// cleanup (a video with no template isn't preserved past the gif it was
/// used for — see that call site's comment) — same DB row + S3 object +
/// local file removal either way, just triggered differently.
pub(crate) async fn delete_video_and_its_assets(state: &AppState, id: &str, owner_id: &str) -> Result<(), AppError> {
    let (uuid, video) = load_video(state, id, owner_id).await?;

    db::delete_video(&state.pool, id, owner_id).await?;

    if let Err(err) = state
        .source_storage
        .delete_object(&paths::video_object_key(&uuid, &video.extension))
        .await
    {
        tracing::warn!(id = %uuid, error = %err, "failed to remove object storage copy of deleted video");
    }

    let video_path = paths::video_path(&state.config.video_dir, &uuid, &video.extension);
    let thumb_path = paths::thumbnail_path(&state.config.video_dir, &uuid);
    let sprite_path = paths::filmstrip_sprite_path(&state.config.video_dir, &uuid);
    for path in [video_path, thumb_path, sprite_path] {
        if let Err(err) = tokio::fs::remove_file(&path).await
            && err.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(path = %path.display(), error = %err, "failed to remove file for deleted video");
        }
    }

    Ok(())
}

pub async fn get_filmstrip_image(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Response, AppError> {
    let (uuid, video) = load_video(&state, &id, &user.id).await?;

    let sprite_path = paths::filmstrip_sprite_path(&state.config.video_dir, &uuid);
    let sprite_exists = match tokio::fs::try_exists(&sprite_path).await {
        Ok(exists) => exists,
        Err(err) => {
            tracing::warn!(
                path = %sprite_path.display(),
                error = %err,
                "failed to check filmstrip cache, regenerating"
            );
            false
        }
    };
    if !sprite_exists {
        let video_path = source_video::ensure_on_disk(&state, &uuid, &video.extension)
            .await
            .map_err(AppError::Internal)?;
        let layout = compute_filmstrip_layout(video.duration_seconds, video.width, video.height);
        ffmpeg::generate_filmstrip_sprite(&video_path, &sprite_path, &layout)
            .await
            .map_err(|e| {
                AppError::Internal(anyhow::anyhow!("failed to generate filmstrip: {e}"))
            })?;
    }

    let bytes = tokio::fs::read(&sprite_path).await?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response())
}

/// SPEC.md §12: `GET /api/videos/{id}/template` — 404 if none exists,
/// distinct from a 404 for the video itself not existing.
pub async fn get_template(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<TemplatePayload>, AppError> {
    load_video(&state, &id, &user.id).await?;
    let template = db::get_template(&state.pool, &id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(template))
}

/// SPEC.md §12: `PUT /api/videos/{id}/template` — upserts (creates or
/// overwrites) the template with the request body. SPEC-CLOUD.md §4: the
/// video is trimmed to the template's range into its own independent
/// clip file (+ thumbnail), rather than the template just referencing
/// offsets into the original video.
pub async fn put_template(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
    Json(payload): Json<TemplatePayload>,
) -> Result<Json<TemplatePayload>, AppError> {
    let (video_uuid, video) = load_video(&state, &id, &user.id).await?;
    save_template(&state, &video_uuid, &id, &video.extension, &user.id, &payload).await?;
    Ok(Json(payload))
}

/// The actual clip/thumbnail/filmstrip generation + upsert behind
/// `put_template` above — pulled out so `exports::run_pipeline` can also
/// call it directly for the "Create template" checkbox (SPEC.md §12),
/// which must happen inside the same export request as the video's own
/// post-export cleanup (see `ExportRequest::save_as_template`'s doc
/// comment for why a separate follow-up call would race it).
pub(crate) async fn save_template(
    state: &AppState,
    video_uuid: &Uuid,
    video_id: &str,
    video_extension: &str,
    owner_id: &str,
    payload: &TemplatePayload,
) -> Result<(), AppError> {
    if payload.gif_range_end <= payload.gif_range_start {
        return Err(AppError::BadRequest(
            "gif_range_end must be after gif_range_start".to_string(),
        ));
    }

    // Reusing an existing template's id (rather than always generating a
    // fresh one) means an overwrite replaces its clip/thumbnail/filmstrip
    // files in place — `paths::template_clip_path`/`template_thumbnail_path`/
    // `template_filmstrip_path` are named after this id — instead of
    // orphaning the previous save's.
    let template_id = match db::get_template_id(&state.pool, video_id).await? {
        Some(existing) => Uuid::parse_str(&existing)?,
        None => Uuid::new_v4(),
    };

    let stage_started = std::time::Instant::now();
    let source_path = source_video::ensure_on_disk(state, video_uuid, video_extension)
        .await
        .map_err(AppError::Internal)?;
    let ensure_on_disk_ms = stage_started.elapsed().as_millis() as u64;

    let clip_path = paths::template_clip_path(&state.config.video_dir, &template_id);
    let thumb_path = paths::template_thumbnail_path(&state.config.video_dir, &template_id);
    let filmstrip_path = paths::template_filmstrip_path(&state.config.video_dir, &template_id);

    let stage_started = std::time::Instant::now();
    ffmpeg::trim_video(
        &source_path,
        &clip_path,
        payload.gif_range_start,
        payload.gif_range_end - payload.gif_range_start,
        payload.width,
        payload.height,
    )
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to clip template video: {e}")))?;
    let trim_ms = stage_started.elapsed().as_millis() as u64;

    // Seeking to 0.0 on the just-produced clip is the "first frame of the
    // trimmed clip" §4 asks for.
    let stage_started = std::time::Instant::now();
    ffmpeg::generate_thumbnail(&clip_path, &thumb_path, 0.0)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to generate template thumbnail: {e}")))?;
    let thumbnail_ms = stage_started.elapsed().as_millis() as u64;

    // Generated from the already-trimmed clip (not the source video), so
    // this only ever spans the template's own range — fixes the "still
    // shows the full-length film strip" gap using a template never had
    // its own sprite at all before this.
    let filmstrip_layout = compute_filmstrip_layout(
        payload.gif_range_end - payload.gif_range_start,
        payload.width,
        payload.height,
    );
    let stage_started = std::time::Instant::now();
    ffmpeg::generate_filmstrip_sprite(&clip_path, &filmstrip_path, &filmstrip_layout)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to generate template filmstrip: {e}")))?;
    let filmstrip_ms = stage_started.elapsed().as_millis() as u64;

    let stage_started = std::time::Instant::now();
    db::upsert_template(
        &state.pool,
        &template_id.to_string(),
        video_id,
        owner_id,
        payload,
        &Utc::now().to_rfc3339(),
    )
    .await?;
    let db_upsert_ms = stage_started.elapsed().as_millis() as u64;

    tracing::info!(
        video_id = %video_id,
        template_id = %template_id,
        ensure_on_disk_ms,
        trim_ms,
        thumbnail_ms,
        filmstrip_ms,
        db_upsert_ms,
        total_ms = ensure_on_disk_ms + trim_ms + thumbnail_ms + filmstrip_ms + db_upsert_ms,
        "save_template stage timings"
    );

    Ok(())
}

/// SPEC.md §12: `DELETE /api/videos/{id}/template` — allows the video to
/// be deleted afterwards.
pub async fn delete_template(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<StatusCode, AppError> {
    load_video(&state, &id, &user.id).await?;
    let template_id = db::get_template_id(&state.pool, &id).await?;
    let deleted = db::delete_template(&state.pool, &id).await?;
    if !deleted {
        return Err(AppError::NotFound);
    }

    if let Some(template_id) = template_id.and_then(|t| Uuid::parse_str(&t).ok()) {
        let clip_path = paths::template_clip_path(&state.config.video_dir, &template_id);
        let thumb_path = paths::template_thumbnail_path(&state.config.video_dir, &template_id);
        let filmstrip_path = paths::template_filmstrip_path(&state.config.video_dir, &template_id);
        for path in [clip_path, thumb_path, filmstrip_path] {
            if let Err(err) = tokio::fs::remove_file(&path).await
                && err.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(path = %path.display(), error = %err, "failed to remove file for deleted template");
            }
        }
    }

    Ok(StatusCode::NO_CONTENT)
}
