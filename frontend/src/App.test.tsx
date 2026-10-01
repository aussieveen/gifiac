import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { resizeTo } from './testUtils'
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
  getVideo: vi.fn(),
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
  listMyTemplates: vi.fn(),
  listOtherTemplates: vi.fn(),
  getTemplateDetail: vi.fn(),
  renameTemplate: vi.fn(),
  setTemplatePublic: vi.fn(),
  deleteTemplateById: vi.fn(),
  templateThumbnailUrl: (id: string) => `/api/templates/${id}/thumbnail`,
  templateClipUrl: (id: string) => `/api/templates/${id}/clip`,
  getTemplateFilmstripMeta: vi.fn(),
  createTemplateExport: vi.fn(),
  listAdminUsers: vi.fn(),
  setUserDisabled: vi.fn(),
  listLibrary: vi.fn(),
  recordGifUse: vi.fn(),
  getConfig: vi.fn(() => Promise.resolve({ turnstileSiteKey: null })),
  startEmailLogin: vi.fn(),
  verifyEmailCode: vi.fn(),
  EmailAuthError: class EmailAuthError extends Error {
    code: string
    retryAfterSeconds?: number
    attemptsRemaining?: number
    constructor(code: string, retryAfterSeconds?: number, attemptsRemaining?: number) {
      super(code)
      this.code = code
      this.retryAfterSeconds = retryAfterSeconds
      this.attemptsRemaining = attemptsRemaining
    }
  },
}))

import {
  createExport,
  EmailAuthError,
  getCurrentUser,
  getFilmstripMeta,
  getTemplate,
  getVideo,
  listAdminUsers,
  listGifs,
  listLibrary,
  listMyTemplates,
  listOtherTemplates,
  logout,
  setHandle,
  startEmailLogin,
  subscribeExportProgress,
  uploadVideo,
  verifyEmailCode,
} from './api'
import type { ExportProgressHandlers } from './api'
import type { CurrentUser } from './types'

const loggedInUser: CurrentUser = {
  id: 'u1',
  handle: 'testuser',
  slug: 'testuser',
  role: 'user',
  avatarUrl: null,
  suggestedHandle: null,
  preferences: { disableGifAutoplay: false },
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

// SPEC-CLOUD.md §9: App's own header now uses <Link> (the avatar/handle
// button to /u/:handle), which needs a Router context to render — in
// production that's main.tsx's BrowserRouter, here a MemoryRouter.
function renderApp() {
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  )
}

function renderAppAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(uploadVideo).mockReset()
  vi.mocked(getFilmstripMeta).mockReset()
  vi.mocked(getVideo).mockReset()
  vi.mocked(listGifs).mockReset()
  vi.mocked(createExport).mockReset()
  vi.mocked(subscribeExportProgress).mockReset()
  vi.mocked(getTemplate).mockReset().mockResolvedValue(null)
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue(loggedInUser)
  vi.mocked(setHandle).mockReset()
  vi.mocked(startEmailLogin).mockReset()
  vi.mocked(verifyEmailCode).mockReset()
  vi.mocked(listAdminUsers).mockReset().mockResolvedValue([])
  vi.mocked(logout).mockReset().mockResolvedValue(undefined)
  vi.mocked(listLibrary).mockReset().mockResolvedValue([])
  vi.mocked(listMyTemplates).mockReset().mockResolvedValue([])
  vi.mocked(listOtherTemplates).mockReset().mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  resizeTo(1440)
})

