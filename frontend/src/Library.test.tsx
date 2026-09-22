import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import type { LibraryEntry, PublicTemplate } from './types'

vi.mock('./api', () => ({
  listLibrary: vi.fn(),
  listPublicTemplates: vi.fn(),
  recordGifUse: vi.fn(),
}))

import { listLibrary, listPublicTemplates, recordGifUse } from './api'

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

const templateA: PublicTemplate = {
  id: 't1',
  is_public: true,
  use_count: 0,
  owner_handle: 'alice',
  saved_at: '2026-01-02T00:00:00Z',
  clip_url: 'http://example.com/t1/clip',
  thumbnail_url: 'http://example.com/t1/thumbnail',
  captions: [],
  gif_range_start: 0,
  gif_range_end: 2,
  width: 320,
  height: 240,
}

beforeEach(() => {
  vi.mocked(listLibrary).mockReset()
  vi.mocked(listPublicTemplates).mockReset().mockResolvedValue([])
  vi.mocked(recordGifUse).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderLibrary(onUseTemplate = vi.fn()) {
  return render(
    <MemoryRouter>
      <Library onUseTemplate={onUseTemplate} />
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
    expect(screen.getByText('GIF', { selector: '.library-tile-badge' })).toBeInTheDocument()
  })

  it('renders template tiles with a badge, attribution, and a Use this template action', async () => {
    vi.mocked(listLibrary).mockResolvedValue([])
    vi.mocked(listPublicTemplates).mockResolvedValue([templateA])
    renderLibrary()

    await screen.findByText('Template', { selector: '.library-tile-badge' })
    const link = screen.getByRole('link', { name: '@alice' })
    expect(link).toHaveAttribute('href', '/u/alice')
    expect(screen.getByRole('button', { name: /use this template/i })).toBeInTheDocument()
  })

  it('clicking Use this template calls onUseTemplate with the clicked template', async () => {
    vi.mocked(listLibrary).mockResolvedValue([])
    vi.mocked(listPublicTemplates).mockResolvedValue([templateA])
    const onUseTemplate = vi.fn()
    const user = userEvent.setup()
    renderLibrary(onUseTemplate)

    await user.click(await screen.findByRole('button', { name: /use this template/i }))

    expect(onUseTemplate).toHaveBeenCalledWith(templateA)
  })

  it('shows an empty state with no public gifs or templates', async () => {
    vi.mocked(listLibrary).mockResolvedValue([])
    renderLibrary()

    expect(await screen.findByText(/no public gifs or templates yet/i)).toBeInTheDocument()
  })

  it('re-queries both gifs and templates as the search input changes', async () => {
    vi.mocked(listLibrary).mockResolvedValue([])
    const user = userEvent.setup()
    renderLibrary()

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'newest'))
    expect(listPublicTemplates).toHaveBeenCalledWith('', 'newest')

    await user.type(screen.getByLabelText('Search the library'), 'cat')

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('cat', 'newest'))
    expect(listPublicTemplates).toHaveBeenCalledWith('cat', 'newest')
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

  it('switching the sort pill re-queries both lists with the most-used sort', async () => {
    vi.mocked(listLibrary).mockResolvedValue([entryA])
    const user = userEvent.setup()
    renderLibrary()

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'newest'))

    await user.click(screen.getByRole('button', { name: 'Most-used' }))

    await waitFor(() => expect(listLibrary).toHaveBeenCalledWith('', 'most-used'))
    expect(listPublicTemplates).toHaveBeenCalledWith('', 'most-used')
  })

  it('merges gifs and templates into one feed ordered newest-first', async () => {
    const olderGif = { ...entryA, created_at: '2026-01-01T00:00:00Z' }
    const newerTemplate = { ...templateA, saved_at: '2026-01-05T00:00:00Z' }
    vi.mocked(listLibrary).mockResolvedValue([olderGif])
    vi.mocked(listPublicTemplates).mockResolvedValue([newerTemplate])
    renderLibrary()

    await screen.findByText('cat jumping')
    const badges = screen.getAllByText(/^(GIF|Template)$/, { selector: '.library-tile-badge' })
    expect(badges.map((b) => b.textContent)).toEqual(['Template', 'GIF'])
  })

  it('merges gifs and templates ordered most-used-first when sorted that way', async () => {
    const lowUseGif = { ...entryA, use_count: 1 }
    const highUseTemplate = { ...templateA, use_count: 5 }
    vi.mocked(listLibrary).mockResolvedValue([lowUseGif])
    vi.mocked(listPublicTemplates).mockResolvedValue([highUseTemplate])
    const user = userEvent.setup()
    renderLibrary()

    await screen.findByText('cat jumping')
    await user.click(screen.getByRole('button', { name: 'Most-used' }))

    await waitFor(() => {
      const badges = screen.getAllByText(/^(GIF|Template)$/, { selector: '.library-tile-badge' })
      expect(badges.map((b) => b.textContent)).toEqual(['Template', 'GIF'])
    })
  })
})
