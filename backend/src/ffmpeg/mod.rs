mod clip;
pub mod export;
mod filmstrip;
mod probe;
pub mod progress;
mod thumbnail;
mod webp;

pub use clip::trim_video;
pub use filmstrip::generate_filmstrip_sprite;
pub use probe::probe_video;
pub use thumbnail::{generate_midpoint_thumbnail, generate_thumbnail};
pub use webp::{extract_webp_frame, looks_like_webp, webp_frame_count};

use std::process::Stdio;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use progress::ProgressTracker;

/// Covers both `ffmpeg` and (for animated WebP, see webp.rs)
/// `webpmux`/`dwebp` — every external CLI tool this module shells out to
/// fails the same two ways (won't launch, or exits non-zero), so one error
/// type serves all of them rather than a near-identical one per binary.
#[derive(Debug, Error)]
pub enum FfmpegCliError {
    #[error("failed to launch {program}: {source}")]
    Spawn { program: String, source: std::io::Error },
    #[error("{program} exited with status {status}: {stderr}")]
    NonZeroExit {
        program: String,
        status: std::process::ExitStatus,
        stderr: String,
    },
}

async fn run_command(program: &str, args: &[String]) -> Result<(), FfmpegCliError> {
    let output = Command::new(program)
        .args(args)
        .output()
        .await
        .map_err(|source| FfmpegCliError::Spawn {
            program: program.to_string(),
            source,
        })?;

    if !output.status.success() {
        return Err(FfmpegCliError::NonZeroExit {
            program: program.to_string(),
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }
    Ok(())
}

async fn run_ffmpeg(args: &[String]) -> Result<(), FfmpegCliError> {
    run_command("ffmpeg", args).await
}

/// Like [`run_ffmpeg`], but adds `-progress pipe:1` and streams the
/// resulting `key=value` lines through a [`ProgressTracker`], invoking
/// `on_progress` with each new percent-complete figure it reports.
async fn run_ffmpeg_with_progress<F: FnMut(u8)>(
    args: &[String],
    total_duration_seconds: f64,
    mut on_progress: F,
) -> Result<(), FfmpegCliError> {
    let mut full_args = vec![
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
    ];
    full_args.extend_from_slice(args);

    let mut child = Command::new("ffmpeg")
        .args(&full_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|source| FfmpegCliError::Spawn {
            program: "ffmpeg".to_string(),
            source,
        })?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let tracker = ProgressTracker::new(total_duration_seconds);

    let stdout_task = async {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(percent) = tracker.feed(&line) {
                on_progress(percent);
            }
        }
    };
    let stderr_task = async {
        let mut lines = BufReader::new(stderr).lines();
        let mut buf = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    };
    let (_, stderr_output) = tokio::join!(stdout_task, stderr_task);

    let status = child.wait().await.map_err(|source| FfmpegCliError::Spawn {
        program: "ffmpeg".to_string(),
        source,
    })?;
    if !status.success() {
        return Err(FfmpegCliError::NonZeroExit {
            program: "ffmpeg".to_string(),
            status,
            stderr: stderr_output,
        });
    }
    Ok(())
}
