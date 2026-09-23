use std::path::Path;

use super::{FfmpegCliError, run_ffmpeg};

/// Trims `source_path` to `[range_start, range_start + duration]` into its
/// own independent file — SPEC-CLOUD.md §4: a template becomes a
/// self-contained clipped asset rather than a set of offsets into the
/// original video. Plain re-encode (no captions burned in — those are
/// still stored as data in the template payload and burned in only when
/// an actual GIF/MP4/WebM is exported from it), `-ss` before `-i` so the
/// re-encode (not a keyframe-bound stream copy) lands on the exact
/// requested start frame rather than the nearest earlier keyframe —
/// accuracy the "true like-for-like re-creation of the original edit"
/// requirement in SPEC-CLOUD.md §4 depends on.
///
/// Scaled to `width`x`height` (the template's own output dimensions,
/// already capped at `scale::MAX_WIDTH` by the same rule every other
/// generated asset follows) rather than kept at the source's native
/// resolution: nothing downstream reads this clip above that size — the
/// thumbnail and film-strip sprite generated from it are the only
/// consumers today — so encoding it any larger just spends CPU on pixels
/// nothing ever looks at.
pub async fn trim_video(
    source_path: &Path,
    out_path: &Path,
    range_start: f64,
    duration: f64,
    width: i64,
    height: i64,
) -> Result<(), FfmpegCliError> {
    let args = [
        "-y".to_string(),
        "-ss".to_string(),
        format!("{range_start:.3}"),
        "-i".to_string(),
        source_path.to_string_lossy().into_owned(),
        "-t".to_string(),
        format!("{duration:.3}"),
        "-vf".to_string(),
        format!("scale={width}:{height}"),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "veryfast".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "128k".to_string(),
        out_path.to_string_lossy().into_owned(),
    ];
    run_ffmpeg(&args).await
}
