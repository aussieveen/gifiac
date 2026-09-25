//! The one scale-down-only sizing rule every generated image/video derived
//! from a source clip shares: the film-strip sprite and every export
//! output (GIF/MP4/WebM) all cap width at [`MAX_WIDTH`], never upscale,
//! and round height to the nearest even number (matching FFmpeg's
//! `scale=W:-2`, which H.264/VP9 encoders require).
//!
//! Using one Rust-side implementation for this — rather than each caller
//! reimplementing the arithmetic — is what makes the caption editor's
//! live preview and film-strip actually match the real export pixel
//! geometry: both are built from frame dimensions computed by
//! [`scaled_dimensions`], so a caption positioned/sized against the
//! preview lands in the same place, at the same relative size, when
//! burned into the real output.

pub const MAX_WIDTH: u32 = 480;

/// `min(source_width, MAX_WIDTH)`, with height scaled to preserve aspect
/// ratio and rounded to match FFmpeg's actual `-2` behavior. Falls back to
/// a 16:9 assumption if the source dimensions are missing/invalid, so this
/// stays total instead of panicking or dividing by zero.
pub fn scaled_dimensions(source_width: i64, source_height: i64) -> (i64, i64) {
    if source_width <= 0 || source_height <= 0 {
        let width = i64::from(MAX_WIDTH);
        return (width, round_to_even_ffmpeg_style(width as f64 * 9.0 / 16.0));
    }

    let capped_width = source_width.min(i64::from(MAX_WIDTH));
    let raw_height = source_height as f64 * capped_width as f64 / source_width as f64;
    // Truncate (not round) to even, matching the ffmpeg filter's
    // `trunc(min(iw,W)/2)*2` — MAX_WIDTH itself is even, so this only ever
    // changes anything for a source narrower than MAX_WIDTH with an odd
    // native width (e.g. 245px), which otherwise passed straight through
    // un-evened and made libx264/libvpx-vp9 reject the frame size.
    let width = (capped_width / 2) * 2;
    (width, round_to_even_ffmpeg_style(raw_height))
}

/// Matches FFmpeg's `-2` scale-filter height rounding: halve, round to
/// the nearest integer, then double. This is *not* the same as "round to
/// the nearest integer, then round that down to even" — they agree most
/// of the time but can differ by 2px in borderline cases. Caught by
/// testing against a real export: a 1236x668 source scaled to width 480
/// produces a real FFmpeg output height of 260 (verified with `ffprobe`
/// on the actual encoded file), not 258, which "round-then-floor" would
/// have computed (raw height 259.42 rounds to 259, then floors to 258).
fn round_to_even_ffmpeg_style(raw: f64) -> i64 {
    (((raw / 2.0).round()) as i64 * 2).max(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_down_a_landscape_source_preserving_aspect_ratio() {
        assert_eq!(scaled_dimensions(1920, 1080), (480, 270));
    }

    #[test]
    fn never_upscales_a_source_narrower_than_max_width() {
        assert_eq!(scaled_dimensions(320, 240), (320, 240));
    }

    #[test]
    fn matches_a_real_ffmpeg_output_where_naive_rounding_would_be_off_by_two() {
        // Verified with `ffprobe` against the actual file FFmpeg produced
        // for this exact source resolution: 480x260, not 480x258.
        assert_eq!(scaled_dimensions(1236, 668), (480, 260));
    }

    #[test]
    fn height_is_always_even() {
        for (w, h) in [(1920, 1081), (1236, 668), (1081, 1920), (333, 217)] {
            let (_, height) = scaled_dimensions(w, h);
            assert_eq!(
                height % 2,
                0,
                "scaled_dimensions({w}, {h}) produced odd height {height}"
            );
        }
    }

    #[test]
    fn width_is_always_even() {
        // 245 reproduces a real upload ("tempting fate.gif") whose odd
        // native width, left un-truncated, made libx264 reject the mp4
        // encode with "width not divisible by 2".
        for (w, h) in [(245, 176), (1920, 1081), (333, 217), (479, 100)] {
            let (width, _) = scaled_dimensions(w, h);
            assert_eq!(
                width % 2,
                0,
                "scaled_dimensions({w}, {h}) produced odd width {width}"
            );
        }
    }

    #[test]
    fn falls_back_to_16_9_when_dimensions_are_missing() {
        assert_eq!(scaled_dimensions(0, 0), (480, 270));
    }

    #[test]
    fn matches_the_854x480_case_verified_against_real_ffmpeg_output() {
        // Manually confirmed via `ffmpeg -vf scale='min(iw\,480)':-2` on an
        // 854x480 source during export-pipeline development: real output
        // was 480x270.
        assert_eq!(scaled_dimensions(854, 480), (480, 270));
    }
}
