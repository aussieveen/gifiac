import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Archive } from './Archive'
import type { Gif } from './types'

vi.mock('./api', () => ({
  listGifs: vi.fn(),
  renameGif: vi.fn(),
  deleteGif: vi.fn(),
  importGifs: vi.fn(),
  linkGif: vi.fn(),
  setGifOneOff: vi.fn(),
  setGifPublic: vi.fn(),
  recordGifUse: vi.fn(),
}))

import { deleteGif, importGifs, linkGif, listGifs, recordGifUse, renameGif, setGifOneOff, setGifPublic } from './api'

const gifA: Gif = {
  id: 'g1',
  video_id: 'v1',
  name: 'cat jumping',
  caption_text: 'meow',
  captions_json: '[]',
  gif_range_start: 0,
  gif_range_end: 2,
  width: 480,
  height: 270,
  external_url: null,
  created_at: '2026-01-01T00:00:00Z',
  is_one_off: false,
  is_public: false,
  use_count: 0,
  gif_url: 'http://localhost:19000/gifiac-test/gifs/g1.gif',
  mp4_url: 'http://localhost:19000/gifiac-test/clips/g1.mp4',
  webm_url: 'http://localhost:19000/gifiac-test/clips/g1.webm',
}

const gifB: Gif = {
  ...gifA,
  id: 'g2',
  name: 'dog running',
  caption_text: '',
  gif_url: 'http://localhost:19000/gifiac-test/gifs/g2.gif',
  mp4_url: 'http://localhost:19000/gifiac-test/clips/g2.mp4',
  webm_url: 'http://localhost:19000/gifiac-test/clips/g2.webm',
}

const linkedGif: Gif = {
  id: 'g3',
  video_id: null,
  name: 'linked meme',
  caption_text: '',
  captions_json: null,
  gif_range_start: null,
  gif_range_end: null,
  width: null,
  height: null,
  external_url: 'https://example.com/meme.gif',
  created_at: '2026-01-01T00:00:00Z',
  is_one_off: false,
  is_public: false,
  use_count: 0,
  gif_url: 'https://example.com/meme.gif',
  mp4_url: null,
  webm_url: null,
}

