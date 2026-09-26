import type {
  AdminUserView,
  Caption,
  CurrentUser,
  FilmstripMeta,
  Gif,
  LibraryEntry,
  LibrarySort,
  Preferences,
  Profile,
  TemplatePayload,
  Video,
} from './types'

// Deliberately doesn't include the request URL/route — that's an
// implementation detail, not something a user should see in an error
// message.
async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return
  const body = await response.text().catch(() => '')
  throw new Error(`Request failed (${response.status}): ${body || response.statusText}`)
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  await throwIfNotOk(response)
  return (await response.json()) as T
}

// Auth per SPEC-CLOUD.md §2. Sign-in itself isn't a fetch call — it's a
// full-page navigation to `/api/auth/login`, which redirects on to
// Google, since the whole point is the browser following Google's own
// sign-in UI.
export const LOGIN_URL = '/api/auth/login'

export function getCurrentUser(): Promise<CurrentUser | null> {
  return request<CurrentUser | null>('/api/auth/me')
}

export async function logout(): Promise<void> {
  const input = '/api/auth/logout'
  await throwIfNotOk(await fetch(input, { method: 'POST' }))
}

// SPEC-CLOUD.md §5: a handle can only ever be set once — a second call
// 409s, which the caller surfaces as an error like any other failed request.
export function setHandle(handle: string): Promise<CurrentUser> {
  return request<CurrentUser>('/api/users/me/handle', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle }),
  })
}

// The Preferences page's one write endpoint — reads come bundled onto
// `getCurrentUser()`'s response instead (`CurrentUser.preferences`), so
// there's no separate `getPreferences`.
export function updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  return request<Preferences>('/api/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disable_gif_autoplay: patch.disableGifAutoplay }),
  })
}

export function getProfile(handle: string): Promise<Profile> {
  return request<Profile>(`/api/profiles/${encodeURIComponent(handle)}`)
}

export function listVideos(): Promise<Video[]> {
  return request<Video[]>('/api/videos')
}

export function getVideo(id: string): Promise<Video> {
  return request<Video>(`/api/videos/${id}`)
}

export function uploadVideo(file: File): Promise<Video> {
  const body = new FormData()
  body.append('file', file, file.name)
  return request<Video>('/api/videos', { method: 'POST', body })
}

export async function deleteVideo(id: string): Promise<void> {
  const input = `/api/videos/${id}`
  await throwIfNotOk(await fetch(input, { method: 'DELETE' }))
}

export function getFilmstripMeta(id: string): Promise<FilmstripMeta> {
  return request<FilmstripMeta>(`/api/videos/${id}/filmstrip`)
}

export function thumbnailUrl(id: string): string {
  return `/api/videos/${id}/thumbnail`
}

export function videoFileUrl(id: string): string {
  return `/api/videos/${id}/file`
}

// Body shape per SPEC.md §5 "Exports": snake_case fields at the top level
// (matching the `gifs` table columns), a camelCase `captions` array
// (matching the caption data structure in §4).
export interface ExportRequest {
  video_id: string
  name: string
  // The "Create template" checkbox — must ride along with the export
  // request itself rather than a separate follow-up PUT after it
  // completes, since a video not saved as a template doesn't survive
  // past its export (see CaptionEditor's makeGif, which relies on this
  // instead of calling putTemplate after the fact).
  save_as_template?: boolean
  captions: Caption[]
  gif_range_start: number
  gif_range_end: number
}

export interface ExportAccepted {
  export_id: string
}

export function createExport(req: ExportRequest): Promise<ExportAccepted> {
  return request<ExportAccepted>('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
}

// Stage names per SPEC.md §6 — each is its own named SSE event carrying
// `{ percent }`, ending with a `complete` event carrying the full `gifs`
// row (or an `error` event with `{ message }` on failure).
const EXPORT_STAGES = ['palette_gen', 'encoding_gif', 'encoding_mp4', 'encoding_webm', 'uploading'] as const

export interface ExportProgressHandlers {
  onProgress?: (stage: (typeof EXPORT_STAGES)[number], percent: number) => void
  onComplete?: (gif: Gif) => void
  onError?: (message: string) => void
}

/** Subscribes to an export's progress stream; returns an unsubscribe function. */
export function subscribeExportProgress(exportId: string, handlers: ExportProgressHandlers): () => void {
  const source = new EventSource(`/api/exports/${exportId}/progress`)

  for (const stage of EXPORT_STAGES) {
    source.addEventListener(stage, (e) => {
      const { percent } = JSON.parse((e as MessageEvent).data) as { percent: number }
      handlers.onProgress?.(stage, percent)
    })
  }

  source.addEventListener('complete', (e) => {
    const gif = JSON.parse((e as MessageEvent).data) as Gif
    handlers.onComplete?.(gif)
    source.close()
  })

  source.addEventListener('error', (e) => {
    // A plain browser connection-drop also fires as an 'error' event, but
    // without `.data` (it isn't a real MessageEvent) — only a pipeline
    // failure the server actually reported carries JSON here.
    const raw = (e as MessageEvent).data
    if (raw) {
      const { message } = JSON.parse(raw) as { message: string }
      handlers.onError?.(message)
      source.close()
    }
  })

  return () => source.close()
}

// Archive endpoints per SPEC.md §5/§8.

export function listGifs(q?: string): Promise<Gif[]> {
  const query = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''
  return request<Gif[]>(`/api/gifs${query}`)
}

export function getGif(id: string): Promise<Gif> {
  return request<Gif>(`/api/gifs/${id}`)
}

export function renameGif(id: string, name: string): Promise<Gif> {
  return request<Gif>(`/api/gifs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

// SPEC.md §8: toggles the "one-off" flag — the same button flips it back
// to `false` to return a GIF to the reusable group.
export function setGifOneOff(id: string, isOneOff: boolean): Promise<Gif> {
  return request<Gif>(`/api/gifs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_one_off: isOneOff }),
  })
}

