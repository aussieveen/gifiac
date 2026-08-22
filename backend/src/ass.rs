//! Converts the caption array from `POST /api/exports` into an ASS
//! subtitle file for FFmpeg's `subtitles=`/libass burn-in filter, per
//! SPEC.md §6: "the caption array is serialized into an ASS subtitle file
//! — start/end/text map to ASS timing; font/size/color/align/x,y map to an
//! ASS style plus `\pos()` override tags."
//!
//! One named Style per caption (rather than deduping identical styles) —
//! simplest correct thing, and export jobs have at most a handful of
//! captions. `align` drives the ASS `Alignment` field (which, per the ASS
//! spec, jointly controls anchor point and multi-line text justification —
//! there's no way to decouple those two), so `\pos` is the point that
//! corner/edge of the text box sits at, not always its center; this only
//! visibly matters for wrapped multi-line captions.

use crate::models::{Caption, CaptionAlign};

pub fn generate_ass(
    captions: &[Caption],
    range_start: f64,
    range_end: f64,
    frame_width: i64,
    frame_height: i64,
) -> String {
    let clip_duration = (range_end - range_start).max(0.0);

    let mut styles = String::new();
    let mut events = String::new();

    for (i, caption) in captions.iter().enumerate() {
        let local_start = (caption.start_time - range_start).clamp(0.0, clip_duration);
        let local_end = (caption.end_time - range_start).clamp(0.0, clip_duration);
        if local_end <= local_start {
            continue; // entirely outside the exported range
        }

        let style_name = format!("cap{i}");
        let pos_x = (caption.x * frame_width as f64).round() as i64;
        let pos_y = (caption.y * frame_height as f64).round() as i64;

        styles.push_str(&format!(
            "Style: {name},{font},{size},{color},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,{align},10,10,10,1\n",
            name = style_name,
            font = ass_font_name(&caption.font_family),
            size = caption.font_size.round() as i64,
            color = ass_color(&caption.color),
            align = ass_alignment(caption.align),
        ));

        events.push_str(&format!(
            "Dialogue: 0,{start},{end},{name},,0,0,0,,{{\\pos({x},{y})}}{text}\n",
            start = ass_timestamp(local_start),
            end = ass_timestamp(local_end),
            name = style_name,
            x = pos_x,
            y = pos_y,
            text = ass_escape_text(&caption.text),
        ));
    }

    format!(
        "[Script Info]\n\
         ScriptType: v4.00+\n\
         PlayResX: {frame_width}\n\
         PlayResY: {frame_height}\n\
         WrapStyle: 0\n\
         ScaledBorderAndShadow: yes\n\
         \n\
         [V4+ Styles]\n\
         Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
         {styles}\n\
         [Events]\n\
         Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n\
         {events}"
    )
}

/// `frame_family` is a CSS font stack like `"Impact, sans-serif"`; ASS
/// wants a single font name.
fn ass_font_name(font_family: &str) -> String {
    font_family
        .split(',')
        .next()
        .unwrap_or(font_family)
        .trim()
        .trim_matches(|c| c == '\'' || c == '"')
        .to_string()
}

/// `#rrggbb` -> ASS's `&HAABBGGRR` (blue/green/red byte order, alpha `00`
/// = fully opaque — ASS alpha is inverted from CSS: `00` opaque, `FF`
/// transparent). No trailing `&`, matching the convention real .ass files
/// (e.g. Aegisub's output) use in the Styles section.
fn ass_color(hex: &str) -> String {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 {
        return "&H00FFFFFF".to_string(); // fall back to opaque white
    }
    let r = &hex[0..2];
    let g = &hex[2..4];
    let b = &hex[4..6];
    format!("&H00{b}{g}{r}").to_uppercase()
}

fn ass_alignment(align: CaptionAlign) -> u8 {
    // Middle row (4/5/6) so the vertical anchor matches the frontend's
    // always-vertically-centered `transform: translate(-50%, -50%)`.
    match align {
        CaptionAlign::Left => 4,
        CaptionAlign::Center => 5,
        CaptionAlign::Right => 6,
    }
}

/// `H:MM:SS.CC` (centiseconds), the timestamp format ASS/libass expects.
fn ass_timestamp(seconds: f64) -> String {
    let total_centis = (seconds.max(0.0) * 100.0).round() as i64;
    let hours = total_centis / 360_000;
    let minutes = (total_centis / 6_000) % 60;
    let secs = (total_centis / 100) % 60;
    let centis = total_centis % 100;
    format!("{hours}:{minutes:02}:{secs:02}.{centis:02}")
}

