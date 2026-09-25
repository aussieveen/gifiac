import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Archive } from './Archive'
import { resizeTo } from './testUtils'
import type { CurrentUser, Gif } from './types'

vi.mock('./api', () => ({
  listGifs: vi.fn(),
  listFavourites: vi.fn(),
  renameGif: vi.fn(),
  deleteGif: vi.fn(),
  importGifs: vi.fn(),
  linkGif: vi.fn(),
  setGifOneOff: vi.fn(),
  setGifPublic: vi.fn(),
  recordGifUse: vi.fn(),
  favouriteGif: vi.fn(),
  unfavouriteGif: vi.fn(),
  getCurrentUser: vi.fn(),
}))

import {
  deleteGif,
  favouriteGif,
  getCurrentUser,
  importGifs,
  linkGif,
  listFavourites,
  listGifs,
  recordGifUse,
  renameGif,
  setGifOneOff,
  setGifPublic,
  unfavouriteGif,
} from './api'

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
  is_favourited: false,
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
  is_favourited: false,
  gif_url: 'https://example.com/meme.gif',
  mp4_url: null,
  webm_url: null,
}

const plainUser: CurrentUser = {
  id: 'u1',
  handle: 'simon',
  slug: 'simon',
  role: 'user',
  avatarUrl: null,
  suggestedHandle: null,
}

// Archive now renders a <Link> (the "Remix" secondary button, shown when a
// gif has a video_id) — needs a Router context to render, in production
// that's main.tsx's BrowserRouter, here a MemoryRouter.
function renderArchive() {
  return render(
    <MemoryRouter>
      <Archive />
    </MemoryRouter>,
  )
}

/** Opens the "Import" menu (design brief §4 moved "Upload GIFs"/"Add from
 * URL" behind it) — both the file input and the "Add from URL" trigger
 * only exist in the DOM while it's open. */
async function openImportMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /import/i }))
}

