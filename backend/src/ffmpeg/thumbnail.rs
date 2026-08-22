use std::path::Path;

use super::{FfmpegCliError, run_ffmpeg};

/// Generates a single poster-frame thumbnail. Seeks to the midpoint of the
/// first two seconds (clamped to the clip's actual duration) so very short
/// clips still produce a frame instead of seeking past end-of-stream.
pub async fn generate_thumbnail(
    video_path: &Path,
    out_path: &Path,
    duration_seconds: f64,
) -> Result<(), FfmpegCliError> {
    let seek = (duration_seconds / 2.0).clamp(0.0, 1.0);
    let args = [
        "-y".to_string(),
        "-ss".to_string(),
        format!("{seek:.3}"),
        "-i".to_string(),
        video_path.to_string_lossy().into_owned(),
        "-frames:v".to_string(),
        "1".to_string(),
        out_path.to_string_lossy().into_owned(),
    ];
    run_ffmpeg(&args).await
}
