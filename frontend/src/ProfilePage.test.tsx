import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfilePage } from './ProfilePage'
import type { Profile } from './types'

vi.mock('./api', () => ({
  getProfile: vi.fn(),
}))

import { getProfile } from './api'

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
})

describe('ProfilePage', () => {
  it('renders the handle and avatar', async () => {
    vi.mocked(getProfile).mockResolvedValue(profile)
    renderAt('simon')

    expect(await screen.findByText('@simon')).toBeInTheDocument()
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
})
