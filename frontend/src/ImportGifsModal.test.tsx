import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetLastTabForTests, ImportGifsModal } from './ImportGifsModal'
import type { Gif } from './types'

vi.mock('./api', () => ({
  checkLink: vi.fn(),
  linkGif: vi.fn(),
  uploadGifFile: vi.fn(),
  deleteGif: vi.fn(),
  renameGif: vi.fn(),
  setGifPublic: vi.fn(),
  getConfig: vi.fn(() => Promise.resolve({ turnstileSiteKey: null, maxGifBytes: 20 * 1024 * 1024 })),
}))

import { checkLink, deleteGif, getConfig, linkGif, renameGif, setGifPublic, uploadGifFile } from './api'

function makeGif(id: string, name: string, overrides: Partial<Gif> = {}): Gif {
  return {
    id,
    video_id: null,
    name,
    caption_text: '',
    captions_json: null,
    gif_range_start: null,
    gif_range_end: null,
    width: 480,
    height: 270,
    external_url: null,
    created_at: '2026-01-01T00:00:00Z',
    is_one_off: false,
    is_public: false,
    use_count: 0,
    is_favourited: false,
    template_id: null,
    template_remixable: false,
    gif_url: `https://example.com/${id}.gif`,
    mp4_url: `https://example.com/${id}.mp4`,
    webm_url: `https://example.com/${id}.webm`,
    ...overrides,
  }
}

