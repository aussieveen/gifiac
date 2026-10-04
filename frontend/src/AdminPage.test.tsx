import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminPage } from './AdminPage'
import type { AdminActionView, AdminUserView } from './types'

vi.mock('./api', () => ({
  listAdminUsers: vi.fn(),
  setUserDisabled: vi.fn(),
  deleteUser: vi.fn(),
  listAdminActions: vi.fn(),
}))

import { deleteUser, listAdminActions, listAdminUsers, setUserDisabled } from './api'

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

const sampleAction: AdminActionView = {
  id: 'a1',
  admin_user_id: 'u1',
  action_type: 'delete_user',
  target_id: 'u2',
  details: '{"handle":"newbie"}',
  created_at: '2026-01-10T00:00:00Z',
}

beforeEach(() => {
  vi.mocked(listAdminUsers).mockReset()
  vi.mocked(setUserDisabled).mockReset()
  vi.mocked(deleteUser).mockReset()
  vi.mocked(listAdminActions).mockReset()
  vi.mocked(listAdminActions).mockResolvedValue([])
})

describe('AdminPage', () => {
  it('renders every user with their usage stats', async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([activeUser, noHandleUser])

    render(<AdminPage currentUserId="u1" />)

    await screen.findByText('simon')
    expect(screen.getByText('simon@example.com')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('(no handle)')).toBeInTheDocument()
    expect(screen.getByText('newbie@example.com')).toBeInTheDocument()
  })

  it('shows a load error when the users request fails', async () => {
    vi.mocked(listAdminUsers).mockRejectedValue(new Error('/api/admin/users failed (403): forbidden'))

    render(<AdminPage currentUserId="u1" />)

    await screen.findByText(/forbidden/)
  })

  it('disabling a user calls the API and flips the button to Enable', async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([activeUser])
    vi.mocked(setUserDisabled).mockResolvedValue({ id: 'u1', disabled: true })
    const user = userEvent.setup()

    render(<AdminPage currentUserId="other-admin" />)
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

    render(<AdminPage currentUserId="other-admin" />)
    await screen.findByText('simon')
    await user.click(screen.getByRole('button', { name: 'Enable' }))

    expect(setUserDisabled).toHaveBeenCalledWith('u1', false)
    await screen.findByRole('button', { name: 'Disable' })
  })

  it('hides the Delete button for the signed-in admin\'s own row', async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([activeUser, noHandleUser])

    render(<AdminPage currentUserId="u1" />)
    await screen.findByText('simon')

    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)
  })

  it('deleting a user asks for confirmation, then calls the API and removes the row', async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([activeUser, noHandleUser])
    vi.mocked(deleteUser).mockResolvedValue(undefined)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()

    render(<AdminPage currentUserId="u1" />)
    await screen.findByText('newbie@example.com')
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('0 gifs'))
    expect(deleteUser).toHaveBeenCalledWith('u2')
    await waitFor(() => expect(screen.queryByText('newbie@example.com')).not.toBeInTheDocument())

    confirmSpy.mockRestore()
  })

  it('does not call the API when the confirmation is declined', async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([activeUser, noHandleUser])
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()

    render(<AdminPage currentUserId="u1" />)
    await screen.findByText('newbie@example.com')
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(deleteUser).not.toHaveBeenCalled()
    expect(screen.getByText('newbie@example.com')).toBeInTheDocument()

    confirmSpy.mockRestore()
  })

  it('renders recent admin actions', async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([activeUser])
    vi.mocked(listAdminActions).mockResolvedValue([sampleAction])

    render(<AdminPage currentUserId="u1" />)

    await screen.findByText('delete_user')
    expect(screen.getByText('u2')).toBeInTheDocument()
  })
})
