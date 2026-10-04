//! The export side of the Lambda migration (wayfinder gifiac#32): ffmpeg
//! encoding itself now runs in the export Lambda (`bin/export_lambda.rs`),
//! one invocation per format (gif/mp4/webm). This module holds what's
//! left on the backend — the SSE event shape relayed from the Lambda's
//! callbacks (`routes::internal::export_callback`), the terminal-state
//! rules those callbacks and the stuck-job sweep both need, and
//! `finalize_gif` and `cleanup_after_all_formats`, which split what the
//! old in-process pipeline used to do in one step after its ffmpeg calls
//! returned: building the `gifs` row and handling the "save as template"
//! checkbox happen as soon as gif alone is done (gif is the only
//! shareable output today, gifiac#36), while cleaning up the source video
//! still waits for mp4/webm too, since the export Lambda needs it present
//! until then.
//!
//! `transcode_and_upload` is the one piece of the pre-Lambda pipeline
//! that's *not* going away — bulk import (SPEC.md §7,
//! `routes::gifs::import_gifs`) is out of this map's scope and still runs
//! ffmpeg in-process on the backend.

use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

use crate::models::{ExportFormat, ExportJob, ExportJobContext, Gif, NewGif};
use crate::state::AppState;
use crate::{db, paths};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ExportEvent {
    Progress { format: ExportFormat, percent: u8 },
    FormatDone { format: ExportFormat },
    FormatFailed { format: ExportFormat, message: String },
    /// The whole job succeeded — at minimum the gif format, which is
    /// load-bearing (gifiac#36).
    Complete { gif: Box<Gif> },
    /// The whole job failed — gif failed or timed out, regardless of
    /// mp4/webm's own outcome (gifiac#36: "gif failure fails the whole
    /// export job even if mp4/webm succeeded").
    Failed { message: String },
}

pub(crate) fn is_terminal_status(status: &str) -> bool {
    matches!(status, "done" | "failed" | "timed_out")
}

/// A job is terminal once every format has reached a terminal status —
/// what the callback handler and the stuck-job sweep both check before
/// deciding the job's overall outcome.
pub fn export_job_is_terminal(job: &ExportJob) -> bool {
    is_terminal_status(&job.gif_status) && is_terminal_status(&job.mp4_status) && is_terminal_status(&job.webm_status)
}

/// gif is the only shareable output today (gifiac#36) — its failure (or
/// timeout) fails the whole job even if mp4/webm succeeded. mp4/webm
/// failing on their own doesn't fail the job: `finalize_gif` still builds
/// a `gifs` row from gif's output alone.
pub fn export_job_failed(job: &ExportJob) -> bool {
    matches!(job.gif_status.as_str(), "failed" | "timed_out")
}

/// Builds the `gifs` row (plus the "save as template" checkbox, for a
/// video export) as soon as gif's own format status is terminal and
/// succeeded — independent of mp4/webm, which may still be encoding (gif
/// is the only shareable output today, gifiac#36, so nothing else needs to
/// finish first). Idempotent: if the row already exists — e.g. this is
/// called a second time from the all-formats-terminal path, or the stuck-
/// job sweep races a Lambda callback — it's returned as-is rather than
/// inserted again.
pub async fn finalize_gif(state: &AppState, job: &ExportJob) -> anyhow::Result<Gif> {
    if let Some(gif) = db::get_gif_unscoped(&state.pool, &job.id).await? {
        return Ok(gif);
    }

    let export_id = Uuid::parse_str(&job.id)?;
    let context: ExportJobContext = serde_json::from_str(&job.request_json)?;
    let (gif_width, gif_height) = (
        job.gif_width.ok_or_else(|| anyhow::anyhow!("export job {} terminal without gif dimensions", job.id))?,
        job.gif_height.ok_or_else(|| anyhow::anyhow!("export job {} terminal without gif dimensions", job.id))?,
    );

    match context {
        ExportJobContext::Video { video_id, owner_id, request } => {
            finalize_video_gif(state, export_id, &video_id, &owner_id, &request, gif_width, gif_height).await
        }
        ExportJobContext::Template { template_id, owner_id, request } => {
            finalize_template_export(state, export_id, &template_id, &owner_id, &request, gif_width, gif_height).await
        }
    }
}

