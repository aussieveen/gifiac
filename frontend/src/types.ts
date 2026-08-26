// Caption data structure per SPEC.md §4 — produced by the editor, consumed
// by the export pipeline and the API. Field names are camelCase exactly as
// given there. `width` and `outlineColor` extend the original spec
// (user-requested: a resizable text box so long captions can be kept on
// one line, and an optional colored outline).
export interface Caption {
  id: string
  startTime: number // seconds, relative to the source clip
  endTime: number // seconds
  text: string
  fontFamily: string
  fontSize: number
  color: string // hex
  align: 'left' | 'center' | 'right'
  x: number // 0-1 fractional position within the frame
  y: number // 0-1 fractional position within the frame
  width: number // 0-1 fractional box width, centered on x — controls text wrap
  outlineColor: string | null // hex, or null for no outline
  lineHeight: number // multiplier of fontSize -> gap between wrapped lines
}

// `videos` row shape returned by the backend (SPEC.md §2) — snake_case,
// matching the SQLite column names.
export interface Video {
  id: string
  original_filename: string
  extension: string
  file_size_bytes: number
  duration_seconds: number
  width: number
  height: number
  uploaded_at: string
  // SPEC.md §12: only present on `GET /api/videos` list responses, where
  // it's resolved via a join — drives the video-picker's template badge.
  has_template?: boolean
}

// SPEC.md §12: the saved export template payload — `PUT/GET
// /api/videos/{id}/template`. Deliberately excludes `name` (per-GIF, not
// per-template).
export interface TemplatePayload {
  captions: Caption[]
  gif_range_start: number
  gif_range_end: number
  width: number
  height: number
}

// GET /api/videos/{id}/filmstrip response shape (SPEC.md §5) — camelCase.
export interface FilmstripMeta {
  frameCount: number
  cols: number
  rows: number
  frameWidth: number
  frameHeight: number
  interval: number
  imageUrl: string
}

// `gifs` row shape (SPEC.md §2) — snake_case, matching the SQLite column
// names, same convention as `Video`. The `_url` fields are derived by the
// backend (never stored — SPEC.md §9) and only present on responses from
// the archive endpoints (`GET/PATCH /api/gifs...`), not on the export
// pipeline's SSE `complete` event, hence optional here.
export interface Gif {
  id: string
  video_id: string | null
  name: string
  caption_text: string
  captions_json: string | null
  gif_range_start: number | null
  gif_range_end: number | null
  width: number | null
  height: number | null
  // Non-null marks a linked GIF (SPEC.md §13) — hotlinked to a
  // third-party URL, never downloaded or re-hosted on R2.
  external_url: string | null
  created_at: string
  gif_url?: string
  // `null` (not just absent) for a linked GIF — see GifResponse in the
  // backend, which always includes these keys, `null` or not.
  mp4_url?: string | null
  webm_url?: string | null
}