// SPEC-CLOUD.md §4/§8: opts a gif into (or out of) the global library and
// the owner's public profile.
export function setGifPublic(id: string, isPublic: boolean): Promise<Gif> {
  return request<Gif>(`/api/gifs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_public: isPublic }),
  })
}

// SPEC-CLOUD.md §8: the global library — every user's public gifs, no
// sign-in required. `sort` defaults to newest-first on the backend when
// omitted.
export function listLibrary(q?: string, sort?: LibrarySort): Promise<LibraryEntry[]> {
  const params = new URLSearchParams()
  if (q?.trim()) params.set('q', q.trim())
  if (sort) params.set('sort', sort)
  const query = params.toString()
  return request<LibraryEntry[]>(`/api/library${query ? `?${query}` : ''}`)
}

// SPEC-CLOUD.md §8: bumps a gif's use counter — fired by copy-link,
// copy-embed, and download, with no dedup. Returns the updated row so
// callers can update their local count without a separate re-fetch.
export function recordGifUse(id: string): Promise<Gif> {
  return request<Gif>(`/api/gifs/${id}/use`, { method: 'POST' })
}

export async function deleteGif(id: string): Promise<void> {
  const input = `/api/gifs/${id}`
  await throwIfNotOk(await fetch(input, { method: 'DELETE' }))
}

// SPEC-CLOUD.md §14: both idempotent, both return the updated gif so
// callers can sync local state without a separate re-fetch — same pattern
// as `recordGifUse`.
export function favouriteGif(id: string): Promise<Gif> {
  return request<Gif>(`/api/gifs/${id}/favourite`, { method: 'POST' })
}

export function unfavouriteGif(id: string): Promise<Gif> {
  return request<Gif>(`/api/gifs/${id}/favourite`, { method: 'DELETE' })
}

// SPEC-CLOUD.md §14: the caller's saved gifs, newest-favourited first, in
// the same attributed shape as `listLibrary`.
export function listFavourites(): Promise<LibraryEntry[]> {
  return request<LibraryEntry[]>('/api/favourites')
}

// Bulk import per SPEC.md §7 — multiple files in one multipart request,
// each field named "files" (reusing the video-upload multipart pattern,
// extended to multi-file), returning the array of created gif rows.
export function importGifs(files: File[]): Promise<Gif[]> {
  const body = new FormData()
  for (const file of files) body.append('files', file, file.name)
  return request<Gif[]>('/api/gifs/import', { method: 'POST', body })
}

// Link import per SPEC.md §13 — a pure hotlink, never downloaded/re-hosted.
export function linkGif(url: string, name: string): Promise<Gif> {
  return request<Gif>('/api/gifs/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, name }),
  })
}

// Video templates per SPEC.md §12.

export async function getTemplate(videoId: string): Promise<TemplatePayload | null> {
  const input = `/api/videos/${videoId}/template`
  const response = await fetch(input)
  if (response.status === 404) return null
  await throwIfNotOk(response)
  return (await response.json()) as TemplatePayload
}

export function putTemplate(videoId: string, payload: TemplatePayload): Promise<TemplatePayload> {
  return request<TemplatePayload>(`/api/videos/${videoId}/template`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function deleteTemplate(videoId: string): Promise<void> {
  const input = `/api/videos/${videoId}/template`
  await throwIfNotOk(await fetch(input, { method: 'DELETE' }))
}

// Admin area per SPEC-CLOUD.md §7 — every user plus per-user usage stats,
// and the one urgent action (disable/re-enable) if a bad actor shows up.

export function listAdminUsers(): Promise<AdminUserView[]> {
  return request<AdminUserView[]>('/api/admin/users')
}

export function setUserDisabled(id: string, disabled: boolean): Promise<{ id: string; disabled: boolean }> {
  return request<{ id: string; disabled: boolean }>(`/api/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled }),
  })
}

// Admin-scoped equivalent of `deleteGif` — no ownership check, so an admin
// can remove any user's gif (design brief §5: the Global Library's Delete
// action, admin-only).
export async function adminDeleteGif(id: string): Promise<void> {
  const input = `/api/admin/gifs/${id}`
  await throwIfNotOk(await fetch(input, { method: 'DELETE' }))
}
