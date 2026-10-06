import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkLink,
  createExport,
  deleteGif,
  deleteTemplate,
  getFilmstripMeta,
  getGif,
  getTemplate,
  LinkCheckError,
  linkGif,
  listGifs,
  listVideos,
  putTemplate,
  renameGif,
  subscribeExportProgress,
  subscribeIngestProgress,
  thumbnailUrl,
  uploadGifFile,
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

class FakeXHR {
  static instances: FakeXHR[] = []
  method = ''
  url = ''
  status = 0
  statusText = ''
  responseText = ''
  sentBody: FormData | null = null
  aborted = false
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXHR.instances.push(this)
  }

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  send(body: FormData) {
    this.sentBody = body
  }

  abort() {
    this.aborted = true
    this.onabort?.()
  }
}

describe('uploadGifFile', () => {
  beforeEach(() => {
    FakeXHR.instances = []
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
  })

  it('POSTs the name and file as multipart form data, reporting progress and resolving with the created gif', async () => {
    const file = new File(['a'], 'a.gif', { type: 'image/gif' })
    const onProgress = vi.fn()

    const promise = uploadGifFile(file, 'A gif', onProgress)
    const xhr = FakeXHR.instances[0]
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('/api/gifs/import')
    expect(xhr.sentBody?.get('name')).toBe('A gif')
    expect((xhr.sentBody?.get('files') as File).name).toBe('a.gif')

    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 })
    expect(onProgress).toHaveBeenCalledWith(50)

    xhr.status = 201
    xhr.responseText = JSON.stringify([{ id: 'g1', name: 'A gif' }])
    xhr.onload?.()

    await expect(promise).resolves.toEqual({ id: 'g1', name: 'A gif' })
  })

  it('clamps progress at 100% even if a browser reports loaded exceeding total', () => {
    const onProgress = vi.fn()
    uploadGifFile(new File(['a'], 'a.gif'), 'A gif', onProgress)
    const xhr = FakeXHR.instances[0]

    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 188, total: 100 })

    expect(onProgress).toHaveBeenCalledWith(100)
  })

  it('rejects with the response body on a non-2xx status', async () => {
    const promise = uploadGifFile(new File(['a'], 'a.gif'), 'A gif', vi.fn())
    const xhr = FakeXHR.instances[0]

    xhr.status = 400
    xhr.responseText = "That's too big. GIFs can be up to 20MB."
    xhr.onload?.()

    await expect(promise).rejects.toThrow(/too big/)
  })

  it('aborts the underlying request when the signal is aborted', async () => {
    const controller = new AbortController()
    const promise = uploadGifFile(new File(['a'], 'a.gif'), 'A gif', vi.fn(), controller.signal)
    const xhr = FakeXHR.instances[0]

    controller.abort()

    expect(xhr.aborted).toBe(true)
    await expect(promise).rejects.toThrow()
  })
})

describe('linkGif', () => {
  it('POSTs the url, name, and is_public as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'g1', external_url: 'https://example.com/a.gif' }))
    vi.stubGlobal('fetch', fetchMock)

    await linkGif('https://example.com/a.gif', 'a gif', true)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/gifs/link')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://example.com/a.gif', name: 'a gif', is_public: true })
  })

  it('rejects with the response body on a non-ok status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not an image', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(linkGif('https://example.com/a.gif', 'a gif', false)).rejects.toThrow(/not an image/)
  })
})

