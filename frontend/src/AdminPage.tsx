import { useEffect, useState } from 'react'
import { deleteUser, listAdminActions, listAdminUsers, setUserDisabled } from './api'
import type { AdminActionView, AdminUserView } from './types'

// SPEC-CLOUD.md §7: owner-only admin area. Deliberately minimal — a
// users table with per-user usage stats and the two account actions
// (disable/re-enable, delete) — at the same low-polish level
// Archive/Library shipped at well before the full nav redesign (M7).
// Browsing/moderating an individual user's gifs/templates has a backend
// (see api.ts's listAdminUsers-adjacent routes) but no UI here yet.
export function AdminPage({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUserView[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [actions, setActions] = useState<AdminActionView[]>([])

  useEffect(() => {
    let cancelled = false
    listAdminUsers()
      .then((result) => {
        if (!cancelled) setUsers(result)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    listAdminActions()
      .then((result) => {
        if (!cancelled) setActions(result)
      })
      .catch(() => {
        // Non-critical — the users table is the page's main job.
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function toggleDisabled(user: AdminUserView) {
    setPendingId(user.id)
    try {
      const updated = await setUserDisabled(user.id, !user.disabled)
      setUsers((us) => us.map((u) => (u.id === updated.id ? { ...u, disabled: updated.disabled } : u)))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingId(null)
    }
  }

  async function handleDeleteUser(user: AdminUserView) {
    const label = user.handle ?? user.email ?? user.id
    const confirmed = window.confirm(
      `Delete user ${label}? This will permanently delete their ${user.gif_count} gif${user.gif_count === 1 ? '' : 's'}, ` +
        `plus all associated templates, videos, and sessions. This cannot be undone.`,
    )
    if (!confirmed) return

    setPendingId(user.id)
    try {
      await deleteUser(user.id)
      setUsers((us) => us.filter((u) => u.id !== user.id))
      listAdminActions()
        .then(setActions)
        .catch(() => {})
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingId(null)
    }
  }

  if (loading) {
    return (
      <div className="page">
        <p className="va-hint">Loading…</p>
      </div>
    )
  }

  return (
    <div className="page">
      <h1>Admin</h1>
      <p className="subtitle">Every user, with usage stats and account access.</p>
      {loadError && <p className="export-error">{loadError}</p>}
      <table className="admin-users-table">
        <thead>
          <tr>
            <th>Handle</th>
            <th>Email</th>
            <th>Role</th>
            <th>Gifs</th>
            <th>Last activity</th>
            <th>Joined</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className={user.disabled ? 'admin-user-disabled' : ''}>
              <td>{user.handle ?? <span className="va-hint">(no handle)</span>}</td>
              <td>{user.email ?? <span className="va-hint">—</span>}</td>
              <td>{user.role}</td>
              <td>{user.gif_count}</td>
              <td>{user.latest_gif_at ? new Date(user.latest_gif_at).toLocaleDateString() : '—'}</td>
              <td>{new Date(user.created_at).toLocaleDateString()}</td>
              <td>
                <button className="btn btn-secondary" onClick={() => toggleDisabled(user)} disabled={pendingId === user.id}>
                  {user.disabled ? 'Enable' : 'Disable'}
                </button>
                {user.id !== currentUserId && (
                  <button
                    className="btn btn-danger-pill"
                    onClick={() => handleDeleteUser(user)}
                    disabled={pendingId === user.id}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent admin actions</h2>
      {actions.length === 0 ? (
        <p className="va-hint">No admin actions yet.</p>
      ) : (
        <table className="admin-actions-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Target</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {actions.map((action) => (
              <tr key={action.id}>
                <td>{new Date(action.created_at).toLocaleString()}</td>
                <td>{action.admin_user_id}</td>
                <td>{action.action_type}</td>
                <td>{action.target_id}</td>
                <td>{action.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
