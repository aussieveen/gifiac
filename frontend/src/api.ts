import type { Caption, FilmstripMeta, Video } from './types'

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

export function getFilmstripMeta(id: string): Promise<FilmstripMeta> {
  return request<FilmstripMeta>(`/api/videos/${id}/filmstrip`)
}

export function thumbnailUrl(id: string): string {
  return `/api/videos/${id}/thumbnail`
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
