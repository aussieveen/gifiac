//! Parses FFmpeg's `-progress pipe:1` key=value output into a 0–100
//! percent-complete figure, so each pipeline stage can report real
//! progress over SSE (SPEC.md §6) instead of just "running"/"done".

/// Accumulates `-progress` lines and reports percent complete against a
/// known total clip duration. FFmpeg's `-progress` output is a stream of
/// `key=value` lines with an `out_time_ms=` (or `out_time_us=`, depending
/// on version) line once per flushed frame, terminated by `progress=end`.
#[derive(Debug, Default)]
pub struct ProgressTracker {
    total_duration_seconds: f64,
}

impl ProgressTracker {
    pub fn new(total_duration_seconds: f64) -> Self {
        Self {
            total_duration_seconds: total_duration_seconds.max(0.0),
        }
    }

    /// Feeds one line of `-progress` output; returns `Some(percent)` when
    /// the line carries new timing/completion info, `None` for lines that
    /// don't (most `key=value` lines aren't `out_time_*` or `progress=end`).
    pub fn feed(&self, line: &str) -> Option<u8> {
        let (key, value) = line.split_once('=')?;
        match key {
            "out_time_us" | "out_time_ms" => {
                let micros: f64 = value.trim().parse().ok()?;
                let seconds = if key == "out_time_ms" {
                    micros / 1000.0
                } else {
                    micros / 1_000_000.0
                };
                Some(self.percent_for(seconds))
            }
            "out_time" => parse_ffmpeg_timestamp(value.trim()).map(|s| self.percent_for(s)),
            "progress" if value.trim() == "end" => Some(100),
            _ => None,
        }
    }

    fn percent_for(&self, elapsed_seconds: f64) -> u8 {
        if self.total_duration_seconds <= 0.0 {
            return 100;
        }
        let fraction = (elapsed_seconds / self.total_duration_seconds).clamp(0.0, 1.0);
        (fraction * 100.0).round() as u8
    }
}

/// Parses FFmpeg's `HH:MM:SS.ffffff` progress timestamp into seconds.
fn parse_ffmpeg_timestamp(s: &str) -> Option<f64> {
    let mut parts = s.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn out_time_us_reports_a_fraction_of_the_total() {
        let tracker = ProgressTracker::new(10.0);
        assert_eq!(tracker.feed("out_time_us=5000000"), Some(50));
    }

    #[test]
    fn out_time_ms_is_interpreted_as_milliseconds_not_microseconds() {
        let tracker = ProgressTracker::new(10.0);
        assert_eq!(tracker.feed("out_time_ms=5000"), Some(50));
    }

    #[test]
    fn out_time_hms_string_is_parsed() {
        let tracker = ProgressTracker::new(60.0);
        assert_eq!(tracker.feed("out_time=00:00:30.000000"), Some(50));
    }

    #[test]
    fn progress_end_reports_100_regardless_of_last_out_time() {
        let tracker = ProgressTracker::new(10.0);
        assert_eq!(tracker.feed("progress=end"), Some(100));
    }

    #[test]
    fn progress_continue_is_ignored() {
        let tracker = ProgressTracker::new(10.0);
        assert_eq!(tracker.feed("progress=continue"), None);
    }

    #[test]
    fn unrelated_lines_are_ignored() {
        let tracker = ProgressTracker::new(10.0);
        assert_eq!(tracker.feed("frame=42"), None);
        assert_eq!(tracker.feed("fps=15.00"), None);
        assert_eq!(tracker.feed(""), None);
    }

    #[test]
    fn percent_is_clamped_to_100_even_if_ffmpeg_overshoots() {
        let tracker = ProgressTracker::new(10.0);
        assert_eq!(tracker.feed("out_time_us=15000000"), Some(100));
    }

    #[test]
    fn zero_total_duration_reports_complete_immediately() {
        let tracker = ProgressTracker::new(0.0);
        assert_eq!(tracker.feed("out_time_us=0"), Some(100));
    }
}
