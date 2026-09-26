//! Async pipeline that gives a linked gif (SPEC.md §13 — hotlinked, no
//! mp4/webm of its own) a static poster-frame thumbnail: the only way to
//! show a "paused" preview for something that's otherwise just a raw
//! `<img>` pointed at a third-party URL (see the "disable gif autoplay"
//! preference). Shared by the background job `routes::gifs::link_gif`
//! spawns for a freshly linked gif and the one-off `backfill_thumbnails`
//! CLI for gifs linked before this pipeline existed.

use anyhow::{Context, Result};
use sqlx::PgPool;
use uuid::Uuid;

use crate::storage::Storage;
use crate::{db, ffmpeg, paths};

/// Downloads `external_url`, extracts a midpoint frame, uploads it, and
/// records the outcome in `gifs.thumbnail_status`. A fetch/probe/encode
/// failure is recorded as `failed` rather than propagated — a caller
/// looping over many gifs (the backfill CLI) doesn't need its own per-gif
/// error handling; only a genuine local I/O or database failure bubbles
/// up as `Err`. Returns whether it succeeded (`true` = `ready`, `false` =
/// `failed`) so a caller can report accurately without re-querying.
pub async fn generate_and_store(
    pool: &PgPool,
    storage: &Storage,
    http_client: &reqwest::Client,
    gif_id: &str,
    external_url: &str,
) -> Result<bool> {
    match try_generate(storage, http_client, gif_id, external_url).await {
        Ok(()) => {
            db::set_thumbnail_status(pool, gif_id, "ready").await?;
            Ok(true)
        }
        Err(err) => {
            tracing::warn!(gif_id, error = ?err, "failed to generate external gif thumbnail");
            db::set_thumbnail_status(pool, gif_id, "failed").await?;
            Ok(false)
        }
    }
}

async fn try_generate(storage: &Storage, http_client: &reqwest::Client, gif_id: &str, external_url: &str) -> Result<()> {
    let uuid = Uuid::parse_str(gif_id).context("gif id is not a valid UUID")?;
    let tmp_dir = tempfile::tempdir()?;
    let source_path = tmp_dir.path().join("source");
    let thumb_path = tmp_dir.path().join("thumb.jpg");

    let bytes = http_client
        .get(external_url)
        .send()
        .await
        .context("requesting external gif")?
        .error_for_status()
        .context("external gif returned an error status")?
        .bytes()
        .await
        .context("reading external gif body")?;
    tokio::fs::write(&source_path, &bytes)
        .await
        .context("writing downloaded gif to disk")?;

    // Animated WebP never reaches ffmpeg directly — the version this app
    // actually ships (see ffmpeg/webp.rs's doc comment) can't decode it at
    // all, regardless of seeking. `webpmux` (a separate tool, not part of
    // ffmpeg) extracts a single frame first; only that clean, unwrapped
    // frame goes to ffmpeg afterward, same as any other static image. A
    // *static* (single-frame) WebP never had ANIM/ANMF chunks to begin
    // with — ffmpeg's ordinary decoder already handles it directly, and
    // `webpmux -get frame` actually errors if asked to extract a "frame"
    // from one (confirmed: `WEBP_MUX_NOT_FOUND`), so that case skips
    // straight to the plain-decode path below instead.
    let webp_frame_count = if ffmpeg::looks_like_webp(&bytes) {
        Some(
            ffmpeg::webp_frame_count(&source_path)
                .await
                .context("reading webp frame count")?,
        )
    } else {
        None
    };

    if let Some(frame_count) = webp_frame_count.filter(|&n| n > 1) {
        let frame_path = tmp_dir.path().join("frame.webp");
        ffmpeg::extract_webp_frame(&source_path, frame_count / 2 + 1, &frame_path)
            .await
            .context("extracting webp frame")?;
        ffmpeg::generate_midpoint_thumbnail(&frame_path, &thumb_path, 0.0)
            .await
            .context("decoding extracted webp frame")?;
    } else if webp_frame_count.is_some() {
        // A static WebP — no duration/seeking is meaningful for a still
        // image, and this is also exactly the "unknown duration" case
        // `generate_midpoint_thumbnail` already handles by skipping `-ss`.
        ffmpeg::generate_midpoint_thumbnail(&source_path, &thumb_path, 0.0)
            .await
            .context("decoding static webp")?;
    } else {
        let probe_path = source_path.clone();
        let probe = tokio::task::spawn_blocking(move || ffmpeg::probe_video(&probe_path))
            .await
            .context("probe task panicked")?
            .context("probing downloaded gif")?;

        ffmpeg::generate_midpoint_thumbnail(&source_path, &thumb_path, probe.duration_seconds)
            .await
            .context("extracting thumbnail frame")?;
    }

    storage
        .upload_file(&paths::thumbnail_object_key(&uuid), &thumb_path, "image/jpeg")
        .await
        .context("uploading thumbnail")?;

    Ok(())
}
