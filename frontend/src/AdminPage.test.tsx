import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminPage } from './AdminPage'
import type { AdminUserView } from './types'

vi.mock('./api', () => ({
  listAdminUsers: vi.fn(),
  setUserDisabled: vi.fn(),
}))

import { listAdminUsers, setUserDisabled } from './api'

const activeUser: AdminUserView = {
  id: 'u1',
  handle: 'simon',
  email: 'simon@example.com',
  avatar_url: null,
  role: 'admin',
  disabled: false,
  created_at: '2026-01-01T00:00:00Z',
  gif_count: 3,
  latest_gif_at: '2026-01-05T00:00:00Z',
}

const noHandleUser: AdminUserView = {
  id: 'u2',
  handle: null,
  email: 'newbie@example.com',
  avatar_url: null,
  role: 'user',
  disabled: false,
  created_at: '2026-01-02T00:00:00Z',
  gif_count: 0,
  latest_gif_at: null,
}

beforeEach(() => {
  vi.mocked(listAdminUsers).mockReset()
  vi.mocked(setUserDisabled).mockReset()
})

describe('AdminPage', () => {
  it('renders every user with their usage stats', async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([activeUser, noHandleUser])

    render(<AdminPage />)

    await screen.findByText('simon')
    expect(screen.getByText('simon@example.com')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('(no handle)')).toBeInTheDocument()
    expect(screen.getByText('newbie@example.com')).toBeInTheDocument()
  })

  it('shows a load error when the users request fails', async () => {
    vi.mocked(listAdminUsers).mockRejectedValue(new Error('/api/admin/users failed (403): forbidden'))

    render(<AdminPage />)

    await screen.findByText(/forbidden/)
  })

  it('disabling a user calls the API and flips the button to Enable', async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([activeUser])
    vi.mocked(setUserDisabled).mockResolvedValue({ id: 'u1', disabled: true })
    const user = userEvent.setup()

    render(<AdminPage />)
    await screen.findByText('simon')
    await user.click(screen.getByRole('button', { name: 'Disable' }))

    expect(setUserDisabled).toHaveBeenCalledWith('u1', true)
    await screen.findByRole('button', { name: 'Enable' })
  })

  it('re-enabling a disabled user calls the API with false', async () => {
    const disabledUser = { ...activeUser, disabled: true }
    vi.mocked(listAdminUsers).mockResolvedValue([disabledUser])
    vi.mocked(setUserDisabled).mockResolvedValue({ id: 'u1', disabled: false })
    const user = userEvent.setup()

    render(<AdminPage />)
    await screen.findByText('simon')
    await user.click(screen.getByRole('button', { name: 'Enable' }))

    expect(setUserDisabled).toHaveBeenCalledWith('u1', false)
    await screen.findByRole('button', { name: 'Disable' })
  })
})
