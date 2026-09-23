//! One-time migration of Simon's existing single-user archive (SQLite
//! metadata + already-in-place R2 outputs) into the new multi-tenant
//! Postgres schema, as his account's content (SPEC-CLOUD.md §12 — a hard
//! requirement, not optional).
//!
//! Scope, matching §12 exactly:
//! - `videos`/`gifs` rows copy across as-is (ids and timestamps
//!   preserved), tagged with `--user-id`.
//! - R2 GIF/MP4/WebM outputs are left untouched — both the old and new
//!   systems derive the same object keys from a gif's own id
//!   (`gifs/{id}.gif`, `clips/{id}.mp4`, `clips/{id}.webm`), so as long as
//!   the new deploy points at the same R2 bucket, there's nothing to copy.
//! - Old `video_templates` rows (an offset into the source video) are
//!   *not* copied as-is — each one is actually re-clipped with ffmpeg into
//!   the new self-contained `templates` asset shape (SPEC-CLOUD.md §4),
//!   which is why this needs the old video files on disk, not just the
//!   old database.
//!
//! Deliberately out of scope: migrating raw source videos into the new S3
//! bucket. They're ephemeral processing scratch space in the new system
//! (7-day lifecycle, SPEC-CLOUD.md §6) — old videos aren't needed there
//! for anything except feeding ffmpeg during this one run.
//!
//! Safe to re-run: every row is skipped if already present (checked by id
//! for videos/gifs, by video_id for templates — matching `upsert_template`
//! itself being an upsert), so an interrupted run can just be re-invoked.
//!
//! See MIGRATION.md for the runbook (where the old archive needs to live,
//! how to find `--user-id`, and the manual RDS snapshot to take first).

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use gifiac_backend::config::Config;
use gifiac_backend::filmstrip_layout::compute_filmstrip_layout;
use gifiac_backend::models::{NewGif, NewVideo, TemplatePayload};
use gifiac_backend::{db, ffmpeg, paths};
use rusqlite::Connection;
use sqlx::PgPool;
use uuid::Uuid;

struct Args {
    old_sqlite: PathBuf,
    old_video_dir: PathBuf,
    user_id: String,
}

fn parse_args() -> Result<Args> {
    let mut old_sqlite = None;
    let mut old_video_dir = None;
    let mut user_id = None;

    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .with_context(|| format!("{flag} requires a value"))?;
        match flag.as_str() {
            "--old-sqlite" => old_sqlite = Some(PathBuf::from(value)),
            "--old-video-dir" => old_video_dir = Some(PathBuf::from(value)),
            "--user-id" => user_id = Some(value),
            other => bail!("unknown flag {other} (expected --old-sqlite, --old-video-dir, --user-id)"),
        }
    }

    Ok(Args {
        old_sqlite: old_sqlite.context("--old-sqlite <path> is required")?,
        old_video_dir: old_video_dir.context("--old-video-dir <path> is required")?,
        user_id: user_id.context("--user-id <uuid> is required")?,
    })
}

struct OldVideo {
    id: String,
    original_filename: String,
    extension: String,
    file_size_bytes: i64,
    duration_seconds: f64,
    width: i64,
    height: i64,
    uploaded_at: String,
}

struct OldGif {
    id: String,
    video_id: Option<String>,
    name: String,
    caption_text: String,
    captions_json: Option<String>,
    gif_range_start: Option<f64>,
    gif_range_end: Option<f64>,
    width: Option<i64>,
    height: Option<i64>,
    external_url: Option<String>,
    created_at: String,
    is_one_off: bool,
}

struct OldTemplate {
    video_id: String,
    payload_json: String,
    saved_at: String,
}

