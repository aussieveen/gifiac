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

// A user's Preferences-page settings (bundled onto `CurrentUser` rather
// than fetched separately — see `CurrentUser.preferences`). camelCase,
// matching the backend's `PreferencesView`.
export interface Preferences {
  // The Preferences section's first option: stop gifs autoplaying/looping
  // unsolicited in grid/library views. The detail pane always loops
  // regardless of this setting.
  disableGifAutoplay: boolean
}

// GET /api/auth/me response shape (SPEC-CLOUD.md §2) — camelCase, matching
// the backend's `CurrentUserView`. `null` overall means logged out.
export interface CurrentUser {
  id: string
  handle: string | null
  // The real, possibly collision-suffixed profile-URL slug (migration
  // 0012) — always use this (never derive one from `handle`) when
  // building a `/u/:slug` link; see handles.ts's `profileUrl`.
  slug: string | null
  role: string
  avatarUrl: string | null
  // SPEC-CLOUD.md §5: a slugified guess at a handle, computed server-side
  // from the Google display name — only meaningful while `handle` is
  // still null, to prefill the handle picker.
  suggestedHandle: string | null
  preferences: Preferences
}

// GET /api/profiles/{handle} response shape (SPEC-CLOUD.md §5) —
// camelCase, matching the backend's `ProfileResponse`.
export interface Profile {
  handle: string
  avatarUrl: string | null
  gifs: Gif[]
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
  // Whether this GIF has been marked "unlikely to be reused" (toggled via
  // `PATCH /api/gifs/{id}`) — sorts to the bottom of the archive, behind
  // a "One-offs" divider (SPEC.md §8).
  is_one_off: boolean
  // Opted into the global library and the owner's public profile
  // (SPEC-CLOUD.md §4/§8), toggled via the same `PATCH /api/gifs/{id}`.
  is_public: boolean
  // Bumped by `POST /api/gifs/{id}/use` (SPEC-CLOUD.md §8) every time a
  // copy-link/copy-embed/download action fires — no dedup, auth only.
  use_count: number
  // Per-viewer, not a property of the gif itself (SPEC-CLOUD.md §14) —
  // whether the signed-in caller has saved this gif. `false` for every
  // gif when the caller is logged out.
  is_favourited: boolean
  gif_url?: string
  // `null` (not just absent) for a linked GIF — see GifResponse in the
  // backend, which always includes these keys, `null` or not.
  mp4_url?: string | null
  webm_url?: string | null
  // A linked gif's generated poster frame — only present once generation
  // succeeds; `null`/absent while pending, on failure, or for a non-linked
  // gif (which needs no thumbnail at all, mp4_url/webm_url cover it).
  thumbnail_url?: string | null
}

// GET /api/library response shape (SPEC-CLOUD.md §8) — a Gif plus its
// creator's handle for attribution. snake_case, matching the backend's
// `LibraryEntry` (which flattens `GifResponse`, itself snake_case).
export interface LibraryEntry extends Gif {
  owner_handle: string | null
  // The owner's real profile-URL slug (migration 0012) — see
  // `CurrentUser.slug`'s comment; use this, not `owner_handle`, for the
  // attribution link.
  owner_slug: string | null
}

// `GET /api/library?sort=` (SPEC-CLOUD.md §8) — matching the backend's
// `LibrarySort`, kebab-case on the wire.
export type LibrarySort = 'newest' | 'most-used'

// GET /api/admin/users response row (SPEC-CLOUD.md §7) — snake_case,
// matching the backend's `AdminUserView`.
export interface AdminUserView {
  id: string
  handle: string | null
  email: string | null
  avatar_url: string | null
  role: string
  disabled: boolean
  created_at: string
  gif_count: number
  latest_gif_at: string | null
}
