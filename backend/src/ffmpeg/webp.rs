//! Animated WebP support for the linked-gif thumbnail pipeline
//! (thumbnails.rs) — a dedicated path around ffmpeg entirely, not a fix to
//! it. ffmpeg 5.1.9 (Debian bookworm, what the runtime image actually
//! ships — confirmed by reproducing this directly in that exact image)
//! has no working animated-WebP demuxer: it logs "skipping unsupported
//! chunk: ANIM"/"ANMF" for every frame and fails outright, regardless of
//! seeking. This isn't a version we control our way out of by tweaking
//! ffmpeg arguments — the fix is to never hand ffmpeg an animated WebP at
//! all. `webpmux` (from the `webp` package — libwebp's own CLI tooling,
//! not part of ffmpeg) reliably extracts a single frame from any WebP,
//! animated or not, as a clean standalone single-frame file with no ANIM/
//! ANMF wrapping — which ffmpeg's ordinary (non-animated) WebP decoder
//! then opens exactly like any other static image, no seeking needed.

use std::path::Path;

use super::{FfmpegCliError, run_command};

/// Sniffs whether `bytes` is a WebP file (the RIFF container header, then
/// the four-byte "WEBP" form type) — cheap enough to run unconditionally
/// on every downloaded linked gif before deciding which extraction path to
/// use, no need to trust the source URL's extension.
pub fn looks_like_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

/// Parses `webpmux -info`'s "Number of frames: N" line — the one piece of
/// its human-readable output this pipeline actually needs, to pick a
/// midpoint frame index the same way `generate_midpoint_thumbnail` picks a
/// midpoint timestamp for a real video. Always at least 1, even for a
/// single-frame (non-animated) WebP.
pub async fn webp_frame_count(path: &Path) -> Result<u32, FfmpegCliError> {
    let args = ["-info".to_string(), path.to_string_lossy().into_owned()];
    let output = tokio::process::Command::new("webpmux")
        .args(&args)
        .output()
        .await
        .map_err(|source| FfmpegCliError::Spawn {
            program: "webpmux".to_string(),
            source,
        })?;
    if !output.status.success() {
        return Err(FfmpegCliError::NonZeroExit {
            program: "webpmux".to_string(),
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let count = stdout
        .lines()
        .find_map(|line| line.strip_prefix("Number of frames: "))
        .and_then(|n| n.trim().parse::<u32>().ok())
        // A single-frame (non-animated) WebP has no "Number of frames"
        // line at all in `-info`'s output — exactly one frame either way.
        .unwrap_or(1)
        .max(1);
    Ok(count)
}

/// Extracts one frame (1-indexed, matching `webpmux`'s own numbering) as
/// its own standalone single-frame WebP file at `out_path`.
pub async fn extract_webp_frame(path: &Path, frame_index: u32, out_path: &Path) -> Result<(), FfmpegCliError> {
    let args = [
        "-get".to_string(),
        "frame".to_string(),
        frame_index.to_string(),
        path.to_string_lossy().into_owned(),
        "-o".to_string(),
        out_path.to_string_lossy().into_owned(),
    ];
    run_command("webpmux", &args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_webp_recognizes_the_riff_webp_header() {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 0]); // file size, not checked
        bytes.extend_from_slice(b"WEBP");
        assert!(looks_like_webp(&bytes));
    }

    #[test]
    fn looks_like_webp_rejects_other_formats() {
        assert!(!looks_like_webp(b"GIF89a"));
        assert!(!looks_like_webp(&[0xFF, 0xD8, 0xFF, 0xE0])); // JPEG magic
        assert!(!looks_like_webp(b"RIFF????AVI "));
    }

    #[test]
    fn looks_like_webp_rejects_a_too_short_input() {
        assert!(!looks_like_webp(b"RIFF"));
    }

    /// Synthesizes a tiny animated WebP with the system `ffmpeg` binary
    /// (same on-the-fly fixture convention as thumbnail.rs's own test) —
    /// this dev machine's ffmpeg build handles animated-WebP *encoding*
    /// fine even though production's can't *decode* it, which is exactly
    /// why this module exists.
    async fn make_test_animated_webp(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("source.webp");
        let status = tokio::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=64x64:duration=1:rate=10",
                "-loop",
                "0",
                path.to_str().unwrap(),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .expect("failed to run ffmpeg to build animated webp fixture");
        assert!(status.success(), "ffmpeg animated-webp fixture generation failed");
        path
    }

    /// A static (single-frame, non-animated) WebP has no "frame" feature
    /// for `webpmux -get frame` to act on at all — confirmed directly
    /// (`WEBP_MUX_NOT_FOUND`) — which is why thumbnails.rs only calls
    /// `extract_webp_frame` when `webp_frame_count` reports more than one
    /// frame, decoding a static WebP directly with ffmpeg instead (it
    /// never had the ANIM/ANMF chunks this module exists to work around).
    #[tokio::test]
    async fn reports_a_frame_count_of_one_for_a_static_webp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("static.webp");
        let status = tokio::process::Command::new("ffmpeg")
            .args(["-y", "-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", path.to_str().unwrap()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .expect("failed to run ffmpeg to build static webp fixture");
        assert!(status.success(), "ffmpeg static-webp fixture generation failed");

        assert_eq!(webp_frame_count(&path).await.unwrap(), 1);

        let frame_path = dir.path().join("frame.webp");
        let err = extract_webp_frame(&path, 1, &frame_path).await.unwrap_err();
        assert!(matches!(err, FfmpegCliError::NonZeroExit { .. }));
    }

    #[tokio::test]
    async fn reports_the_frame_count_of_an_animated_webp() {
        let dir = tempfile::tempdir().unwrap();
        let path = make_test_animated_webp(dir.path()).await;

        let count = webp_frame_count(&path).await.unwrap();

        // 1 second at 10fps — allow either count ffmpeg's own webp muxer
        // rounds to, rather than pinning an exact frame count.
        assert!((5..=15).contains(&count), "expected roughly 10 frames, got {count}");
    }

    #[tokio::test]
    async fn extracts_a_single_frame_that_ffmpegs_ordinary_decoder_can_then_open() {
        let dir = tempfile::tempdir().unwrap();
        let source_path = make_test_animated_webp(dir.path()).await;
        let frame_path = dir.path().join("frame.webp");
        let thumb_path = dir.path().join("thumb.jpg");

        let count = webp_frame_count(&source_path).await.unwrap();
        extract_webp_frame(&source_path, count / 2 + 1, &frame_path).await.unwrap();
        assert!(frame_path.exists());

        // The single extracted frame has no ANIM/ANMF wrapping left — the
        // exact "no -ss" path `generate_midpoint_thumbnail` already uses
        // for a duration of 0 handles it like any other static image.
        super::super::generate_midpoint_thumbnail(&frame_path, &thumb_path, 0.0)
            .await
            .expect("ffmpeg should decode the extracted single frame");
        assert!(thumb_path.exists());
    }
}
