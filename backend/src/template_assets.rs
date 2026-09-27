//! Lazy local cache over the private template-assets S3 bucket a saved
//! template's clip/thumbnail/filmstrip are backed up to (SPEC-CLOUD.md
//! §10, see `routes::videos::save_template`). Same shape as
//! [`crate::source_video::ensure_on_disk`]: the three files are written to
//! local disk at save time, but that disk is just working scratch space —
//! on a cache miss (a fresh instance, or local disk that's since been
//! cleared) this re-downloads from the durable S3 copy instead.

use std::path::PathBuf;
use std::time::Instant;

use anyhow::Result;
use uuid::Uuid;

use crate::{paths, state::AppState};

#[derive(Debug, Clone, Copy)]
pub enum TemplateAssetKind {
    Clip,
    Thumbnail,
    Filmstrip,
}

impl TemplateAssetKind {
    fn local_path(self, video_dir: &std::path::Path, id: &Uuid) -> PathBuf {
        match self {
            TemplateAssetKind::Clip => paths::template_clip_path(video_dir, id),
            TemplateAssetKind::Thumbnail => paths::template_thumbnail_path(video_dir, id),
            TemplateAssetKind::Filmstrip => paths::template_filmstrip_path(video_dir, id),
        }
    }

    fn object_key(self, id: &Uuid) -> String {
        match self {
            TemplateAssetKind::Clip => paths::template_clip_object_key(id),
            TemplateAssetKind::Thumbnail => paths::template_thumbnail_object_key(id),
            TemplateAssetKind::Filmstrip => paths::template_filmstrip_object_key(id),
        }
    }
}

pub async fn ensure_on_disk(state: &AppState, id: &Uuid, kind: TemplateAssetKind) -> Result<PathBuf> {
    let path = kind.local_path(&state.config.video_dir, id);
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Ok(path);
    }
    let key = kind.object_key(id);
    let started = Instant::now();
    state.template_assets_storage.download_file(&key, &path).await?;
    tracing::info!(
        template_id = %id,
        key = %key,
        kind = ?kind,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "template_assets cache miss: downloaded from object storage"
    );
    Ok(path)
}
