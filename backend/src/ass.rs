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
        let (margin_l, margin_r) = ass_margins(caption.x, caption.width, frame_width);
        let (outline_colour, outline_width) = ass_outline(&caption.outline_color);
        let font_name = ass_font_name(&caption.font_family);
        let font_size = caption.font_size * ass_font_size_multiplier(&font_name);

        styles.push_str(&format!(
            "Style: {name},{font},{size},{color},&H000000FF,{outline_colour},&H00000000,0,0,0,0,100,100,0,0,1,{outline_width},0,{align},{margin_l},{margin_r},10,1\n",
            name = style_name,
            font = font_name,
            size = font_size.round() as i64,
            color = ass_color(&caption.color),
            align = ass_alignment(caption.align),
        ));

        let start = ass_timestamp(local_start);
        let end = ass_timestamp(local_end);
        let lines: Vec<&str> = caption.text.split('\n').collect();

        if lines.len() <= 1 {
            events.push_str(&format!(
                "Dialogue: 0,{start},{end},{name},,0,0,0,,{{\\pos({x},{y})}}{text}\n",
                name = style_name,
                x = pos_x,
                y = pos_y,
                text = ass_escape_text(&caption.text),
            ));
        } else {
            // libass has no line-spacing control independent of font size
            // (verified directly: `\fscy` scales glyph height and line
            // pitch together, no combination decouples them — see
            // `Caption::line_height`'s doc comment) — so a multi-line
            // caption is laid out here instead, as one singly-positioned
            // Dialogue event per line, spaced by `line_height`, rather
            // than one event with libass's fixed automatic pitch.
            let line_height_px = font_size * caption.line_height;
            let line_count = lines.len() as f64;
            for (line_index, line) in lines.iter().enumerate() {
                let offset = (line_index as f64 - (line_count - 1.0) / 2.0) * line_height_px;
                let y = (pos_y as f64 + offset).round() as i64;
                events.push_str(&format!(
                    "Dialogue: 0,{start},{end},{name},,0,0,0,,{{\\pos({x},{y})}}{text}\n",
                    name = style_name,
                    x = pos_x,
                    text = ass_escape_text(line),
                ));
            }
        }
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

