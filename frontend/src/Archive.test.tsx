import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Archive } from './Archive'
import { resizeTo } from './testUtils'
import type { CollectionWithCount, CurrentUser, Gif } from './types'

vi.mock('./api', () => ({
  listGifs: vi.fn(),
  listFavourites: vi.fn(),
  listCollections: vi.fn(),
  listCollectionGifs: vi.fn(),
  createCollection: vi.fn(),
  renameCollection: vi.fn(),
  deleteCollection: vi.fn(),
  addGifToCollection: vi.fn(),
  removeGifFromCollection: vi.fn(),
  gifCollectionIds: vi.fn(),
  renameGif: vi.fn(),
  deleteGif: vi.fn(),
  setGifOneOff: vi.fn(),
  setGifPublic: vi.fn(),
  recordGifUse: vi.fn(),
  favouriteGif: vi.fn(),
  unfavouriteGif: vi.fn(),
  getCurrentUser: vi.fn(),
}))

import {
  addGifToCollection,
  createCollection,
  deleteCollection,
  deleteGif,
  favouriteGif,
  getCurrentUser,
  gifCollectionIds,
  listCollectionGifs,
  listCollections,
  listFavourites,
  listGifs,
  recordGifUse,
  removeGifFromCollection,
  renameCollection,
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
  template_id: null,
  template_remixable: false,
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
  template_id: null,
  template_remixable: false,
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
  preferences: { disableGifAutoplay: false },
}

