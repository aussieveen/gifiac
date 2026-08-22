import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { FilmstripMeta, Video } from './types'

vi.mock('./api', () => ({
  listVideos: vi.fn(),
  uploadVideo: vi.fn(),
  thumbnailUrl: (id: string) => `/api/videos/${id}/thumbnail`,
  getFilmstripMeta: vi.fn(),
  createExport: vi.fn(),
}))

import { getFilmstripMeta, listVideos } from './api'

const video: Video = {
  id: 'v1',
  original_filename: 'clip.mp4',
  extension: 'mp4',
  file_size_bytes: 100,
  duration_seconds: 8,
  width: 1920,
  height: 1080,
  uploaded_at: '2026-01-01T00:00:00Z',
}

const filmstrip: FilmstripMeta = {
  frameCount: 32,
  cols: 6,
  rows: 6,
  frameWidth: 160,
  frameHeight: 90,
  interval: 0.25,
  imageUrl: '/api/videos/v1/filmstrip.jpg',
}

const otherVideo: Video = { ...video, id: 'v2', original_filename: 'other.mp4' }

beforeEach(() => {
  vi.mocked(listVideos).mockReset()
  vi.mocked(getFilmstripMeta).mockReset()
})

describe('App', () => {
  it('starts on the video picker', async () => {
    vi.mocked(listVideos).mockResolvedValue([video])
    render(<App />)
    await screen.findByText('Gifiac')
  })

  it('selecting a video loads its film-strip and opens the editor', async () => {
    vi.mocked(listVideos).mockResolvedValue([video])
    vi.mocked(getFilmstripMeta).mockResolvedValue(filmstrip)
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByRole('button', { name: /clip.mp4/i }))

    expect(await screen.findByText('clip.mp4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make GIF' })).toBeInTheDocument()
  })

  it('shows an error and lets you go back if the film-strip fails to load', async () => {
    vi.mocked(listVideos).mockResolvedValue([video])
    vi.mocked(getFilmstripMeta).mockRejectedValue(new Error('/api/videos/v1/filmstrip failed (500): boom'))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByRole('button', { name: /clip.mp4/i }))

    await screen.findByText(/boom/)
    await user.click(screen.getByRole('button', { name: /back to library/i }))
    await screen.findByText('Gifiac')
  })

  it('never renders one video against another video\'s stale film-strip when switching', async () => {
    vi.mocked(listVideos).mockResolvedValue([video, otherVideo])
    vi.mocked(getFilmstripMeta).mockImplementation((id: string) =>
      id === video.id ? Promise.resolve(filmstrip) : new Promise(() => {}), // never resolves for the switch target
    )
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByRole('button', { name: /clip\.mp4/i }))
    await screen.findByText('clip.mp4')

    await user.click(screen.getByRole('button', { name: /back to library/i }))
    await user.click(await screen.findByRole('button', { name: /other\.mp4/i }))

    // The switch target's film-strip fetch never resolves, so the editor
    // (and clip.mp4's now-stale film-strip data) must not render at all.
    expect(screen.queryByRole('button', { name: 'Make GIF' })).not.toBeInTheDocument()
    expect(await screen.findByText(/loading film-strip/i)).toBeInTheDocument()
  })
})
