import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptionEditor } from './CaptionEditor'
import type { FilmstripMeta, TemplateDetail, Video } from './types'

/** Opens the "Make GIF" dialog. Naming lives entirely inside it now — no
 * header-level name field exists to type into first. */
async function openMakeGifDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Make GIF' }))
  return screen.findByRole('dialog', { name: 'Make GIF' })
}

/** Opens the dialog, optionally types `name` into its own GIF name field,
 * then submits — the common path most export-related tests need. Omit
 * `name` to submit with whatever the field already holds (e.g. empty, to
 * exercise the validation error). */
async function makeGif(user: ReturnType<typeof userEvent.setup>, name?: string) {
  const dialog = await openMakeGifDialog(user)
  if (name !== undefined) {
    await user.type(within(dialog).getByLabelText('GIF name'), name)
  }
  await user.click(within(dialog).getByRole('button', { name: /Make GIF/ }))
  return dialog
}

vi.mock('./api', () => ({
  createExport: vi.fn(),
  createTemplateExport: vi.fn(),
  subscribeExportProgress: vi.fn(),
  videoFileUrl: (id: string) => `/api/videos/${id}/file`,
  templateClipUrl: (id: string) => `/api/templates/${id}/clip`,
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

const templateDetail: TemplateDetail = {
  id: 't1',
  name: 'One-line change',
  is_public: false,
  saved_at: '2026-01-01T00:00:00Z',
  duration_seconds: 8.2,
  width: 160,
  height: 90,
  captions: [],
  owner_handle: null,
  is_own: true,
}

beforeEach(() => {
  vi.mocked(createExport).mockReset()
  vi.mocked(subscribeExportProgress).mockReset()
  vi.mocked(subscribeExportProgress).mockReturnValue(() => {})
  vi.mocked(getTemplate).mockReset().mockResolvedValue(null)
  vi.mocked(putTemplate).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CaptionEditor', () => {
  it('renders no name input in the header — naming happens only in the Make GIF dialog', () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    expect(screen.queryByLabelText('GIF name')).not.toBeInTheDocument()
    expect(screen.getByText('New GIF')).toBeInTheDocument()
  })

  it('shows the upload source in the header for flow A', () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    expect(screen.getByText('clip.mp4 · 160×90 · 8.0s')).toBeInTheDocument()
  })

  it('shows "From template: <name>" in the header when reached via the New GIF page', () => {
    render(<CaptionEditor source={{ kind: 'template', template: templateDetail }} filmstrip={filmstrip} onBack={() => {}} />)

    expect(screen.getByText('From template: One-line change · 160×90 · 8.2s')).toBeInTheDocument()
  })

  it('shows "Remix of: <gif name>" in the header when reached via a GIF\'s Remix button', () => {
    render(
      <CaptionEditor
        source={{ kind: 'template', template: templateDetail, remixOfName: 'my old gif' }}
        filmstrip={filmstrip}
        onBack={() => {}}
      />,
    )

    expect(screen.getByText('Remix of: my old gif · 160×90 · 8.2s')).toBeInTheDocument()
  })

  it('starts with no captions, and Make GIF stays enabled — the dialog opens regardless of whether a name is filled in yet', () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    expect(screen.getByText(/select a caption on the timeline/i)).toBeInTheDocument()
    const makeGifButton = screen.getByRole('button', { name: 'Make GIF' })
    expect(makeGifButton).toBeEnabled()
    expect(makeGifButton).not.toHaveAttribute('title')
  })

  it('the dialog opens with an empty name; submitting from it focuses the field and shows an error, without starting an export', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    const dialog = await openMakeGifDialog(user)
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Make GIF' }))

    const nameInput = within(dialog).getByLabelText('GIF name')
    expect(nameInput).toHaveFocus()
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give your GIF a name before making it')
    expect(createExport).not.toHaveBeenCalled()
  })

  it('typing a name in the dialog clears its empty-name error', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const dialog = await openMakeGifDialog(user)
    await user.click(within(dialog).getByRole('button', { name: 'Make GIF' }))
    expect(within(dialog).getByRole('alert')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('GIF name'), 'my clip')

    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('adding a caption selects it and shows it in the style panel', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const textarea = screen.getByLabelText('Caption text') as HTMLTextAreaElement
    expect(textarea.value).toBe('New caption')
    expect(screen.getByRole('button', { name: /delete caption/i })).toBeInTheDocument()
  })

  it('editing the style-panel textarea updates the caption text', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const textarea = screen.getByLabelText('Caption text')
    await user.clear(textarea)
    await user.type(textarea, 'Whoa!')

    expect(screen.getByText('Whoa!', { selector: '.va-track-pill' })).toBeInTheDocument()
  })

  it('defaults new captions to a visible black outline and a resizable box width', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))
    await makeGif(user, 'my clip')

    await waitFor(() => expect(createExport).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(createExport).mock.calls[0][0]
    expect(payload.captions[0]).toMatchObject({ width: 0.6, outlineColor: '#000000', lineHeight: 1.1 })
  })

  it('the line-height slider updates the caption and the live preview', async () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const slider = screen.getByLabelText('Line height')
    expect(slider).toHaveValue('1.1')
    expect(document.querySelector('.preview-caption')).toHaveStyle({ lineHeight: '1.1' })

    fireEvent.change(slider, { target: { value: '0.4' } })

    expect(screen.getByText('0.40×')).toBeInTheDocument()
    expect(document.querySelector('.preview-caption')).toHaveStyle({ lineHeight: '0.4' })
  })

  it('previews at a whole-number "Fit" scale by default for a small output, and 1x/2x apply exactly', async () => {
    vi.stubGlobal('innerWidth', 1200)
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    // filmstrip.frameWidth (160) is under the 320px "tiny output"
    // threshold, so the default zoom is 'fit': floor((1200 - 400 - 64) /
    // 160) = 4 — a caption's fontSize (28, in *output* pixels) scales
    // with it.
    expect(screen.getByRole('button', { name: 'Fit' })).toHaveClass('active')
    expect(document.querySelector('.preview-caption')).toHaveStyle({ fontSize: '112px' })
    expect(screen.queryByText('Actual size')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '1×' }))
    expect(document.querySelector('.preview-caption')).toHaveStyle({ fontSize: '28px' })
    expect(screen.getByText('Actual size')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '2×' }))
    expect(document.querySelector('.preview-caption')).toHaveStyle({ fontSize: '56px' })
    expect(screen.queryByText('Actual size')).not.toBeInTheDocument()
  })

  it('unchecking Outline hides the color picker and sends outlineColor: null', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    await user.click(screen.getByRole('switch', { name: /outline/i }))
    expect(screen.queryByLabelText('Outline color')).not.toBeInTheDocument()

    await makeGif(user, 'my clip')
    await waitFor(() => expect(createExport).toHaveBeenCalledTimes(1))
    expect(vi.mocked(createExport).mock.calls[0][0].captions[0].outlineColor).toBeNull()
  })

  it('re-checking Outline after unchecking it brings the color picker back', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const outlineSwitch = screen.getByRole('switch', { name: /outline/i })
    await user.click(outlineSwitch)
    await user.click(outlineSwitch)

    expect(screen.getByLabelText('Outline color')).toBeInTheDocument()
  })

  it('only shows width-resize handles on the selected caption', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
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
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    await user.click(screen.getByRole('button', { name: /delete caption/i }))

    expect(screen.getByText(/select a caption on the timeline/i)).toBeInTheDocument()
  })

  it('applies a style change to every track when "All tracks" is checked', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))
    await user.click(screen.getByLabelText(/apply this style to every caption/i))

    const redButton = screen.getAllByRole('button', { name: 'Align right' })[0]
    await user.click(redButton)

    // Both tracks' preview captions should now render right-aligned (style
    // applied to all, not just the currently-selected one).
    const previewCaptions = screen.getAllByText('New caption', { selector: '.preview-caption' })
    expect(previewCaptions).toHaveLength(2)
    for (const caption of previewCaptions) {
      expect(caption).toHaveStyle({ textAlign: 'right' })
    }
  })

  it('submits the export payload and subscribes to progress once a name is entered', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const makeGifButton = screen.getByRole('button', { name: 'Make GIF' })
    await makeGif(user, '  my clip  ')

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
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await makeGif(user, 'my clip')
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
        is_favourited: false,
        template_id: null,
        template_remixable: false,
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
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} onGifCreated={onGifCreated} />)
    await makeGif(user, 'my clip')
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
      is_favourited: false,
      template_id: null,
      template_remixable: false,
      created_at: '2026-01-01T00:00:00Z',
    }
    act(() => handlers.onComplete?.(gif))

    expect(onGifCreated).toHaveBeenCalledWith(gif)
  })

  it('the Make GIF dialog offers "Also save as a template", unchecked by default', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    await openMakeGifDialog(user)

    const checkbox = screen.getByRole('checkbox', { name: /also save as a template/i })
    expect(checkbox).not.toBeChecked()
    expect(screen.queryByLabelText('Template name')).not.toBeInTheDocument()
  })

  it('flow B (a template source) never shows the "Also save as a template" option, even for the template\'s own creator', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'template', template: templateDetail }} filmstrip={filmstrip} onBack={() => {}} />)

    await openMakeGifDialog(user)

    expect(screen.queryByRole('checkbox', { name: /also save as a template/i })).not.toBeInTheDocument()
  })

  it('opening the dialog moves focus to its own GIF name field', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    const dialog = await openMakeGifDialog(user)

    expect(within(dialog).getByLabelText('GIF name')).toHaveFocus()
  })

  it('autofocuses the name field with the cursor at the end of any existing text', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    let dialog = await openMakeGifDialog(user)
    await user.type(within(dialog).getByLabelText('GIF name'), 'my clip')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    dialog = await screen.findByRole('dialog', { name: 'Make GIF' })

    const nameInput = within(dialog).getByLabelText('GIF name') as HTMLInputElement
    expect(nameInput).toHaveFocus()
    expect(nameInput.selectionStart).toBe(nameInput.value.length)
    expect(nameInput.selectionEnd).toBe(nameInput.value.length)
  })

  it('Escape closes the dialog and returns focus to the Make GIF button', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const makeGifButton = screen.getByRole('button', { name: 'Make GIF' })
    await user.click(makeGifButton)
    await screen.findByRole('dialog', { name: 'Make GIF' })

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Make GIF' })).not.toBeInTheDocument()
    expect(makeGifButton).toHaveFocus()
  })

  it('Cancel closes the dialog and returns focus to the Make GIF button', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const makeGifButton = screen.getByRole('button', { name: 'Make GIF' })
    await user.click(makeGifButton)
    const dialog = await screen.findByRole('dialog', { name: 'Make GIF' })

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog', { name: 'Make GIF' })).not.toBeInTheDocument()
    expect(makeGifButton).toHaveFocus()
  })

  it('the dialog summary omits the GIF name and shows duration, caption count, and dimensions', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    const dialog = await openMakeGifDialog(user)
    await user.type(within(dialog).getByLabelText('GIF name'), 'my clip')

    expect(dialog).not.toHaveTextContent('my clip')
    expect(dialog).toHaveTextContent('8.0s · 1 caption · 160×90')
  })

  it('pre-fills captions and the GIF range from a saved template', async () => {
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

    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    await screen.findByRole('button', { name: 'Delete caption "from template"' })
    expect(screen.getByText(/Trim 1\.00s → 6\.00s/)).toBeInTheDocument()
  })

  it('checking "Also save as a template" sends save_as_template/template_name/template_is_public on the export request itself, not a separate call', async () => {
    // Regression test: this used to fire a separate putTemplate() call
    // after the export completed, which raced the backend's own
    // post-export cleanup of an untemplated video — the video could
    // already be gone by the time that follow-up call arrived. The fix
    // is the backend saving the template atomically as part of the same
    // export request, signaled by these fields.
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    let handlers: ExportProgressHandlers = {}
    vi.mocked(subscribeExportProgress).mockImplementation((_id, h) => {
      handlers = h
      return () => {}
    })
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const dialog = await openMakeGifDialog(user)
    await user.type(within(dialog).getByLabelText('GIF name'), 'my clip')
    await user.click(within(dialog).getByRole('checkbox', { name: /also save as a template/i }))
    await user.clear(within(dialog).getByLabelText('Template name'))
    await user.type(within(dialog).getByLabelText('Template name'), 'my template')
    await user.click(within(dialog).getByRole('switch', { name: /share template/i }))
    await user.click(within(dialog).getByRole('button', { name: 'Make GIF & save template' }))
    await waitFor(() => expect(subscribeExportProgress).toHaveBeenCalled())

    expect(createExport).toHaveBeenCalledWith(
      expect.objectContaining({
        save_as_template: true,
        template_name: 'my template',
        template_is_public: true,
      }),
    )
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
        is_favourited: false,
        template_id: null,
        template_remixable: false,
        created_at: '2026-01-01T00:00:00Z',
      }),
    )

    expect(putTemplate).not.toHaveBeenCalled()
  })

  it('leaving "Also save as a template" unchecked sends save_as_template: false', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await makeGif(user, 'my clip')

    await waitFor(() => expect(createExport).toHaveBeenCalled())
    expect(createExport).toHaveBeenCalledWith(expect.objectContaining({ save_as_template: false }))
  })

  it('does not save a template on export when "Also save as a template" is left unchecked', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    let handlers: ExportProgressHandlers = {}
    vi.mocked(subscribeExportProgress).mockImplementation((_id, h) => {
      handlers = h
      return () => {}
    })
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await makeGif(user, 'my clip')
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
        is_favourited: false,
        template_id: null,
        template_remixable: false,
        created_at: '2026-01-01T00:00:00Z',
      }),
    )

    expect(putTemplate).not.toHaveBeenCalled()
  })

  it('shows an error message when the initial export request fails', async () => {
    vi.mocked(createExport).mockRejectedValue(new Error('/api/exports failed (404): not found'))
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    await makeGif(user, 'my clip')

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
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await makeGif(user, 'my clip')
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
    const { unmount } = render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await makeGif(user, 'my clip')
    await waitFor(() => expect(subscribeExportProgress).toHaveBeenCalled())

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('calls onBack when the back link is clicked', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={onBack} />)

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
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    const button = screen.getByRole('button', { name: 'Play' })
    await user.click(button)
    expect(playSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    expect(pauseSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()

    playSpy.mockRestore()
    pauseSpy.mockRestore()
  })

  it('reflects the video element\'s playback position as it plays', () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement

    Object.defineProperty(videoEl, 'currentTime', { value: 3.25, configurable: true })
    act(() => {
      videoEl.dispatchEvent(new Event('timeupdate'))
    })

    expect(screen.getByText('0:03.25')).toBeInTheDocument()
  })

  it('pauses the video and seeks it when the film-strip is clicked', () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
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
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
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
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement

    Object.defineProperty(videoEl, 'currentTime', { value: 2, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    fireEvent.click(screen.getByRole('button', { name: 'Trim start' }))

    Object.defineProperty(videoEl, 'currentTime', { value: 6, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    fireEvent.click(screen.getByRole('button', { name: 'Trim end' }))

    expect(screen.getByText(/Trim 2\.00s → 6\.00s/)).toBeInTheDocument()
  })

  it('loops playback back to the range start once the playhead reaches the range end', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLVideoElement) {
      this.dispatchEvent(new Event('play'))
      return Promise.resolve()
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLVideoElement) {
      this.dispatchEvent(new Event('pause'))
    })
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement

    // Narrow the GIF range to 1s-3s.
    Object.defineProperty(videoEl, 'currentTime', { value: 1, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    fireEvent.click(screen.getByRole('button', { name: 'Trim start' }))
    Object.defineProperty(videoEl, 'currentTime', { value: 3, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    fireEvent.click(screen.getByRole('button', { name: 'Trim end' }))

    // Pressing play while sitting at the range's end (out of range) snaps
    // back to its start instead of doing nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(videoEl.currentTime).toBe(1)

    // Reaching the range's end while playing loops back to its start,
    // without pausing.
    Object.defineProperty(videoEl, 'currentTime', { value: 3, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))

    expect(videoEl.currentTime).toBe(1)
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('caps rendered film-strip frames at how many fit legibly, evenly sampled from the full sprite', () => {
    const longFilmstrip: FilmstripMeta = { ...filmstrip, frameCount: 200 }
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={longFilmstrip} onBack={() => {}} />)

    // BASE_TIMELINE_WIDTH (700px) at the default zoom / MIN_FRAME_WIDTH
    // (40px) -> 17 frames, not all 200 sampled ones.
    expect(document.querySelectorAll('.va-frame')).toHaveLength(17)
  })

  it('renders every sampled frame when there are fewer than fit at the minimum width', () => {
    const shortFilmstrip: FilmstripMeta = { ...filmstrip, frameCount: 5 }
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={shortFilmstrip} onBack={() => {}} />)

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
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(videoEl, 'currentTime', { value: 8, configurable: true, writable: true })

    act(() => videoEl.dispatchEvent(new Event('ended')))

    expect(videoEl.currentTime).toBe(0) // gifRange.start defaults to 0
    expect(playSpy).toHaveBeenCalled()
    playSpy.mockRestore()
  })

  it('defaults new captions to a light-grey text color and a black outline', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    expect(screen.getByLabelText('Caption color')).toHaveValue('#fcfcfc')
    expect(screen.getByLabelText('Outline color')).toHaveValue('#000000')
  })

  it('there is exactly one add-caption-at-playhead control, attached to the playhead', async () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)

    expect(screen.getAllByRole('button', { name: /add caption at playhead/i })).toHaveLength(1)
    expect(document.querySelector('.va-playhead-add')).toBeInTheDocument()
    expect(document.querySelector('.va-add-track')).not.toBeInTheDocument()
  })

  it('the playhead add-caption button adds a caption at the current time without pausing/seeking', () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(videoEl, 'currentTime', { value: 3, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))

    fireEvent.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    expect(pauseSpy).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Caption text')).toHaveValue('New caption')
    expect(screen.getByRole('button', { name: 'Set start to playhead' })).toHaveTextContent('3.00s')
    expect(screen.getByRole('button', { name: 'Set end to playhead' })).toHaveTextContent('4.00s')
    pauseSpy.mockRestore()
  })

  it('clicking a text-color swatch sets the caption color and highlights that swatch', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    await user.click(screen.getByRole('button', { name: 'Text color #00ccff' }))

    expect(screen.getByLabelText('Caption color')).toHaveValue('#00ccff')
    expect(screen.getByRole('button', { name: 'Text color #00ccff' })).toHaveClass('active')
    expect(document.querySelector('.preview-caption')).toHaveStyle({ color: '#00ccff' })
  })

  it('clicking an outline-color swatch sets the outline color and highlights that swatch', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
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
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))
    const videoEl = document.querySelector('video') as HTMLVideoElement

    Object.defineProperty(videoEl, 'currentTime', { value: 0.5, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    await user.click(screen.getByRole('button', { name: 'Set start to playhead' }))

    Object.defineProperty(videoEl, 'currentTime', { value: 6, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    await user.click(screen.getByRole('button', { name: 'Set end to playhead' }))

    expect(screen.getByRole('button', { name: 'Set start to playhead' })).toHaveTextContent('0.50s')
    expect(screen.getByRole('button', { name: 'Set end to playhead' })).toHaveTextContent('6.00s')
  })

  it('zooms in/out when scrolling the mouse wheel over the timeline, up to zoom in', () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const scrollEl = document.querySelector('.va-timeline-scroll') as HTMLElement
    expect(document.querySelector('.va-filmstrip')).toHaveStyle({ width: '700px' })

    fireEvent.wheel(scrollEl, { deltaY: -100 })

    expect(document.querySelector('.va-filmstrip')).toHaveStyle({ width: '1050px' })
  })

  it('zooms out on a downward wheel scroll', () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const scrollEl = document.querySelector('.va-timeline-scroll') as HTMLElement

    fireEvent.wheel(scrollEl, { deltaY: 100 })

    expect(document.querySelector('.va-filmstrip')).toHaveStyle({ width: '525px' })
  })

  it('ignores a horizontal-only wheel gesture (trackpad pan), leaving zoom unchanged', () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const scrollEl = document.querySelector('.va-timeline-scroll') as HTMLElement

    fireEvent.wheel(scrollEl, { deltaX: 100, deltaY: 0 })

    expect(document.querySelector('.va-filmstrip')).toHaveStyle({ width: '700px' })
  })

  it('debounces rapid wheel events so one gesture only steps the zoom once', () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const scrollEl = document.querySelector('.va-timeline-scroll') as HTMLElement

    fireEvent.wheel(scrollEl, { deltaY: -100 })
    fireEvent.wheel(scrollEl, { deltaY: -100 })
    fireEvent.wheel(scrollEl, { deltaY: -100 })

    // Three rapid events fired within the same cooldown window step the
    // zoom level exactly once (700px -> 1050px), not three times.
    expect(document.querySelector('.va-filmstrip')).toHaveStyle({ width: '1050px' })
  })

  it('re-centers the playhead in the visible window whenever the zoom level changes', () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement
    const scrollEl = document.querySelector('.va-timeline-scroll') as HTMLElement
    Object.defineProperty(scrollEl, 'clientWidth', { value: 200, configurable: true })
    Object.defineProperty(videoEl, 'currentTime', { value: 4, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    // New timelineWidth is 1050 (zoom level 1.5x); playhead at t=4/8 -> x=525;
    // centered in a 200px-wide viewport -> scrollLeft = 525 - 100 = 425.
    expect(scrollEl.scrollLeft).toBe(425)
  })

  it('snaps a dragged caption edge onto the playhead and shows a guide line while snapped', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
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

    expect(screen.getByRole('button', { name: 'Set start to playhead' })).toHaveTextContent('0.00s')
    expect(screen.getByRole('button', { name: 'Set end to playhead' })).toHaveTextContent('3.00s')
    const guide = document.querySelector('.va-snap-guide') as HTMLElement
    expect(guide).toBeInTheDocument()
    expect(guide).toHaveStyle({ left: '262.5px' })

    fireEvent.mouseUp(window)
    expect(document.querySelector('.va-snap-guide')).not.toBeInTheDocument()
  })

  it('snaps a dragged GIF range handle onto a caption edge', () => {
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    const videoEl = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(videoEl, 'currentTime', { value: 3, configurable: true, writable: true })
    act(() => videoEl.dispatchEvent(new Event('timeupdate')))
    fireEvent.click(screen.getByRole('button', { name: /add caption at playhead/i })) // caption: 3s - 4s
    const startHandle = document.querySelectorAll('.va-range-handle')[0] as HTMLElement

    // Drag the range's start handle (orig 0) by 350px (4s at 87.5px/s) so it
    // lands exactly on the caption's end time (4s), not the playhead (3s).
    fireEvent.mouseDown(startHandle, { clientX: 0 })
    fireEvent.mouseMove(window, { clientX: 350 })

    expect(screen.getByText(/Trim 4\.00s → 8\.00s/)).toBeInTheDocument()
  })

  it('labels the font-size slider "Size", matching "Line height"', async () => {
    const user = userEvent.setup()
    render(<CaptionEditor source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />)
    await user.click(screen.getByRole('button', { name: /add caption at playhead/i }))

    expect(screen.getByText('Size')).toBeInTheDocument()
  })
})