beforeEach(() => {
  vi.mocked(listGifs).mockReset()
  vi.mocked(listFavourites).mockReset()
  vi.mocked(renameGif).mockReset()
  vi.mocked(deleteGif).mockReset()
  vi.mocked(importGifs).mockReset()
  vi.mocked(linkGif).mockReset()
  vi.mocked(setGifOneOff).mockReset()
  vi.mocked(setGifPublic).mockReset()
  vi.mocked(recordGifUse).mockReset()
  vi.mocked(favouriteGif).mockReset()
  vi.mocked(unfavouriteGif).mockReset()
  // Archive now uses useCurrentUser() itself (SPEC-CLOUD.md §14, to gate
  // owner-only controls in Saved mode) — default to a plain signed-in
  // user matching gifA/gifB's implicit ownership.
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue(plainUser)
  // Fire-and-forget by design (see recordUse in Archive.tsx) — most tests
  // don't care about this call, so give it a harmless default that the
  // component's own `.catch(() => {})` swallows.
  vi.mocked(recordGifUse).mockRejectedValue(new Error('not mocked'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resizeTo(1440)
})

describe('Archive', () => {
  it('lists gifs returned by the backend as grid thumbnails', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA, gifB])

    renderArchive()

    await screen.findByRole('button', { name: 'cat jumping' })
    expect(screen.getByRole('button', { name: 'dog running' })).toBeInTheDocument()
  })

  it('shows a load error if the list request fails', async () => {
    vi.mocked(listGifs).mockRejectedValue(new Error('/api/gifs failed (500): boom'))

    renderArchive()

    await screen.findByText(/boom/)
  })

  it('shows an empty state when there are no gifs', async () => {
    vi.mocked(listGifs).mockResolvedValue([])

    renderArchive()

    await screen.findByText(/no gifs yet/i)
  })

  it('re-queries the backend as the search box is typed into', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })
    expect(listGifs).toHaveBeenCalledWith('')

    await user.type(screen.getByLabelText('Search archive'), 'cat')

    await waitFor(() => expect(listGifs).toHaveBeenLastCalledWith('cat'))
  })

  it('selecting a thumbnail opens its detail panel with a preview, name, caption, and date', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByLabelText('GIF name')).toHaveValue('cat jumping')
    expect(screen.getByText('meow')).toBeInTheDocument()
    const preview = screen.getByAltText('cat jumping preview') as HTMLImageElement
    expect(preview.src).toBe(gifA.gif_url)
  })

  it('selecting a different gif swaps the preview image so its animation restarts', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA, gifB])
    const user = userEvent.setup()

    renderArchive()
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

    renderArchive()
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

    renderArchive()
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

    renderArchive()
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

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    await user.click(screen.getByRole('button', { name: 'Embed' }))

    expect(writeText).toHaveBeenCalledWith(`<img src="${gifA.gif_url}" alt="cat jumping">`)
    await screen.findByText(/embed copied/i)
  })

  it('copy embed falls back to execCommand when navigator.clipboard is unavailable', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand

    await user.click(screen.getByRole('button', { name: 'Embed' }))

    expect(execCommand).toHaveBeenCalledWith('copy')
    await screen.findByText(/embed copied/i)
  })

  it('copy embed escapes HTML-sensitive characters in the alt attribute', async () => {
    const gifWithSpecialName = { ...gifA, name: 'cat & dog <"jumping">' }
    vi.mocked(listGifs).mockResolvedValue([gifWithSpecialName])
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: gifWithSpecialName.name }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
    await user.click(screen.getByRole('button', { name: 'Embed' }))

    expect(writeText).toHaveBeenCalledWith(
      `<img src="${gifA.gif_url}" alt="cat &amp; dog &lt;&quot;jumping&quot;&gt;">`,
    )
  })

  it('the download action links directly to the gif url', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const downloadLink = screen.getByRole('link', { name: /download/i }) as HTMLAnchorElement
    expect(downloadLink.href).toBe(gifA.gif_url)
  })

  it('copying a link bumps the use count and shows the updated total', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(recordGifUse).mockResolvedValue({ ...gifA, use_count: 1 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderArchive()
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

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })

    await user.click(screen.getByRole('button', { name: 'Embed' }))

    expect(recordGifUse).toHaveBeenCalledWith('g1')
    await screen.findByText('1 use')
  })

  it('clicking download bumps the use count', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(recordGifUse).mockResolvedValue({ ...gifA, use_count: 1 })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    await user.click(screen.getByRole('link', { name: /download/i }))

    expect(recordGifUse).toHaveBeenCalledWith('g1')
    await screen.findByText('1 use')
  })

  it('marking a gif as one-off calls the API and flips the One-off switch', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(setGifOneOff).mockResolvedValue({ ...gifA, is_one_off: true })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const oneOffSwitch = screen.getByRole('switch', { name: 'One-off' })
    expect(oneOffSwitch).toHaveAttribute('aria-checked', 'false')

    await user.click(oneOffSwitch)

    expect(setGifOneOff).toHaveBeenCalledWith('g1', true)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'One-off' })).toHaveAttribute('aria-checked', 'true'))
    await screen.findByText(/marked as one-off/i)
  })

  it('marking a gif back as reusable calls the API with false', async () => {
    const oneOffGif = { ...gifA, is_one_off: true }
    vi.mocked(listGifs).mockResolvedValue([oneOffGif])
    vi.mocked(setGifOneOff).mockResolvedValue({ ...gifA, is_one_off: false })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const oneOffSwitch = screen.getByRole('switch', { name: 'One-off' })
    expect(oneOffSwitch).toHaveAttribute('aria-checked', 'true')

    await user.click(oneOffSwitch)

    expect(setGifOneOff).toHaveBeenCalledWith('g1', false)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'One-off' })).toHaveAttribute('aria-checked', 'false'))
    await screen.findByText(/marked as reusable/i)
  })

  it('making a gif public calls the API and flips the Public switch', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(setGifPublic).mockResolvedValue({ ...gifA, is_public: true })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const publicSwitch = screen.getByRole('switch', { name: 'Public' })
    expect(publicSwitch).toHaveAttribute('aria-checked', 'false')

    await user.click(publicSwitch)

    expect(setGifPublic).toHaveBeenCalledWith('g1', true)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Public' })).toHaveAttribute('aria-checked', 'true'))
    await screen.findByText(/made public/i)
  })

  it('making a gif private calls the API with false', async () => {
    const publicGif = { ...gifA, is_public: true }
    vi.mocked(listGifs).mockResolvedValue([publicGif])
    vi.mocked(setGifPublic).mockResolvedValue({ ...gifA, is_public: false })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const publicSwitch = screen.getByRole('switch', { name: 'Public' })
    expect(publicSwitch).toHaveAttribute('aria-checked', 'true')

    await user.click(publicSwitch)

    expect(setGifPublic).toHaveBeenCalledWith('g1', false)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Public' })).toHaveAttribute('aria-checked', 'false'))
    await screen.findByText(/made private/i)
  })

  it('shows a "One-offs" divider above one-off gifs in the grid, only when one exists', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA, gifB])
    const { rerender } = render(
      <MemoryRouter>
        <Archive />
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: 'cat jumping' })
    expect(screen.queryByText('One-offs', { selector: '.archive-grid-divider' })).not.toBeInTheDocument()

    vi.mocked(listGifs).mockResolvedValue([gifA, { ...gifB, is_one_off: true }])
    rerender(
      <MemoryRouter>
        <Archive key="reload" />
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: 'dog running' })
    expect(screen.getByText('One-offs', { selector: '.archive-grid-divider' })).toBeInTheDocument()
  })

  it('deleting asks for confirmation, then calls the API and clears the selection', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(deleteGif).mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()

    renderArchive()
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

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(screen.getByRole('button', { name: /delete/i }))

    expect(deleteGif).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
  })

  it('the filter chips narrow the grid client-side', async () => {
    const publicGif = { ...gifA, is_public: true }
    const privateOneOff = { ...gifB, is_public: false, is_one_off: true }
    vi.mocked(listGifs).mockResolvedValue([publicGif, privateOneOff])
    const user = userEvent.setup()

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })
    expect(screen.getByRole('button', { name: 'dog running' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Public' }))
    expect(screen.getByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'dog running' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'One-offs' }))
    expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'dog running' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'dog running' })).toBeInTheDocument()
  })

  it('the Favourites chip narrows the grid to favourited gifs only', async () => {
    const favourited = { ...gifA, is_favourited: true }
    const notFavourited = { ...gifB, is_favourited: false }
    vi.mocked(listGifs).mockResolvedValue([favourited, notFavourited])
    const user = userEvent.setup()

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })

    await user.click(screen.getByRole('button', { name: 'Favourites' }))
    expect(screen.getByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'dog running' })).not.toBeInTheDocument()
  })

  it('importing files calls the API and prepends the created gifs to the grid', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(importGifs).mockResolvedValue([gifB])
    const user = userEvent.setup()

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })
    await openImportMenu(user)

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

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })
    await openImportMenu(user)

    const file = new File(['bytes'], 'bad.gif', { type: 'image/gif' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    await screen.findByText(/bad file/)
    expect(screen.queryByRole('button', { name: 'dog running' })).not.toBeInTheDocument()
  })

  it('shows an external badge only for a linked gif, not a native/imported one', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA, linkedGif])

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })

    const nativeThumb = screen.getByRole('button', { name: 'cat jumping' })
    const linkedThumb = screen.getByRole('button', { name: 'linked meme' })
    expect(nativeThumb.querySelector('.archive-badge-external')).not.toBeInTheDocument()
    expect(linkedThumb.querySelector('.archive-badge-external')).toBeInTheDocument()
  })

  it('a linked gif shows "Open original" instead of Download, linking to the external url', async () => {
    vi.mocked(listGifs).mockResolvedValue([linkedGif])
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'linked meme' }))

    expect(screen.queryByRole('link', { name: /download/i })).not.toBeInTheDocument()
    const openOriginal = screen.getByRole('link', { name: /open original/i }) as HTMLAnchorElement
    expect(openOriginal.href).toBe(linkedGif.external_url)
  })

  it('a native gif still shows Download, not "Open original"', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('link', { name: /open original/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument()
  })

  it('a gif with a video_id offers a Remix link back into the editor', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const remix = screen.getByRole('link', { name: 'Remix' }) as HTMLAnchorElement
    expect(remix.getAttribute('href')).toBe(`/edit/${gifA.video_id}`)
  })

  it('a linked gif (no video_id) has no Remix link', async () => {
    vi.mocked(listGifs).mockResolvedValue([linkedGif])
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'linked meme' }))

    expect(screen.queryByRole('link', { name: 'Remix' })).not.toBeInTheDocument()
  })

  it('adding a gif by url calls the API and prepends it to the grid', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(linkGif).mockResolvedValue(linkedGif)
    const user = userEvent.setup()

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })
    await openImportMenu(user)
    await user.click(screen.getByRole('menuitem', { name: 'Add from URL' }))
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

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })
    await openImportMenu(user)
    await user.click(screen.getByRole('menuitem', { name: 'Add from URL' }))
    await user.type(screen.getByLabelText('GIF URL'), 'https://example.com/not-an-image')
    await user.type(screen.getByLabelText('Linked GIF title'), 'bad link')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByText(/not an image/)
    expect(screen.queryByRole('button', { name: 'bad link' })).not.toBeInTheDocument()
  })

  it('marks the layout as having a selection, and the Back button clears it', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    resizeTo(390)
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByRole('button', { name: 'cat jumping' }).closest('.archive-layout')).toHaveClass(
      'has-selection',
    )
    const backButton = screen.getByRole('button', { name: 'Back to library' })

    await user.click(backButton)

    expect(screen.getByRole('button', { name: 'cat jumping' }).closest('.archive-layout')).not.toHaveClass(
      'has-selection',
    )
    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
  })

  it('hides Remix below the editor breakpoint', async () => {
    const videoGif = { ...gifA, video_id: 'v1' }
    vi.mocked(listGifs).mockResolvedValue([videoGif])
    resizeTo(390)
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('link', { name: 'Remix' })).not.toBeInTheDocument()
  })

  it('shows a pinned Share/Copy-link bar below the editor breakpoint', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    resizeTo(390)
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(document.querySelector('.archive-mobile-action-bar')).not.toBeNull()
  })
})

