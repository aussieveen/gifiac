import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { FilmstripMeta, Video } from './types'

vi.mock('./api', () => ({
  LOGIN_URL: '/api/auth/login',
  getCurrentUser: vi.fn(),
  setHandle: vi.fn(),
  logout: vi.fn(),
  listVideos: vi.fn(),
  uploadVideo: vi.fn(),
  deleteVideo: vi.fn(),
  thumbnailUrl: (id: string) => `/api/videos/${id}/thumbnail`,
  videoFileUrl: (id: string) => `/api/videos/${id}/file`,
  getFilmstripMeta: vi.fn(),
  createExport: vi.fn(),
  subscribeExportProgress: vi.fn(),
  listGifs: vi.fn(),
  renameGif: vi.fn(),
  deleteGif: vi.fn(),
  importGifs: vi.fn(),
  linkGif: vi.fn(),
  getTemplate: vi.fn(),
  putTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  listAdminUsers: vi.fn(),
  setUserDisabled: vi.fn(),
}))

import {
  createExport,
  getCurrentUser,
  getFilmstripMeta,
  getTemplate,
  listAdminUsers,
  listGifs,
  listVideos,
  setHandle,
  subscribeExportProgress,
} from './api'
import type { ExportProgressHandlers } from './api'
import type { CurrentUser } from './types'

const loggedInUser: CurrentUser = {
  id: 'u1',
  handle: 'testuser',
  role: 'user',
  avatarUrl: null,
  suggestedHandle: null,
}
const userWithoutAHandle: CurrentUser = { ...loggedInUser, handle: null, suggestedHandle: 'sim-on' }

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
  vi.mocked(listGifs).mockReset()
  vi.mocked(createExport).mockReset()
  vi.mocked(subscribeExportProgress).mockReset()
  vi.mocked(getTemplate).mockReset().mockResolvedValue(null)
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue(loggedInUser)
  vi.mocked(setHandle).mockReset()
  vi.mocked(listAdminUsers).mockReset().mockResolvedValue([])
})

describe('App', () => {
  it('shows the handle picker prefilled with the suggestion, and proceeds once set', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userWithoutAHandle)
    vi.mocked(setHandle).mockResolvedValue({ ...loggedInUser, handle: 'sim-on' })
    vi.mocked(listGifs).mockResolvedValue([])
    const user = userEvent.setup()

    render(<App />)

    const input = await screen.findByLabelText('Handle')
    expect(input).toHaveValue('sim-on')

    await user.click(screen.getByRole('button', { name: 'Confirm handle' }))

    expect(setHandle).toHaveBeenCalledWith('sim-on')
    await screen.findByText(/no gifs yet/i)
  })

  it('starts on the archive', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    render(<App />)
    await screen.findByText(/no gifs yet/i)
    expect(screen.getByRole('button', { name: 'Archive' })).toHaveClass('active')
  })

  it('does not show an Admin tab for a plain user', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    render(<App />)
    await screen.findByText(/no gifs yet/i)
    expect(screen.queryByRole('button', { name: 'Admin' })).not.toBeInTheDocument()
  })

  it('shows an Admin tab for an admin user and switches to the admin page', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ ...loggedInUser, role: 'admin' })
    vi.mocked(listGifs).mockResolvedValue([])
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText(/no gifs yet/i)

    await user.click(screen.getByRole('button', { name: 'Admin' }))

    await screen.findByText('Admin', { selector: 'h1' })
  })

  it('the New GIF nav tab switches to the video picker', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(listVideos).mockResolvedValue([video])
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText(/no gifs yet/i)

    await user.click(screen.getByRole('button', { name: 'New GIF' }))

    await screen.findByText('Gifiac')
  })

  it('selecting a video loads its film-strip and opens the editor', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(listVideos).mockResolvedValue([video])
    vi.mocked(getFilmstripMeta).mockResolvedValue(filmstrip)
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('button', { name: 'New GIF' }))
    await user.click(await screen.findByRole('button', { name: /^clip\.mp4/i }))

    expect(await screen.findByText('clip.mp4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make GIF' })).toBeInTheDocument()
  })

  it('shows an error and lets you go back if the film-strip fails to load', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(listVideos).mockResolvedValue([video])
    vi.mocked(getFilmstripMeta).mockRejectedValue(new Error('/api/videos/v1/filmstrip failed (500): boom'))
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('button', { name: 'New GIF' }))
    await user.click(await screen.findByRole('button', { name: /^clip\.mp4/i }))

    await screen.findByText(/boom/)
    await user.click(screen.getByRole('button', { name: /back to library/i }))
    await screen.findByText('Gifiac')
  })

  it('never renders one video against another video\'s stale film-strip when switching', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(listVideos).mockResolvedValue([video, otherVideo])
    vi.mocked(getFilmstripMeta).mockImplementation((id: string) =>
      id === video.id ? Promise.resolve(filmstrip) : new Promise(() => {}), // never resolves for the switch target
    )
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('button', { name: 'New GIF' }))
    await user.click(await screen.findByRole('button', { name: /^clip\.mp4/i }))
    await screen.findByText('clip.mp4')

    await user.click(screen.getByRole('button', { name: /back to library/i }))
    await user.click(await screen.findByRole('button', { name: /^other\.mp4/i }))

    // The switch target's film-strip fetch never resolves, so the editor
    // (and clip.mp4's now-stale film-strip data) must not render at all.
    expect(screen.queryByRole('button', { name: 'Make GIF' })).not.toBeInTheDocument()
    expect(await screen.findByText(/loading film-strip/i)).toBeInTheDocument()
  })

  it('the Archive nav tab returns from the video picker to the archive', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(listVideos).mockResolvedValue([video])
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('button', { name: 'New GIF' }))
    await screen.findByText('Gifiac')

    await user.click(screen.getByRole('button', { name: 'Archive' }))

    await screen.findByText(/no gifs yet/i)
    expect(listGifs).toHaveBeenCalled()
  })

  it('making a GIF switches to the archive with it already selected', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(listVideos).mockResolvedValue([video])
    vi.mocked(getFilmstripMeta).mockResolvedValue(filmstrip)
    vi.mocked(createExport).mockResolvedValue({ export_id: 'exp-1' })
    let handlers: ExportProgressHandlers = {}
    vi.mocked(subscribeExportProgress).mockImplementation((_id, h) => {
      handlers = h
      return () => {}
    })
    const createdGif = {
      id: 'g1',
      video_id: 'v1',
      name: 'my clip',
      caption_text: '',
      captions_json: null,
      gif_range_start: 0,
      gif_range_end: 8,
      width: 480,
      height: 270,
      external_url: null,
      is_one_off: false,
      is_public: false,
      use_count: 0,
      created_at: '2026-01-01T00:00:00Z',
      gif_url: 'http://example.com/g1.gif',
    }
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('button', { name: 'New GIF' }))
    await user.click(await screen.findByRole('button', { name: /^clip\.mp4/i }))
    await screen.findByText('clip.mp4')
    await user.type(screen.getByLabelText('GIF name'), 'my clip')
    vi.mocked(listGifs).mockResolvedValue([createdGif])
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    await waitFor(() => expect(subscribeExportProgress).toHaveBeenCalled())

    act(() => handlers.onComplete?.(createdGif))

    expect(await screen.findByLabelText('GIF name')).toHaveValue('my clip')
    expect(screen.getByRole('button', { name: 'Archive' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'my clip' })).toHaveClass('selected')
  })
})
