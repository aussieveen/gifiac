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

/// The `-vf`/`-lavfi` prefix shared by every output format: burn in
/// captions, then apply the shared fps/scale caps. Each caller appends its
/// own suffix (`palettegen`, `paletteuse`, or nothing for a plain encode).
fn captioned_scale_filter(ass_path: &Path) -> String {
    format!(
        "subtitles={ass},fps={fps},{scale}",
        ass = escape_filter_path(ass_path),
        fps = EXPORT_FPS,
        scale = scale_filter(),
    )
}

/// ffmpeg's filtergraph parser treats `:` and `\` specially inside a
/// filter option value (e.g. `subtitles=<path>`); backslash-escape them so
/// a path containing either survives being embedded in a filter string.
fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace(':', "\\:")
}

/// The source clip + burn-in inputs every export stage reads from — the
/// same four values for all four ffmpeg invocations in one export job, so
/// callers build it once and pass it through instead of four positional
/// args apiece (this used to be inlined per-function until a `keep_audio`
/// param pushed `encode_video` over clippy's too-many-arguments limit).
#[derive(Debug, Clone, Copy)]
pub struct ClipSource<'a> {
    pub video_path: &'a Path,
    pub ass_path: &'a Path,
    pub range_start: f64,
    pub clip_duration: f64,
}

fn seek_args(clip: ClipSource) -> Vec<String> {
    vec![
        "-ss".to_string(),
        format!("{:.3}", clip.range_start),
        "-i".to_string(),
        clip.video_path.to_string_lossy().into_owned(),
        "-t".to_string(),
        format!("{:.3}", clip.clip_duration),
    ]
}

/// Pass 1 of the two-pass GIF encode: analyze the (captioned, scaled,
/// fps-reduced) clip and write an optimal 256-color palette image.
pub async fn generate_palette<F: FnMut(u8)>(
    clip: ClipSource<'_>,
    palette_path: &Path,
    on_progress: F,
) -> Result<(), FfmpegCliError> {
    let filter = format!(
        "{},palettegen=max_colors=256:stats_mode=full",
        captioned_scale_filter(clip.ass_path)
    );
    let mut args = vec!["-y".to_string()];
    args.extend(seek_args(clip));
    args.push("-vf".to_string());
    args.push(filter);
    args.push(palette_path.to_string_lossy().into_owned());

    run_ffmpeg_with_progress(&args, clip.clip_duration, on_progress).await
}

/// Pass 2 of the two-pass GIF encode: apply the generated palette.
pub async fn encode_gif<F: FnMut(u8)>(
    clip: ClipSource<'_>,
    palette_path: &Path,
    out_path: &Path,
    on_progress: F,
) -> Result<(), FfmpegCliError> {
    let filter = format!(
        "{}[x];[x][1:v]paletteuse=dither=bayer[out]",
        captioned_scale_filter(clip.ass_path)
    );
    let mut args = vec!["-y".to_string()];
    args.extend(seek_args(clip));
    args.push("-i".to_string());
    args.push(palette_path.to_string_lossy().into_owned());
    args.push("-lavfi".to_string());
    args.push(filter);
    args.push("-map".to_string());
    args.push("[out]".to_string());
    args.push(out_path.to_string_lossy().into_owned());

    run_ffmpeg_with_progress(&args, clip.clip_duration, on_progress).await
}

/// `keep_audio` controls whether the source's audio track (if any) is
/// carried through — SPEC.md §6 only calls the WebM output "silent-loop",
/// implying the MP4 isn't necessarily muted. `-c:a aac`/no `-an` is a
/// no-op (ffmpeg just omits the output audio stream) when the source has
/// no audio, so this is safe either way.
async fn encode_video<F: FnMut(u8)>(
    clip: ClipSource<'_>,
    out_path: &Path,
    video_codec: &str,
    keep_audio: bool,
    on_progress: F,
) -> Result<(), FfmpegCliError> {
    let mut args = vec!["-y".to_string()];
    args.extend(seek_args(clip));
    args.extend([
        "-vf".to_string(),
        captioned_scale_filter(clip.ass_path),
        "-c:v".to_string(),
        video_codec.to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
    ]);
    if keep_audio {
        args.extend([
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "128k".to_string(),
        ]);
    } else {
        args.push("-an".to_string());
    }
    args.push(out_path.to_string_lossy().into_owned());

    run_ffmpeg_with_progress(&args, clip.clip_duration, on_progress).await
}

pub async fn encode_mp4<F: FnMut(u8)>(
    clip: ClipSource<'_>,
    out_path: &Path,
    on_progress: F,
) -> Result<(), FfmpegCliError> {
    encode_video(clip, out_path, "libx264", true, on_progress).await
}

pub async fn encode_webm<F: FnMut(u8)>(
    clip: ClipSource<'_>,
    out_path: &Path,
    on_progress: F,
) -> Result<(), FfmpegCliError> {
    encode_video(clip, out_path, "libvpx-vp9", false, on_progress).await // "silent-loop WebM" per SPEC.md §6
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