/// libass sizes text from the font file's own design metrics (units-per-em
/// and ascent/descent from the font tables), which can diverge sharply from
/// how a browser's Canvas/DOM text renderer sizes the *same* nominal
/// "Fontsize" for the *same* font file. Measured directly: rendering "MY
/// TURN" through the real subtitles-burn-in pipeline (libass, PlayResX
/// 480/PlayResY 198) at Fontsize 32 and 64 and trimming the actual ink
/// pixels gave 60x16 and 118x32; measuring the identical string via
/// Canvas2D `measureText().actualBoundingBox*` at the same 32px/64px sizes
/// in Chrome (same "Anton" font file) gave ink boxes of 102.7x29 and
/// 205.4x56 — a consistent ~1.75x gap across both sizes and both
/// dimensions (not an additive offset), so a caption that looks a given
/// size in the live preview burns in visibly smaller without this
/// correction. Other fonts haven't shown this gap and stay uncorrected
/// until measured the same way.
fn ass_font_size_multiplier(font_name: &str) -> f64 {
    match font_name {
        "Anton" => 1.75,
        _ => 1.0,
    }
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

/// ASS wraps text based on `PlayResX - MarginL - MarginR`, regardless of
/// where `\pos` anchors the caption — so to get a wrap box that's
/// `width` wide and centered on `x` (matching the frontend's resizable
/// caption box, itself centered at `x`), the margins have to be derived
/// from both, not just hardcoded. Clamps to the frame edges if the box
/// would otherwise overflow them.
fn ass_margins(x: f64, width: f64, frame_width: i64) -> (i64, i64) {
    let half = (width / 2.0).max(0.0);
    let left_edge = (x - half).clamp(0.0, 1.0);
    let right_edge = (x + half).clamp(0.0, 1.0);
    let margin_l = (left_edge * frame_width as f64).round() as i64;
    let margin_r = ((1.0 - right_edge) * frame_width as f64).round() as i64;
    (margin_l, margin_r)
}

/// `None` = no outline (optional per user request): zero-width outline is
/// invisible regardless of colour, so the colour value doesn't matter in
/// that case — still emits a valid ASS colour rather than an empty field.
fn ass_outline(outline_color: &Option<String>) -> (String, i64) {
    match outline_color {
        Some(color) => (ass_color(color), 2),
        None => ("&H00000000".to_string(), 0),
    }
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
            width: 0.6,
            outline_color: Some("#000000".to_string()),
            line_height: 0.65,
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
    fn generate_ass_positions_each_line_of_a_multiline_caption_separately() {
        // No longer joined into one \N Dialogue — libass's automatic line
        // pitch can't be decoupled from font size (see `line_height`'s doc
        // comment), so each line is its own positioned event instead.
        let mut c = caption("c1", 0.0, 1.0, "line one\nline two");
        c.x = 0.5;
        c.y = 0.5;
        c.font_size = 28.0;
        c.line_height = 0.65;
        let ass = generate_ass(&[c], 0.0, 2.0, 640, 360);

        assert!(!ass.contains("\\N"));
        // pos_y = round(0.5*360) = 180; line_height_px = 28*0.65 = 18.2;
        // offsets = ∓9.1 -> 170.9/189.1, rounding to 171/189.
        assert!(ass.contains("Dialogue: 0,0:00:00.00,0:00:01.00,cap0,,0,0,0,,{\\pos(320,171)}line one"));
        assert!(ass.contains("Dialogue: 0,0:00:00.00,0:00:01.00,cap0,,0,0,0,,{\\pos(320,189)}line two"));
    }

    #[test]
    fn generate_ass_spaces_multiline_lines_by_the_line_height_multiplier() {
        let mut c = caption("c1", 0.0, 1.0, "a\nb");
        c.font_size = 100.0;
        c.line_height = 1.0;
        c.y = 0.5;
        let ass = generate_ass(&[c], 0.0, 2.0, 640, 360);

        // pos_y = 180, line_height_px = 100*1.0 = 100 -> +/-50.
        assert!(ass.contains("{\\pos(320,130)}a"));
        assert!(ass.contains("{\\pos(320,230)}b"));
    }

    #[test]
    fn generate_ass_leaves_a_single_line_caption_as_one_dialogue_event() {
        let c = caption("c1", 0.0, 1.0, "one line only");
        let ass = generate_ass(&[c], 0.0, 2.0, 640, 360);

        assert_eq!(ass.matches("Dialogue:").count(), 1);
    }

    #[test]
    fn generate_ass_with_no_captions_is_still_a_valid_skeleton() {
        let ass = generate_ass(&[], 0.0, 5.0, 640, 360);
        assert!(ass.contains("[Script Info]"));
        assert!(ass.contains("[V4+ Styles]"));
        assert!(ass.contains("[Events]"));
    }

    #[test]
    fn ass_margins_centers_the_wrap_box_around_x() {
        // width=0.6 centered at x=0.5 on a 640-wide frame -> a 384px box
        // with 128px on each side.
        assert_eq!(ass_margins(0.5, 0.6, 640), (128, 128));
    }

    #[test]
    fn ass_margins_clamps_to_the_frame_edge_instead_of_going_negative() {
        // A box centered near the left edge would want a negative left
        // margin; clamp to 0 instead of producing a nonsensical value.
        let (margin_l, margin_r) = ass_margins(0.1, 0.6, 640);
        assert_eq!(margin_l, 0);
        assert_eq!(margin_r, 384); // (1 - (0.1+0.3)) * 640
    }

    #[test]
    fn ass_outline_is_invisible_but_present_when_none() {
        assert_eq!(ass_outline(&None), ("&H00000000".to_string(), 0));
    }

    #[test]
    fn ass_outline_uses_the_requested_color_and_a_visible_width_when_some() {
        assert_eq!(
            ass_outline(&Some("#ff0000".to_string())),
            ("&H000000FF".to_string(), 2)
        );
    }

    #[test]
    fn generate_ass_reflects_caption_width_in_the_style_margins() {
        let mut c = caption("c1", 0.0, 1.0, "hi");
        c.width = 0.6;
        let ass = generate_ass(&[c], 0.0, 2.0, 640, 360);

        // x=0.5, width=0.6, frame_width=640 -> margins of 128,128 (see
        // ass_margins_centers_the_wrap_box_around_x).
        assert!(ass.contains(",128,128,10,1"));
    }

    #[test]
    fn generate_ass_omits_the_outline_when_outline_color_is_none() {
        let mut c = caption("c1", 0.0, 1.0, "hi");
        c.outline_color = None;
        let ass = generate_ass(&[c], 0.0, 2.0, 640, 360);

        // Outline width 0 right after BorderStyle=1.
        assert!(ass.contains(",1,0,0,5,"));
    }

    #[test]
    fn generate_ass_scales_up_anton_fontsize_to_match_the_browser_preview() {
        let mut c = caption("c1", 0.0, 1.0, "hi");
        c.font_family = "Anton, sans-serif".to_string();
        c.font_size = 64.0;
        let ass = generate_ass(&[c], 0.0, 2.0, 640, 360);

        assert!(ass.contains("Style: cap0,Anton,112,")); // 64 * 1.75 = 112
    }

    #[test]
    fn generate_ass_leaves_other_fonts_fontsize_unscaled() {
        let mut c = caption("c1", 0.0, 1.0, "hi");
        c.font_family = "Georgia".to_string();
        c.font_size = 64.0;
        let ass = generate_ass(&[c], 0.0, 2.0, 640, 360);

        assert!(ass.contains("Style: cap0,Georgia,64,"));
    }

    #[test]
    fn generate_ass_applies_the_requested_outline_color() {
        let mut c = caption("c1", 0.0, 1.0, "hi");
        c.outline_color = Some("#ff0000".to_string());
        let ass = generate_ass(&[c], 0.0, 2.0, 640, 360);

        // PrimaryColour, SecondaryColour, then OutlineColour = red-in-ABGR.
        assert!(ass.contains("&H00FFFFFF,&H000000FF,&H000000FF,&H00000000"));
    }
}
