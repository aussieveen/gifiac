import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptionEditor } from './CaptionEditor'
import type { FilmstripMeta, Video } from './types'

vi.mock('./api', () => ({
  createExport: vi.fn(),
  subscribeExportProgress: vi.fn(),
  videoFileUrl: (id: string) => `/api/videos/${id}/file`,
  getTemplate: vi.fn(),
  putTemplate: vi.fn(),
}))

import { createExport, getTemplate, putTemplate, subscribeExportProgress } from './api'
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
  vi.mocked(getTemplate).mockReset().mockResolvedValue(null)
  vi.mocked(putTemplate).mockReset()
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
    expect(payload.captions[0]).toMatchObject({ width: 0.6, outlineColor: '#000000', lineHeight: 0.65 })
  })

  it('the line-height slider updates the caption and the live preview', async () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const slider = screen.getByLabelText('Line height')
    expect(slider).toHaveValue('0.65')
    expect(document.querySelector('.preview-caption')).toHaveStyle({ lineHeight: '0.65' })

    fireEvent.change(slider, { target: { value: '0.4' } })

    expect(screen.getByText('0.40×')).toBeInTheDocument()
    expect(document.querySelector('.preview-caption')).toHaveStyle({ lineHeight: '0.4' })
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
        external_url: null,
        is_one_off: false,
        is_public: false,
        use_count: 0,
        created_at: '2026-01-01T00:00:00Z',
      }),
    )

    await screen.findByText(/"my clip" is ready \(480×270\)/)
    expect(screen.getByRole('button', { name: 'Make GIF' })).toBeEnabled()
  })

  it('calls onGifCreated with the completed gif once the SSE stream reports it', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    let handlers: ExportProgressHandlers = {}
    vi.mocked(subscribeExportProgress).mockImplementation((_id, h) => {
      handlers = h
      return () => {}
    })
    const onGifCreated = vi.fn()
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} onGifCreated={onGifCreated} />)
    await user.type(screen.getByLabelText('GIF name'), 'my clip')
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    await waitFor(() => expect(subscribeExportProgress).toHaveBeenCalled())

    const gif = {
      id: 'g1',
      video_id: 'v1',
      name: 'my clip',
      caption_text: '',
      captions_json: null,
      gif_range_start: 0,
      gif_range_end: 8,
      width: 480,
      height: 270,
      external_url: null,
        is_one_off: false,
        is_public: false,
      use_count: 0,
      created_at: '2026-01-01T00:00:00Z',
    }
    act(() => handlers.onComplete?.(gif))

    expect(onGifCreated).toHaveBeenCalledWith(gif)
  })

  it('shows a "Create template" checkbox for a video with no template', async () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)

    expect(await screen.findByText('Create template')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Overwrite template' })).not.toBeInTheDocument()
  })

  it('pre-fills captions and the GIF range from a saved template, and shows "Overwrite template" instead', async () => {
    vi.mocked(getTemplate).mockResolvedValue({
      captions: [
        {
          id: 'c1',
          startTime: 1,
          endTime: 3,
          text: 'from template',
          fontFamily: 'Impact, sans-serif',
          fontSize: 28,
          color: '#ffffff',
          align: 'center',
          x: 0.5,
          y: 0.88,
          width: 0.6,
          outlineColor: null,
          lineHeight: 0.65,
        },
      ],
      gif_range_start: 1,
      gif_range_end: 6,
      width: 160,
      height: 90,
    })

    render(<CaptionEditor video={{ ...video, has_template: true }} filmstrip={filmstrip} onBack={() => {}} />)

    await screen.findByRole('button', { name: 'Delete caption "from template"' })
    expect(screen.getByText(/GIF range: 1\.00s – 6\.00s/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Overwrite template' })).toBeInTheDocument()
    expect(screen.queryByText('Create template')).not.toBeInTheDocument()
  })

  it('clicking "Overwrite template" saves the current captions/range without exporting', async () => {
    vi.mocked(getTemplate).mockResolvedValue({ captions: [], gif_range_start: 0, gif_range_end: 8, width: 160, height: 90 })
    vi.mocked(putTemplate).mockResolvedValue({ captions: [], gif_range_start: 0, gif_range_end: 1, width: 160, height: 90 })
    const user = userEvent.setup()
    render(<CaptionEditor video={{ ...video, has_template: true }} filmstrip={filmstrip} onBack={() => {}} />)
    await screen.findByRole('button', { name: 'Overwrite template' })

    await user.click(screen.getByRole('button', { name: 'Overwrite template' }))

    await waitFor(() =>
      expect(putTemplate).toHaveBeenCalledWith(
        'v1',
        expect.objectContaining({ gif_range_start: 0, gif_range_end: 8, width: 160, height: 90 }),
      ),
    )
    await screen.findByText('Template saved.')
    expect(createExport).not.toHaveBeenCalled()
  })

  it('checking "Create template" sends save_as_template on the export request itself, not a separate call', async () => {
    // Regression test: this used to fire a separate putTemplate() call
    // after the export completed, which raced the backend's own
    // post-export cleanup of an untemplated video — the video could
    // already be gone by the time that follow-up call arrived. The fix
    // is the backend saving the template atomically as part of the same
    // export request, signaled by this one flag.
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    let handlers: ExportProgressHandlers = {}
    vi.mocked(subscribeExportProgress).mockImplementation((_id, h) => {
      handlers = h
      return () => {}
    })
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(await screen.findByText('Create template'))
    await user.type(screen.getByLabelText('GIF name'), 'my clip')
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    await waitFor(() => expect(subscribeExportProgress).toHaveBeenCalled())

    expect(createExport).toHaveBeenCalledWith(expect.objectContaining({ save_as_template: true }))
    expect(putTemplate).not.toHaveBeenCalled()

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
        external_url: null,
        is_one_off: false,
        is_public: false,
        use_count: 0,
        created_at: '2026-01-01T00:00:00Z',
      }),
    )

    expect(putTemplate).not.toHaveBeenCalled()
  })

  it('unchecking "Create template" sends save_as_template: false', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.type(screen.getByLabelText('GIF name'), 'my clip')
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))

    await waitFor(() => expect(createExport).toHaveBeenCalled())
    expect(createExport).toHaveBeenCalledWith(expect.objectContaining({ save_as_template: false }))
  })

  it('does not save a template on export when "Create template" is left unchecked', async () => {
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
        external_url: null,
        is_one_off: false,
        is_public: false,
        use_count: 0,
        created_at: '2026-01-01T00:00:00Z',
      }),
    )

    expect(putTemplate).not.toHaveBeenCalled()
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

  it('defaults new captions to a light-grey text color and a black outline', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    expect(screen.getByLabelText('Caption color')).toHaveValue('#fcfcfc')
    expect(screen.getByLabelText('Outline color')).toHaveValue('#000000')
  })

  it('there is exactly one add-caption-at-playhead control, attached to the playhead', async () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)

    expect(screen.getAllByRole('button', { name: /add caption at playhead/i })).toHaveLength(1)
    expect(document.querySelector('.va-playhead-add')).toBeInTheDocument()
    expect(document.querySelector('.va-add-track')).not.toBeInTheDocument()
  })

  it('the playhead add-caption button adds a caption at the current time without pausing/seeking', () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(videoEl, 'currentTime', { value: 3, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))

    fireEvent.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    expect(pauseSpy).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Caption text')).toHaveValue('New caption')
    expect(screen.getByText(/3\.00s – 4\.00s/)).toBeInTheDocument()
    pauseSpy.mockRestore()
  })

  it('clicking a text-color swatch sets the caption color and highlights that swatch', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    await user.click(screen.getByRole('button', { name: 'Text color #00ccff' }))

    expect(screen.getByLabelText('Caption color')).toHaveValue('#00ccff')
    expect(screen.getByRole('button', { name: 'Text color #00ccff' })).toHaveClass('active')
    expect(document.querySelector('.preview-caption')).toHaveStyle({ color: '#00ccff' })
  })

  it('clicking an outline-color swatch sets the outline color and highlights that swatch', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))
    // Default outline is already #000000, which is itself one of the
    // swatches — switch away first so the click below is a real change.
    await user.click(screen.getByRole('button', { name: 'Outline color #ff6666' }))

    expect(screen.getByLabelText('Outline color')).toHaveValue('#ff6666')
    expect(screen.getByRole('button', { name: 'Outline color #ff6666' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'Outline color #000000' })).not.toHaveClass('active')
  })

  it('"Set start/end to playhead" set the selected caption\'s timing to the current playhead', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))
    const videoEl = document.querySelector('video') as HTMLVideoElement

    Object.defineProperty(videoEl, 'currentTime', { value: 0.5, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    await user.click(screen.getByRole('button', { name: 'Set start to playhead' }))

    Object.defineProperty(videoEl, 'currentTime', { value: 6, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    await user.click(screen.getByRole('button', { name: 'Set end to playhead' }))

    expect(screen.getByText(/0\.50s – 6\.00s/)).toBeInTheDocument()
  })

  it('zooms in/out when scrolling the mouse wheel over the timeline, up to zoom in', () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const scrollEl = document.querySelector('.va-timeline-scroll') as HTMLElement
    expect(document.querySelector('.va-filmstrip')).toHaveStyle({ width: '700px' })

    fireEvent.wheel(scrollEl, { deltaY: -100 })

    expect(document.querySelector('.va-filmstrip')).toHaveStyle({ width: '1050px' })
  })

  it('zooms out on a downward wheel scroll', () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const scrollEl = document.querySelector('.va-timeline-scroll') as HTMLElement

    fireEvent.wheel(scrollEl, { deltaY: 100 })

    expect(document.querySelector('.va-filmstrip')).toHaveStyle({ width: '525px' })
  })

  it('ignores a horizontal-only wheel gesture (trackpad pan), leaving zoom unchanged', () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const scrollEl = document.querySelector('.va-timeline-scroll') as HTMLElement

    fireEvent.wheel(scrollEl, { deltaX: 100, deltaY: 0 })

    expect(document.querySelector('.va-filmstrip')).toHaveStyle({ width: '700px' })
  })

  it('debounces rapid wheel events so one gesture only steps the zoom once', () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const scrollEl = document.querySelector('.va-timeline-scroll') as HTMLElement

    fireEvent.wheel(scrollEl, { deltaY: -100 })
    fireEvent.wheel(scrollEl, { deltaY: -100 })
    fireEvent.wheel(scrollEl, { deltaY: -100 })

    // Three rapid events fired within the same cooldown window step the
    // zoom level exactly once (700px -> 1050px), not three times.
    expect(document.querySelector('.va-filmstrip')).toHaveStyle({ width: '1050px' })
  })

  it('re-centers the playhead in the visible window whenever the zoom level changes', () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement
    const scrollEl = document.querySelector('.va-timeline-scroll') as HTMLElement
    Object.defineProperty(scrollEl, 'clientWidth', { value: 200, configurable: true })
    Object.defineProperty(videoEl, 'currentTime', { value: 4, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))

    fireEvent.click(screen.getByRole('button', { name: '🔍+' }))

    // New timelineWidth is 1050 (zoom level 1.5x); playhead at t=4/8 -> x=525;
    // centered in a 200px-wide viewport -> scrollLeft = 525 - 100 = 425.
    expect(scrollEl.scrollLeft).toBe(425)
  })

  it('snaps a dragged caption edge onto the playhead and shows a guide line while snapped', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i })) // caption: 0s - 1s
    const videoEl = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(videoEl, 'currentTime', { value: 3, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    const rightHandle = document.querySelectorAll('.va-track-handle.right')[0] as HTMLElement

    // Timeline is 700px wide for an 8s clip -> 87.5px/s. Dragging the right
    // edge by 175px (2s) from its default 1s end lands it exactly on the
    // playhead at t=3s.
    fireEvent.mouseDown(rightHandle, { clientX: 0 })
    fireEvent.mouseMove(window, { clientX: 175 })

    expect(screen.getByText(/0\.00s – 3\.00s/)).toBeInTheDocument()
    const guide = document.querySelector('.va-snap-guide') as HTMLElement
    expect(guide).toBeInTheDocument()
    expect(guide).toHaveStyle({ left: '262.5px' })

    fireEvent.mouseUp(window)
    expect(document.querySelector('.va-snap-guide')).not.toBeInTheDocument()
  })

  it('snaps a dragged GIF range handle onto a caption edge', () => {
    render(<CaptionEditor video={video} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(videoEl, 'currentTime', { value: 3, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    fireEvent.click(screen.getByRole('button', { name: /add caption at playhead/i })) // caption: 3s - 4s
    const startHandle = document.querySelectorAll('.va-range-handle')[0] as HTMLElement

    // Drag the range's start handle (orig 0) by 350px (4s at 87.5px/s) so it
    // lands exactly on the caption's end time (4s), not the playhead (3s).
    fireEvent.mouseDown(startHandle, { clientX: 0 })
    fireEvent.mouseMove(window, { clientX: 350 })

    expect(screen.getByText(/GIF range: 4\.00s – 8\.00s/)).toBeInTheDocument()
  })
})
