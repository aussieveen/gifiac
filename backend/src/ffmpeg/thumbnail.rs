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

/// Like [`generate_thumbnail`], but seeks to the true midpoint of the
/// whole clip rather than clamping to the first two seconds — that
/// heuristic exists for scrubbing a much longer source video, and badly
/// under-represents a clip that's only a few seconds long to begin with
/// (e.g. a linked gif's own poster frame, or a gif-backed `<video>`'s
/// paused preview frame — see SPEC's "disable gif autoplay" preference).
///
/// `duration_seconds <= 0.0` skips seeking entirely rather than passing
/// `-ss 0.000` — confirmed directly against a real animated WebP: ffmpeg's
/// `webp_anim` demuxer never reports a duration at all (probe_video reads
/// that back as `0.0`, not an error), and an input seek of *any* amount,
/// including exactly zero, makes that demuxer fail outright (`Error while
/// opening encoder`). Omitting `-ss` and just grabbing whatever frame
/// ffmpeg decodes first is the best available fallback for a source this
/// pipeline can't reliably report (let alone seek within) a duration for.
pub async fn generate_midpoint_thumbnail(
    source_path: &Path,
    out_path: &Path,
    duration_seconds: f64,
) -> Result<(), FfmpegCliError> {
    let mut args = vec!["-y".to_string()];
    if duration_seconds > 0.0 {
        args.push("-ss".to_string());
        args.push(format!("{:.3}", duration_seconds / 2.0));
    }
    args.push("-i".to_string());
    args.push(source_path.to_string_lossy().into_owned());
    args.push("-frames:v".to_string());
    args.push("1".to_string());
    args.push(out_path.to_string_lossy().into_owned());
    run_ffmpeg(&args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthesizes a tiny animated WebP with the system `ffmpeg` binary —
    /// no fixture file to check in, same "generate it on the fly"
    /// convention `backend/tests/common::make_test_video` uses for mp4
    /// fixtures. Animated WebP is the regression case here: ffmpeg's
    /// `webp_anim` demuxer never reports a duration for it (confirmed
    /// directly — both the format and stream duration read back as
    /// `AV_NOPTS_VALUE`), which is what `probe_video` turns into `0.0`.
    async fn make_test_animated_webp(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("source.webp");
        let status = tokio::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=64x64:duration=1:rate=10",
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

    /// Regression test for a real failure: passing `-ss 0.000` (this
    /// function's old behavior whenever `probe_video` reported an unknown
    /// duration as `0.0`) makes ffmpeg's `webp_anim` demuxer fail outright
    /// — confirmed directly against both a real-world animated WebP and
    /// this synthesized one, with the exact same "Error while opening
    /// encoder" / "Conversion failed!" failure either way. Omitting `-ss`
    /// entirely for a non-positive duration (this function's fix) must
    /// still produce a usable thumbnail rather than erroring.
    #[tokio::test]
    async fn succeeds_on_an_animated_webp_with_no_reported_duration() {
        let dir = tempfile::tempdir().unwrap();
        let source_path = make_test_animated_webp(dir.path()).await;
        let out_path = dir.path().join("thumb.jpg");

        generate_midpoint_thumbnail(&source_path, &out_path, 0.0)
            .await
            .expect("thumbnail generation should succeed without seeking");

        assert!(out_path.exists(), "expected a thumbnail file to be written");
    }
}