fn read_old_archive(sqlite_path: &Path) -> Result<(Vec<OldVideo>, Vec<OldGif>, Vec<OldTemplate>)> {
    let conn = Connection::open(sqlite_path)
        .with_context(|| format!("opening old SQLite archive at {}", sqlite_path.display()))?;

    let mut stmt = conn.prepare(
        "SELECT id, original_filename, extension, file_size_bytes, duration_seconds, width, height, uploaded_at \
         FROM videos",
    )?;
    let videos = stmt
        .query_map([], |row| {
            Ok(OldVideo {
                id: row.get(0)?,
                original_filename: row.get(1)?,
                extension: row.get(2)?,
                file_size_bytes: row.get(3)?,
                duration_seconds: row.get(4)?,
                width: row.get(5)?,
                height: row.get(6)?,
                uploaded_at: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = conn.prepare(
        "SELECT id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, \
         external_url, created_at, is_one_off FROM gifs",
    )?;
    let gifs = stmt
        .query_map([], |row| {
            Ok(OldGif {
                id: row.get(0)?,
                video_id: row.get(1)?,
                name: row.get(2)?,
                caption_text: row.get(3)?,
                captions_json: row.get(4)?,
                gif_range_start: row.get(5)?,
                gif_range_end: row.get(6)?,
                width: row.get(7)?,
                height: row.get(8)?,
                external_url: row.get(9)?,
                created_at: row.get(10)?,
                is_one_off: row.get::<_, i64>(11)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = conn.prepare("SELECT video_id, payload_json, saved_at FROM video_templates")?;
    let templates = stmt
        .query_map([], |row| {
            Ok(OldTemplate {
                video_id: row.get(0)?,
                payload_json: row.get(1)?,
                saved_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok((videos, gifs, templates))
}

/// `table` is always one of the two literals below, never caller/row data
/// — safe from injection despite the match, which exists only so the SQL
/// stays a `&'static str` (sqlx statically requires that, not a runtime
/// safety check).
async fn row_exists(pool: &PgPool, table: &'static str, id: &str) -> Result<bool> {
    let sql = match table {
        "videos" => "SELECT 1 FROM videos WHERE id = $1",
        "gifs" => "SELECT 1 FROM gifs WHERE id = $1",
        "users" => "SELECT 1 FROM users WHERE id = $1",
        other => bail!("row_exists: unsupported table {other}"),
    };
    let exists: Option<i32> = sqlx::query_scalar(sql).bind(id).fetch_optional(pool).await?;
    Ok(exists.is_some())
}

/// Copies a video's already-generated thumbnail/filmstrip sprite, and its
/// raw file itself, over from the old archive, if present.
///
/// The thumbnail/filmstrip are self-contained, local-disk-only assets in
/// both the old and new systems (never in S3 — see paths.rs), so there's
/// nothing to regenerate, just to place at the new video_dir.
///
/// The raw video is different: normally it's meant to be ephemeral (S3,
/// 7-day TTL, SPEC-CLOUD.md §6) — but re-opening an *existing* template to
/// overwrite it, or the caption editor's live preview, both need the
/// original source video to actually be available, not just its already-
/// produced outputs. Placing it directly at the new system's local
/// video_dir (rather than uploading to S3, which would still only buy the
/// same 7-day window) is what makes `ensure_on_disk` find it without any
/// S3 round-trip — behaviorally identical to a normal cache hit, just
/// without ever having gone through S3 first. Same durability caveat as
/// the thumbnail/filmstrip above: local-disk-only, gone if the instance's
/// root volume ever is.
///
/// Tolerant of any of the three files being missing and safe to re-run
/// (skips a file that's already been copied). Returns whether anything was
/// actually copied.
async fn restore_video_assets(args: &Args, config: &Config, video: &OldVideo) -> Result<bool> {
    let id = Uuid::parse_str(&video.id)?;
    let mut copied_any = false;

    let old_thumb = paths::thumbnail_path(&args.old_video_dir, &id);
    let new_thumb = paths::thumbnail_path(&config.video_dir, &id);
    if tokio::fs::try_exists(&old_thumb).await.unwrap_or(false) && !tokio::fs::try_exists(&new_thumb).await.unwrap_or(false) {
        tokio::fs::copy(&old_thumb, &new_thumb)
            .await
            .with_context(|| format!("copying thumbnail for video {}", video.id))?;
        copied_any = true;
    }

    let old_filmstrip = paths::filmstrip_sprite_path(&args.old_video_dir, &id);
    let new_filmstrip = paths::filmstrip_sprite_path(&config.video_dir, &id);
    if tokio::fs::try_exists(&old_filmstrip).await.unwrap_or(false) && !tokio::fs::try_exists(&new_filmstrip).await.unwrap_or(false) {
        tokio::fs::copy(&old_filmstrip, &new_filmstrip)
            .await
            .with_context(|| format!("copying filmstrip for video {}", video.id))?;
        copied_any = true;
    }

    let old_video = paths::video_path(&args.old_video_dir, &id, &video.extension);
    let new_video = paths::video_path(&config.video_dir, &id, &video.extension);
    if tokio::fs::try_exists(&old_video).await.unwrap_or(false) && !tokio::fs::try_exists(&new_video).await.unwrap_or(false) {
        tokio::fs::copy(&old_video, &new_video)
            .await
            .with_context(|| format!("copying raw video file for video {}", video.id))?;
        copied_any = true;
    }

    Ok(copied_any)
}

async fn migrate_template(
    pool: &PgPool,
    config: &Config,
    args: &Args,
    template: &OldTemplate,
    old_videos: &[OldVideo],
) -> Result<()> {
    let source_video = old_videos
        .iter()
        .find(|v| v.id == template.video_id)
        .with_context(|| format!("template references unknown video {}", template.video_id))?;

    let payload: TemplatePayload = serde_json::from_str(&template.payload_json)
        .with_context(|| format!("parsing template payload for video {}", template.video_id))?;

    let source_uuid = Uuid::parse_str(&source_video.id)?;
    let source_path = paths::video_path(&args.old_video_dir, &source_uuid, &source_video.extension);
    if !source_path.exists() {
        bail!("source video file not found at {}", source_path.display());
    }

    // Fresh id — the old `video_templates` table has no id of its own
    // (`video_id` was its primary key), same as a normal `put_template`
    // save allocating one for a first-time save.
    let template_id = Uuid::new_v4();
    let clip_path = paths::template_clip_path(&config.video_dir, &template_id);
    let thumb_path = paths::template_thumbnail_path(&config.video_dir, &template_id);
    let filmstrip_path = paths::template_filmstrip_path(&config.video_dir, &template_id);

    ffmpeg::trim_video(
        &source_path,
        &clip_path,
        payload.gif_range_start,
        payload.gif_range_end - payload.gif_range_start,
    )
    .await
    .with_context(|| format!("clipping template video for {}", template.video_id))?;

    ffmpeg::generate_thumbnail(&clip_path, &thumb_path, 0.0)
        .await
        .context("generating template thumbnail")?;

    let filmstrip_layout = compute_filmstrip_layout(
        payload.gif_range_end - payload.gif_range_start,
        payload.width,
        payload.height,
    );
    ffmpeg::generate_filmstrip_sprite(&clip_path, &filmstrip_path, &filmstrip_layout)
        .await
        .context("generating template filmstrip")?;

    db::upsert_template(
        pool,
        &template_id.to_string(),
        &template.video_id,
        &args.user_id,
        &payload,
        &template.saved_at,
    )
    .await?;

    Ok(())
}

/// Backfills just the filmstrip for a template a previous run of this
/// script already fully migrated (row + clip + thumbnail), for a template
/// migrated before filmstrip generation existed at all. Reuses the
/// already-migrated clip file rather than re-clipping from the source
/// video, so it works even if the source video itself is long gone.
/// Returns whether it actually generated one.
async fn backfill_template_filmstrip(
    pool: &PgPool,
    config: &Config,
    video_id: &str,
    payload: &TemplatePayload,
) -> Result<bool> {
    let template_id_str = db::get_template_id(pool, video_id)
        .await?
        .with_context(|| format!("template row for video {video_id} vanished mid-migration"))?;
    let template_id = Uuid::parse_str(&template_id_str)?;

    let filmstrip_path = paths::template_filmstrip_path(&config.video_dir, &template_id);
    if tokio::fs::try_exists(&filmstrip_path).await.unwrap_or(false) {
        return Ok(false);
    }

    let clip_path = paths::template_clip_path(&config.video_dir, &template_id);
    if !tokio::fs::try_exists(&clip_path).await.unwrap_or(false) {
        bail!(
            "template clip missing at {} — can't backfill a filmstrip without it",
            clip_path.display()
        );
    }

    let layout = compute_filmstrip_layout(
        payload.gif_range_end - payload.gif_range_start,
        payload.width,
        payload.height,
    );
    ffmpeg::generate_filmstrip_sprite(&clip_path, &filmstrip_path, &layout)
        .await
        .context("generating template filmstrip")?;
    Ok(true)
}

/// Returns whether any row failed — callers use this to pick the process
/// exit code, since a partial failure shouldn't look like success but
/// also shouldn't discard everything that *did* migrate.
async fn run() -> Result<bool> {
    let args = parse_args()?;
    let config = Config::from_env();

    let (old_videos, old_gifs, old_templates) = read_old_archive(&args.old_sqlite)?;
    println!(
        "loaded {} videos, {} gifs, {} templates from {}",
        old_videos.len(),
        old_gifs.len(),
        old_templates.len(),
        args.old_sqlite.display()
    );

    let pool = db::create_pool(&config.database_url).await?;

    if !row_exists(&pool, "users", &args.user_id).await? {
        bail!(
            "no user with id {} exists yet — log into the new app once via Google \
             OAuth first so its account row exists, then pass that id here (see MIGRATION.md)",
            args.user_id
        );
    }

    let mut videos_migrated = 0;
    let mut assets_restored = 0;
    for video in &old_videos {
        if row_exists(&pool, "videos", &video.id).await? {
            // Row already migrated (e.g. a prior run) — still fall through
            // to the asset restore below, so re-running this script can
            // backfill thumbnails/filmstrips for videos it already copied
            // the row for, without needing --user-id logic to special-case
            // that.
        } else {
            db::insert_video(
                &pool,
                &NewVideo {
                    id: video.id.clone(),
                    original_filename: video.original_filename.clone(),
                    extension: video.extension.clone(),
                    file_size_bytes: video.file_size_bytes,
                    duration_seconds: video.duration_seconds,
                    width: video.width,
                    height: video.height,
                    user_id: args.user_id.clone(),
                },
                &video.uploaded_at,
            )
            .await
            .with_context(|| format!("inserting video {}", video.id))?;
            videos_migrated += 1;
        }

        if restore_video_assets(&args, &config, video).await? {
            assets_restored += 1;
        }
    }
    println!(
        "videos: {videos_migrated} inserted, {} already present",
        old_videos.len() - videos_migrated
    );
    println!(
        "video assets (raw file, thumbnail, filmstrip): restored for {assets_restored} of {} videos",
        old_videos.len()
    );

    let mut gifs_migrated = 0;
    for gif in &old_gifs {
        if row_exists(&pool, "gifs", &gif.id).await? {
            continue;
        }
        db::insert_gif(
            &pool,
            &NewGif {
                id: gif.id.clone(),
                video_id: gif.video_id.clone(),
                name: gif.name.clone(),
                caption_text: gif.caption_text.clone(),
                captions_json: gif.captions_json.clone(),
                gif_range_start: gif.gif_range_start,
                gif_range_end: gif.gif_range_end,
                width: gif.width,
                height: gif.height,
                external_url: gif.external_url.clone(),
                user_id: args.user_id.clone(),
            },
            &gif.created_at,
        )
        .await
        .with_context(|| format!("inserting gif {}", gif.id))?;
        if gif.is_one_off {
            db::set_gif_one_off(&pool, &gif.id, &args.user_id, true).await?;
        }
        gifs_migrated += 1;
    }
    println!(
        "gifs: {gifs_migrated} inserted, {} already present",
        old_gifs.len() - gifs_migrated
    );

    let mut templates_migrated = 0;
    let mut templates_failed = 0;
    let mut filmstrips_backfilled = 0;
    for template in &old_templates {
        if let Some(existing_payload) = db::get_template(&pool, &template.video_id).await? {
            // Already migrated by an earlier run — that run may predate
            // filmstrip generation entirely, so backfill just that rather
            // than skipping outright.
            match backfill_template_filmstrip(&pool, &config, &template.video_id, &existing_payload).await {
                Ok(true) => filmstrips_backfilled += 1,
                Ok(false) => {}
                Err(err) => eprintln!("template filmstrip backfill for video {} failed: {err:#}", template.video_id),
            }
            continue;
        }
        match migrate_template(&pool, &config, &args, template, &old_videos).await {
            Ok(()) => templates_migrated += 1,
            Err(err) => {
                eprintln!("template for video {} failed: {err:#}", template.video_id);
                templates_failed += 1;
            }
        }
    }
    println!(
        "templates: {templates_migrated} clipped, {templates_failed} failed, {} already present ({filmstrips_backfilled} filmstrips backfilled)",
        old_templates.len() - templates_migrated - templates_failed
    );

    Ok(templates_failed > 0)
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt::init();
    match run().await {
        Ok(had_failures) => {
            if had_failures {
                eprintln!("migration finished with failures — see above, safe to re-run once fixed");
                ExitCode::FAILURE
            } else {
                println!("migration complete");
                ExitCode::SUCCESS
            }
        }
        Err(err) => {
            eprintln!("migration aborted: {err:#}");
            ExitCode::FAILURE
        }
    }
}
