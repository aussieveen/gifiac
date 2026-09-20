use std::path::Path;

use super::{FfmpegCliError, run_ffmpeg};

/// Trims `source_path` to `[range_start, range_start + duration]` into its
/// own independent file — SPEC-CLOUD.md §4: a template becomes a
/// self-contained clipped asset rather than a set of offsets into the
/// original video. Plain re-encode, no captions burned in and no scale
/// filter (unlike the export pipeline in `super::export`) — captions are
/// still stored as data in the template payload and burned in only when
/// an actual GIF/MP4/WebM is exported from it.
pub async fn trim_video(
    source_path: &Path,
    out_path: &Path,
    range_start: f64,
    duration: f64,
) -> Result<(), FfmpegCliError> {
    let args = [
        "-y".to_string(),
        "-ss".to_string(),
        format!("{range_start:.3}"),
        "-i".to_string(),
        source_path.to_string_lossy().into_owned(),
        "-t".to_string(),
        format!("{duration:.3}"),
        "-c:v".to_string(),
        "libx264".to_string(),
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
