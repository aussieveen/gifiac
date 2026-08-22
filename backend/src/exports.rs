//! Orchestrates one export job: burns captions into the source clip and
//! produces GIF + MP4 + WebM (SPEC.md §6), uploads all three to R2, and
//! records the result as a `gifs` row. Runs as a detached background task
//! kicked off by `POST /api/exports`; progress is broadcast over
//! [`ExportEvent`]s for `GET /api/exports/{id}/progress` (SSE) to relay.

use chrono::Utc;
use serde::Serialize;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::ass::generate_ass;
use crate::ffmpeg::export as ffmpeg_export;
use crate::models::{ExportRequest, Gif, NewGif, Video};
use crate::state::AppState;
use crate::{db, paths};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ExportEvent {
    Progress { stage: &'static str, percent: u8 },
    Complete { gif: Gif },
    Failed { message: String },
}

/// Runs the full pipeline and broadcasts its outcome. Never returns an
/// `Err` itself — failures are reported as an `ExportEvent::Failed` so the
/// only way a caller learns the outcome is via the event stream (matching
/// how the SSE endpoint is the sole way a client observes this job).
pub async fn run_export_job(
    state: &AppState,
    export_id: Uuid,
    video: Video,
    request: ExportRequest,
    events: broadcast::Sender<ExportEvent>,
) {
    let send = |event: ExportEvent| {
        let _ = events.send(event);
    };

    match run_pipeline(state, export_id, &video, &request, &send).await {
        Ok(gif) => send(ExportEvent::Complete { gif }),
        Err(err) => {
            tracing::error!(export_id = %export_id, error = ?err, "export job failed");
            send(ExportEvent::Failed {
                message: err.to_string(),
            });
        }
    }
}

async fn run_pipeline(
    state: &AppState,
    export_id: Uuid,
    video: &Video,
    request: &ExportRequest,
    send: &impl Fn(ExportEvent),
) -> anyhow::Result<Gif> {
    let clip_duration = request.gif_range_end - request.gif_range_start;
    let video_uuid = Uuid::parse_str(&video.id)?;
    let video_path = paths::video_path(&state.config.video_dir, &video_uuid, &video.extension);

    let tmp_dir = tempfile::tempdir()?;
    let ass_path = tmp_dir.path().join("captions.ass");
    let palette_path = tmp_dir.path().join("palette.png");
    let gif_path = tmp_dir.path().join("out.gif");
    let mp4_path = tmp_dir.path().join("out.mp4");
    let webm_path = tmp_dir.path().join("out.webm");

    let ass = generate_ass(
        &request.captions,
        request.gif_range_start,
        request.gif_range_end,
        video.width,
        video.height,
    );
    tokio::fs::write(&ass_path, ass).await?;

    let clip = ffmpeg_export::ClipSource {
        video_path: &video_path,
        ass_path: &ass_path,
        range_start: request.gif_range_start,
        clip_duration,
    };

    ffmpeg_export::generate_palette(clip, &palette_path, |percent| {
        send(ExportEvent::Progress {
            stage: "palette_gen",
            percent,
        })
    })
    .await?;

    ffmpeg_export::encode_gif(clip, &palette_path, &gif_path, |percent| {
        send(ExportEvent::Progress {
            stage: "encoding_gif",
            percent,
        })
    })
    .await?;

    ffmpeg_export::encode_mp4(clip, &mp4_path, |percent| {
        send(ExportEvent::Progress {
            stage: "encoding_mp4",
            percent,
        })
    })
    .await?;

    ffmpeg_export::encode_webm(clip, &webm_path, |percent| {
        send(ExportEvent::Progress {
            stage: "encoding_webm",
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
    // stages) — just an even split across however many files this export
    // uploads, so a future 4th output format doesn't need its own
    // hand-picked percent literal.
    let uploads = [
        (
            paths::gif_object_key(&export_id),
            gif_path.as_path(),
            "image/gif",
        ),
        (
            paths::mp4_object_key(&export_id),
            mp4_path.as_path(),
            "video/mp4",
        ),
        (
            paths::webm_object_key(&export_id),
            webm_path.as_path(),
            "video/webm",
        ),
    ];
    let total = uploads.len();
    for (i, (key, path, content_type)) in uploads.iter().enumerate() {
        send(ExportEvent::Progress {
            stage: "uploading",
            percent: (i * 100 / total) as u8,
        });
        state.storage.upload_file(key, path, content_type).await?;
    }
    send(ExportEvent::Progress {
        stage: "uploading",
        percent: 100,
    });

    let caption_text = request
        .captions
        .iter()
        .map(|c| c.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let new_gif = NewGif {
        id: export_id.to_string(),
        video_id: Some(video.id.clone()),
        name: request.name.clone(),
        caption_text,
        captions_json: Some(serde_json::to_string(&request.captions)?),
        gif_range_start: request.gif_range_start,
        gif_range_end: request.gif_range_end,
        width: probe.width,
        height: probe.height,
    };
    let gif = db::insert_gif(&state.pool, &new_gif, &Utc::now().to_rfc3339()).await?;

    Ok(gif)
    // `tmp_dir` drops here, deleting the local ass/palette/gif/mp4/webm
    // scratch files — R2 is the only persistent home for the outputs
    // (SPEC.md §9).
}
