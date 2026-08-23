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
}))

import { deleteGif, importGifs, listGifs, renameGif } from './api'

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
  created_at: '2026-01-01T00:00:00Z',
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

beforeEach(() => {
  vi.mocked(listGifs).mockReset()
  vi.mocked(renameGif).mockReset()
  vi.mocked(deleteGif).mockReset()
  vi.mocked(importGifs).mockReset()
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

  it('the download action links directly to the gif url', async () => {
    vi.mocked(listGifs).mockResolvedValue([gifA])
    const user = userEvent.setup()

    render(<Archive />)
    await user.click(await screen.findByRole('button', { name: 'cat jumping' }))

    const downloadLink = screen.getByRole('link', { name: /download/i }) as HTMLAnchorElement
    expect(downloadLink.href).toBe(gifA.gif_url)
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
})
