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

    let probe_path = source_path.clone();
    let probe = tokio::task::spawn_blocking(move || ffmpeg::probe_video(&probe_path))
        .await
        .context("probe task panicked")?
        .context("probing downloaded gif")?;

    ffmpeg::generate_midpoint_thumbnail(&source_path, &thumb_path, probe.duration_seconds)
        .await
        .context("extracting thumbnail frame")?;

    storage
        .upload_file(&paths::thumbnail_object_key(&uuid), &thumb_path, "image/jpeg")
        .await
        .context("uploading thumbnail")?;

    Ok(())
}
