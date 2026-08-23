import type { Caption, FilmstripMeta, Gif, Video } from './types'

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${input} failed (${response.status}): ${body || response.statusText}`)
  }
  return (await response.json()) as T
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
  const response = await fetch(`/api/videos/${id}`, { method: 'DELETE' })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`/api/videos/${id} failed (${response.status}): ${body || response.statusText}`)
  }
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

export async function deleteGif(id: string): Promise<void> {
  const response = await fetch(`/api/gifs/${id}`, { method: 'DELETE' })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`/api/gifs/${id} failed (${response.status}): ${body || response.statusText}`)
  }
}

// Bulk import per SPEC.md §7 — multiple files in one multipart request,
// each field named "files" (reusing the video-upload multipart pattern,
// extended to multi-file), returning the array of created gif rows.
export function importGifs(files: File[]): Promise<Gif[]> {
  const body = new FormData()
  for (const file of files) body.append('files', file, file.name)
  return request<Gif[]>('/api/gifs/import', { method: 'POST', body })
}
