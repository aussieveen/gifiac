import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptionEditor } from './CaptionEditor'
import type { FilmstripMeta, Video } from './types'

vi.mock('./api', () => ({
  createExport: vi.fn(),
  subscribeExportProgress: vi.fn(),
  videoFileUrl: (id: string) => `/api/videos/${id}/file`,
}))

import { createExport, subscribeExportProgress } from './api'
import type { ExportProgressHandlers } from './api'

const video: Video = {
  id: 'v1',
  original_filename: 'clip.mp4',
  extension: 'mp4',
  file_size_bytes: 12345,
  duration_seconds: 8,
  width: 1920,
  height: 1080,
  uploaded_at: '2026-01-01T00:00:00Z',
}

const filmstrip: FilmstripMeta = {
  frameCount: 32,
  cols: 6,
  rows: 6,
  frameWidth: 160,
  frameHeight: 90,
  interval: 0.25,
  imageUrl: '/api/videos/v1/filmstrip.jpg',
}

beforeEach(() => {
  vi.mocked(createExport).mockReset()
  vi.mocked(subscribeExportProgress).mockReset()
  vi.mocked(subscribeExportProgress).mockReturnValue(() => {})
})

describe('CaptionEditor', () => {
  it('starts with no captions and the Make GIF button disabled', () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)

    expect(screen.getByText(/select a caption track/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make GIF' })).toBeDisabled()
  })

  it('adding a caption selects it and shows it in the style panel', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)

    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const textarea = screen.getByLabelText('Caption text') as HTMLTextAreaElement
    expect(textarea.value).toBe('New caption')
    expect(screen.getByRole('button', { name: /delete caption/i })).toBeInTheDocument()
  })

  it('editing the style-panel textarea updates the caption text', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const textarea = screen.getByLabelText('Caption text')
    await user.clear(textarea)
    await user.type(textarea, 'Whoa!')

    expect(screen.getByText('Whoa!', { selector: '.va-track-pill' })).toBeInTheDocument()
  })

  it('defaults new captions to a visible black outline and a resizable box width', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))
    await user.type(screen.getByLabelText('GIF name'), 'my clip')
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))

    await waitFor(() => expect(createExport).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(createExport).mock.calls[0][0]
    expect(payload.captions[0]).toMatchObject({ width: 0.6, outlineColor: '#000000' })
  })

  it('unchecking Outline hides the color picker and sends outlineColor: null', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    await user.click(screen.getByRole('checkbox', { name: /outline/i }))
    expect(screen.queryByLabelText('Outline color')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('GIF name'), 'my clip')
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    await waitFor(() => expect(createExport).toHaveBeenCalledTimes(1))
    expect(vi.mocked(createExport).mock.calls[0][0].captions[0].outlineColor).toBeNull()
  })

  it('re-checking Outline after unchecking it brings the color picker back', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const outlineCheckbox = screen.getByRole('checkbox', { name: /outline/i })
    await user.click(outlineCheckbox)
    await user.click(outlineCheckbox)

    expect(screen.getByLabelText('Outline color')).toBeInTheDocument()
  })

  it('only shows width-resize handles on the selected caption', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    // The second (most recently added) caption is selected by default.
    const previewCaptions = document.querySelectorAll('.preview-caption')
    expect(previewCaptions).toHaveLength(2)
    expect(previewCaptions[0].querySelectorAll('.preview-caption-handle')).toHaveLength(0)
    expect(previewCaptions[1].querySelectorAll('.preview-caption-handle')).toHaveLength(2)
  })

  it('deleting a caption removes its track and clears the style panel', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    await user.click(screen.getByRole('button', { name: /delete caption/i }))

    expect(screen.getByText(/select a caption track/i)).toBeInTheDocument()
  })

  it('applies a style change to every track when "All tracks" is checked', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))
    await user.click(screen.getByLabelText(/all tracks/i))

    const redButton = screen.getAllByRole('button', { name: 'right' })[0]
    await user.click(redButton)

    // Both tracks' preview captions should now render right-aligned (style
    // applied to all, not just the currently-selected one).
    const previewCaptions = screen.getAllByText('New caption', { selector: '.preview-caption' })
    expect(previewCaptions).toHaveLength(2)
    for (const caption of previewCaptions) {
      expect(caption).toHaveStyle({ textAlign: 'right' })
    }
  })

  it('keeps Make GIF disabled until a name is entered, then submits the export payload and subscribes to progress', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const makeGifButton = screen.getByRole('button', { name: 'Make GIF' })
    expect(makeGifButton).toBeDisabled()

    await user.type(screen.getByLabelText('GIF name'), '  my clip  ')
    expect(makeGifButton).toBeEnabled()

    await user.click(makeGifButton)

    await waitFor(() => expect(createExport).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(createExport).mock.calls[0][0]
    expect(payload.video_id).toBe('v1')
    expect(payload.name).toBe('my clip')
    expect(payload.gif_range_start).toBe(0)
    expect(payload.gif_range_end).toBe(8)
    expect(payload.captions).toHaveLength(1)
    expect(payload.captions[0]).toMatchObject({ text: 'New caption', x: 0.5, y: 0.88 })

    await waitFor(() => expect(subscribeExportProgress).toHaveBeenCalledWith('exp-1', expect.anything()))
    expect(makeGifButton).toBeDisabled() // still submitting until progress reports complete/error
  })

  it('shows live progress and the completed gif once the SSE stream reports it', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    let handlers: ExportProgressHandlers = {}
    vi.mocked(subscribeExportProgress).mockImplementation((_id, h) => {
      handlers = h
      return () => {}
    })
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.type(screen.getByLabelText('GIF name'), 'my clip')
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    await waitFor(() => expect(subscribeExportProgress).toHaveBeenCalled())

    act(() => handlers.onProgress?.('encoding_gif', 42))
    await screen.findByText(/encoding_gif.*42%/)

    act(() =>
      handlers.onComplete?.({
        id: 'g1',
        video_id: 'v1',
        name: 'my clip',
        caption_text: '',
        captions_json: null,
        gif_range_start: 0,
        gif_range_end: 8,
        width: 480,
        height: 270,
        created_at: '2026-01-01T00:00:00Z',
      }),
    )

    await screen.findByText(/"my clip" is ready \(480×270\)/)
    expect(screen.getByRole('button', { name: 'Make GIF' })).toBeEnabled()
  })

  it('shows an error message when the initial export request fails', async () => {
    vi.mocked(createExport).mockRejectedValue(new Error('/api/exports failed (404): not found'))
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)

    await user.type(screen.getByLabelText('GIF name'), 'my clip')
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))

    await screen.findByText(/not found/i)
  })

  it('shows an error message when the SSE stream reports a pipeline failure', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    let handlers: ExportProgressHandlers = {}
    vi.mocked(subscribeExportProgress).mockImplementation((_id, h) => {
      handlers = h
      return () => {}
    })
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.type(screen.getByLabelText('GIF name'), 'my clip')
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    await waitFor(() => expect(subscribeExportProgress).toHaveBeenCalled())

    act(() => handlers.onError?.('ffmpeg exploded'))

    await screen.findByText('ffmpeg exploded')
    expect(screen.getByRole('button', { name: 'Make GIF' })).toBeEnabled()
  })

  it('unsubscribes from export progress on unmount', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    const unsubscribe = vi.fn()
    vi.mocked(subscribeExportProgress).mockReturnValue(unsubscribe)
    const user = userEvent.setup()
    const { unmount } = render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.type(screen.getByLabelText('GIF name'), 'my clip')
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    await waitFor(() => expect(subscribeExportProgress).toHaveBeenCalled())

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('calls onBack when the back link is clicked', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={onBack} />)

    await user.click(screen.getByRole('button', { name: /back to library/i }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('plays and pauses the underlying video element via the Play/Pause button', async () => {
    // jsdom doesn't implement real media playback — stub the two methods
    // the component calls and drive isPlaying via the play/pause events
    // exactly as a real <video> element would fire them.
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLVideoElement) {
      this.dispatchEvent(new Event('play'))
      return Promise.resolve()
    })
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLVideoElement) {
      this.dispatchEvent(new Event('pause'))
    })
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)

    const button = screen.getByRole('button', { name: '▶ Play' })
    await user.click(button)
    expect(playSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '⏸ Pause' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '⏸ Pause' }))
    expect(pauseSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '▶ Play' })).toBeInTheDocument()

    playSpy.mockRestore()
    pauseSpy.mockRestore()
  })

  it('reflects the video element\'s playback position as it plays', () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement

    Object.defineProperty(videoEl, 'currentTime', { value: 3.25, configurable: true })
    act(() => {
      videoEl.dispatchEvent(new Event('timeupdate'))
    })

    expect(screen.getByText('3.25s')).toBeInTheDocument()
  })

  it('pauses the video and seeks it when the film-strip is clicked', () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement
    const strip = document.querySelector('.va-filmstrip') as HTMLElement
    // jsdom's real layout is all zeros; stub a 700px-wide strip so a click
    // at clientX=350 (its midpoint) maps to a real, checkable time.
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 700 } as DOMRect)

    fireEvent.click(strip, { clientX: 350 })

    expect(pauseSpy).toHaveBeenCalledTimes(1)
    expect(videoEl.currentTime).toBeCloseTo(video.duration_seconds / 2, 1)

    pauseSpy.mockRestore()
  })

  it('dragging the playhead pauses the video and seeks it as it moves', () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement
    const playhead = document.querySelector('.va-playhead') as HTMLElement

    fireEvent.mouseDown(playhead, { clientX: 0 })
    expect(pauseSpy).toHaveBeenCalledTimes(1)

    // The timeline is BASE_TIMELINE_WIDTH (700px) wide at the default
    // zoom, so a 350px move is exactly half the timeline -> half the
    // video's duration.
    fireEvent.mouseMove(window, { clientX: 350 })
    fireEvent.mouseUp(window)

    expect(videoEl.currentTime).toBeCloseTo(video.duration_seconds / 2, 1)
    pauseSpy.mockRestore()
  })

  it('"Set start"/"Set end" set the GIF range to the current playhead time', () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement

    Object.defineProperty(videoEl, 'currentTime', { value: 2, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    fireEvent.click(screen.getByRole('button', { name: 'Set start' }))

    Object.defineProperty(videoEl, 'currentTime', { value: 6, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    fireEvent.click(screen.getByRole('button', { name: 'Set end' }))

    expect(screen.getByText(/GIF range: 2\.00s – 6\.00s/)).toBeInTheDocument()
  })

  it('loops playback back to the range start once the playhead reaches the range end', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLVideoElement) {
      this.dispatchEvent(new Event('play'))
      return Promise.resolve()
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLVideoElement) {
      this.dispatchEvent(new Event('pause'))
    })
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement

    // Narrow the GIF range to 1s-3s.
    Object.defineProperty(videoEl, 'currentTime', { value: 1, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    fireEvent.click(screen.getByRole('button', { name: 'Set start' }))
    Object.defineProperty(videoEl, 'currentTime', { value: 3, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    fireEvent.click(screen.getByRole('button', { name: 'Set end' }))

    // Pressing play while sitting at the range's end (out of range) snaps
    // back to its start instead of doing nothing.
    fireEvent.click(screen.getByRole('button', { name: '▶ Play' }))
    expect(videoEl.currentTime).toBe(1)

    // Reaching the range's end while playing loops back to its start,
    // without pausing.
    Object.defineProperty(videoEl, 'currentTime', { value: 3, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))

    expect(videoEl.currentTime).toBe(1)
    expect(screen.getByRole('button', { name: '⏸ Pause' })).toBeInTheDocument()
  })

  it('caps rendered film-strip frames at how many fit legibly, evenly sampled from the full sprite', () => {
    const longFilmstrip: FilmstripMeta = { ...filmstrip, frameCount: 200 }
    render(<CaptionEditor video={video} filmstrip={longFilmstrip} onBack={() => {}} />)

    // BASE_TIMELINE_WIDTH (700px) at the default zoom / MIN_FRAME_WIDTH
    // (40px) -> 17 frames, not all 200 sampled ones.
    expect(document.querySelectorAll('.va-frame')).toHaveLength(17)
  })

  it('renders every sampled frame when there are fewer than fit at the minimum width', () => {
    const shortFilmstrip: FilmstripMeta = { ...filmstrip, frameCount: 5 }
    render(<CaptionEditor video={video} filmstrip={shortFilmstrip} onBack={() => {}} />)

    const frames = document.querySelectorAll('.va-frame')
    expect(frames).toHaveLength(5)
    // Each still stretches to fill the full timeline width between them.
    expect(frames[0]).toHaveStyle({ width: '140px' })
  })

  it('resumes at the range start when the browser fires "ended"', () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLVideoElement) {
      this.dispatchEvent(new Event('play'))
      return Promise.resolve()
    })
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(videoEl, 'currentTime', { value: 8, configurable: true, writable: true })

    act(() => videoEl.dispatchEvent(new Event('ended')))

    expect(videoEl.currentTime).toBe(0) // gifRange.start defaults to 0
    expect(playSpy).toHaveBeenCalled()
    playSpy.mockRestore()
  })
})
