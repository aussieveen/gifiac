import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptionEditor } from './CaptionEditor'
import type { FilmstripMeta, Video } from './types'

vi.mock('./api', () => ({
  createExport: vi.fn(),
  subscribeExportProgress: vi.fn(),
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
})
