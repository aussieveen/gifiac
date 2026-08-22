mod filmstrip;
mod probe;
mod thumbnail;

pub use filmstrip::generate_filmstrip_sprite;
pub use probe::probe_video;
pub use thumbnail::generate_thumbnail;

use thiserror::Error;
use tokio::process::Command;

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
