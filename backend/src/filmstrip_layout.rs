//! Pure grid-layout math for the film-strip sprite sheet. Kept separate from
//! the FFmpeg invocation that actually renders the sprite so the layout
//! rules can be tested without touching a video file.

pub const FILMSTRIP_INTERVAL_SECONDS: f64 = 0.25;
const SPRITE_FRAME_WIDTH: u32 = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FilmstripLayout {
    pub frame_count: u32,
    pub cols: u32,
    pub rows: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    pub interval: FilmstripIntervalMillis,
}

/// Interval stored as milliseconds so the layout type can derive `Eq` for
/// straightforward test assertions; convert to seconds at the FFmpeg/JSON
/// boundary with `seconds()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FilmstripIntervalMillis(pub u32);

impl FilmstripIntervalMillis {
    pub fn seconds(self) -> f64 {
        f64::from(self.0) / 1000.0
    }
}

/// Computes the sprite-sheet grid for a video of the given duration and
/// source dimensions. One frame is sampled every `FILMSTRIP_INTERVAL_SECONDS`;
/// the grid is laid out as close to square as possible so the resulting
/// sprite image doesn't end up absurdly wide or tall.
pub fn compute_filmstrip_layout(
    duration_seconds: f64,
    video_width: i64,
    video_height: i64,
) -> FilmstripLayout {
    let duration_seconds = duration_seconds.max(0.0);
    let frame_count = ((duration_seconds / FILMSTRIP_INTERVAL_SECONDS).ceil() as u32).max(1);

    let cols = (f64::from(frame_count).sqrt().ceil() as u32).max(1);
    let rows = frame_count.div_ceil(cols);

    let frame_height = if video_width > 0 && video_height > 0 {
        ((SPRITE_FRAME_WIDTH as f64) * (video_height as f64) / (video_width as f64)).round() as u32
    } else {
        // Fall back to a 16:9 assumption if probing somehow yielded no
        // dimensions; this keeps the grid math total instead of panicking.
        (SPRITE_FRAME_WIDTH * 9) / 16
    }
    .max(1);

    FilmstripLayout {
        frame_count,
        cols,
        rows,
        frame_width: SPRITE_FRAME_WIDTH,
        frame_height,
        interval: FilmstripIntervalMillis((FILMSTRIP_INTERVAL_SECONDS * 1000.0).round() as u32),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_second_16_9_video_lays_out_a_near_square_grid() {
        let layout = compute_filmstrip_layout(10.0, 1920, 1080);
        assert_eq!(layout.frame_count, 40);
        assert_eq!(layout.cols, 7);
        assert_eq!(layout.rows, 6);
        assert_eq!(layout.frame_width, 160);
        assert_eq!(layout.frame_height, 90);
        assert_eq!(layout.interval.seconds(), 0.25);
    }

    #[test]
    fn zero_duration_still_yields_one_frame() {
        let layout = compute_filmstrip_layout(0.0, 1920, 1080);
        assert_eq!(layout.frame_count, 1);
        assert_eq!(layout.cols, 1);
        assert_eq!(layout.rows, 1);
    }

    #[test]
    fn sub_interval_duration_rounds_up_to_one_frame() {
        let layout = compute_filmstrip_layout(0.1, 1920, 1080);
        assert_eq!(layout.frame_count, 1);
    }

    #[test]
    fn negative_duration_is_clamped_instead_of_panicking() {
        let layout = compute_filmstrip_layout(-5.0, 1920, 1080);
        assert_eq!(layout.frame_count, 1);
    }

    #[test]
    fn missing_dimensions_fall_back_to_16_9() {
        let layout = compute_filmstrip_layout(10.0, 0, 0);
        assert_eq!(layout.frame_width, 160);
        assert_eq!(layout.frame_height, 90);
    }

    #[test]
    fn portrait_video_scales_height_up() {
        let layout = compute_filmstrip_layout(1.0, 1080, 1920);
        assert_eq!(layout.frame_width, 160);
        assert_eq!(layout.frame_height, 284);
    }

    #[test]
    fn exact_square_frame_count_uses_matching_grid() {
        // 9 frames == exactly 2.25s of video at 0.25s/frame -> 9 frames -> 3x3 grid.
        let layout = compute_filmstrip_layout(2.25, 1920, 1080);
        assert_eq!(layout.frame_count, 9);
        assert_eq!(layout.cols, 3);
        assert_eq!(layout.rows, 3);
    }
}