/// Caption text -> ASS event text: literal newlines become `\N` (ASS's
/// hard line break). Known limitation: a caption containing a literal `{`
/// or `}` would be misread as an override-tag delimiter by libass — ASS
/// has no clean escape for that, so it's left as-is (rare input).
fn ass_escape_text(text: &str) -> String {
    text.replace('\n', "\\N")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caption(id: &str, start: f64, end: f64, text: &str) -> Caption {
        Caption {
            id: id.to_string(),
            start_time: start,
            end_time: end,
            text: text.to_string(),
            font_family: "Impact, sans-serif".to_string(),
            font_size: 28.0,
            color: "#ffffff".to_string(),
            align: CaptionAlign::Center,
            x: 0.5,
            y: 0.88,
        }
    }

    #[test]
    fn ass_timestamp_formats_hours_minutes_seconds_centiseconds() {
        assert_eq!(ass_timestamp(0.0), "0:00:00.00");
        assert_eq!(ass_timestamp(1.5), "0:00:01.50");
        assert_eq!(ass_timestamp(65.25), "0:01:05.25");
        assert_eq!(ass_timestamp(3661.99), "1:01:01.99");
    }

    #[test]
    fn ass_timestamp_clamps_negative_to_zero() {
        assert_eq!(ass_timestamp(-5.0), "0:00:00.00");
    }

    #[test]
    fn ass_font_name_takes_the_first_stack_entry_unquoted() {
        assert_eq!(ass_font_name("Impact, sans-serif"), "Impact");
        assert_eq!(ass_font_name("'Courier New', monospace"), "Courier New");
        assert_eq!(ass_font_name("Georgia"), "Georgia");
    }

    #[test]
    fn ass_color_converts_hex_rgb_to_abgr() {
        assert_eq!(ass_color("#ffffff"), "&H00FFFFFF");
        assert_eq!(ass_color("#ff0000"), "&H000000FF"); // red -> BB=00 GG=00 RR=FF
        assert_eq!(ass_color("#00ff00"), "&H0000FF00"); // green -> BB=00 GG=FF RR=00
        assert_eq!(ass_color("#0000ff"), "&H00FF0000"); // blue -> BB=FF GG=00 RR=00
    }

    #[test]
    fn ass_color_falls_back_to_white_on_malformed_input() {
        assert_eq!(ass_color("not-a-color"), "&H00FFFFFF");
    }

    #[test]
    fn ass_alignment_uses_the_middle_row() {
        assert_eq!(ass_alignment(CaptionAlign::Left), 4);
        assert_eq!(ass_alignment(CaptionAlign::Center), 5);
        assert_eq!(ass_alignment(CaptionAlign::Right), 6);
    }

    #[test]
    fn generate_ass_emits_one_style_and_dialogue_per_caption() {
        let captions = vec![
            caption("c1", 0.5, 2.5, "Hello"),
            caption("c2", 3.0, 4.0, "World"),
        ];
        let ass = generate_ass(&captions, 0.0, 6.0, 640, 360);

        assert!(ass.contains("PlayResX: 640"));
        assert!(ass.contains("PlayResY: 360"));
        assert!(ass.contains("Style: cap0,Impact,28,&H00FFFFFF"));
        assert!(ass.contains("Style: cap1,Impact,28,&H00FFFFFF"));
        assert!(
            ass.contains("Dialogue: 0,0:00:00.50,0:00:02.50,cap0,,0,0,0,,{\\pos(320,317)}Hello")
        );
        assert!(
            ass.contains("Dialogue: 0,0:00:03.00,0:00:04.00,cap1,,0,0,0,,{\\pos(320,317)}World")
        );
    }

    #[test]
    fn generate_ass_rebases_timestamps_against_the_gif_range_start() {
        // A 10s-20s export range: a caption at 12s-14s should land at 2s-4s
        // in the trimmed clip, not 12s-14s (which would be out of bounds).
        let captions = vec![caption("c1", 12.0, 14.0, "Mid-clip")];
        let ass = generate_ass(&captions, 10.0, 20.0, 640, 360);

        assert!(ass.contains("Dialogue: 0,0:00:02.00,0:00:04.00,cap0"));
    }

    #[test]
    fn generate_ass_drops_captions_entirely_outside_the_export_range() {
        let captions = vec![
            caption("before", 0.0, 1.0, "before"),
            caption("in-range", 2.0, 3.0, "in range"),
        ];
        let ass = generate_ass(&captions, 2.0, 5.0, 640, 360);

        assert!(!ass.contains("before"));
        assert!(ass.contains("in range"));
    }

    #[test]
    fn generate_ass_clamps_a_caption_that_only_partially_overlaps_the_range() {
        let captions = vec![caption("c1", 1.0, 3.0, "spans the cut")];
        let ass = generate_ass(&captions, 2.0, 5.0, 640, 360);

        // Starts before range_start (2.0) -> clamped to local 0.0.
        assert!(ass.contains("Dialogue: 0,0:00:00.00,0:00:01.00,cap0"));
    }

    #[test]
    fn generate_ass_escapes_newlines_as_hard_breaks() {
        let mut c = caption("c1", 0.0, 1.0, "line one\nline two");
        c.text = "line one\nline two".to_string();
        let ass = generate_ass(&[c], 0.0, 2.0, 640, 360);

        assert!(ass.contains("line one\\Nline two"));
    }

    #[test]
    fn generate_ass_with_no_captions_is_still_a_valid_skeleton() {
        let ass = generate_ass(&[], 0.0, 5.0, 640, 360);
        assert!(ass.contains("[Script Info]"));
        assert!(ass.contains("[V4+ Styles]"));
        assert!(ass.contains("[Events]"));
    }
}