// Archive now renders a <Link> (the "Remix" secondary button, shown when a
// gif has a video_id) — needs a Router context to render, in production
// that's main.tsx's BrowserRouter, here a MemoryRouter.
function renderArchive(view: import('./LibrarySidebar').LibraryView = { kind: 'all' }) {
  return render(
    <MemoryRouter>
      <Archive view={view} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(listGifs).mockReset().mockResolvedValue({ items: [], has_more: false, total: 0, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 } })
  vi.mocked(listCollections).mockReset().mockResolvedValue([])
  vi.mocked(gifCollectionIds).mockReset().mockResolvedValue([])
  vi.mocked(listFavourites).mockReset()
  vi.mocked(renameGif).mockReset()
  vi.mocked(deleteGif).mockReset()
  vi.mocked(setGifOneOff).mockReset()
  vi.mocked(setGifPublic).mockReset()
  vi.mocked(recordGifUse).mockReset()
  vi.mocked(favouriteGif).mockReset()
  vi.mocked(unfavouriteGif).mockReset()
  // Archive now uses useCurrentUser() itself (SPEC-CLOUD.md §14, to gate
  // owner-only controls in Favourites mode) — default to a plain signed-in
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA, gifB], has_more: false, total: 2, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })

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
    vi.mocked(listGifs).mockResolvedValue({ items: [], has_more: false, total: 0, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })

    renderArchive()

    await screen.findByText(/no gifs yet/i)
  })

  it('re-queries the backend as the search box is typed into', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })
    expect(listGifs).toHaveBeenCalledWith('', 1)

    await user.type(screen.getByLabelText('Search archive'), 'cat')

    await waitFor(() => expect(listGifs).toHaveBeenLastCalledWith('cat', 1))
  })

  it('selecting a thumbnail opens its detail panel with a preview, name, caption, and date', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByLabelText('GIF name')).toHaveValue('cat jumping')
    expect(screen.getByText('meow')).toBeInTheDocument()
    const preview = screen.getByAltText('cat jumping preview') as HTMLImageElement
    expect(preview.src).toBe(gifA.gif_url)
  })

  it('selecting a different gif swaps the preview image so its animation restarts', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA, gifB], has_more: false, total: 2, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const firstPreview = screen.getByAltText('cat jumping preview')

    await user.click(screen.getByRole('button', { name: 'dog running' }))
    const secondPreview = screen.getByAltText('dog running preview')

    expect(firstPreview).not.toBe(secondPreview)
  })

  it('the close button closes the panel and returns focus to the tile', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    const tile = await screen.findByRole('button', { name: 'cat jumping' })
    await user.click(tile)
    expect(screen.getByLabelText('GIF name')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close details' }))

    expect(screen.queryByLabelText('GIF name')).not.toBeInTheDocument()
    expect(tile).toHaveFocus()
  })

  it('clicking the already-selected tile closes the panel', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    const tile = await screen.findByRole('button', { name: 'cat jumping' })
    await user.click(tile)
    expect(screen.getByLabelText('GIF name')).toBeInTheDocument()

    await user.click(tile)

    expect(screen.queryByLabelText('GIF name')).not.toBeInTheDocument()
  })

  it('clicking empty grid space closes the panel', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    expect(screen.getByLabelText('GIF name')).toBeInTheDocument()

    // The grid container itself (not a tile) — its own click handler only
    // fires for a click that lands directly on it, not one bubbled up from
    // a child, so target it directly rather than a descendant.
    await user.click(document.querySelector('.archive-grid')!)

    expect(screen.queryByLabelText('GIF name')).not.toBeInTheDocument()
  })

  it('Escape closes the panel and returns focus to the tile', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    const tile = await screen.findByRole('button', { name: 'cat jumping' })
    await user.click(tile)
    expect(screen.getByLabelText('GIF name')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByLabelText('GIF name')).not.toBeInTheDocument()
    expect(tile).toHaveFocus()
  })

  it('Escape does not close the panel while focus is in the rename field', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(screen.getByLabelText('GIF name'))

    await user.keyboard('{Escape}')

    expect(screen.getByLabelText('GIF name')).toBeInTheDocument()
  })

  it('renaming on blur calls the API and updates the grid', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifWithSpecialName], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const downloadLink = screen.getByRole('link', { name: /download/i }) as HTMLAnchorElement
    expect(downloadLink.href).toBe(gifA.gif_url)
  })

  it('copying a link bumps the use count and shows the updated total', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    vi.mocked(recordGifUse).mockResolvedValue({ ...gifA, use_count: 1 })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    await user.click(screen.getByRole('link', { name: /download/i }))

    expect(recordGifUse).toHaveBeenCalledWith('g1')
    await screen.findByText('1 use')
  })

  it('marking a gif as one-off calls the API and flips the One-off switch', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    vi.mocked(setGifOneOff).mockResolvedValue({ ...gifA, is_one_off: true })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const oneOffSwitch = screen.getByRole('switch', { name: 'Hide' })
    expect(oneOffSwitch).toHaveAttribute('aria-checked', 'false')

    await user.click(oneOffSwitch)

    expect(setGifOneOff).toHaveBeenCalledWith('g1', true)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Hide' })).toHaveAttribute('aria-checked', 'true'))
    await screen.findByText(/marked as hidden/i)
  })

  it('marking a gif back as reusable calls the API with false', async () => {
    const oneOffGif = { ...gifA, is_one_off: true }
    vi.mocked(listGifs).mockResolvedValue({ items: [oneOffGif], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    vi.mocked(setGifOneOff).mockResolvedValue({ ...gifA, is_one_off: false })
    const user = userEvent.setup()

    renderArchive()
    await user.click(screen.getByRole('button', { name: 'Hidden' }))
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const oneOffSwitch = screen.getByRole('switch', { name: 'Hide' })
    expect(oneOffSwitch).toHaveAttribute('aria-checked', 'true')

    await user.click(oneOffSwitch)

    expect(setGifOneOff).toHaveBeenCalledWith('g1', false)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Hide' })).toHaveAttribute('aria-checked', 'false'))
    await screen.findByText(/Marked as visible/i)
  })

  it('making a gif public calls the API and flips the Public switch', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [publicGif], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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

  it('a hidden gif never shows under All/Public/Private — only the Hidden chip reveals it', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA, { ...gifB, is_one_off: true, is_public: true }], has_more: false, total: 2, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()
    renderArchive()

    await screen.findByRole('button', { name: 'cat jumping' })
    expect(screen.queryByRole('button', { name: 'dog running' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Public' }))
    expect(screen.queryByRole('button', { name: 'dog running' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Hidden' }))
    expect(screen.getByRole('button', { name: 'dog running' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument()
  })

  it('deleting asks for confirmation, then calls the API and clears the selection', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [publicGif, privateOneOff], has_more: false, total: 2, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })
    // The hidden gif never shows under All — only the Hidden chip reveals it.
    expect(screen.queryByRole('button', { name: 'dog running' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Public' }))
    expect(screen.getByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'dog running' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Hidden' }))
    expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'dog running' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'dog running' })).not.toBeInTheDocument()
  })

  it('shows an external badge only for a linked gif, not a native/imported one', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA, linkedGif], has_more: false, total: 2, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })

    renderArchive()
    await screen.findByRole('button', { name: 'cat jumping' })

    const nativeThumb = screen.getByRole('button', { name: 'cat jumping' })
    const linkedThumb = screen.getByRole('button', { name: 'linked meme' })
    expect(nativeThumb.querySelector('.archive-badge-external')).not.toBeInTheDocument()
    expect(linkedThumb.querySelector('.archive-badge-external')).toBeInTheDocument()
  })

  it('a linked gif shows "Open original" instead of Download, linking to the external url', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [linkedGif], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'linked meme' }))

    expect(screen.queryByRole('link', { name: /download/i })).not.toBeInTheDocument()
    const openOriginal = screen.getByRole('link', { name: /open original/i }) as HTMLAnchorElement
    expect(openOriginal.href).toBe(linkedGif.external_url)
  })

  it('a native gif still shows Download, not "Open original"', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('link', { name: /open original/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument()
  })

  it('a gif with remixable template lineage offers a "Remix this GIF" link to that template', async () => {
    const gifWithTemplate = { ...gifA, template_id: 't1', template_remixable: true }
    vi.mocked(listGifs).mockResolvedValue({ items: [gifWithTemplate], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const remix = screen.getByRole('link', { name: /remix/i }) as HTMLAnchorElement
    expect(remix.getAttribute('href')).toBe('/from-template/t1')
  })

  it('a gif with template lineage that is no longer remixable (template deleted/made private) has no Remix link', async () => {
    const gifWithStaleTemplate = { ...gifA, template_id: 't1', template_remixable: false }
    vi.mocked(listGifs).mockResolvedValue({ items: [gifWithStaleTemplate], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('link', { name: /remix/i })).not.toBeInTheDocument()
  })

  it('a gif with no template lineage has no Remix link', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [linkedGif], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'linked meme' }))

    expect(screen.queryByRole('link', { name: /remix/i })).not.toBeInTheDocument()
  })

  it('marks the layout as having a selection, and the Back button clears it', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    resizeTo(390)
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByRole('button', { name: 'cat jumping' }).closest('.library-grid')).toHaveClass(
      'has-selection',
    )
    const backButton = screen.getByRole('button', { name: 'Back to library' })

    await user.click(backButton)

    expect(screen.getByRole('button', { name: 'cat jumping' }).closest('.library-grid')).not.toHaveClass(
      'has-selection',
    )
    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
  })

  it('has no close button below the editor breakpoint — the Back arrow is the only way to close', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    resizeTo(390)
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('button', { name: 'Close details' })).not.toBeInTheDocument()
  })

  it('hides Remix below the editor breakpoint', async () => {
    const videoGif = { ...gifA, video_id: 'v1' }
    vi.mocked(listGifs).mockResolvedValue({ items: [videoGif], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    resizeTo(390)
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('link', { name: 'Remix' })).not.toBeInTheDocument()
  })

  it('shows a pinned Share/Copy-link bar below the editor breakpoint', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
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
    vi.mocked(listGifs).mockResolvedValue({ items: [{ ...gifA, is_favourited: true }], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    vi.mocked(unfavouriteGif).mockResolvedValue({ ...gifA, is_favourited: false })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const panel = document.querySelector('.archive-panel') as HTMLElement
    await user.click(within(panel).getByRole('button', { name: 'Favourite', pressed: true }))

    expect(unfavouriteGif).toHaveBeenCalledWith('g1')
    expect(await within(panel).findByRole('button', { name: 'Favourite', pressed: false })).toBeInTheDocument()
  })

  it("the favourites view fetches and renders the caller's favourites, not All GIFs", async () => {
    vi.mocked(listFavourites).mockResolvedValue([{ ...gifB, owner_handle: 'jess', owner_slug: 'jess' }])

    renderArchive({ kind: 'favourites' })

    expect(await screen.findByRole('button', { name: 'dog running' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument()
  })

  it('shows an empty state with a link to the Global Library when Favourites has nothing', async () => {
    vi.mocked(listFavourites).mockResolvedValue([])

    renderArchive({ kind: 'favourites' })

    expect(await screen.findByText(/no favourites yet/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /browse global library/i })).toHaveAttribute('href', '/explore')
  })

  it('unfavouriting a gif in the favourites view removes it from view and closes its detail panel', async () => {
    vi.mocked(listFavourites).mockResolvedValue([{ ...gifA, is_favourited: true, owner_handle: null, owner_slug: null }])
    vi.mocked(unfavouriteGif).mockResolvedValue({ ...gifA, is_favourited: false })
    const user = userEvent.setup()

    renderArchive({ kind: 'favourites' })
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const panel = document.querySelector('.archive-panel') as HTMLElement
    await user.click(within(panel).getByRole('button', { name: 'Favourite', pressed: true }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument())
    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
  })

  it("shows owner attribution in the favourites view for someone else's gif", async () => {
    vi.mocked(listFavourites).mockResolvedValue([{ ...gifA, is_favourited: true, owner_handle: 'jess', owner_slug: 'jess' }])
    const user = userEvent.setup()

    renderArchive({ kind: 'favourites' })
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByRole('link', { name: 'by @jess' })).toHaveAttribute('href', '/u/jess')
  })

  it("hides owner-only controls (rename, Public/One-off, Delete, Remix) for someone else's gif in the favourites view", async () => {
    // The backend's own rename/publish/delete/remix-source endpoints are
    // ownership-scoped and 404 for a non-owner — this is the frontend
    // half: don't even offer controls that would just fail.
    vi.mocked(listFavourites).mockResolvedValue([
      { ...gifA, is_favourited: true, video_id: 'v1', owner_handle: 'jess', owner_slug: 'jess' },
    ])
    const user = userEvent.setup()

    renderArchive({ kind: 'favourites' })
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByLabelText('GIF name')).not.toBeInTheDocument()
    expect(screen.getByText('cat jumping')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Public' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Hide' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Remix' })).not.toBeInTheDocument()
  })

  it('still shows owner-only controls for your own gif favourited via the favourites view', async () => {
    vi.mocked(listFavourites).mockResolvedValue([
      { ...gifA, is_favourited: true, owner_handle: 'simon', owner_slug: 'simon' },
    ])
    const user = userEvent.setup()

    renderArchive({ kind: 'favourites' })
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByLabelText('GIF name')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Public' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
  })
})

const favouritesCollection: CollectionWithCount = {
  id: 'c-fav',
  ownerId: 'u1',
  name: 'Favourites',
  kind: 'favourites',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  gifCount: 0,
}

const roadtripCollection: CollectionWithCount = {
  id: 'c-roadtrip',
  ownerId: 'u1',
  name: 'Roadtrip',
  kind: 'custom',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  gifCount: 1,
}

describe('Archive collections', () => {
  it('opening the Save to collection picker shows every collection with its checked state', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    vi.mocked(listCollections).mockResolvedValue([favouritesCollection, roadtripCollection])
    vi.mocked(gifCollectionIds).mockResolvedValue(['c-roadtrip'])
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(await screen.findByRole('button', { name: 'Save to collection' }))

    const menu = await screen.findByRole('menu', { name: 'Save to collection' })
    expect(within(menu).getByRole('checkbox', { name: /Favourites/ })).toHaveAttribute('aria-checked', 'false')
    expect(within(menu).getByRole('checkbox', { name: /Roadtrip/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('checking a custom collection in the picker saves it there; unchecking removes it', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    vi.mocked(listCollections).mockResolvedValue([roadtripCollection])
    vi.mocked(gifCollectionIds).mockResolvedValue([])
    vi.mocked(addGifToCollection).mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(await screen.findByRole('button', { name: 'Save to collection' }))
    const menu = await screen.findByRole('menu', { name: 'Save to collection' })
    await user.click(within(menu).getByRole('checkbox', { name: /Roadtrip/ }))

    expect(addGifToCollection).toHaveBeenCalledWith('c-roadtrip', 'g1')
    await waitFor(() => expect(within(menu).getByRole('checkbox', { name: /Roadtrip/ })).toHaveAttribute('aria-checked', 'true'))

    vi.mocked(removeGifFromCollection).mockResolvedValue(undefined)
    await user.click(within(menu).getByRole('checkbox', { name: /Roadtrip/ }))
    expect(removeGifFromCollection).toHaveBeenCalledWith('c-roadtrip', 'g1')
  })

  it('checking the Favourites row in the picker favourites the gif, same as the star', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    vi.mocked(listCollections).mockResolvedValue([favouritesCollection])
    vi.mocked(gifCollectionIds).mockResolvedValue([])
    vi.mocked(favouriteGif).mockResolvedValue({ ...gifA, is_favourited: true })
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(await screen.findByRole('button', { name: 'Save to collection' }))
    const menu = await screen.findByRole('menu', { name: 'Save to collection' })
    await user.click(within(menu).getByRole('checkbox', { name: /Favourites/ }))

    expect(favouriteGif).toHaveBeenCalledWith('g1')
    const panel = document.querySelector('.archive-panel') as HTMLElement
    expect(within(panel).getByRole('button', { name: 'Favourite', pressed: true })).toBeInTheDocument()
  })

  it('creating a new collection from the picker creates it and adds the open gif', async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    vi.mocked(listCollections).mockResolvedValue([])
    vi.mocked(gifCollectionIds).mockResolvedValue([])
    vi.mocked(createCollection).mockResolvedValue({
      id: 'c-new',
      ownerId: 'u1',
      name: 'New One',
      kind: 'custom',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    vi.mocked(addGifToCollection).mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(await screen.findByRole('button', { name: 'Save to collection' }))
    const menu = await screen.findByRole('menu', { name: 'Save to collection' })
    await user.type(within(menu).getByLabelText('New collection name'), 'New One')
    await user.click(within(menu).getByRole('button', { name: /create/i }))

    expect(createCollection).toHaveBeenCalledWith('New One')
    await waitFor(() => expect(addGifToCollection).toHaveBeenCalledWith('c-new', 'g1'))
  })

  it("the detail panel's \"In collections\" chips link to the gif's collections", async () => {
    vi.mocked(listGifs).mockResolvedValue({ items: [gifA], has_more: false, total: 1, filter_counts: { all: 0, public: 0, private: 0, hidden: 0 }  })
    vi.mocked(listCollections).mockResolvedValue([roadtripCollection])
    vi.mocked(gifCollectionIds).mockResolvedValue(['c-roadtrip'])
    const user = userEvent.setup()

    renderArchive()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(await screen.findByText('In collections')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Roadtrip/ })).toHaveAttribute('href', '/library/c/c-roadtrip')
  })

  it("the \"Remove from '<collection>'\" button removes the gif from that collection's view", async () => {
    vi.mocked(listCollectionGifs).mockResolvedValue([{ ...gifA, owner_handle: 'simon', owner_slug: 'simon' }])
    vi.mocked(listCollections).mockResolvedValue([roadtripCollection])
    vi.mocked(gifCollectionIds).mockResolvedValue(['c-roadtrip'])
    vi.mocked(removeGifFromCollection).mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderArchive({ kind: 'collection', id: 'c-roadtrip' })
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(await screen.findByRole('button', { name: /remove from/i }))

    expect(removeGifFromCollection).toHaveBeenCalledWith('c-roadtrip', 'g1')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument())
  })

  it('renaming a collection via the ⋯ menu calls the API and updates the title', async () => {
    vi.mocked(listCollectionGifs).mockResolvedValue([])
    vi.mocked(listCollections).mockResolvedValue([roadtripCollection])
    vi.mocked(renameCollection).mockResolvedValue({ ...roadtripCollection, name: '2026 Roadtrip' })
    const user = userEvent.setup()

    renderArchive({ kind: 'collection', id: 'c-roadtrip' })
    await screen.findByText('Roadtrip', { selector: 'h1' })
    await user.click(screen.getByRole('button', { name: 'Collection options' }))
    await user.click(screen.getByRole('menuitem', { name: /rename/i }))

    const nameField = screen.getByLabelText('Name')
    await user.clear(nameField)
    await user.type(nameField, '2026 Roadtrip')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(renameCollection).toHaveBeenCalledWith('c-roadtrip', '2026 Roadtrip')
  })

  it('deleting a collection navigates away and offers an Undo that recreates it', async () => {
    vi.mocked(listCollectionGifs).mockResolvedValue([{ ...gifA, owner_handle: 'simon', owner_slug: 'simon' }])
    vi.mocked(listCollections).mockResolvedValue([roadtripCollection])
    vi.mocked(deleteCollection).mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderArchive({ kind: 'collection', id: 'c-roadtrip' })
    await screen.findByRole('button', { name: 'cat jumping' })
    await user.click(screen.getByRole('button', { name: 'Collection options' }))
    await user.click(screen.getByRole('menuitem', { name: /delete collection/i }))
    await user.click(screen.getByRole('button', { name: 'Delete collection' }))

    expect(deleteCollection).toHaveBeenCalledWith('c-roadtrip')
    expect(await screen.findByText(/deleted 'roadtrip'/i)).toBeInTheDocument()

    vi.mocked(createCollection).mockResolvedValue({
      id: 'c-restored',
      ownerId: 'u1',
      name: 'Roadtrip',
      kind: 'custom',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    vi.mocked(addGifToCollection).mockResolvedValue(undefined)
    await user.click(screen.getByRole('button', { name: 'Undo' }))

    expect(createCollection).toHaveBeenCalledWith('Roadtrip')
    await waitFor(() => expect(addGifToCollection).toHaveBeenCalledWith('c-restored', 'g1'))
  })

  it('the Mine/From others chips filter a collection view client-side', async () => {
    vi.mocked(listCollectionGifs).mockResolvedValue([
      { ...gifA, owner_handle: 'simon', owner_slug: 'simon' },
      { ...gifB, owner_handle: 'jess', owner_slug: 'jess' },
    ])
    vi.mocked(listCollections).mockResolvedValue([roadtripCollection])
    const user = userEvent.setup()

    renderArchive({ kind: 'collection', id: 'c-roadtrip' })
    await screen.findByRole('button', { name: 'cat jumping' })
    expect(screen.getByRole('button', { name: 'dog running' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Mine' }))
    expect(screen.getByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'dog running' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Borrowed' }))
    expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'dog running' })).toBeInTheDocument()
  })
})