describe('App', () => {
  it('shows the email sign-in screen after clicking "Continue with email", and back returns to the landing screen', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    const user = userEvent.setup()

    renderApp()

    await screen.findByText('Continue with Google')
    await user.click(screen.getByRole('button', { name: 'Continue with email' }))

    await screen.findByRole('heading', { name: 'Continue with email' })
    await user.click(screen.getByRole('button', { name: /back/i }))

    await screen.findByText('Continue with Google')
  })

  it('signing in with email routes a brand-new user into the handle picker, same as Google', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    vi.mocked(startEmailLogin).mockResolvedValue(undefined)
    vi.mocked(verifyEmailCode).mockResolvedValue(userWithoutAHandle)
    const user = userEvent.setup()

    renderApp()

    await user.click(await screen.findByRole('button', { name: 'Continue with email' }))
    await user.type(screen.getByLabelText('Email address'), 'new@example.com')
    await user.click(screen.getByRole('button', { name: 'Send code' }))

    expect(startEmailLogin).toHaveBeenCalledWith('new@example.com', '')
    await user.type(await screen.findByLabelText('6-digit code'), '123456')

    expect(verifyEmailCode).toHaveBeenCalledWith('new@example.com', '123456')
    await screen.findByLabelText('Handle')
  })

  it('shows the wrong-code error with attempts remaining, and lets the visitor retry', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    vi.mocked(startEmailLogin).mockResolvedValue(undefined)
    vi.mocked(verifyEmailCode)
      .mockRejectedValueOnce(new EmailAuthError('invalid_or_expired', undefined, 3))
      .mockResolvedValueOnce(loggedInUser)
    const user = userEvent.setup()

    renderApp()

    await user.click(await screen.findByRole('button', { name: 'Continue with email' }))
    await user.type(screen.getByLabelText('Email address'), 'jess@example.com')
    await user.click(screen.getByRole('button', { name: 'Send code' }))

    await user.type(await screen.findByLabelText('6-digit code'), '000000')
    await screen.findByText(/that code is incorrect or has expired/i)
    await screen.findByText(/you have 3 tries left with this code/i)

    // the field clears on a rejected code, so the visitor can retry
    expect(screen.getByLabelText('6-digit code')).toHaveValue('')
    await user.type(screen.getByLabelText('6-digit code'), '123456')
    expect(verifyEmailCode).toHaveBeenLastCalledWith('jess@example.com', '123456')
  })

  it('shows too-many-attempts without an attempts-remaining count', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    vi.mocked(startEmailLogin).mockResolvedValue(undefined)
    vi.mocked(verifyEmailCode).mockRejectedValue(new EmailAuthError('too_many_attempts'))
    const user = userEvent.setup()

    renderApp()

    await user.click(await screen.findByRole('button', { name: 'Continue with email' }))
    await user.type(screen.getByLabelText('Email address'), 'jess@example.com')
    await user.click(screen.getByRole('button', { name: 'Send code' }))

    await user.type(await screen.findByLabelText('6-digit code'), '000000')
    await screen.findByText(/too many attempts\. request a new code/i)
    expect(screen.queryByText(/tries left/i)).not.toBeInTheDocument()
  })

  it('disables resend during the cooldown, then enables it once the countdown reaches zero', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    vi.mocked(startEmailLogin).mockResolvedValue(undefined)
    const user = userEvent.setup({ delay: null })

    renderApp()

    await user.click(await screen.findByRole('button', { name: 'Continue with email' }))
    await user.type(screen.getByLabelText('Email address'), 'jess@example.com')
    await user.click(screen.getByRole('button', { name: 'Send code' }))
    await screen.findByLabelText('6-digit code')

    expect(screen.queryByRole('button', { name: 'Resend code' })).not.toBeInTheDocument()
    expect(screen.getByText(/resend code in 1:00/i)).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })

    expect(await screen.findByRole('button', { name: 'Resend code' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resend code' }))
    expect(startEmailLogin).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('surfaces the retry-after wait and resets the cooldown when a resend is rate-limited', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    vi.mocked(startEmailLogin)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new EmailAuthError('too_many_requests', 42))
    const user = userEvent.setup({ delay: null })

    renderApp()

    await user.click(await screen.findByRole('button', { name: 'Continue with email' }))
    await user.type(screen.getByLabelText('Email address'), 'jess@example.com')
    await user.click(screen.getByRole('button', { name: 'Send code' }))
    await screen.findByLabelText('6-digit code')

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    await user.click(await screen.findByRole('button', { name: 'Resend code' }))

    await screen.findByText(/please wait 42 seconds before requesting another code/i)
    expect(screen.getByText(/resend code in 0:42/i)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('shows the handle picker prefilled with the suggestion, and proceeds once set', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userWithoutAHandle)
    vi.mocked(setHandle).mockResolvedValue({ ...loggedInUser, handle: 'sim-on' })
    vi.mocked(listGifs).mockResolvedValue([])
    const user = userEvent.setup()

    renderApp()

    const input = await screen.findByLabelText('Handle')
    expect(input).toHaveValue('sim-on')

    await user.click(screen.getByRole('button', { name: 'Confirm handle' }))

    expect(setHandle).toHaveBeenCalledWith('sim-on')
    await screen.findByText(/no gifs yet/i)
  })

  it('starts on my library', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    renderApp()
    await screen.findByText(/no gifs yet/i)
    expect(screen.getByRole('link', { name: 'My Library' })).toHaveClass('active')
  })

  it('does not show an Admin tab for a plain user', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    renderApp()
    await screen.findByText(/no gifs yet/i)
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument()
  })

  it('shows an Admin tab for an admin user and switches to the admin page', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ ...loggedInUser, role: 'admin' })
    vi.mocked(listGifs).mockResolvedValue([])
    const user = userEvent.setup()

    renderApp()
    await screen.findByText(/no gifs yet/i)

    await user.click(screen.getByRole('link', { name: 'Admin' }))

    await screen.findByText('Admin', { selector: 'h1' })
  })

  it('the + New GIF button switches to the video picker', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    const user = userEvent.setup()

    renderApp()
    await screen.findByText(/no gifs yet/i)

    await user.click(screen.getByRole('link', { name: 'New GIF' }))

    await screen.findByText('New GIF', { selector: 'h1' })
  })

  it('uploading a video loads its film-strip and opens the editor', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(uploadVideo).mockResolvedValue(video)
    vi.mocked(getVideo).mockResolvedValue(video)
    vi.mocked(getFilmstripMeta).mockResolvedValue(filmstrip)
    const user = userEvent.setup()

    renderApp()
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('link', { name: 'New GIF' }))
    await screen.findByText('New GIF', { selector: 'h1' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }))

    expect(await screen.findByText(/clip\.mp4/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make GIF' })).toBeInTheDocument()
    // The editor renders its own full header (back button, wordmark,
    // title) — the global app header would just be a redundant second one
    // stacked above it, so App.tsx skips it for this route.
    expect(screen.queryByRole('link', { name: 'My Library' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /back to library/i })).toBeInTheDocument()
  })

  it('shows an error and lets you go back if the film-strip fails to load', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(uploadVideo).mockResolvedValue(video)
    vi.mocked(getVideo).mockResolvedValue(video)
    vi.mocked(getFilmstripMeta).mockRejectedValue(new Error('/api/videos/v1/filmstrip failed (500): boom'))
    const user = userEvent.setup()

    renderApp()
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('link', { name: 'New GIF' }))
    await screen.findByText('New GIF', { selector: 'h1' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }))

    await screen.findByText(/boom/)
    await user.click(screen.getByRole('button', { name: /back to library/i }))
    await screen.findByText('New GIF', { selector: 'h1' })
  })

  it("never renders one upload against a second upload's stale film-strip", async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(uploadVideo).mockImplementation((file: File) =>
      Promise.resolve(file.name === 'clip.mp4' ? video : otherVideo),
    )
    vi.mocked(getVideo).mockImplementation((id: string) =>
      Promise.resolve(id === video.id ? video : otherVideo),
    )
    vi.mocked(getFilmstripMeta).mockImplementation((id: string) =>
      id === video.id ? Promise.resolve(filmstrip) : new Promise(() => {}), // never resolves for the switch target
    )
    const user = userEvent.setup()

    renderApp()
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('link', { name: 'New GIF' }))
    await screen.findByText('New GIF', { selector: 'h1' })
    let input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }))
    await screen.findByText(/clip\.mp4/)

    await user.click(screen.getByRole('button', { name: /back to library/i }))
    await screen.findByText('New GIF', { selector: 'h1' })
    input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['bytes'], 'other.mp4', { type: 'video/mp4' }))

    // The second upload's film-strip fetch never resolves, so the editor
    // (and the first upload's now-stale film-strip data) must not render.
    expect(screen.queryByRole('button', { name: 'Make GIF' })).not.toBeInTheDocument()
    expect(await screen.findByText(/loading film-strip/i)).toBeInTheDocument()
  })

  it('the My Library nav tab returns from the video picker to my library', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    const user = userEvent.setup()

    renderApp()
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('link', { name: 'New GIF' }))
    await screen.findByText('New GIF', { selector: 'h1' })

    await user.click(screen.getByRole('link', { name: 'My Library' }))

    await screen.findByText(/no gifs yet/i)
    expect(listGifs).toHaveBeenCalled()
  })

  it('the account pill opens a menu linking to the current user\'s own profile', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    const user = userEvent.setup()
    renderApp()
    await screen.findByText(/no gifs yet/i)

    await user.click(screen.getByRole('button', { name: loggedInUser.handle! }))

    const profileLink = screen.getByRole('menuitem', { name: 'View profile' })
    expect(profileLink).toHaveAttribute('href', `/u/${loggedInUser.handle}`)
  })

  it('shows the handle as typed, but links to the real (possibly suffixed) slug', async () => {
    // slug is a real, backend-assigned field independent of handle's
    // display case — including a collision suffix (migration 0012) — so
    // it must never be re-derived from the handle on the frontend.
    vi.mocked(getCurrentUser).mockResolvedValue({ ...loggedInUser, handle: 'Simon_Mc', slug: 'simon_mc2' })
    vi.mocked(listGifs).mockResolvedValue([])
    const user = userEvent.setup()
    renderApp()
    await screen.findByText(/no gifs yet/i)

    expect(screen.getByText('Simon_Mc')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Simon_Mc' }))

    const profileLink = screen.getByRole('menuitem', { name: 'View profile' })
    expect(profileLink).toHaveAttribute('href', '/u/simon_mc2')
  })

  it('sign out (from the account menu) calls the logout API', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    // window.location.reload isn't implemented in jsdom — stub it so the
    // post-logout reload the button triggers doesn't error the test.
    vi.stubGlobal('location', { ...window.location, reload: vi.fn() })
    const user = userEvent.setup()

    renderApp()
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('button', { name: loggedInUser.handle! }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    await waitFor(() => expect(logout).toHaveBeenCalled())
  })

  it('making a GIF switches to the archive with it already selected', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(uploadVideo).mockResolvedValue(video)
    vi.mocked(getVideo).mockResolvedValue(video)
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
      is_favourited: false,
      template_id: null,
      template_remixable: false,
      created_at: '2026-01-01T00:00:00Z',
      gif_url: 'http://example.com/g1.gif',
    }
    const user = userEvent.setup()

    renderApp()
    await screen.findByText(/no gifs yet/i)
    await user.click(screen.getByRole('link', { name: 'New GIF' }))
    await screen.findByText('New GIF', { selector: 'h1' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }))
    await screen.findByText(/clip\.mp4/)
    vi.mocked(listGifs).mockResolvedValue([createdGif])
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    const dialog = await screen.findByRole('dialog', { name: 'Make GIF' })
    await user.type(within(dialog).getByLabelText('GIF name'), 'my clip')
    await user.click(within(dialog).getByRole('button', { name: 'Make GIF' }))
    await waitFor(() => expect(subscribeExportProgress).toHaveBeenCalled())

    act(() => handlers.onComplete?.(createdGif))

    expect(await screen.findByLabelText('GIF name')).toHaveValue('my clip')
    expect(screen.getByRole('link', { name: 'My Library' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'my clip' })).toHaveClass('selected')
  })

  it('shows the New GIF button at desktop width but not at phone width', async () => {
    vi.mocked(listGifs).mockResolvedValue([])

    resizeTo(1280)
    const desktop = renderApp()
    await screen.findByText(/no gifs yet/i)
    expect(screen.getByRole('link', { name: 'New GIF' })).toBeInTheDocument()
    desktop.unmount()

    resizeTo(390)
    renderApp()
    await screen.findByText(/no gifs yet/i)
    expect(screen.queryByRole('link', { name: 'New GIF' })).not.toBeInTheDocument()
  })

  it('shows the "bigger screen" message instead of the editor at phone width', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(getVideo).mockResolvedValue(video)
    vi.mocked(getFilmstripMeta).mockResolvedValue(filmstrip)

    resizeTo(390)
    renderAppAt('/edit/v1')

    await screen.findByText('The editor needs a bigger screen')
    expect(screen.queryByRole('button', { name: 'Make GIF' })).not.toBeInTheDocument()
  })

  it('renders the editor immediately once resized above the breakpoint, without a reload', async () => {
    vi.mocked(listGifs).mockResolvedValue([])
    vi.mocked(getVideo).mockResolvedValue(video)
    vi.mocked(getFilmstripMeta).mockResolvedValue(filmstrip)

    resizeTo(390)
    renderAppAt('/edit/v1')
    await screen.findByText('The editor needs a bigger screen')

    act(() => resizeTo(1280))

    expect(await screen.findByRole('button', { name: 'Make GIF' })).toBeInTheDocument()
    expect(screen.queryByText('The editor needs a bigger screen')).not.toBeInTheDocument()
  })

  it('returns a signed-in-from-a-deep-link visitor to the page they started on', async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce(null as unknown as typeof loggedInUser)
    vi.mocked(listGifs).mockResolvedValue([])
    const user = userEvent.setup()

    renderAppAt('/library/abc123')
    const signInLink = await screen.findByRole('link', { name: /continue with google/i })
    await user.click(signInLink)
    expect(sessionStorage.getItem('strewthgif:return_to')).toBe('/library/abc123')

    // Simulate the OAuth round trip landing back on "/" with a now-valid
    // session — App.tsx should pick the saved path back up from there.
    vi.mocked(getCurrentUser).mockResolvedValue(loggedInUser)
    renderAppAt('/')

    await waitFor(() => expect(sessionStorage.getItem('strewthgif:return_to')).toBeNull())
  })
})
