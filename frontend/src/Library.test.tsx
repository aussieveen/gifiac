import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import { resizeTo } from './testUtils'
import type { CurrentUser, LibraryEntry } from './types'

vi.mock('./api', () => ({
  listLibrary: vi.fn(),
  recordGifUse: vi.fn(),
  adminDeleteGif: vi.fn(),
  getCurrentUser: vi.fn(),
  favouriteGif: vi.fn(),
  unfavouriteGif: vi.fn(),
  listCollections: vi.fn(),
  gifCollectionIds: vi.fn(),
  createCollection: vi.fn(),
  addGifToCollection: vi.fn(),
  removeGifFromCollection: vi.fn(),
}))

import {
  adminDeleteGif,
  favouriteGif,
  getCurrentUser,
  gifCollectionIds,
  listCollections,
  listLibrary,
  recordGifUse,
  unfavouriteGif,
} from './api'

const entryA: LibraryEntry = {
  id: 'g1',
  video_id: 'v1',
  name: 'cat jumping',
  caption_text: '',
  captions_json: null,
  gif_range_start: 0,
  gif_range_end: 1,
  width: 480,
  height: 270,
  external_url: null,
  created_at: '2026-01-01T00:00:00Z',
  is_one_off: false,
  is_public: true,
  use_count: 0,
  is_favourited: false,
  template_id: null,
  template_remixable: false,
  gif_url: 'http://example.com/g1.gif',
  owner_handle: 'simon',
  owner_slug: 'simon',
}

const plainUser: CurrentUser = {
  id: 'u1',
  handle: 'viewer',
  slug: 'viewer',
  role: 'user',
  avatarUrl: null,
  suggestedHandle: null,
  preferences: { disableGifAutoplay: false },
}

beforeEach(() => {
  vi.mocked(listLibrary).mockReset()
  vi.mocked(recordGifUse).mockReset()
  // Fire-and-forget by design (see recordUse in Library.tsx) — most tests
  // don't care about this call, so give it a harmless default that the
  // component's own `.catch(() => {})` swallows.
  vi.mocked(recordGifUse).mockRejectedValue(new Error('not mocked'))
  vi.mocked(adminDeleteGif).mockReset()
  vi.mocked(favouriteGif).mockReset()
  vi.mocked(unfavouriteGif).mockReset()
  vi.mocked(listCollections).mockReset().mockResolvedValue([])
  vi.mocked(gifCollectionIds).mockReset().mockResolvedValue([])
  // Library.tsx uses useCurrentUser() itself (only to gate the admin-only
  // Delete button) — default to a plain signed-in user; individual tests
  // override this to check the admin case.
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue(plainUser)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resizeTo(1440)
})

function renderLibrary() {
  return render(
    <MemoryRouter>
      <Library />
    </MemoryRouter>,
  )
}

