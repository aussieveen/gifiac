use std::path::Path;

use super::{FfmpegCliError, run_ffmpeg_with_progress};

/// Provisional caps per SPEC.md §6 — "tunable constants, not hardcoded
/// values", expected to be revisited once real exported output has been
/// reviewed.
pub const EXPORT_FPS: u32 = 15;
pub const EXPORT_MAX_WIDTH: u32 = 480;

/// `scale='min(iw,W)':-2` scales down to `EXPORT_MAX_WIDTH` but never up
/// (`min(iw, W)`), and `-2` keeps the height even (required by libx264 /
/// libvpx-vp9) while preserving aspect ratio.
fn scale_filter() -> String {
    format!("scale='min(iw\\,{EXPORT_MAX_WIDTH})':-2:flags=lanczos")
}

/// ffmpeg's filtergraph parser treats `:` and `\` specially inside a
/// filter option value (e.g. `subtitles=<path>`); backslash-escape them so
/// a path containing either survives being embedded in a filter string.
fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace(':', "\\:")
}

fn seek_args(video_path: &Path, range_start: f64, clip_duration: f64) -> Vec<String> {
    vec![
        "-ss".to_string(),
        format!("{range_start:.3}"),
        "-i".to_string(),
        video_path.to_string_lossy().into_owned(),
        "-t".to_string(),
        format!("{clip_duration:.3}"),
    ]
}

/// Pass 1 of the two-pass GIF encode: analyze the (captioned, scaled,
/// fps-reduced) clip and write an optimal 256-color palette image.
pub async fn generate_palette<F: FnMut(u8)>(
    video_path: &Path,
    ass_path: &Path,
    palette_path: &Path,
    range_start: f64,
    clip_duration: f64,
    on_progress: F,
) -> Result<(), FfmpegCliError> {
    let filter = format!(
        "subtitles={ass},fps={fps},{scale},palettegen=max_colors=256:stats_mode=full",
        ass = escape_filter_path(ass_path),
        fps = EXPORT_FPS,
        scale = scale_filter(),
    );
    let mut args = vec!["-y".to_string()];
    args.extend(seek_args(video_path, range_start, clip_duration));
    args.push("-vf".to_string());
    args.push(filter);
    args.push(palette_path.to_string_lossy().into_owned());

    run_ffmpeg_with_progress(&args, clip_duration, on_progress).await
}

/// Pass 2 of the two-pass GIF encode: apply the generated palette.
pub async fn encode_gif<F: FnMut(u8)>(
    video_path: &Path,
    ass_path: &Path,
    palette_path: &Path,
    out_path: &Path,
    range_start: f64,
    clip_duration: f64,
    on_progress: F,
) -> Result<(), FfmpegCliError> {
    let filter = format!(
        "subtitles={ass},fps={fps},{scale}[x];[x][1:v]paletteuse=dither=bayer[out]",
        ass = escape_filter_path(ass_path),
        fps = EXPORT_FPS,
        scale = scale_filter(),
    );
    let mut args = vec!["-y".to_string()];
    args.extend(seek_args(video_path, range_start, clip_duration));
    args.push("-i".to_string());
    args.push(palette_path.to_string_lossy().into_owned());
    args.push("-lavfi".to_string());
    args.push(filter);
    args.push("-map".to_string());
    args.push("[out]".to_string());
    args.push(out_path.to_string_lossy().into_owned());

    run_ffmpeg_with_progress(&args, clip_duration, on_progress).await
}

async fn encode_video<F: FnMut(u8)>(
    video_path: &Path,
    ass_path: &Path,
    out_path: &Path,
    range_start: f64,
    clip_duration: f64,
    video_codec: &str,
    on_progress: F,
) -> Result<(), FfmpegCliError> {
    let filter = format!(
        "subtitles={ass},fps={fps},{scale}",
        ass = escape_filter_path(ass_path),
        fps = EXPORT_FPS,
        scale = scale_filter(),
    );
    let mut args = vec!["-y".to_string()];
    args.extend(seek_args(video_path, range_start, clip_duration));
    args.extend([
        "-vf".to_string(),
        filter,
        "-c:v".to_string(),
        video_codec.to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-an".to_string(), // silent clip — matches the WebM output SPEC.md §6 calls for; kept
        // consistent across all three formats since they're the same clip.
        out_path.to_string_lossy().into_owned(),
    ]);

    run_ffmpeg_with_progress(&args, clip_duration, on_progress).await
}

pub async fn encode_mp4<F: FnMut(u8)>(
    video_path: &Path,
    ass_path: &Path,
    out_path: &Path,
    range_start: f64,
    clip_duration: f64,
    on_progress: F,
) -> Result<(), FfmpegCliError> {
    encode_video(
        video_path,
        ass_path,
        out_path,
        range_start,
        clip_duration,
        "libx264",
        on_progress,
    )
    .await
}

pub async fn encode_webm<F: FnMut(u8)>(
    video_path: &Path,
    ass_path: &Path,
    out_path: &Path,
    range_start: f64,
    clip_duration: f64,
    on_progress: F,
) -> Result<(), FfmpegCliError> {
    encode_video(
        video_path,
        ass_path,
        out_path,
        range_start,
        clip_duration,
        "libvpx-vp9",
        on_progress,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_filter_path_escapes_colons() {
        assert_eq!(
            escape_filter_path(Path::new("/tmp/a:b.ass")),
            "/tmp/a\\:b.ass"
        );
    }

    #[test]
    fn escape_filter_path_escapes_backslashes_before_colons() {
        assert_eq!(
            escape_filter_path(Path::new("C:\\clips\\a.ass")),
            "C\\:\\\\clips\\\\a.ass"
        );
    }

    #[test]
    fn escape_filter_path_leaves_a_plain_path_unchanged() {
        assert_eq!(
            escape_filter_path(Path::new("/tmp/abc-123/x.ass")),
            "/tmp/abc-123/x.ass"
        );
    }

    #[test]
    fn scale_filter_caps_width_without_upscaling() {
        let filter = scale_filter();
        assert!(filter.contains("min(iw\\,480)"));
        assert!(filter.contains(":-2:"));
    }
}