/// Deletes the source video once *every* format has reached a terminal
/// state, provided it wasn't saved as a template — this must stay gated on
/// all three formats (not just gif), since the export Lambda still needs
/// the source video present to encode mp4/webm. No-op for a template
/// export, which has no source video of its own.
pub async fn cleanup_after_all_formats(state: &AppState, job: &ExportJob) -> anyhow::Result<()> {
    let context: ExportJobContext = serde_json::from_str(&job.request_json)?;
    let ExportJobContext::Video { video_id, owner_id, .. } = context else {
        return Ok(());
    };

    // A video that was never turned into a template is scratch space —
    // see `routes::videos::delete_video_and_its_assets`'s call site
    // comment for the full reasoning (unchanged from the pre-Lambda
    // pipeline).
    if db::get_template_id(&state.pool, &video_id).await?.is_none()
        && let Err(err) = crate::routes::videos::delete_video_and_its_assets(state, &video_id, &owner_id).await
    {
        tracing::warn!(video_id = %video_id, error = ?err, "failed to clean up source video after export");
    }
    Ok(())
}

/// Reacts to gif's own format status having just become terminal: on
/// success, finalizes the `gifs` row and broadcasts `Complete`; on
/// failure, broadcasts `Failed` (gif failing fails the whole job
/// regardless of mp4/webm's own outcome, gifiac#36). Either way, the job's
/// broadcast channel is torn down here — once gif is settled, nothing else
/// the frontend is waiting on remains pending.
pub async fn handle_gif_terminal(state: &AppState, job: &ExportJob, job_uuid: Uuid) {
    let tx = state.export_jobs.lock().unwrap().remove(&job_uuid);
    if export_job_failed(job) {
        if let Some(tx) = &tx {
            let _ = tx.send(ExportEvent::Failed {
                message: job.gif_error.clone().unwrap_or_else(|| "export failed".to_string()),
            });
        }
        return;
    }
    match finalize_gif(state, job).await {
        Ok(gif) => {
            if let Some(tx) = &tx {
                let _ = tx.send(ExportEvent::Complete { gif: Box::new(gif) });
            }
        }
        Err(err) => tracing::error!(job_id = %job.id, error = ?err, "failed to finalize gif"),
    }
}

async fn finalize_video_gif(
    state: &AppState,
    export_id: Uuid,
    video_id: &str,
    owner_id: &str,
    request: &crate::models::ExportRequest,
    gif_width: i64,
    gif_height: i64,
) -> anyhow::Result<Gif> {
    let video = db::get_video(&state.pool, video_id, owner_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("video {video_id} missing at export finalize time"))?;
    let video_uuid = Uuid::parse_str(&video.id)?;

    let caption_text = request.captions.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" ");
    let new_gif = NewGif {
        id: export_id.to_string(),
        video_id: Some(video.id.clone()),
        name: request.name.clone(),
        caption_text,
        captions_json: Some(serde_json::to_string(&request.captions)?),
        gif_range_start: Some(request.gif_range_start),
        gif_range_end: Some(request.gif_range_end),
        width: Some(gif_width),
        height: Some(gif_height),
        external_url: None,
        user_id: owner_id.to_string(),
        template_id: None,
    };
    let mut gif = db::insert_gif(&state.pool, &new_gif, &Utc::now().to_rfc3339()).await?;

    // SPEC.md §12's "Create template" checkbox — see
    // `ExportRequest::save_as_template`'s doc comment for why this must
    // happen before the cleanup below, in the same job.
    if request.save_as_template
        && let Some(template_name) = request.template_name.as_deref().filter(|n| !n.is_empty())
    {
        let (output_width, output_height) = crate::scale::scaled_dimensions(
            video.width.ok_or_else(|| anyhow::anyhow!("video {video_id} has no probed dimensions"))?,
            video.height.ok_or_else(|| anyhow::anyhow!("video {video_id} has no probed dimensions"))?,
        );
        let template_payload = crate::models::TemplatePayload {
            captions: request.captions.clone(),
            gif_range_start: request.gif_range_start,
            gif_range_end: request.gif_range_end,
            width: output_width,
            height: output_height,
        };
        if let Err(err) = crate::routes::videos::save_template(
            state,
            &video_uuid,
            &video.id,
            &video.extension,
            owner_id,
            template_name,
            request.template_is_public,
            &template_payload,
        )
        .await
        {
            tracing::warn!(video_id = %video.id, error = ?err, "failed to save template requested alongside export");
        } else if let Some(template_id) = db::get_template_id(&state.pool, &video.id).await? {
            db::set_gif_template_id(&state.pool, &gif.id, &template_id).await?;
            gif.template_id = Some(template_id);
        }
    }

    Ok(gif)
}

