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
// /api/videos/{id}/template`. `name`/`is_public` are real `templates`
// columns, not part of this payload blob — see api.ts's `putTemplate`.
export interface TemplatePayload {
  captions: Caption[]
  gif_range_start: number
  gif_range_end: number
  width: number
  height: number
}

// Public templates (pass 2) — `GET /api/templates/mine` and `/others` row
// shape, matching the backend's `TemplateSummary`. Drives the New GIF
// page's template grid.
export interface TemplateSummary {
  id: string
  name: string
  is_public: boolean
  saved_at: string
  duration_seconds: number
  caption_count: number
  // The first caption's text (already trimmed), if any — overlaid on the
  // tile's thumbnail in the caption style so templates are tellable apart
  // while browsing, without opening each one.
  first_caption_text: string | null
  // Only ever set on an "others" row — `null` for your own templates,
  // which need no attribution shown.
  owner_handle: string | null
}

// `GET /api/templates/{id}` — matching the backend's `TemplateDetail`.
// What the "use this template" flow (flow B) needs to seed a locked-range
// editor session: captions/dimensions, but deliberately no trim range to
// edit (the frontend derives its `[0, duration_seconds]` timeline from
// `duration_seconds` alone).
export interface TemplateDetail {
  id: string
  name: string
  is_public: boolean
  saved_at: string
  duration_seconds: number
  width: number
  height: number
  captions: Caption[]
  owner_handle: string | null
  // Whether the current viewer is the template's creator — gates the New
  // GIF page's rename/publish-toggle/delete controls.
  is_own: boolean
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
  displayName: string | null
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
  // Lineage to the template this gif was exported from via flow B
  // ("start from a template") — `null` for a gif made directly from a
  // video (flow A), even when that video has its own saved template.
  // Never shown as attribution, only drives the Remix button below.
  template_id: string | null
  // Per-viewer, like `is_favourited`: whether "Remix this GIF" should
  // show — `true` only while `template_id`'s template is still
  // accessible to the current viewer (public, or owned by them).
  // Server-computed so it disappears cleanly the moment the template is
  // deleted or made private.
  template_remixable: boolean
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

// Shared shape for `GET /api/gifs` and `GET /api/library` — 24 items per
// page (backend's `db::PAGE_SIZE`), `has_more` tells the caller whether a
// `page + 1` request would return anything, and `total` is the real
// matching row count (scoped by owner/`is_public` and any search `q`,
// same as `items`) — for display (a sidebar badge, a page header), never
// for paging logic.
export interface Page<T> {
  items: T[]
  has_more: boolean
  total: number
}

// `GET/POST/PATCH /api/collections` response shape (collections-design/
// COLLECTIONS.md §1) — camelCase, matching the backend's `Collection`.
// `kind` is `'favourites'` for the one reserved, un-renameable/
// undeletable collection every user has, `'custom'` for the rest.
export interface Collection {
  id: string
  ownerId: string
  name: string
  kind: 'favourites' | 'custom'
  createdAt: string
  updatedAt: string
}

// `GET /api/collections` row shape — a `Collection` plus how many of its
// gifs are currently visible to the caller (a collected gif someone else
// made private, or deleted, silently drops out of this count without
// removing the membership row — collections-design/COLLECTIONS.md §2).
export interface CollectionWithCount extends Collection {
  gifCount: number
}

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

// GET /api/admin/actions response row — matching the backend's
// `AdminActionView`. `details` is a raw JSON string (see migration
// `0020_admin_actions.sql`), parsed for display, not typed per action.
export interface AdminActionView {
  id: string
  admin_user_id: string
  action_type: string
  target_id: string
  details: string
  created_at: string
}
