import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExport, getFilmstripMeta, listVideos, thumbnailUrl, uploadVideo } from './api'
import type { Caption } from './types'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listVideos', () => {
  it('GETs /api/videos and returns the parsed array', async () => {
    const videos = [{ id: 'v1' }]
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(videos))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listVideos()).resolves.toEqual(videos)
    expect(fetchMock).toHaveBeenCalledWith('/api/videos', undefined)
  })

  it('rejects with the response body on a non-ok status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listVideos()).rejects.toThrow(/500/)
  })
})

describe('uploadVideo', () => {
  it('POSTs the file as multipart form data under the "file" field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'v1' }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['bytes'], 'clip.mp4', { type: 'video/mp4' })

    await uploadVideo(file)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/videos')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    const submitted = (init.body as FormData).get('file') as File
    expect(submitted.name).toBe('clip.mp4')
    expect(submitted.type).toBe('video/mp4')
  })
})

describe('getFilmstripMeta', () => {
  it('GETs the per-video filmstrip endpoint', async () => {
    const meta = { frameCount: 40, cols: 7, rows: 6, frameWidth: 160, frameHeight: 90, interval: 0.25, imageUrl: '/x' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(meta))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getFilmstripMeta('abc')).resolves.toEqual(meta)
    expect(fetchMock).toHaveBeenCalledWith('/api/videos/abc/filmstrip', undefined)
  })
})

describe('thumbnailUrl', () => {
  it('builds the thumbnail path for a video id', () => {
    expect(thumbnailUrl('abc')).toBe('/api/videos/abc/thumbnail')
  })
})

describe('createExport', () => {
  it('POSTs JSON with the snake_case export fields and camelCase captions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ export_id: 'e1' }))
    vi.stubGlobal('fetch', fetchMock)
    const captions: Caption[] = [
      {
        id: 'c1',
        startTime: 0.5,
        endTime: 2.5,
        text: 'hi',
        fontFamily: 'Impact, sans-serif',
        fontSize: 28,
        color: '#fff',
        align: 'center',
        x: 0.5,
        y: 0.88,
      },
    ]

    const result = await createExport({
      video_id: 'v1',
      name: 'my gif',
      captions,
      gif_range_start: 1,
      gif_range_end: 4,
    })

    expect(result).toEqual({ export_id: 'e1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/exports')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({
      video_id: 'v1',
      name: 'my gif',
      captions,
      gif_range_start: 1,
      gif_range_end: 4,
    })
  })
})