async fn finalize_template_export(
    state: &AppState,
    export_id: Uuid,
    template_id: &str,
    owner_id: &str,
    request: &crate::models::TemplateExportRequest,
    gif_width: i64,
    gif_height: i64,
) -> anyhow::Result<Gif> {
    let template = db::get_template_for_use(&state.pool, template_id, owner_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("template {template_id} missing at export finalize time"))?;
    let payload: crate::models::TemplatePayload = serde_json::from_str(&template.payload_json)?;
    let clip_duration = payload.gif_range_end - payload.gif_range_start;

    let caption_text = request.captions.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" ");
    let new_gif = NewGif {
        id: export_id.to_string(),
        video_id: None,
        name: request.name.clone(),
        caption_text,
        captions_json: Some(serde_json::to_string(&request.captions)?),
        gif_range_start: Some(0.0),
        gif_range_end: Some(clip_duration),
        width: Some(gif_width),
        height: Some(gif_height),
        external_url: None,
        user_id: owner_id.to_string(),
        template_id: Some(template.id.clone()),
    };
    let gif = db::insert_gif(&state.pool, &new_gif, &Utc::now().to_rfc3339()).await?;
    Ok(gif)
}

/// The R2 object keys a `transcode_and_upload` run produced, plus the
/// output GIF's actual post-scale dimensions — everything a caller needs
/// to build its own `NewGif` row. Still used directly by bulk import
/// (SPEC.md §7, `routes::gifs::import_gifs`) — unlike the captioned
/// export flow above, that one path stays running in-process on the
/// backend; it's out of this map's scope.
pub struct TranscodeResult {
    pub width: i64,
    pub height: i64,
}

pub async fn transcode_and_upload(
    state: &AppState,
    id: Uuid,
    video_path: &std::path::Path,
    ass_content: &str,
    range_start: f64,
    clip_duration: f64,
    send: &impl Fn(ExportEvent),
) -> anyhow::Result<TranscodeResult> {
    let tmp_dir = tempfile::tempdir()?;
    let ass_path = tmp_dir.path().join("captions.ass");
    let palette_path = tmp_dir.path().join("palette.png");
    let gif_path = tmp_dir.path().join("out.gif");
    let mp4_path = tmp_dir.path().join("out.mp4");
    let webm_path = tmp_dir.path().join("out.webm");
    tokio::fs::write(&ass_path, ass_content).await?;

    let clip = crate::ffmpeg::export::ClipSource {
        video_path,
        ass_path: &ass_path,
        range_start,
        clip_duration,
    };

    crate::ffmpeg::export::generate_palette(clip, &palette_path, |percent| {
        send(ExportEvent::Progress {
            format: ExportFormat::Gif,
            percent,
        })
    })
    .await?;

    crate::ffmpeg::export::encode_gif(clip, &palette_path, &gif_path, |percent| {
        send(ExportEvent::Progress {
            format: ExportFormat::Gif,
            percent,
        })
    })
    .await?;

    crate::ffmpeg::export::encode_mp4(clip, &mp4_path, |percent| {
        send(ExportEvent::Progress {
            format: ExportFormat::Mp4,
            percent,
        })
    })
    .await?;

    crate::ffmpeg::export::encode_webm(clip, &webm_path, |percent| {
        send(ExportEvent::Progress {
            format: ExportFormat::Webm,
            percent,
        })
    })
    .await?;

    // The GIF's actual post-scale dimensions (for the `gifs` row) come
    // from probing the file FFmpeg just produced, rather than
    // reimplementing the scale filter's rounding rules a second time in
    // Rust — one source of truth, and it can't drift from what the filter
    // actually did.
    let probe_path = gif_path.clone();
    let probe =
        tokio::task::spawn_blocking(move || crate::ffmpeg::probe_video(&probe_path)).await??;

    // Not driven off real byte-transfer progress (unlike the FFmpeg
    // stages) — just an even split across however many files this upload
    // covers, so a future 4th output format doesn't need its own
    // hand-picked percent literal.
    let uploads = [
        (paths::gif_object_key(&id), gif_path.as_path(), "image/gif"),
        (paths::mp4_object_key(&id), mp4_path.as_path(), "video/mp4"),
        (
            paths::webm_object_key(&id),
            webm_path.as_path(),
            "video/webm",
        ),
    ];
    for (key, path, content_type) in uploads.iter() {
        state.storage.upload_file(key, path, content_type).await?;
    }

    Ok(TranscodeResult {
        width: probe.width,
        height: probe.height,
    })
    // `tmp_dir` drops here, deleting the local ass/palette/gif/mp4/webm
    // scratch files — R2 is the only persistent home for the outputs
    // (SPEC.md §9).
}