function pasteInto(input: HTMLElement, text: string) {
  fireEvent.paste(input, { clipboardData: { getData: () => text } })
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

beforeEach(() => {
  vi.mocked(checkLink).mockReset()
  vi.mocked(linkGif).mockReset()
  vi.mocked(uploadGifFile).mockReset()
  vi.mocked(deleteGif).mockReset()
  vi.mocked(renameGif).mockReset()
  vi.mocked(setGifPublic).mockReset()
  vi.mocked(getConfig)
    .mockReset()
    .mockResolvedValue({ turnstileSiteKey: null, maxGifBytes: 20 * 1024 * 1024 })
  _resetLastTabForTests()
})

describe('ImportGifsModal — shared chrome', () => {
  it('opens on the Upload files tab by default, with a drop zone visible', () => {
    render(<ImportGifsModal onClose={vi.fn()} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    expect(screen.getByRole('tab', { name: 'Upload files' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/drop gifs here, or browse/i)).toBeInTheDocument()
  })

  it('switching to From links and back preserves rows in both tabs', async () => {
    const user = userEvent.setup()
    vi.mocked(checkLink).mockResolvedValue({ width: 480, height: 270, sizeBytes: 1_400_000 })
    render(<ImportGifsModal onClose={vi.fn()} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    await user.click(screen.getByRole('tab', { name: 'From links' }))
    pasteInto(screen.getByLabelText('GIF link'), 'https://example.com/a.gif')
    await screen.findByText(/480×270/)

    await user.click(screen.getByRole('tab', { name: 'Upload files' }))
    expect(screen.queryByLabelText('GIF link')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'From links' }))
    expect(screen.getByLabelText('GIF link')).toHaveValue('https://example.com/a.gif')
    await screen.findByText(/480×270/)
  })

  it('Esc closes the modal with no confirmation when there is nothing to lose', () => {
    const onClose = vi.fn()
    render(<ImportGifsModal onClose={onClose} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ImportGifsModal — Upload files', () => {
  it('starting an upload shows progress and, once ready, a live preview and footer count', async () => {
    let resolveUpload: (gif: Gif) => void = () => {}
    vi.mocked(uploadGifFile).mockImplementation(
      (_file, _name, onProgress) =>
        new Promise((resolve) => {
          onProgress(40)
          resolveUpload = resolve
        }),
    )
    const onAdded = vi.fn()
    render(<ImportGifsModal onClose={vi.fn()} onAdded={onAdded} onRemoved={vi.fn()} />)

    const file = new File(['bytes'], 'monday-standup.gif', { type: 'image/gif' })
    fireEvent.change(fileInput(), { target: { files: [file] } })

    expect(uploadGifFile).toHaveBeenCalledWith(file, 'Monday standup', expect.any(Function), expect.anything())
    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Monday standup')).toBeDisabled()

    const created = makeGif('g1', 'Monday standup')
    resolveUpload(created)
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith([created]))
    await screen.findByText(/480×270/)
    expect(screen.getByRole('button', { name: /add 1 gif$/i })).toBeInTheDocument()
  })

  it('rejects an oversized file client-side without ever calling uploadGifFile', () => {
    render(<ImportGifsModal onClose={vi.fn()} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    const big = new File([new Uint8Array(21 * 1024 * 1024)], 'huge.gif', { type: 'image/gif' })
    fireEvent.change(fileInput(), { target: { files: [big] } })

    expect(screen.getByText("That's too big. GIFs can be up to 20MB.")).toBeInTheDocument()
    expect(uploadGifFile).not.toHaveBeenCalled()
  })

  it('a failed upload shows "Upload failed." with a working Retry button', async () => {
    vi.mocked(uploadGifFile).mockRejectedValueOnce(new Error('Upload failed.')).mockResolvedValueOnce(makeGif('g1', 'Bad'))
    render(<ImportGifsModal onClose={vi.fn()} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'bad.gif', { type: 'image/gif' })] } })
    await screen.findByText('Upload failed.')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(uploadGifFile).toHaveBeenCalledTimes(2))
    await screen.findByText(/480×270/)
  })

  it('editing the name of a ready row PATCHes it on blur', async () => {
    vi.mocked(uploadGifFile).mockResolvedValue(makeGif('g1', 'Original'))
    vi.mocked(renameGif).mockResolvedValue(makeGif('g1', 'Renamed'))
    render(<ImportGifsModal onClose={vi.fn()} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } })
    const nameInput = await screen.findByDisplayValue('Original')

    fireEvent.change(nameInput, { target: { value: 'Renamed' } })
    fireEvent.blur(nameInput)

    await waitFor(() => expect(renameGif).toHaveBeenCalledWith('g1', 'Renamed'))
  })

  it('toggling Public on a ready row calls setGifPublic', async () => {
    vi.mocked(uploadGifFile).mockResolvedValue(makeGif('g1', 'A'))
    vi.mocked(setGifPublic).mockResolvedValue(makeGif('g1', 'A', { is_public: true }))
    render(<ImportGifsModal onClose={vi.fn()} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } })
    await screen.findByText(/480×270/)

    fireEvent.click(screen.getByRole('switch', { name: 'Public' }))

    await waitFor(() => expect(setGifPublic).toHaveBeenCalledWith('g1', true))
  })

  it('removing a ready row DELETEs it and reports the removal', async () => {
    vi.mocked(uploadGifFile).mockResolvedValue(makeGif('g1', 'A'))
    vi.mocked(deleteGif).mockResolvedValue(undefined)
    const onRemoved = vi.fn()
    render(<ImportGifsModal onClose={vi.fn()} onAdded={vi.fn()} onRemoved={onRemoved} />)

    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } })
    await screen.findByText(/480×270/)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(deleteGif).toHaveBeenCalledWith('g1'))
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('g1'))
    expect(screen.queryByText(/480×270/)).not.toBeInTheDocument()
  })

  it('closing without clicking Add does not confirm once an upload has already finished', async () => {
    vi.mocked(uploadGifFile).mockResolvedValue(makeGif('g1', 'A'))
    const onClose = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm')
    render(<ImportGifsModal onClose={onClose} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } })
    await screen.findByText(/480×270/)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closing while an upload is still in flight asks for confirmation', async () => {
    vi.mocked(uploadGifFile).mockImplementation(() => new Promise(() => {})) // never resolves
    const onClose = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ImportGifsModal onClose={onClose} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } })
    expect(screen.getByText('0%')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(window.confirm).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('ImportGifsModal — From links', () => {
  async function openLinksTab(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('tab', { name: 'From links' }))
  }

  it('"Add N GIFs" counts ready rows across both tabs combined', async () => {
    const user = userEvent.setup()
    vi.mocked(checkLink).mockResolvedValue({ width: 480, height: 270, sizeBytes: 1_400_000 })
    vi.mocked(uploadGifFile).mockResolvedValue(makeGif('g1', 'A'))
    render(<ImportGifsModal onClose={vi.fn()} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } })
    await screen.findByText(/480×270/)

    await openLinksTab(user)
    pasteInto(screen.getByLabelText('GIF link'), 'https://example.com/b.gif')
    await screen.findByText(/480×270/)

    expect(screen.getByRole('button', { name: /add 2 gifs/i })).toBeInTheDocument()
  })

  it('a non-GIF link shows the specific message', async () => {
    const user = userEvent.setup()
    vi.mocked(checkLink).mockRejectedValue(new Error("That link isn't a GIF. Use the direct link to the .gif file."))
    render(<ImportGifsModal onClose={vi.fn()} onAdded={vi.fn()} onRemoved={vi.fn()} />)

    await openLinksTab(user)
    pasteInto(screen.getByLabelText('GIF link'), 'https://example.com/not-a-gif.png')

    await screen.findByText("That link isn't a GIF. Use the direct link to the .gif file.")
  })
})