describe('Library', () => {
  it('lists gifs returned by the backend as grid thumbnails', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    renderLibrary()

    expect(await screen.findByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
  })

  it('shows an empty state with no public gifs', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [], has_more: false, total: 0 })
    renderLibrary()

    expect(await screen.findByText(/no public gifs yet/i)).toBeInTheDocument()
  })

  it('re-queries as the search input changes', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [], has_more: false, total: 0 })
    const user = userEvent.setup()
    renderLibrary()

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'newest', 1))

    await user.type(screen.getByLabelText('Search the library'), 'cat')

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('cat', 'newest', 1))
  })

  it('selecting a tile opens its detail panel with attribution linking to the owner profile', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    const user = userEvent.setup()
    renderLibrary()

    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByText('cat jumping')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'by @simon' })
    expect(link).toHaveAttribute('href', '/u/simon')
  })

  it('shows the owner handle as typed, but links to the real (possibly suffixed) slug', async () => {
    // owner_slug is a real, backend-assigned field independent of
    // owner_handle's display case — including a collision suffix
    // (migration 0012) — so it must never be re-derived on the frontend.
    vi.mocked(listLibrary).mockResolvedValue({ items: [{ ...entryA, owner_handle: 'Simon_Mc', owner_slug: 'simon_mc2' }], has_more: false, total: 1 })
    const user = userEvent.setup()
    renderLibrary()

    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const link = screen.getByRole('link', { name: 'by @Simon_Mc' })
    expect(link).toHaveAttribute('href', '/u/simon_mc2')
  })

  it('the close button closes the panel and returns focus to the tile', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    const user = userEvent.setup()
    renderLibrary()

    const tile = await screen.findByRole('button', { name: 'cat jumping' })
    await user.click(tile)
    expect(screen.getByText(/simon/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close details' }))

    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
    expect(tile).toHaveFocus()
  })

  it('clicking the already-selected tile closes the panel', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    const user = userEvent.setup()
    renderLibrary()

    const tile = await screen.findByRole('button', { name: 'cat jumping' })
    await user.click(tile)
    await user.click(tile)

    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
  })

  it('clicking empty grid space closes the panel', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    const user = userEvent.setup()
    renderLibrary()

    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    expect(screen.getByText(/simon/i)).toBeInTheDocument()

    await user.click(document.querySelector('.archive-grid')!)

    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
  })

  it('Escape closes the panel and returns focus to the tile', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    const user = userEvent.setup()
    renderLibrary()

    const tile = await screen.findByRole('button', { name: 'cat jumping' })
    await user.click(tile)

    await user.keyboard('{Escape}')

    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
    expect(tile).toHaveFocus()
  })

  it('Escape does not close the panel while focus is in the search box', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    const user = userEvent.setup()
    renderLibrary()

    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(screen.getByLabelText('Search the library'))

    await user.keyboard('{Escape}')

    expect(screen.getByText(/simon/i)).toBeInTheDocument()
  })

  it('has no close button below the editor breakpoint — the Back arrow is the only way to close', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    resizeTo(390)
    const user = userEvent.setup()
    renderLibrary()

    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('button', { name: 'Close details' })).not.toBeInTheDocument()
  })

  it('the copy-link button copies the gif url and bumps its use count', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    vi.mocked(recordGifUse).mockResolvedValue({ ...entryA, use_count: 1 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderLibrary()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })

    await user.click(screen.getByRole('button', { name: /copy link/i }))

    expect(writeText).toHaveBeenCalledWith(entryA.gif_url)
    expect(recordGifUse).toHaveBeenCalledWith('g1')
    await screen.findByText('1 use')
  })

  it('the embed button copies an <img> tag', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderLibrary()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })

    await user.click(screen.getByRole('button', { name: 'Embed' }))

    expect(writeText).toHaveBeenCalledWith(`<img src="${entryA.gif_url}" alt="cat jumping">`)
    await screen.findByText(/embed copied/i)
  })

  it('switching the sort chip re-queries with the most-used sort', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    const user = userEvent.setup()
    renderLibrary()

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'newest', 1))

    await user.click(screen.getByRole('button', { name: 'Most used' }))

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'most-used', 1))
  })

  it('does not show a Delete button for a plain user', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    const user = userEvent.setup()
    renderLibrary()

    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })

  it('an admin can delete a gif from the detail panel', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ ...plainUser, role: 'admin' })
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    vi.mocked(adminDeleteGif).mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()

    renderLibrary()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    await user.click(screen.getByRole('button', { name: /delete/i }))

    await waitFor(() => expect(adminDeleteGif).toHaveBeenCalledWith('g1'))
    expect(screen.queryByRole('button', { name: 'cat jumping' })).not.toBeInTheDocument()
    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
  })

  it('shows a mobile top bar with a Back button below the editor breakpoint', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    resizeTo(390)
    const user = userEvent.setup()

    renderLibrary()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const backButton = screen.getByRole('button', { name: 'Back to library' })
    await user.click(backButton)

    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
  })

  it('shows a pinned Share/Copy-link bar below the editor breakpoint', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    resizeTo(390)
    const user = userEvent.setup()

    renderLibrary()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(document.querySelector('.archive-mobile-action-bar')).not.toBeNull()
  })
})