// SPEC-CLOUD.md §14.
describe('Archive favourites', () => {
  it('clicking a thumbnail star favourites it without opening the detail panel', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(favouriteGif).mockResolvedValue({ ...gifA, is_favourited: true })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'Favourite', pressed: false }))

    expect(favouriteGif).toHaveBeenCalledWith('g1')
    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
    const grid = document.querySelector('.archive-grid') as HTMLElement
    expect(await within(grid).findByRole('button', { name: 'Favourite', pressed: true })).toBeInTheDocument()
  })

  it('the detail panel favourite button unfavourites an already-saved gif', async () => {
    vi.mocked(listGifs).mockResolvedValue([{ ...gifA, is_favourited: true }])
    vi.mocked(unfavouriteGif).mockResolvedValue({ ...gifA, is_favourited: false })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const panel = document.querySelector('.archive-panel') as HTMLElement
    await user.click(within(panel).getByRole('button', { name: 'Favourite', pressed: true }))

    expect(unfavouriteGif).toHaveBeenCalledWith('g1')
    expect(await within(panel).findByRole('button', { name: 'Favourite', pressed: false })).toBeInTheDocument()
  })

  it('switching to Saved mode fetches and renders the caller\'s favourites, not "My GIFs"', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(listFavourites).mockResolvedValue([{ ...gifB, owner_handle: 'jess', owner_slug: 'jess' }])
    const user = userEvent.setup()

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })

    await user.click(screen.getByRole('button', { name: 'Saved' }))

    expect(await screen.findByRole('button', { name: 'dog running' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument()
  })

  it('shows an empty state with a link to the Global Library when Saved has nothing', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    vi.mocked(listFavourites).mockResolvedValue([])
    const user = userEvent.setup()

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })
    await user.click(screen.getByRole('button', { name: 'Saved' }))

    expect(await screen.findByText(/no saved gifs yet/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /browse global library/i })).toHaveAttribute('href', '/explore')
  })

  it('unfavouriting a gif in Saved mode removes it from view and closes its detail panel', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(listFavourites).mockResolvedValue([{ ...gifA, is_favourited: true, owner_handle: null, owner_slug: null }])
    vi.mocked(unfavouriteGif).mockResolvedValue({ ...gifA, is_favourited: false })
    const user = userEvent.setup()

    renderArchive()
    await user.click(screen.getByRole('button', { name: 'My GIFs' })) // ensure default mode's fetch settles first
    await user.click(screen.getByRole('button', { name: 'Saved' }))
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const panel = document.querySelector('.archive-panel') as HTMLElement
    await user.click(within(panel).getByRole('button', { name: 'Favourite', pressed: true }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument())
    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
  })

  it('shows owner attribution in Saved mode for someone else\'s gif', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(listFavourites).mockResolvedValue([{ ...gifA, is_favourited: true, owner_handle: 'jess', owner_slug: 'jess' }])
    const user = userEvent.setup()

    renderArchive()
    await user.click(screen.getByRole('button', { name: 'Saved' }))
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByRole('link', { name: 'jess' })).toHaveAttribute('href', '/u/jess')
  })

  it('hides owner-only controls (rename, Public/One-off, Delete, Remix) for someone else\'s gif in Saved mode', async () => {
    // The backend's own rename/publish/delete/remix-source endpoints are
    // ownership-scoped and 404 for a non-owner — this is the frontend
    // half: don't even offer controls that would just fail.
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(listFavourites).mockResolvedValue([
      { ...gifA, is_favourited: true, video_id: 'v1', owner_handle: 'jess', owner_slug: 'jess' },
    ])
    const user = userEvent.setup()

    renderArchive()
    await user.click(screen.getByRole('button', { name: 'Saved' }))
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByLabelText('GIF name')).not.toBeInTheDocument()
    expect(screen.getByText('cat jumping')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Public' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'One-off' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Remix' })).not.toBeInTheDocument()
  })

  it('still shows owner-only controls for your own gif favourited via Saved mode', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(listFavourites).mockResolvedValue([
      { ...gifA, is_favourited: true, owner_handle: 'simon', owner_slug: 'simon' },
    ])
    const user = userEvent.setup()

    renderArchive()
    await user.click(screen.getByRole('button', { name: 'Saved' }))
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByLabelText('GIF name')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Public' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
  })
})
