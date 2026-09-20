import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createExport,
  deleteGif,
  deleteTemplate,
  getFilmstripMeta,
  getGif,
  getTemplate,
  importGifs,
  linkGif,
  listGifs,
  listVideos,
  putTemplate,
  renameGif,
  subscribeExportProgress,
  thumbnailUrl,
  uploadVideo,
  videoFileUrl,
} from './api'
import type { Caption, TemplatePayload } from './types'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  private listeners: Record<string, Array<(e: MessageEvent) => void>> = {}

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    ;(this.listeners[type] ??= []).push(handler)
  }

  close() {
    this.closed = true
  }

  emit(type: string, data?: string) {
    for (const handler of this.listeners[type] ?? []) {
      handler({ data } as MessageEvent)
    }
  }
}

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

describe('videoFileUrl', () => {
  it('builds the raw video file path for a video id', () => {
    expect(videoFileUrl('abc')).toBe('/api/videos/abc/file')
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
        width: 0.6,
        outlineColor: '#000000',
        lineHeight: 0.65,
        locked: false,
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

describe('listGifs', () => {
  it('GETs /api/gifs with no query string when q is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await listGifs()

    expect(fetchMock).toHaveBeenCalledWith('/api/gifs', undefined)
  })

  it('appends an encoded q param when a search term is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await listGifs('cat & dog')

    expect(fetchMock).toHaveBeenCalledWith('/api/gifs?q=cat%20%26%20dog', undefined)
  })

  it('omits the query string when q is only whitespace', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await listGifs('   ')

    expect(fetchMock).toHaveBeenCalledWith('/api/gifs', undefined)
  })
})

describe('getGif', () => {
  it('GETs the single-gif endpoint', async () => {
    const gif = { id: 'g1' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(gif))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGif('g1')).resolves.toEqual(gif)
    expect(fetchMock).toHaveBeenCalledWith('/api/gifs/g1', undefined)
  })
})

describe('renameGif', () => {
  it('PATCHes the name as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'g1', name: 'new name' }))
    vi.stubGlobal('fetch', fetchMock)

    await renameGif('g1', 'new name')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/gifs/g1')
    expect(init.method).toBe('PATCH')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ name: 'new name' })
  })
})

describe('deleteGif', () => {
  it('DELETEs the gif', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await deleteGif('g1')

    expect(fetchMock).toHaveBeenCalledWith('/api/gifs/g1', { method: 'DELETE' })
  })

  it('throws on a non-ok status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteGif('g1')).rejects.toThrow(/500/)
  })
})

describe('importGifs', () => {
  it('POSTs each file as multipart form data under the "files" field', async () => {
    const created = [{ id: 'g1' }, { id: 'g2' }]
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(created))
    vi.stubGlobal('fetch', fetchMock)
    const files = [
      new File(['a'], 'a.gif', { type: 'image/gif' }),
      new File(['b'], 'b.gif', { type: 'image/gif' }),
    ]

    const result = await importGifs(files)

    expect(result).toEqual(created)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/gifs/import')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    const submitted = (init.body as FormData).getAll('files') as File[]
    expect(submitted.map((f) => f.name)).toEqual(['a.gif', 'b.gif'])
  })
})

describe('linkGif', () => {
  it('POSTs the url and name as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'g1', external_url: 'https://example.com/a.gif' }))
    vi.stubGlobal('fetch', fetchMock)

    await linkGif('https://example.com/a.gif', 'a gif')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/gifs/link')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://example.com/a.gif', name: 'a gif' })
  })

  it('rejects with the response body on a non-ok status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not an image', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(linkGif('https://example.com/a.gif', 'a gif')).rejects.toThrow(/not an image/)
  })
})

describe('getTemplate', () => {
  it('GETs the template endpoint and returns the parsed payload', async () => {
    const payload: TemplatePayload = { captions: [], gif_range_start: 0, gif_range_end: 2, width: 480, height: 270 }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getTemplate('v1')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith('/api/videos/v1/template')
  })

  it('resolves to null when no template is saved (404)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getTemplate('v1')).resolves.toBeNull()
  })

  it('rejects on a non-404 error status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getTemplate('v1')).rejects.toThrow(/500/)
  })
})

describe('putTemplate', () => {
  it('PUTs the payload as JSON', async () => {
    const payload: TemplatePayload = { captions: [], gif_range_start: 0, gif_range_end: 2, width: 480, height: 270 }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    await putTemplate('v1', payload)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/videos/v1/template')
    expect(init.method).toBe('PUT')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual(payload)
  })
})

describe('deleteTemplate', () => {
  it('DELETEs the template', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await deleteTemplate('v1')

    expect(fetchMock).toHaveBeenCalledWith('/api/videos/v1/template', { method: 'DELETE' })
  })

  it('throws on a non-ok status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteTemplate('v1')).rejects.toThrow(/500/)
  })
})

describe('subscribeExportProgress', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  it('opens a connection to the export id\'s progress endpoint', () => {
    subscribeExportProgress('exp1', {})

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('/api/exports/exp1/progress')
  })

  it('reports each stage event with its stage name and percent', () => {
    const onProgress = vi.fn()
    subscribeExportProgress('exp1', { onProgress })
    const source = FakeEventSource.instances[0]

    source.emit('encoding_gif', JSON.stringify({ percent: 42 }))

    expect(onProgress).toHaveBeenCalledWith('encoding_gif', 42)
  })

  it('reports every documented pipeline stage', () => {
    const onProgress = vi.fn()
    subscribeExportProgress('exp1', { onProgress })
    const source = FakeEventSource.instances[0]

    for (const stage of ['palette_gen', 'encoding_gif', 'encoding_mp4', 'encoding_webm', 'uploading']) {
      source.emit(stage, JSON.stringify({ percent: 10 }))
    }

    expect(onProgress).toHaveBeenCalledTimes(5)
  })

  it('reports the completed gif and closes the connection', () => {
    const onComplete = vi.fn()
    subscribeExportProgress('exp1', { onComplete })
    const source = FakeEventSource.instances[0]
    const gif = { id: 'g1', name: 'x' }

    source.emit('complete', JSON.stringify(gif))

    expect(onComplete).toHaveBeenCalledWith(gif)
    expect(source.closed).toBe(true)
  })

  it('reports a pipeline failure and closes the connection', () => {
    const onError = vi.fn()
    subscribeExportProgress('exp1', { onError })
    const source = FakeEventSource.instances[0]

    source.emit('error', JSON.stringify({ message: 'ffmpeg exploded' }))

    expect(onError).toHaveBeenCalledWith('ffmpeg exploded')
    expect(source.closed).toBe(true)
  })

  it('ignores a native connection-drop error event (no JSON data)', () => {
    const onError = vi.fn()
    subscribeExportProgress('exp1', { onError })
    const source = FakeEventSource.instances[0]

    source.emit('error', undefined)

    expect(onError).not.toHaveBeenCalled()
    expect(source.closed).toBe(false)
  })

  it('returns an unsubscribe function that closes the connection', () => {
    const unsubscribe = subscribeExportProgress('exp1', {})
    const source = FakeEventSource.instances[0]

    unsubscribe()

    expect(source.closed).toBe(true)
  })
})
