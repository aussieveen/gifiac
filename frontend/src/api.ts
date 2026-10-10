import type {
  AdminActionView,
  AdminUserView,
  Caption,
  Collection,
  CollectionWithCount,
  CurrentUser,
  FilmstripMeta,
  Gif,
  GifsPage,
  LibraryEntry,
  LibrarySort,
  Page,
  Preferences,
  Profile,
  TemplateDetail,
  TemplatePayload,
  TemplateSummary,
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

// SPEC-EMAIL-AUTH.md §6/§9: public, non-secret runtime config the sign-in
// screen needs before there's any session — today just whether Turnstile
// is configured (it isn't in local dev/test, where the widget is simply
// not rendered). Also carries the Import GIFs modal's per-GIF size limit,
// served at runtime rather than duplicated as a frontend constant so the
// two can never drift.
export interface AppConfig {
  turnstileSiteKey: string | null
  maxGifBytes: number
}

export function getConfig(): Promise<AppConfig> {
  return request<AppConfig>('/api/config')
}

// The email routes' error bodies are plain text (SPEC-EMAIL-AUTH.md §4:
// the body *is* the machine-readable code, e.g. "invalid_or_expired"),
// with a numeric `Retry-After` header on a 429 and an
// `X-Attempts-Remaining` header on a wrong-code 400 — so these need their
// own error type carrying that structured info, rather than the plain
// `Error`/message string `throwIfNotOk` produces for every other route.
export class EmailAuthError extends Error {
  code: string
  retryAfterSeconds?: number
  attemptsRemaining?: number

  constructor(code: string, retryAfterSeconds?: number, attemptsRemaining?: number) {
    super(code)
    this.name = 'EmailAuthError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
    this.attemptsRemaining = attemptsRemaining
  }
}

async function readEmailAuthError(response: Response): Promise<EmailAuthError> {
  const code = (await response.text().catch(() => '')) || response.statusText
  const retryAfter = response.headers.get('Retry-After')
  const attemptsRemaining = response.headers.get('X-Attempts-Remaining')
  return new EmailAuthError(
    code,
    retryAfter ? Number(retryAfter) : undefined,
    attemptsRemaining ? Number(attemptsRemaining) : undefined,
  )
}

// Starts (or resends) an email-passcode sign-in — 200 on success
// regardless of whether the address is known, disabled, or brand new
// (SPEC-EMAIL-AUTH.md §4). Throws `EmailAuthError` on failure, notably a
// 429 (`retryAfterSeconds`) when the resend cooldown or an hourly limit
// is hit.
export async function startEmailLogin(email: string, turnstileToken: string): Promise<void> {
  const response = await fetch('/api/auth/email/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, turnstileToken }),
  })
  if (!response.ok) throw await readEmailAuthError(response)
}

