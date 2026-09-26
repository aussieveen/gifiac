mod clip;
pub mod export;
mod filmstrip;
mod probe;
pub mod progress;
mod thumbnail;

pub use clip::trim_video;
pub use filmstrip::generate_filmstrip_sprite;
pub use probe::probe_video;
pub use thumbnail::{generate_midpoint_thumbnail, generate_thumbnail};

use std::process::Stdio;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use progress::ProgressTracker;

#[derive(Debug, Error)]
pub enum FfmpegCliError {
    #[error("failed to launch ffmpeg: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("ffmpeg exited with status {status}: {stderr}")]
    NonZeroExit {
        status: std::process::ExitStatus,
        stderr: String,
    },
}

async fn run_ffmpeg(args: &[String]) -> Result<(), FfmpegCliError> {
    let output = Command::new("ffmpeg")
        .args(args)
        .output()
        .await
        .map_err(FfmpegCliError::Spawn)?;

    if !output.status.success() {
        return Err(FfmpegCliError::NonZeroExit {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }
    Ok(())
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
        .map_err(FfmpegCliError::Spawn)?;

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

    let status = child.wait().await.map_err(FfmpegCliError::Spawn)?;
    if !status.success() {
        return Err(FfmpegCliError::NonZeroExit {
            status,
            stderr: stderr_output,
        });
    }
    Ok(())
}
