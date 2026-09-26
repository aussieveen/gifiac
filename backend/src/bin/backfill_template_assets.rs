//! One-off backfill (see `terraform/s3.tf`'s `template_assets` bucket,
//! SPEC-CLOUD.md §10) for templates saved before that bucket existed —
//! anything saved by `PUT /api/videos/{id}/template` since already backs
//! itself up automatically, so this only ever needs a single run against
//! production.
//!
//! Safe to re-run: uploads are plain overwrites (S3 `PutObject`), and a
//! template whose local files are already gone (this same EC2 instance's
//! disk, wiped or replaced since it was saved) is skipped with a warning
//! rather than failing the whole run — there's nothing left to back up
//! for it, and that's a pre-existing gap this script can't retroactively
//! close, not something wrong with the script itself.

use std::path::Path;
use std::process::ExitCode;

use anyhow::Result;
use gifiac_backend::config::Config;
use gifiac_backend::{db, paths, storage};
use uuid::Uuid;

async fn run() -> Result<bool> {
    let config = Config::from_env();
    let pool = db::create_pool(&config.database_url).await?;

    let template_assets = storage::TemplateAssetsConfig::from_env()?;
    let storage = storage::Storage::new_for_template_assets_bucket(&template_assets).await;

    let templates = db::list_all_templates(&pool).await?;
    println!("found {} template(s) in the database", templates.len());

    let mut backed_up = 0;
    let mut skipped_missing = 0;
    let mut failed = 0;
    for template in &templates {
        let Ok(template_id) = Uuid::parse_str(&template.id) else {
            eprintln!("template {} has a non-UUID id, skipping", template.id);
            failed += 1;
            continue;
        };

        let clip_path = paths::template_clip_path(&config.video_dir, &template_id);
        if !tokio::fs::try_exists(&clip_path).await.unwrap_or(false) {
            println!("template {template_id}: no local clip file, skipping (already gone)");
            skipped_missing += 1;
            continue;
        }
        let thumb_path = paths::template_thumbnail_path(&config.video_dir, &template_id);
        let filmstrip_path = paths::template_filmstrip_path(&config.video_dir, &template_id);

        print!("backing up template {template_id}... ");
        match back_up_one(&storage, &template_id, &clip_path, &thumb_path, &filmstrip_path).await {
            Ok(()) => {
                println!("ok");
                backed_up += 1;
            }
            Err(err) => {
                println!("error: {err:#}");
                failed += 1;
            }
        }
    }

    println!("done: {backed_up} backed up, {skipped_missing} skipped (no local files), {failed} failed");
    Ok(failed > 0)
}

async fn back_up_one(
    storage: &storage::Storage,
    template_id: &Uuid,
    clip_path: &Path,
    thumb_path: &Path,
    filmstrip_path: &Path,
) -> Result<()> {
    storage
        .upload_file(&paths::template_clip_object_key(template_id), clip_path, "video/mp4")
        .await?;
    if tokio::fs::try_exists(thumb_path).await.unwrap_or(false) {
        storage
            .upload_file(&paths::template_thumbnail_object_key(template_id), thumb_path, "image/jpeg")
            .await?;
    }
    if tokio::fs::try_exists(filmstrip_path).await.unwrap_or(false) {
        storage
            .upload_file(
                &paths::template_filmstrip_object_key(template_id),
                filmstrip_path,
                "image/jpeg",
            )
            .await?;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt::init();
    match run().await {
        Ok(had_failures) => {
            if had_failures {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(err) => {
            eprintln!("backfill aborted: {err:#}");
            ExitCode::FAILURE
        }
    }
}
