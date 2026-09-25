import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfilePage } from './ProfilePage'
import type { CurrentUser, Gif, Profile } from './types'

vi.mock('./api', () => ({
  getProfile: vi.fn(),
  getCurrentUser: vi.fn(),
  favouriteGif: vi.fn(),
  unfavouriteGif: vi.fn(),
  LOGIN_URL: '/api/auth/login',
}))

import { favouriteGif, getCurrentUser, getProfile, unfavouriteGif } from './api'

const profile: Profile = {
  handle: 'simon',
  avatarUrl: 'https://example.com/avatar.jpg',
  gifs: [],
}

function renderAt(handle: string) {
  return render(
    <MemoryRouter initialEntries={[`/u/${handle}`]}>
      <Routes>
        <Route path="/u/:handle" element={<ProfilePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(getProfile).mockReset()
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue(null)
  vi.mocked(favouriteGif).mockReset()
  vi.mocked(unfavouriteGif).mockReset()
})

describe('ProfilePage', () => {
  it('renders the handle and avatar', async () => {
    vi.mocked(getProfile).mockResolvedValue(profile)
    renderAt('simon')

    expect(await screen.findByText('simon')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: "simon's avatar" })).toHaveAttribute('src', profile.avatarUrl)
  })

  it('shows an empty state when there are no public gifs', async () => {
    vi.mocked(getProfile).mockResolvedValue(profile)
    renderAt('simon')

    expect(await screen.findByText(/no public gifs yet/i)).toBeInTheDocument()
  })

  it('shows a not-found state for an unknown handle', async () => {
    vi.mocked(getProfile).mockRejectedValue(new Error('/api/profiles/nobody failed (404): not found'))
    renderAt('nobody')

    expect(await screen.findByText(/no such user/i)).toBeInTheDocument()
  })

  it('has a back link to the app', async () => {
    vi.mocked(getProfile).mockResolvedValue(profile)
    renderAt('simon')

    await screen.findByText('simon')
    expect(screen.getByRole('link', { name: /back/i })).toHaveAttribute('href', '/')
  })

  it('renders the case from the API response, not the case in the url', async () => {
    // Regression guard for the matching backend fix (get_profile used to
    // echo the raw URL path segment back as `handle` instead of the
    // stored user's own value) — the frontend should trust whatever case
    // the response says, even though this was reached via a lowercase url.
    vi.mocked(getProfile).mockResolvedValue({ ...profile, handle: 'Simon_Mc' })
    renderAt('simon_mc')

    expect(await screen.findByText('Simon_Mc')).toBeInTheDocument()
  })
})

// SPEC-CLOUD.md §14.
describe('ProfilePage favourites', () => {
  const viewer: CurrentUser = {
    id: 'u1',
    handle: 'viewer',
    slug: 'viewer',
    role: 'user',
    avatarUrl: null,
    suggestedHandle: null,
  }

  const gif: Gif = {
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
    gif_url: 'http://example.com/g1.gif',
  }

  it('a signed-in visitor can favourite a gif from a profile page', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(viewer)
    vi.mocked(getProfile).mockResolvedValue({ ...profile, gifs: [gif] })
    vi.mocked(favouriteGif).mockResolvedValue({ ...gif, is_favourited: true })
    const user = userEvent.setup()

    renderAt('simon')
    await user.click(await screen.findByRole('button', { name: 'Favourite', pressed: false }))

    expect(favouriteGif).toHaveBeenCalledWith('g1')
    expect(await screen.findByRole('button', { name: 'Favourite', pressed: true })).toBeInTheDocument()
  })

  it('a logged-out visitor gets a sign-in link instead of a favourite button', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    vi.mocked(getProfile).mockResolvedValue({ ...profile, gifs: [gif] })

    renderAt('simon')

    const signIn = await screen.findByRole('link', { name: /sign in to save/i })
    expect(signIn).toHaveAttribute('href', '/api/auth/login')
    expect(screen.queryByRole('button', { name: 'Favourite' })).not.toBeInTheDocument()
  })
})
