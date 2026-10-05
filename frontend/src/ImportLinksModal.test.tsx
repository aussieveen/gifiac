import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportLinksModal } from './ImportLinksModal'
import type { Gif } from './types'

vi.mock('./api', () => ({
  checkLink: vi.fn(),
  linkGif: vi.fn(),
}))

import { checkLink, linkGif } from './api'

function makeGif(id: string, name: string, isPublic: boolean): Gif {
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
    external_url: `https://example.com/${id}.gif`,
    created_at: '2026-01-01T00:00:00Z',
    is_one_off: false,
    is_public: isPublic,
    use_count: 0,
    is_favourited: false,
    template_id: null,
    template_remixable: false,
    gif_url: `https://example.com/${id}.gif`,
    mp4_url: null,
    webm_url: null,
  }
}

function pasteInto(input: HTMLElement, text: string) {
  fireEvent.paste(input, { clipboardData: { getData: () => text } })
}

beforeEach(() => {
  vi.mocked(checkLink).mockReset()
  vi.mocked(linkGif).mockReset()
})

describe('ImportLinksModal', () => {
  it('starts with a single empty, focused row', () => {
    render(<ImportLinksModal onClose={vi.fn()} onAdded={vi.fn()} />)

    const urlInputs = screen.getAllByLabelText('GIF link')
    expect(urlInputs).toHaveLength(1)
    expect(urlInputs[0]).toHaveFocus()
  })

  it('Esc closes the modal (no confirmation needed when nothing has been entered)', () => {
    const onClose = vi.fn()
    render(<ImportLinksModal onClose={onClose} onAdded={vi.fn()} />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pasting three URLs at once creates three rows', () => {
    render(<ImportLinksModal onClose={vi.fn()} onAdded={vi.fn()} />)

    pasteInto(
      screen.getAllByLabelText('GIF link')[0],
      'https://example.com/a.gif https://example.com/b.gif https://example.com/c.gif',
    )

    const urlInputs = screen.getAllByLabelText('GIF link') as HTMLInputElement[]
    expect(urlInputs).toHaveLength(3)
    expect(urlInputs.map((i) => i.value)).toEqual([
      'https://example.com/a.gif',
      'https://example.com/b.gif',
      'https://example.com/c.gif',
    ])
  })

  it('"Add another link" button adds and focuses a new empty row', async () => {
    const user = userEvent.setup()
    render(<ImportLinksModal onClose={vi.fn()} onAdded={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /add another link/i }))

    const urlInputs = screen.getAllByLabelText('GIF link')
    expect(urlInputs).toHaveLength(2)
    expect(urlInputs[1]).toHaveFocus()
  })

  it('the Public switch defaults off per row, and only a switched-on row is created public', async () => {
    vi.mocked(checkLink).mockResolvedValue({ width: 480, height: 270, sizeBytes: 1_400_000 })
    vi.mocked(linkGif).mockImplementation((url, name, isPublic) =>
      Promise.resolve(makeGif(url.includes('a.gif') ? 'a' : 'b', name, isPublic)),
    )
    const user = userEvent.setup()
    render(<ImportLinksModal onClose={vi.fn()} onAdded={vi.fn()} />)

    pasteInto(screen.getAllByLabelText('GIF link')[0], 'https://example.com/a.gif https://example.com/b.gif')
    await screen.findAllByText(/looks good/i)

    const switches = screen.getAllByRole('switch', { name: 'Public' })
    expect(switches.every((s) => s.getAttribute('aria-checked') === 'false')).toBe(true)
    await user.click(switches[0])

    fireEvent.click(screen.getByRole('button', { name: /add 2 gifs/i }))

    await waitFor(() => expect(linkGif).toHaveBeenCalledTimes(2))
    expect(linkGif).toHaveBeenCalledWith('https://example.com/a.gif', expect.any(String), true)
    expect(linkGif).toHaveBeenCalledWith('https://example.com/b.gif', expect.any(String), false)
  })

  it('"Add N GIFs" counts only ready rows, and an errored row stays in the modal after adding', async () => {
    vi.mocked(checkLink).mockImplementation((url) =>
      url.includes('good')
        ? Promise.resolve({ width: 480, height: 270, sizeBytes: 1_400_000 })
        : Promise.reject(new Error("That link isn't a GIF. Use the direct link to the .gif file.")),
    )
    vi.mocked(linkGif).mockResolvedValue(makeGif('g', 'good', false))
    const onAdded = vi.fn()
    render(<ImportLinksModal onClose={vi.fn()} onAdded={onAdded} />)

    pasteInto(screen.getAllByLabelText('GIF link')[0], 'https://example.com/good.gif https://example.com/bad.gif')
    await screen.findByText(/looks good/i)
    await screen.findByText(/isn't a gif/i)

    fireEvent.click(screen.getByRole('button', { name: /add 1 gif$/i }))

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith([expect.objectContaining({ id: 'g' })]))
    expect(linkGif).toHaveBeenCalledTimes(1)
    // The errored row survives — its URL is still in the DOM, and the
    // ready row that got committed is gone.
    expect(screen.getByDisplayValue('https://example.com/bad.gif')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('https://example.com/good.gif')).not.toBeInTheDocument()
  })

  it('a non-GIF link shows the specific "isn\'t a GIF" message', async () => {
    vi.mocked(checkLink).mockRejectedValue(new Error("That link isn't a GIF. Use the direct link to the .gif file."))
    render(<ImportLinksModal onClose={vi.fn()} onAdded={vi.fn()} />)

    pasteInto(screen.getAllByLabelText('GIF link')[0], 'https://example.com/not-a-gif.png')

    await screen.findByText("That link isn't a GIF. Use the direct link to the .gif file.")
  })

  it('pasting the same URL twice shows the within-modal duplicate message on the second row, leaving the first checked normally', async () => {
    vi.mocked(checkLink).mockResolvedValue({ width: 480, height: 270, sizeBytes: 1_400_000 })
    render(<ImportLinksModal onClose={vi.fn()} onAdded={vi.fn()} />)

    pasteInto(screen.getAllByLabelText('GIF link')[0], 'https://example.com/a.gif https://example.com/a.gif')

    await screen.findByText("You've already added this link above.")
    await screen.findByText(/looks good/i)
    // Only the first of the two identical URLs ever hits the network.
    expect(checkLink).toHaveBeenCalledTimes(1)
  })

  it('removing a row removes it from the modal', async () => {
    const user = userEvent.setup()
    render(<ImportLinksModal onClose={vi.fn()} onAdded={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /add another link/i }))
    expect(screen.getAllByLabelText('GIF link')).toHaveLength(2)

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    await user.click(removeButtons[0])

    expect(screen.getAllByLabelText('GIF link')).toHaveLength(1)
  })

  it('"Add GIFs" is disabled (reads N=0) when nothing is ready yet', () => {
    render(<ImportLinksModal onClose={vi.fn()} onAdded={vi.fn()} />)

    const addButton = screen.getByRole('button', { name: 'Add GIFs' })
    expect(addButton).toBeDisabled()
  })

  it('prefills the name from the URL, sentence-cased with dashes turned into spaces', async () => {
    vi.mocked(checkLink).mockResolvedValue({ width: 480, height: 270, sizeBytes: 1_400_000 })
    render(<ImportLinksModal onClose={vi.fn()} onAdded={vi.fn()} />)

    pasteInto(screen.getAllByLabelText('GIF link')[0], 'https://example.com/monday-standup-final-v2.gif')

    await waitFor(() => expect(screen.getByLabelText('GIF name')).toHaveValue('Monday standup final v2'))
  })

  it('a successful commit that clears every row auto-closes the modal', async () => {
    vi.mocked(checkLink).mockResolvedValue({ width: 480, height: 270, sizeBytes: 1_400_000 })
    vi.mocked(linkGif).mockResolvedValue(makeGif('g', 'good', false))
    const onClose = vi.fn()
    render(<ImportLinksModal onClose={onClose} onAdded={vi.fn()} />)

    pasteInto(screen.getAllByLabelText('GIF link')[0], 'https://example.com/good.gif')
    await screen.findByText(/looks good/i)

    fireEvent.click(screen.getByRole('button', { name: /add 1 gif$/i }))

    await waitFor(() => expect(linkGif).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