// Submits the 6-digit code; resolves to the now-signed-in user on
// success (same shape `getCurrentUser` returns). Throws `EmailAuthError`
// with `code` `"invalid_or_expired"` or `"too_many_attempts"` on failure —
// the former carries `attemptsRemaining` when it's a wrong (rather than
// expired/reused) code.
export async function verifyEmailCode(email: string, code: string): Promise<CurrentUser> {
  const response = await fetch('/api/auth/email/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  })
  if (!response.ok) throw await readEmailAuthError(response)
  return (await response.json()) as CurrentUser
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

// Ingest (probe + thumbnail + filmstrip) now runs in the ingest Lambda,
// off the synchronous upload request (wayfinder gifiac#32) — the upload
// returns fast, 202-style, mirroring export's existing `ExportAccepted`
// shape. `job_id` is what `subscribeIngestProgress` subscribes to.
export interface UploadAccepted {
  video_id: string
  job_id: string
}

export function uploadVideo(file: File): Promise<UploadAccepted> {
  const body = new FormData()
  body.append('file', file, file.name)
  return request<UploadAccepted>('/api/videos', { method: 'POST', body })
}

// One of `ingest_jobs.stage`'s non-terminal values, relayed as-is from
// the backend (gifiac#32) — matches `IngestStage` in
// `IngestLoadingModal.tsx` exactly, no translation layer.
export type IngestStage = 'uploading' | 'analyzing' | 'building_filmstrip'

export interface IngestProgressHandlers {
  onStage?: (stage: IngestStage) => void
  onComplete?: (video: Video) => void
  onError?: (message: string) => void
}

/** Subscribes to an ingest job's progress stream; returns an unsubscribe
 * function. Mirrors `subscribeExportProgress`'s shape exactly. */
export function subscribeIngestProgress(jobId: string, handlers: IngestProgressHandlers): () => void {
  const source = new EventSource(`/api/videos/${jobId}/ingest-progress`)

  source.addEventListener('stage', (e) => {
    const { stage } = JSON.parse((e as MessageEvent).data) as { stage: IngestStage }
    handlers.onStage?.(stage)
  })

  source.addEventListener('complete', (e) => {
    const video = JSON.parse((e as MessageEvent).data) as Video
    handlers.onComplete?.(video)
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
  // The "Also save as a template" checkbox in the Make GIF modal — must
  // ride along with the export request itself rather than a separate
  // follow-up PUT after it completes, since a video not saved as a
  // template doesn't survive past its export (see CaptionEditor's
  // makeGif, which relies on this instead of calling putTemplate after
  // the fact).
  save_as_template?: boolean
  // Required whenever `save_as_template` is true — the modal's "Template
  // name" field.
  template_name?: string
  // The modal's "Public template" toggle — only meaningful alongside
  // `save_as_template`.
  template_is_public?: boolean
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

// gif/mp4/webm now encode in 3 parallel Lambda invocations (wayfinder
// gifiac#32) instead of one sequential in-process pipeline — matches
// `ExportFormat` in `ExportProgressModal.tsx` exactly.
export type ExportFormat = 'gif' | 'mp4' | 'webm'

export interface ExportProgressHandlers {
  onProgress?: (format: ExportFormat, percent: number) => void
  onFormatDone?: (format: ExportFormat) => void
  onFormatFailed?: (format: ExportFormat, message: string) => void
  /** The whole job succeeded — at minimum the gif format, which is
   * load-bearing (gifiac#36). */
  onComplete?: (gif: Gif) => void
  /** The whole job failed — gif failed or timed out, regardless of
   * mp4/webm's own outcome. */
  onError?: (message: string) => void
}

/** Subscribes to an export's progress stream; returns an unsubscribe function. */
export function subscribeExportProgress(exportId: string, handlers: ExportProgressHandlers): () => void {
  const source = new EventSource(`/api/exports/${exportId}/progress`)

  source.addEventListener('progress', (e) => {
    const { format, percent } = JSON.parse((e as MessageEvent).data) as { format: ExportFormat; percent: number }
    handlers.onProgress?.(format, percent)
  })

  source.addEventListener('format_done', (e) => {
    const { format } = JSON.parse((e as MessageEvent).data) as { format: ExportFormat }
    handlers.onFormatDone?.(format)
  })

  source.addEventListener('format_failed', (e) => {
    const { format, message } = JSON.parse((e as MessageEvent).data) as { format: ExportFormat; message: string }
    handlers.onFormatFailed?.(format, message)
  })

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

export function listGifs(q?: string, page = 1): Promise<GifsPage> {
  const params: string[] = []
  if (q?.trim()) params.push(`q=${encodeURIComponent(q.trim())}`)
  if (page > 1) params.push(`page=${page}`)
  const query = params.length ? `?${params.join('&')}` : ''
  return request<GifsPage>(`/api/gifs${query}`)
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
export function listLibrary(q?: string, sort?: LibrarySort, page = 1): Promise<Page<LibraryEntry>> {
  const params = new URLSearchParams()
  if (q?.trim()) params.set('q', q.trim())
  if (sort) params.set('sort', sort)
  if (page > 1) params.set('page', String(page))
  const query = params.toString()
  return request<Page<LibraryEntry>>(`/api/library${query ? `?${query}` : ''}`)
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

// Collections (collections-design/COLLECTIONS.md) — named, unordered
// groupings of gifs. Favourites is one of these under the hood (`kind:
// 'favourites'`), surfaced here alongside whatever custom collections
// the caller has created.

export function listCollections(): Promise<CollectionWithCount[]> {
  return request<CollectionWithCount[]>('/api/collections')
}

export function createCollection(name: string): Promise<Collection> {
  return request<Collection>('/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export function renameCollection(id: string, name: string): Promise<Collection> {
  return request<Collection>(`/api/collections/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export async function deleteCollection(id: string): Promise<void> {
  await throwIfNotOk(await fetch(`/api/collections/${id}`, { method: 'DELETE' }))
}

// Same attributed shape as `listLibrary`/`listFavourites` — a collection
// can hold the caller's own gifs and other people's public gifs.
export function listCollectionGifs(id: string, q?: string): Promise<LibraryEntry[]> {
  const query = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''
  return request<LibraryEntry[]>(`/api/collections/${id}/gifs${query}`)
}

export async function addGifToCollection(collectionId: string, gifId: string): Promise<void> {
  await throwIfNotOk(await fetch(`/api/collections/${collectionId}/gifs/${gifId}`, { method: 'POST' }))
}

export async function removeGifFromCollection(collectionId: string, gifId: string): Promise<void> {
  await throwIfNotOk(await fetch(`/api/collections/${collectionId}/gifs/${gifId}`, { method: 'DELETE' }))
}

// For the detail panel's "In collections" chips / "Save to collection"
// picker's checked state — which of the caller's own collections a gif
// is currently in.
export function gifCollectionIds(gifId: string): Promise<string[]> {
  return request<{ collectionIds: string[] }>(`/api/gifs/${gifId}/collections`).then((r) => r.collectionIds)
}

// The Import GIFs modal's Upload tab (SPEC.md §7's import endpoint, one
// file per request so a failure or a progress bar is scoped to that one
// row — see ImportGifsModal.tsx). Needs XMLHttpRequest, not `fetch`:
// there's still no cross-browser way to observe upload progress from a
// `fetch` request body. `onProgress` fires with 0–100; `signal` lets a
// row's × button cancel an in-flight upload the same way link checks do.
export function uploadGifFile(file: File, name: string, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<Gif> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/gifs/import')

    xhr.upload.onprogress = (e) => {
      // `e.total` can undercount the real multipart body slightly (boundary/
      // header overhead isn't always reflected in it consistently across
      // browsers), which can otherwise push this over 100% right at the end.
      if (e.lengthComputable) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((JSON.parse(xhr.responseText) as Gif[])[0])
      } else {
        reject(new Error(xhr.responseText || xhr.statusText))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed.'))
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'))
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Upload aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => xhr.abort())
    }

    const body = new FormData()
    body.append('name', name)
    body.append('files', file, file.name)
    xhr.send(body)
  })
}

// Link import per SPEC.md §13 — a pure hotlink, never downloaded/re-hosted.
export function linkGif(url: string, name: string, isPublic: boolean): Promise<Gif> {
  return request<Gif>('/api/gifs/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, name, is_public: isPublic }),
  })
}

export interface CheckLinkResult {
  width: number
  height: number
  sizeBytes: number
}

// The plain-English reason a link check failed, read straight off the
// response body — see the backend's `routes::gifs::check_link`, which
// owns this exact copy so the modal doesn't have to.
export class LinkCheckError extends Error {}

// The Import GIFs modal's "From links" row check (SPEC.md §13) — never
// creates a gif, just confirms the URL is a reachable GIF under the size
// limit and not already in the caller's library, and reports its
// dimensions/size for the row's "Looks good" line.
export async function checkLink(url: string, signal?: AbortSignal): Promise<CheckLinkResult> {
  const response = await fetch('/api/gifs/check-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new LinkCheckError(body || response.statusText)
  }
  return (await response.json()) as CheckLinkResult
}

// Video templates (flow A: a video's own save/overwrite-in-place
// template) per SPEC.md §12. `getTemplate` is only used today to prefill
// the Make GIF modal's template name when a video already has one.

export async function getTemplate(videoId: string): Promise<TemplatePayload | null> {
  const input = `/api/videos/${videoId}/template`
  const response = await fetch(input)
  if (response.status === 404) return null
  await throwIfNotOk(response)
  return (await response.json()) as TemplatePayload
}

export function putTemplate(
  videoId: string,
  request_: { name: string; is_public: boolean } & TemplatePayload,
): Promise<TemplatePayload> {
  return request<TemplatePayload>(`/api/videos/${videoId}/template`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request_),
  })
}

export async function deleteTemplate(videoId: string): Promise<void> {
  const input = `/api/videos/${videoId}/template`
  await throwIfNotOk(await fetch(input, { method: 'DELETE' }))
}

// Public templates (pass 2) — flow B, "use a template". `routes::templates`
// on the backend.

// The New GIF page's "My templates" tab.
export function listMyTemplates(): Promise<TemplateSummary[]> {
  return request<TemplateSummary[]>('/api/templates/mine')
}

// The New GIF page's "From others" tab — every other user's public
// template.
export function listOtherTemplates(): Promise<TemplateSummary[]> {
  return request<TemplateSummary[]>('/api/templates/others')
}

export function getTemplateDetail(id: string): Promise<TemplateDetail> {
  return request<TemplateDetail>(`/api/templates/${id}`)
}

// Lightweight, owner-only — doesn't touch the saved trim/captions/assets.
export function renameTemplate(id: string, name: string): Promise<TemplateDetail> {
  return request<TemplateDetail>(`/api/templates/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export function setTemplatePublic(id: string, isPublic: boolean): Promise<TemplateDetail> {
  return request<TemplateDetail>(`/api/templates/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_public: isPublic }),
  })
}

export async function deleteTemplateById(id: string): Promise<void> {
  const input = `/api/templates/${id}`
  await throwIfNotOk(await fetch(input, { method: 'DELETE' }))
}

// The template's own self-contained, already-trimmed clip — the flow-B
// editor's `<video>` source, works even without access to the (possibly
// private, possibly someone else's) source video.
export function templateClipUrl(id: string): string {
  return `/api/templates/${id}/clip`
}

export function templateThumbnailUrl(id: string): string {
  return `/api/templates/${id}/thumbnail`
}

export function getTemplateFilmstripMeta(id: string): Promise<FilmstripMeta> {
  return request<FilmstripMeta>(`/api/templates/${id}/meta`)
}

// Flow B's export — deliberately carries no trim range or dimensions;
// those are always locked to the template's own saved values, enforced
// server-side (see `routes::exports::create_template_export`).
export function createTemplateExport(templateId: string, name: string, captions: Caption[]): Promise<ExportAccepted> {
  return request<ExportAccepted>(`/api/templates/${templateId}/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, captions }),
  })
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

// Cascades a full delete of the user and everything they own. Irreversible
// — the confirm dialog in AdminPage is the only gate before this fires.
export async function deleteUser(id: string): Promise<void> {
  const input = `/api/admin/users/${id}`
  await throwIfNotOk(await fetch(input, { method: 'DELETE' }))
}

export function listAdminActions(): Promise<AdminActionView[]> {
  return request<AdminActionView[]>('/api/admin/actions')
}
