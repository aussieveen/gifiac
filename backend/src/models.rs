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
