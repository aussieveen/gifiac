//! Lazy local cache over the private S3 bucket source videos live in
//! (SPEC-CLOUD.md §6). Local disk is "working scratch space for
//! processing, not the persistence layer": uploading pushes to S3 and
//! deletes the local copy immediately (see `routes::videos::upload_video`),
//! so every later read that needs the actual video bytes goes through
//! [`ensure_on_disk`], which re-downloads on a cache miss and otherwise
//! never proactively evicts what it fetches.

use std::path::PathBuf;
use std::time::Instant;

use anyhow::Result;
use uuid::Uuid;

use crate::{paths, state::AppState};

pub async fn ensure_on_disk(state: &AppState, id: &Uuid, extension: &str) -> Result<PathBuf> {
    let path = paths::video_path(&state.config.video_dir, id, extension);
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Ok(path);
    }
    let key = paths::video_object_key(id, extension);
    let started = Instant::now();
    state.source_storage.download_file(&key, &path).await?;
    tracing::info!(
        video_id = %id,
        key = %key,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "source_video cache miss: downloaded from object storage"
    );
    Ok(path)
}
