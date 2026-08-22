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
}

fn default_caption_width() -> f64 {
    0.6
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
    pub gif_range_start: f64,
    pub gif_range_end: f64,
    pub width: i64,
    pub height: i64,
    pub created_at: String,
}

pub struct NewGif {
    pub id: String,
    pub video_id: Option<String>,
    pub name: String,
    pub caption_text: String,
    pub captions_json: Option<String>,
    pub gif_range_start: f64,
    pub gif_range_end: f64,
    pub width: i64,
    pub height: i64,
}
