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
use crate::models::{Caption, ExportRequest, Gif, NewGif, TemplatePayload, Video};
use crate::state::AppState;
use crate::{db, paths, source_video};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ExportEvent {
    Progress { stage: &'static str, percent: u8 },
    Complete { gif: Box<Gif> },
    Failed { message: String },
}

/// What an export renders from — resolved by the route handler before the
/// background job starts, so `run_pipeline` doesn't need its own
/// visibility/ownership logic (SPEC-CLOUD.md §4: a template-sourced export
/// has no `Video` row at all — the video is never shared, only the
/// template's own already-clipped media).
pub enum ExportSource {
    Video(Video),
    Template { id: String, payload: TemplatePayload },
}

/// SPEC-CLOUD.md §4: "the server silently normalizes away any
/// client-submitted change to a fixed caption's fields rather than
/// rejecting the request — it just applies the template's saved values for
/// those fields and proceeds." Matched by caption `id`; a submitted
/// caption with no matching *locked* template caption (new captions the
/// user added, or a changeable one) passes through unchanged.
///
/// A "use this template" export request works entirely in the template
/// clip's own 0-based coordinate space (`gif_range_start: 0`, every
/// caption's `start_time`/`end_time` pre-shifted by the frontend at load
/// time — see `CaptionEditor`'s template-mode initial state) — but
/// `template.captions`' own saved times are absolute, in the *original*
/// source video's timeline (the space they were authored in). The
/// replacement caption is shifted by the same `-template.gif_range_start`
/// so it lands in that same clip-relative space as everything else in the
/// request, instead of pointing at the wrong end of the clip (or entirely
/// outside it).
pub(crate) fn normalize_locked_captions(submitted: Vec<Caption>, template: &TemplatePayload) -> Vec<Caption> {
    let shift = template.gif_range_start;
    let shifted = |t: &Caption| Caption {
        start_time: t.start_time - shift,
        end_time: t.end_time - shift,
        ..t.clone()
    };

    let mut seen_locked_ids = std::collections::HashSet::new();
    let mut result: Vec<Caption> = submitted
        .into_iter()
        .map(|c| {
            template
                .captions
                .iter()
                .find(|t| t.id == c.id && t.locked)
                .map(|t| {
                    seen_locked_ids.insert(t.id.clone());
                    shifted(t)
                })
                .unwrap_or(c)
        })
        .collect();

    // Protecting a locked caption's *fields* isn't enough if the client
    // can just drop it from the request entirely — that's deletion, not
    // modification, but it's just as much a bypass of "immutable to
    // anyone but the creator." Force every locked caption to be present
    // regardless of what was actually submitted.
    for t in template.captions.iter().filter(|t| t.locked && !seen_locked_ids.contains(&t.id)) {
        result.push(shifted(t));
    }

    result
}

/// Runs the full pipeline and broadcasts its outcome. Never returns an
/// `Err` itself — failures are reported as an `ExportEvent::Failed` so the
/// only way a caller learns the outcome is via the event stream (matching
/// how the SSE endpoint is the sole way a client observes this job).
pub async fn run_export_job(
    state: &AppState,
    export_id: Uuid,
    source: ExportSource,
    request: ExportRequest,
    owner_id: &str,
    events: broadcast::Sender<ExportEvent>,
) {
    let send = |event: ExportEvent| {
        let _ = events.send(event);
    };

    match run_pipeline(state, export_id, &source, &request, owner_id, &send).await {
        Ok(gif) => send(ExportEvent::Complete { gif: Box::new(gif) }),
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
    source: &ExportSource,
    request: &ExportRequest,
    owner_id: &str,
    send: &impl Fn(ExportEvent),
) -> anyhow::Result<Gif> {
    let clip_duration = request.gif_range_end - request.gif_range_start;

    // The captions are burned in *after* the video is scaled down (see
    // captioned_scale_filter's doc comment), so the ASS file's
    // PlayResX/PlayResY — and thus caption font size and \pos() placement
    // — must be the scaled output size, not the source's native
    // resolution, to match what the frontend's live preview (built from
    // the same scaled_dimensions) shows. A template's clip is already
    // trimmed *and* scaled at save time (see `videos::put_template`), so
    // `payload.width`/`payload.height` already are that scaled target —
    // no re-derivation needed the way a fresh video source requires.
    let (media_path, output_width, output_height, video_id, video_extension, template_id) = match source {
        ExportSource::Video(video) => {
            let video_uuid = Uuid::parse_str(&video.id)?;
            // SPEC-CLOUD.md §6: the source video's persistent home is a
            // private S3 bucket, not local disk — re-fetches it if this
            // instance doesn't already have a local copy cached.
            let video_path = source_video::ensure_on_disk(state, &video_uuid, &video.extension).await?;
            let (w, h) = crate::scale::scaled_dimensions(video.width, video.height);
            (video_path, w, h, Some(video.id.clone()), Some(video.extension.clone()), None)
        }
        ExportSource::Template { id, payload } => {
            let template_uuid = Uuid::parse_str(id)?;
            let clip_path = paths::template_clip_path(&state.config.video_dir, &template_uuid);
            (clip_path, payload.width, payload.height, None, None, Some(id.clone()))
        }
    };

    // A template clip's own internal timeline already starts at 0 (it was
    // trimmed to exactly [gif_range_start, gif_range_end] at save time), so
    // a "use this template" caller supplies caption/range times relative
    // to that clip, not the original video's absolute timeline — the same
    // coordinate space a fresh video-based export already uses. Both
    // branches can therefore share this one call.
    let ass = generate_ass(
        &request.captions,
        request.gif_range_start,
        request.gif_range_end,
        output_width,
        output_height,
    );

    let result = transcode_and_upload(
        state,
        export_id,
        &media_path,
        &ass,
        request.gif_range_start,
        clip_duration,
        send,
    )
    .await?;

    let caption_text = request
        .captions
        .iter()
        .map(|c| c.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let new_gif = NewGif {
        id: export_id.to_string(),
        video_id: video_id.clone(),
        name: request.name.clone(),
        caption_text,
        captions_json: Some(serde_json::to_string(&request.captions)?),
        gif_range_start: Some(request.gif_range_start),
        gif_range_end: Some(request.gif_range_end),
        width: Some(result.width),
        height: Some(result.height),
        external_url: None,
        user_id: owner_id.to_string(),
        template_id,
    };
    let gif = db::insert_gif(&state.pool, &new_gif, &Utc::now().to_rfc3339()).await?;

    if let (Some(video_id), Some(video_extension)) = (&video_id, &video_extension) {
        let video_uuid = Uuid::parse_str(video_id)?;

        // SPEC.md §12's "Create template" checkbox — must happen inside
        // this same request, before the cleanup below, or that cleanup
        // would delete the video out from under a separate follow-up
        // save (see `ExportRequest::save_as_template`'s doc comment).
        if request.save_as_template {
            let template_payload = TemplatePayload {
                captions: request.captions.clone(),
                gif_range_start: request.gif_range_start,
                gif_range_end: request.gif_range_end,
                width: output_width,
                height: output_height,
            };
            if let Err(err) =
                crate::routes::videos::save_template(state, &video_uuid, video_id, video_extension, owner_id, &template_payload)
                    .await
            {
                tracing::warn!(video_id = %video_id, error = ?err, "failed to save template requested alongside export");
            }
        }

        // A video that was never turned into a template is scratch space,
        // not a persistent asset — once a gif's been made from it, keep
        // it around no longer. This makes that immediate instead of
        // waiting on the 7-day S3 lifecycle rule (SPEC-CLOUD.md §6), and
        // stops `ensure_on_disk` from re-caching it locally forever the
        // moment anything touches it. Deliberately loses the ability to
        // make a second, different gif from the same upload later without
        // re-uploading — templating first (including via the checkbox
        // above) is the supported way to keep a video's footage around
        // for that. Best-effort: a cleanup failure here doesn't undo the
        // export that already succeeded.
        if db::get_template_id(&state.pool, video_id).await?.is_none()
            && let Err(err) = crate::routes::videos::delete_video_and_its_assets(state, video_id, owner_id).await
        {
            tracing::warn!(video_id = %video_id, error = ?err, "failed to clean up source video after export");
        }
    }

    Ok(gif)
}

/// The R2 object keys a `transcode_and_upload` run produced, plus the
/// output GIF's actual post-scale dimensions — everything a caller needs
/// to build its own `NewGif` row, whether that's an export (captions,
/// tied to a `videos` row) or a bulk import (no captions, no source
/// `videos` row at all). Pulled out of `run_pipeline` because bulk import
/// (SPEC.md §7) needs the exact same burn-in-scale-down-two-pass-GIF-then-
/// MP4-then-WebM-then-upload sequence, just fed a different source file
/// and an empty ASS (no captions to burn in).
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

    let clip = ffmpeg_export::ClipSource {
        video_path,
        ass_path: &ass_path,
        range_start,
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

    Ok(TranscodeResult {
        width: probe.width,
        height: probe.height,
    })
    // `tmp_dir` drops here, deleting the local ass/palette/gif/mp4/webm
    // scratch files — R2 is the only persistent home for the outputs
    // (SPEC.md §9).
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CaptionAlign;

    fn caption(id: &str, start: f64, end: f64, text: &str, locked: bool) -> Caption {
        Caption {
            id: id.to_string(),
            start_time: start,
            end_time: end,
            text: text.to_string(),
            font_family: "Impact, sans-serif".to_string(),
            font_size: 28.0,
            color: "#ffffff".to_string(),
            align: CaptionAlign::Center,
            x: 0.5,
            y: 0.88,
            width: 0.6,
            outline_color: None,
            line_height: 0.65,
            locked,
        }
    }

    fn template_with(captions: Vec<Caption>, gif_range_start: f64) -> TemplatePayload {
        TemplatePayload {
            captions,
            gif_range_start,
            gif_range_end: gif_range_start + 1.0,
            width: 320,
            height: 240,
        }
    }

    #[test]
    fn normalize_locked_captions_overwrites_a_tampered_locked_caption_with_the_templates_own_values() {
        let template = template_with(vec![caption("c1", 2.2, 2.8, "locked caption", true)], 2.0);
        let submitted = vec![caption("c1", 0.0, 1.0, "an attempted override", false)];

        let result = normalize_locked_captions(submitted, &template);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].text, "locked caption");
        // Shifted into the clip's own 0-based space (2.2 - gif_range_start 2.0).
        assert!((result[0].start_time - 0.2).abs() < 1e-9);
        assert!((result[0].end_time - 0.8).abs() < 1e-9);
    }

    #[test]
    fn normalize_locked_captions_passes_through_an_unlocked_captions_edits_unchanged() {
        let template = template_with(vec![caption("c2", 2.1, 2.9, "changeable caption", false)], 2.0);
        let submitted = vec![caption("c2", 0.0, 1.0, "a real edit", false)];

        let result = normalize_locked_captions(submitted, &template);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].text, "a real edit");
        assert_eq!(result[0].start_time, 0.0);
    }

    /// The bypass this whole fix closes: protecting a locked caption's
    /// *fields* does nothing if the client can just leave it out of the
    /// request instead of modifying it — that's deletion, not
    /// modification, but just as much a violation of "immutable to
    /// anyone but the creator."
    #[test]
    fn normalize_locked_captions_re_adds_a_locked_caption_the_client_omitted_entirely() {
        let template = template_with(
            vec![
                caption("c1", 2.2, 2.8, "locked caption", true),
                caption("c2", 2.1, 2.9, "changeable caption", false),
            ],
            2.0,
        );
        // Client submits only the unlocked caption — as if "c1" had been
        // deleted client-side before export.
        let submitted = vec![caption("c2", 0.0, 1.0, "a real edit", false)];

        let result = normalize_locked_captions(submitted, &template);

        assert_eq!(result.len(), 2, "the locked caption must survive even though the client dropped it");
        let locked = result.iter().find(|c| c.id == "c1").expect("locked caption c1 should have been re-added");
        assert_eq!(locked.text, "locked caption");
        assert!((locked.start_time - 0.2).abs() < 1e-9);
        let unlocked = result.iter().find(|c| c.id == "c2").expect("unlocked caption c2 should still be present");
        assert_eq!(unlocked.text, "a real edit");
    }

    #[test]
    fn normalize_locked_captions_lets_a_new_caption_with_no_template_match_through() {
        let template = template_with(vec![caption("c1", 2.2, 2.8, "locked caption", true)], 2.0);
        let submitted = vec![
            caption("c1", 0.2, 0.8, "locked caption", true),
            caption("new-1", 0.0, 0.5, "brand new caption", false),
        ];

        let result = normalize_locked_captions(submitted, &template);

        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|c| c.id == "new-1" && c.text == "brand new caption"));
    }
}