describe('checkLink', () => {
  it('POSTs the url as JSON and returns the parsed dimensions/size', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ width: 480, height: 270, sizeBytes: 1_400_000 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await checkLink('https://example.com/a.gif')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/gifs/check-link')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://example.com/a.gif' })
    expect(result).toEqual({ width: 480, height: 270, sizeBytes: 1_400_000 })
  })

  it('throws a LinkCheckError carrying the plain-English response body on failure', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("That link isn't a GIF. Use the direct link to the .gif file.", { status: 400 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkLink('https://example.com/a.png')).rejects.toThrow(LinkCheckError)
    await expect(checkLink('https://example.com/a.png')).rejects.toThrow(/isn't a GIF/)
  })

  it('forwards an AbortSignal so an in-flight check can be cancelled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ width: 1, height: 1, sizeBytes: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await checkLink('https://example.com/a.gif', controller.signal)

    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBe(controller.signal)
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
    const request = { name: 'My template', is_public: false, ...payload }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    await putTemplate('v1', request)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/videos/v1/template')
    expect(init.method).toBe('PUT')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual(request)
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

  it('reports a progress event with its format and percent', () => {
    const onProgress = vi.fn()
    subscribeExportProgress('exp1', { onProgress })
    const source = FakeEventSource.instances[0]

    source.emit('progress', JSON.stringify({ format: 'gif', percent: 42 }))

    expect(onProgress).toHaveBeenCalledWith('gif', 42)
  })

  it('reports progress independently for all three formats', () => {
    const onProgress = vi.fn()
    subscribeExportProgress('exp1', { onProgress })
    const source = FakeEventSource.instances[0]

    for (const format of ['gif', 'mp4', 'webm']) {
      source.emit('progress', JSON.stringify({ format, percent: 10 }))
    }

    expect(onProgress).toHaveBeenCalledTimes(3)
  })

  it('reports a format finishing', () => {
    const onFormatDone = vi.fn()
    subscribeExportProgress('exp1', { onFormatDone })
    const source = FakeEventSource.instances[0]

    source.emit('format_done', JSON.stringify({ format: 'mp4' }))

    expect(onFormatDone).toHaveBeenCalledWith('mp4')
  })

  it('reports a format failing, without closing the connection', () => {
    const onFormatFailed = vi.fn()
    subscribeExportProgress('exp1', { onFormatFailed })
    const source = FakeEventSource.instances[0]

    source.emit('format_failed', JSON.stringify({ format: 'webm', message: 'encode failed' }))

    expect(onFormatFailed).toHaveBeenCalledWith('webm', 'encode failed')
    expect(source.closed).toBe(false)
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

describe('subscribeIngestProgress', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  it('opens a connection to the ingest job\'s progress endpoint', () => {
    subscribeIngestProgress('job1', {})

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('/api/videos/job1/ingest-progress')
  })

  it('reports a stage event', () => {
    const onStage = vi.fn()
    subscribeIngestProgress('job1', { onStage })
    const source = FakeEventSource.instances[0]

    source.emit('stage', JSON.stringify({ stage: 'analyzing' }))

    expect(onStage).toHaveBeenCalledWith('analyzing')
  })

  it('reports the completed video and closes the connection', () => {
    const onComplete = vi.fn()
    subscribeIngestProgress('job1', { onComplete })
    const source = FakeEventSource.instances[0]
    const video = { id: 'v1', width: 320, height: 240 }

    source.emit('complete', JSON.stringify(video))

    expect(onComplete).toHaveBeenCalledWith(video)
    expect(source.closed).toBe(true)
  })

  it('reports an ingest failure and closes the connection', () => {
    const onError = vi.fn()
    subscribeIngestProgress('job1', { onError })
    const source = FakeEventSource.instances[0]

    source.emit('error', JSON.stringify({ message: 'probe failed' }))

    expect(onError).toHaveBeenCalledWith('probe failed')
    expect(source.closed).toBe(true)
  })

  it('ignores a native connection-drop error event (no JSON data)', () => {
    const onError = vi.fn()
    subscribeIngestProgress('job1', { onError })
    const source = FakeEventSource.instances[0]

    source.emit('error', undefined)

    expect(onError).not.toHaveBeenCalled()
    expect(source.closed).toBe(false)
  })

  it('returns an unsubscribe function that closes the connection', () => {
    const unsubscribe = subscribeIngestProgress('job1', {})
    const source = FakeEventSource.instances[0]

    unsubscribe()

    expect(source.closed).toBe(true)
  })
})
