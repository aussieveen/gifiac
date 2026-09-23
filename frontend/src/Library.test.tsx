import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import type { LibraryEntry } from './types'

vi.mock('./api', () => ({
  listLibrary: vi.fn(),
  recordGifUse: vi.fn(),
}))

import { listLibrary, recordGifUse } from './api'

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
}

beforeEach(() => {
  vi.mocked(listLibrary).mockReset()
  vi.mocked(recordGifUse).mockReset()
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
  it('renders gif tiles with attribution linking to the owner profile', async () => {
    vi.mocked(listLibrary).mockResolvedValue([entryA])
    renderLibrary()

    expect(await screen.findByText('cat jumping')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: '@simon' })
    expect(link).toHaveAttribute('href', '/u/simon')
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

  it('the copy-link button copies the gif url and bumps its use count', async () => {
    vi.mocked(listLibrary).mockResolvedValue([entryA])
    vi.mocked(recordGifUse).mockResolvedValue({ ...entryA, use_count: 1 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderLibrary()
    await screen.findByText('cat jumping')
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

  it('switching the sort pill re-queries with the most-used sort', async () => {
    vi.mocked(listLibrary).mockResolvedValue([entryA])
    const user = userEvent.setup()
    renderLibrary()

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'newest'))

    await user.click(screen.getByRole('button', { name: 'Most-used' }))

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'most-used'))
  })
})
