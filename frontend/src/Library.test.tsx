import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import type { CurrentUser, LibraryEntry } from './types'

vi.mock('./api', () => ({
  listLibrary: vi.fn(),
  recordGifUse: vi.fn(),
  adminDeleteGif: vi.fn(),
  getCurrentUser: vi.fn(),
}))

import { adminDeleteGif, getCurrentUser, listLibrary, recordGifUse } from './api'

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
}

beforeEach(() => {
  vi.mocked(listLibrary).mockReset()
  vi.mocked(recordGifUse).mockReset()
  // Fire-and-forget by design (see recordUse in Library.tsx) — most tests
  // don't care about this call, so give it a harmless default that the
  // component's own `.catch(() => {})` swallows.
  vi.mocked(recordGifUse).mockRejectedValue(new Error('not mocked'))
  vi.mocked(adminDeleteGif).mockReset()
  // Library.tsx uses useCurrentUser() itself (only to gate the admin-only
  // Delete button) — default to a plain signed-in user; individual tests
  // override this to check the admin case.
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue(plainUser)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
    vi.mocked(listLibrary).mockResolvedValue([entryA])
    renderLibrary()

    expect(await screen.findByRole('button', { name: 'cat jumping' })).toBeInTheDocument()
  })

  it('shows an empty state with no public gifs', async () => {
    vi.mocked(listLibrary).mockResolvedValue([])
    renderLibrary()

    expect(await screen.findByText(/no public gifs yet/i)).toBeInTheDocument()
  })

  it('re-queries as the search input changes', async () => {
    vi.mocked(listLibrary).mockResolvedValue([])
    const user = userEvent.setup()
    renderLibrary()

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'newest'))

    await user.type(screen.getByLabelText('Search the library'), 'cat')

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('cat', 'newest'))
  })

  it('selecting a tile opens its detail panel with attribution linking to the owner profile', async () => {
    vi.mocked(listLibrary).mockResolvedValue([entryA])
    const user = userEvent.setup()
    renderLibrary()

    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.getByText('cat jumping')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'simon' })
    expect(link).toHaveAttribute('href', '/u/simon')
  })

  it('shows the owner handle as typed, but links to the real (possibly suffixed) slug', async () => {
    // owner_slug is a real, backend-assigned field independent of
    // owner_handle's display case — including a collision suffix
    // (migration 0012) — so it must never be re-derived on the frontend.
    vi.mocked(listLibrary).mockResolvedValue([{ ...entryA, owner_handle: 'Simon_Mc', owner_slug: 'simon_mc2' }])
    const user = userEvent.setup()
    renderLibrary()

    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const link = screen.getByRole('link', { name: 'Simon_Mc' })
    expect(link).toHaveAttribute('href', '/u/simon_mc2')
  })

  it('the copy-link button copies the gif url and bumps its use count', async () => {
    vi.mocked(listLibrary).mockResolvedValue([entryA])
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
    vi.mocked(listLibrary).mockResolvedValue([entryA])
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
    vi.mocked(listLibrary).mockResolvedValue([entryA])
    const user = userEvent.setup()
    renderLibrary()

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'newest'))

    await user.click(screen.getByRole('button', { name: 'Most used' }))

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'most-used'))
  })

  it('does not show a Delete button for a plain user', async () => {
    vi.mocked(listLibrary).mockResolvedValue([entryA])
    const user = userEvent.setup()
    renderLibrary()

    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })

  it('an admin can delete a gif from the detail panel', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ ...plainUser, role: 'admin' })
    vi.mocked(listLibrary).mockResolvedValue([entryA])
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
})
