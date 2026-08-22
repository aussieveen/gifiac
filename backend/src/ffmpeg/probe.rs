use std::path::Path;
use std::sync::Once;

use thiserror::Error;

static FFMPEG_INIT: Once = Once::new();

fn ensure_ffmpeg_initialized() {
    FFMPEG_INIT.call_once(|| {
        ffmpeg_next::init().expect("failed to initialize ffmpeg library");
    });
}

#[derive(Debug, Error)]
pub enum ProbeError {
    #[error("failed to open video file: {0}")]
    Open(#[source] ffmpeg_next::Error),
    #[error("no video stream found")]
    NoVideoStream,
    #[error("failed to read video stream parameters: {0}")]
    Decode(#[source] ffmpeg_next::Error),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProbeResult {
    pub duration_seconds: f64,
    pub width: i64,
    pub height: i64,
}

/// Probes a video file for duration/width/height. Blocking (uses the
/// synchronous ffmpeg-next bindings) — callers on an async runtime should
/// run this inside `spawn_blocking`.
pub fn probe_video(path: &Path) -> Result<ProbeResult, ProbeError> {
    ensure_ffmpeg_initialized();

    let input = ffmpeg_next::format::input(path).map_err(ProbeError::Open)?;

    let stream = input
        .streams()
        .best(ffmpeg_next::media::Type::Video)
        .ok_or(ProbeError::NoVideoStream)?;

    let context_decoder =
        ffmpeg_next::codec::context::Context::from_parameters(stream.parameters())
            .map_err(ProbeError::Decode)?;
    let video_decoder = context_decoder
        .decoder()
        .video()
        .map_err(ProbeError::Decode)?;

    const AV_TIME_BASE: f64 = 1_000_000.0;
    let format_duration = input.duration();
    let duration_seconds = if format_duration > 0 {
        format_duration as f64 / AV_TIME_BASE
    } else {
        // Some containers only report duration on the stream, not the
        // format context.
        let time_base = stream.time_base();
        stream.duration() as f64 * f64::from(time_base.numerator())
            / f64::from(time_base.denominator())
    };

    Ok(ProbeResult {
        duration_seconds: duration_seconds.max(0.0),
        width: i64::from(video_decoder.width()),
        height: i64::from(video_decoder.height()),
    })
}
