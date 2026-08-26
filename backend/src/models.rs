use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Video {
    pub id: String,
    pub original_filename: String,
    pub extension: String,
    pub file_size_bytes: i64,
    pub duration_seconds: f64,
    pub width: i64,
    pub height: i64,
    pub uploaded_at: String,
}

pub struct NewVideo {
    pub id: String,
    pub original_filename: String,
    pub extension: String,
    pub file_size_bytes: i64,
    pub duration_seconds: f64,
    pub width: i64,
    pub height: i64,
}

/// `GET /api/videos` row shape (SPEC.md §12) — every `Video` field plus
/// `has_template`, resolved via a join so the video-picker badge doesn't
/// need a separate round-trip per video.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct VideoListItem {
    pub id: String,
    pub original_filename: String,
    pub extension: String,
    pub file_size_bytes: i64,
    pub duration_seconds: f64,
    pub width: i64,
    pub height: i64,
    pub uploaded_at: String,
    pub has_template: bool,
}

/// A video's saved export template (SPEC.md §12) — one per video, upserted
/// via `PUT /api/videos/{id}/template`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct VideoTemplate {
    pub video_id: String,
    pub payload_json: String,
    pub saved_at: String,
}

/// The template's actual saved content, serialized into `payload_json`.
/// snake_case at the top level (matching the `gifs` table columns, same
/// convention as `ExportRequest`), camelCase `captions` (matching §4) via
/// `Caption`'s own rename. Deliberately excludes `name` — SPEC.md §12: "The
/// GIF `name` is not stored (it's per-GIF, not per-template)."
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TemplatePayload {
    pub captions: Vec<Caption>,
    pub gif_range_start: f64,
    pub gif_range_end: f64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilmstripMeta {
    pub frame_count: u32,
    pub cols: u32,
    pub rows: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    pub interval: f64,
    pub image_url: String,
}

/// Caption data structure per SPEC.md §4 — camelCase on the wire, produced
/// by the frontend editor and consumed here by the ASS subtitle generator.
/// `width` and `outline_color` extend the original spec (user-requested:
/// a resizable text box so long captions can be kept on one line, and an
/// optional colored outline).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub id: String,
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
    pub font_family: String,
    pub font_size: f64,
    pub color: String,
    pub align: CaptionAlign,
    pub x: f64,
    pub y: f64,
    /// Caption box width, as a 0-1 fraction of the frame width, centered
    /// on `x`. Controls where text wraps — a wider box fits more text on
    /// one line. Defaulted (rather than required) so a request that omits
    /// it — an older client, a hand-built request — still deserializes.
    #[serde(default = "default_caption_width")]
    pub width: f64,
    /// `None` = no outline (optional, per user request — not every
    /// caption should be forced to have one). `#[serde(default)]` so a
    /// missing key means "no outline" rather than a deserialize error.
    #[serde(default)]
    pub outline_color: Option<String>,
    /// Multiplier applied to the (already font-size-corrected) ASS font
    /// size to get the pixel distance between line centers, for captions
    /// with more than one line (split on literal newlines in `text`).
    /// User-requested: ASS/libass has no native line-spacing control
    /// independent of font size (verified directly — `\fscy` scales both
    /// together, no combination decouples them), so multi-line captions
    /// render each line as its own positioned Dialogue event instead of
    /// relying on libass's fixed automatic line pitch, which measured at
    /// roughly a 1.0 multiplier here — and which is exactly what the user
    /// asked to have reduced, so `0.65` is the new default rather than a
    /// value that reproduces the old (complained-about) spacing.
    #[serde(default = "default_line_height")]
    pub line_height: f64,
}

fn default_caption_width() -> f64 {
    0.6
}

fn default_line_height() -> f64 {
    0.65
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionAlign {
    Left,
    Center,
    Right,
}

/// POST /api/exports body per SPEC.md §5 — snake_case top level (matching
/// the `gifs` table columns), camelCase `captions` (matching §4).
#[derive(Debug, Deserialize)]
pub struct ExportRequest {
    pub video_id: String,
    pub name: String,
    pub captions: Vec<Caption>,
    pub gif_range_start: f64,
    pub gif_range_end: f64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Gif {
    pub id: String,
    pub video_id: Option<String>,
    pub name: String,
    pub caption_text: String,
    pub captions_json: Option<String>,
    /// `None` for a linked GIF (SPEC.md §13) — it has no source clip range.
    pub gif_range_start: Option<f64>,
    pub gif_range_end: Option<f64>,
    /// `None` for a linked GIF — not dimension-probed; the frontend sizes
    /// its thumbnail from the live image's natural dimensions instead.
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// Non-`None` marks a linked GIF: hotlinked to a third-party URL,
    /// never downloaded or re-hosted on R2 (SPEC.md §13).
    pub external_url: Option<String>,
    pub created_at: String,
}

impl Gif {
    /// SPEC.md §13: whether this is a linked GIF — hotlinked to a
    /// third-party URL, with no R2 objects of its own to derive/clean up.
    pub fn is_linked(&self) -> bool {
        self.external_url.is_some()
    }
}

pub struct NewGif {
    pub id: String,
    pub video_id: Option<String>,
    pub name: String,
    pub caption_text: String,
    pub captions_json: Option<String>,
    pub gif_range_start: Option<f64>,
    pub gif_range_end: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub external_url: Option<String>,
}
