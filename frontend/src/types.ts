// Caption data structure per SPEC.md §4 — produced by the editor, consumed
// by the export pipeline and the API. Field names are camelCase exactly as
// given there.
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