beforeEach(() => {
  vi.mocked(listGifs).mockReset()
  vi.mocked(renameGif).mockReset()
  vi.mocked(deleteGif).mockReset()
  vi.mocked(importGifs).mockReset()
  vi.mocked(linkGif).mockReset()
  vi.mocked(setGifOneOff).mockReset()
  vi.mocked(setGifPublic).mockReset()
  vi.mocked(recordGifUse).mockReset()
  // Fire-and-forget by design (see recordUse in Archive.tsx) — most tests
  // don't care about this call, so give it a harmless default that the
  // component's own `.catch(() => {})` swallows.
  vi.mocked(recordGifUse).mockRejectedValue(new Error('not mocked'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Archive', () => {
  it('lists gifs returned by the backend as grid thumbnails', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA, gifB])

    render(<Archive />)

    await screen.findByRole('button', { name: 'cat jumping' })
    expect(screen.getByRole('button', { name: 'dog running' })).toBeInTheDocument()
  })

  it('shows a load error if the list request fails', async () => {
    vi.mocked(listGifs).mockRejectedValue(new Error('/api/gifs failed (500): boom'))

    render(<Archive />)

    await screen.findByText(/boom/)
  })

  it('shows an empty state when there are no gifs', async () => {
    vi.mocked(listGifs).mockResolvedValue([])

    render(<Archive />)

    await screen.findByText(/no gifs yet/i)
  })

  it('re-queries the backend as the search box is typed into', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    render(<Archive />)
    await screen.findByRole('button', { name: 'cat jumping' })
    expect(listGifs).toHaveBeenCalledWith('')

    await user.type(screen.getByLabelText('Search archive'), 'cat')

    await waitFor(() => expect(listGifs).toHaveBeenLastCalledWith('cat'))
  })

  it('selecting a thumbnail opens its detail panel with a preview, name, caption, and date', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByLabelText('GIF name')).toHaveValue('cat jumping')
    expect(screen.getByText('meow')).toBeInTheDocument()
    const preview = screen.getByAltText('cat jumping preview') as HTMLImageElement
    expect(preview.src).toBe(gifA.gif_url)
  })

  it('selecting a different gif swaps the preview image so its animation restarts', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA, gifB])
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const firstPreview = screen.getByAltText('cat jumping preview')

    await user.click(screen.getByRole('button', { name: 'dog running' }))
    const secondPreview = screen.getByAltText('dog running preview')

    expect(firstPreview).not.toBe(secondPreview)
  })

  it('renaming on blur calls the API and updates the grid', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(renameGif).mockResolvedValue({ ...gifA, name: 'cat leaping' })
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const nameInput = screen.getByLabelText('GIF name')
    await user.clear(nameInput)
    await user.type(nameInput, 'cat leaping')
    await user.tab() // blur

    await waitFor(() => expect(renameGif).toHaveBeenCalledWith('g1', 'cat leaping'))
    expect(await screen.findByRole('button', { name: 'cat leaping' })).toBeInTheDocument()
  })

  it('copy link writes the gif url to the clipboard', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    // Defined after `userEvent.setup()`/`render` — user-event's own setup
    // touches `navigator.clipboard`, clobbering a stub installed earlier.
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    await user.click(screen.getByRole('button', { name: /copy link/i }))

    expect(writeText).toHaveBeenCalledWith(gifA.gif_url)
    await screen.findByText(/link copied/i)
  })

  it('copy link falls back to execCommand when navigator.clipboard is unavailable (e.g. an insecure-context LAN deployment)', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand

    await user.click(screen.getByRole('button', { name: /copy link/i }))

    expect(execCommand).toHaveBeenCalledWith('copy')
    await screen.findByText(/link copied/i)
  })

  it('copy embed writes an <img> tag to the clipboard', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    await user.click(screen.getByRole('button', { name: /copy embed/i }))

    expect(writeText).toHaveBeenCalledWith(`<img src="${gifA.gif_url}" alt="cat jumping">`)
    await screen.findByText(/embed copied/i)
  })

  it('copy embed falls back to execCommand when navigator.clipboard is unavailable', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand

    await user.click(screen.getByRole('button', { name: /copy embed/i }))

    expect(execCommand).toHaveBeenCalledWith('copy')
    await screen.findByText(/embed copied/i)
  })

  it('copy embed escapes HTML-sensitive characters in the alt attribute', async () => {
    const gifWithSpecialName = { ...gifA, name: 'cat & dog <"jumping">' }
    vi.mocked(listGifs).mockResolvedValue([gifWithSpecialName])
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: gifWithSpecialName.name }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    await user.click(screen.getByRole('button', { name: /copy embed/i }))

    expect(writeText).toHaveBeenCalledWith(
      `<img src="${gifA.gif_url}" alt="cat &amp; dog &lt;&quot;jumping&quot;&gt;">`,
    )
  })

  it('the download action links directly to the gif url', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const downloadLink = screen.getByRole('link', { name: /download/i }) as HTMLAnchorElement
    expect(downloadLink.href).toBe(gifA.gif_url)
  })

  it('copying a link bumps the use count and shows the updated total', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(recordGifUse).mockResolvedValue({ ...gifA, use_count: 1 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    expect(screen.getByText('0 uses')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /copy link/i }))

    expect(recordGifUse).toHaveBeenCalledWith('g1')
    await screen.findByText('1 use')
  })

  it('copying an embed bumps the use count', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(recordGifUse).mockResolvedValue({ ...gifA, use_count: 1 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })

    await user.click(screen.getByRole('button', { name: /copy embed/i }))

    expect(recordGifUse).toHaveBeenCalledWith('g1')
    await screen.findByText('1 use')
  })

  it('clicking download bumps the use count', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(recordGifUse).mockResolvedValue({ ...gifA, use_count: 1 })
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    await user.click(screen.getByRole('link', { name: /download/i }))

    expect(recordGifUse).toHaveBeenCalledWith('g1')
    await screen.findByText('1 use')
  })

  it('marking a gif as one-off calls the API and updates the button label', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(setGifOneOff).mockResolvedValue({ ...gifA, is_one_off: true })
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(screen.getByRole('button', { name: /mark as one-off/i }))

    expect(setGifOneOff).toHaveBeenCalledWith('g1', true)
    await screen.findByRole('button', { name: /mark as reusable/i })
    await screen.findByText(/marked as one-off/i)
  })

  it('marking a gif back as reusable calls the API with false', async () => {
    const oneOffGif = { ...gifA, is_one_off: true }
    vi.mocked(listGifs).mockResolvedValue([oneOffGif])
    vi.mocked(setGifOneOff).mockResolvedValue({ ...gifA, is_one_off: false })
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(screen.getByRole('button', { name: /mark as reusable/i }))

    expect(setGifOneOff).toHaveBeenCalledWith('g1', false)
    await screen.findByRole('button', { name: /mark as one-off/i })
    await screen.findByText(/marked as reusable/i)
  })

  it('making a gif public calls the API and updates the button label', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(setGifPublic).mockResolvedValue({ ...gifA, is_public: true })
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(screen.getByRole('button', { name: /make public/i }))

    expect(setGifPublic).toHaveBeenCalledWith('g1', true)
    await screen.findByRole('button', { name: /make private/i })
    await screen.findByText(/made public/i)
  })

  it('making a gif private calls the API with false', async () => {
    const publicGif = { ...gifA, is_public: true }
    vi.mocked(listGifs).mockResolvedValue([publicGif])
    vi.mocked(setGifPublic).mockResolvedValue({ ...gifA, is_public: false })
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(screen.getByRole('button', { name: /make private/i }))

    expect(setGifPublic).toHaveBeenCalledWith('g1', false)
    await screen.findByRole('button', { name: /make public/i })
    await screen.findByText(/made private/i)
  })

  it('shows a "One-offs" divider above one-off gifs in the grid, only when one exists', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA, gifB])
    const { rerender } = render(<Archive />)
    await screen.findByRole('button', { name: 'cat jumping' })
    expect(screen.queryByText('One-offs')).not.toBeInTheDocument()

    vi.mocked(listGifs).mockResolvedValue([gifA, { ...gifB, is_one_off: true }])
    rerender(<Archive key="reload" />)
    await screen.findByRole('button', { name: 'dog running' })
    expect(screen.getByText('One-offs')).toBeInTheDocument()
  })

  it('deleting asks for confirmation, then calls the API and clears the selection', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(deleteGif).mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(screen.getByRole('button', { name: /delete/i }))

    await waitFor(() => expect(deleteGif).toHaveBeenCalledWith('g1'))
    expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument()
    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
  })

  it('declining the confirmation does not delete', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(screen.getByRole('button', { name: /delete/i }))

    expect(deleteGif).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
  })

  it('importing files calls the API and prepends the created gifs to the grid', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(importGifs).mockResolvedValue([gifB])
    const user = userEvent.setup()

    render(<Archive />)
    await screen.findByRole('button', { name: 'cat jumping' })

    const file = new File(['bytes'], 'dog.gif', { type: 'image/gif' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    await waitFor(() => expect(importGifs).toHaveBeenCalledWith([file]))
    expect(await screen.findByRole('button', { name: 'dog running' })).toBeInTheDocument()
    await screen.findByText(/1 gif imported/i)
  })

  it('shows an import error without touching the grid', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(importGifs).mockRejectedValue(new Error('/api/gifs/import failed (400): bad file'))
    const user = userEvent.setup()

    render(<Archive />)
    await screen.findByRole('button', { name: 'cat jumping' })

    const file = new File(['bytes'], 'bad.gif', { type: 'image/gif' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    await screen.findByText(/bad file/)
    expect(screen.queryByRole('button', { name: 'dog running' })).not.toBeInTheDocument()
  })

  it('shows an external badge only for a linked gif, not a native/imported one', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA, linkedGif])

    render(<Archive />)
    await screen.findByRole('button', { name: 'cat jumping' })

    const nativeThumb = screen.getByRole('button', { name: 'cat jumping' })
    const linkedThumb = screen.getByRole('button', { name: 'linked meme' })
    expect(nativeThumb.querySelector('.archive-badge-external')).not.toBeInTheDocument()
    expect(linkedThumb.querySelector('.archive-badge-external')).toBeInTheDocument()
  })

  it('a linked gif shows "Open original" instead of Download, linking to the external url', async () => {
    vi.mocked(listGifs).mockResolvedValue([linkedGif])
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'linked meme' }))

    expect(screen.queryByRole('link', { name: /download/i })).not.toBeInTheDocument()
    const openOriginal = screen.getByRole('link', { name: /open original/i }) as HTMLAnchorElement
    expect(openOriginal.href).toBe(linkedGif.external_url)
  })

  it('a native gif still shows Download, not "Open original"', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('link', { name: /open original/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument()
  })

  it('adding a gif by url calls the API and prepends it to the grid', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(linkGif).mockResolvedValue(linkedGif)
    const user = userEvent.setup()

    render(<Archive />)
    await screen.findByRole('button', { name: 'cat jumping' })
    await user.click(screen.getByRole('button', { name: '+ Add from URL' }))
    await user.type(screen.getByLabelText('GIF URL'), 'https://example.com/meme.gif')
    await user.type(screen.getByLabelText('Linked GIF title'), 'linked meme')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(linkGif).toHaveBeenCalledWith('https://example.com/meme.gif', 'linked meme'))
    expect(await screen.findByRole('button', { name: 'linked meme' })).toBeInTheDocument()
    await screen.findByText(/^linked$/i)
  })

  it('shows a link error without touching the grid', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(linkGif).mockRejectedValue(new Error('/api/gifs/link failed (400): not an image'))
    const user = userEvent.setup()

    render(<Archive />)
    await screen.findByRole('button', { name: 'cat jumping' })
    await user.click(screen.getByRole('button', { name: '+ Add from URL' }))
    await user.type(screen.getByLabelText('GIF URL'), 'https://example.com/not-an-image')
    await user.type(screen.getByLabelText('Linked GIF title'), 'bad link')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByText(/not an image/)
    expect(screen.queryByRole('button', { name: 'bad link' })).not.toBeInTheDocument()
  })
})