// SPEC-CLOUD.md §14.
describe('Library favourites', () => {
  it('clicking a thumbnail star favourites it without opening the detail panel', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    vi.mocked(favouriteGif).mockResolvedValue({ ...entryA, is_favourited: true })
    const user = userEvent.setup()

    renderLibrary()
    await user.click(await screen.findByRole('button', { name: 'Favourite', pressed: false }))

    expect(favouriteGif).toHaveBeenCalledWith('g1')
    expect(screen.getByText(/select a gif/i)).toBeInTheDocument()
    const grid = document.querySelector('.archive-grid') as HTMLElement
    expect(await within(grid).findByRole('button', { name: 'Favourite', pressed: true })).toBeInTheDocument()
  })

  it('the detail panel favourite button unfavourites an already-saved gif', async () => {
    vi.mocked(listLibrary).mockResolvedValue({ items: [{ ...entryA, is_favourited: true }], has_more: false, total: 1 })
    vi.mocked(unfavouriteGif).mockResolvedValue({ ...entryA, is_favourited: false })
    const user = userEvent.setup()

    renderLibrary()
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))
    const panel = document.querySelector('.archive-panel') as HTMLElement
    await user.click(within(panel).getByRole('button', { name: 'Favourite', pressed: true }))

    expect(unfavouriteGif).toHaveBeenCalledWith('g1')
    expect(await within(panel).findByRole('button', { name: 'Favourite', pressed: false })).toBeInTheDocument()
  })
})

describe('Library logged out', () => {
  it('shows no favourite or save-to-collection button on a grid tile', async () => {
    vi.mocked(getCurrentUser).mockReset().mockResolvedValue(null)
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    renderLibrary()

    await screen.findByRole('button', { name: 'cat jumping' })
    expect(screen.queryByRole('button', { name: 'Favourite' })).not.toBeInTheDocument()
  })

  it('shows no favourite or save-to-collection button in the detail panel', async () => {
    vi.mocked(getCurrentUser).mockReset().mockResolvedValue(null)
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: false, total: 1 })
    const user = userEvent.setup()
    renderLibrary()

    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('button', { name: 'Favourite' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save to collection' })).not.toBeInTheDocument()
    expect(listCollections).not.toHaveBeenCalled()
  })
})

describe('Library infinite scroll', () => {
  // jsdom has no real IntersectionObserver — useInfiniteScroll.ts's one
  // instance per enabled sentinel is captured so the test can fire its
  // callback directly, the same way a real scroll-into-view would.
  class FakeIntersectionObserver {
    static instances: FakeIntersectionObserver[] = []
    callback: IntersectionObserverCallback
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback
      FakeIntersectionObserver.instances.push(this)
    }
    observe() {}
    disconnect() {}
  }

  beforeEach(() => {
    FakeIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  })

  it('requests page 2 and appends it below page 1 when the sentinel intersects, never a Load More button', async () => {
    const entryB: LibraryEntry = { ...entryA, id: 'g2', name: 'dog running' }
    vi.mocked(listLibrary).mockResolvedValue({ items: [entryA], has_more: true, total: 2 })
    renderLibrary()

    await screen.findByRole('button', { name: 'cat jumping' })
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
    // The header shows the server's real total (2), not items.length (1
    // loaded so far) — the whole point of the backend sending `total`.
    expect(screen.getByText('2 GIFs')).toBeInTheDocument()

    vi.mocked(listLibrary).mockResolvedValue({ items: [entryB], has_more: false, total: 2 })
    const observer = FakeIntersectionObserver.instances.at(-1)
    observer?.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    )

    await screen.findByRole('button', { name: 'dog running' })
    expect(listLibrary).toHaveBeenLastCalledWith('', 'newest', 2)
    // Page 1's item is still there — page 2 appends, it doesn't replace.
    expect(screen.getByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
  })
})
