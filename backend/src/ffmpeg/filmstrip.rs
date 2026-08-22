use std::path::Path;

use crate::filmstrip_layout::FilmstripLayout;

use super::{FfmpegCliError, run_ffmpeg};

/// Renders the film-strip sprite sheet: one frame every `layout.interval`
/// seconds, scaled to `frame_width x frame_height`, tiled into a
/// `cols x rows` grid — one FFmpeg invocation, one output image.
pub async fn generate_filmstrip_sprite(
    video_path: &Path,
    out_path: &Path,
    layout: &FilmstripLayout,
) -> Result<(), FfmpegCliError> {
    let fps = 1.0 / layout.interval.seconds();
    let filter = format!(
        "fps={fps},scale={w}:{h},tile={cols}x{rows}",
        w = layout.frame_width,
        h = layout.frame_height,
        cols = layout.cols,
        rows = layout.rows,
    );
    let args = [
        "-y".to_string(),
        "-i".to_string(),
        video_path.to_string_lossy().into_owned(),
        "-vf".to_string(),
        filter,
        out_path.to_string_lossy().into_owned(),
    ];
    run_ffmpeg(&args).await
}
