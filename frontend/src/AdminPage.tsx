import { useEffect, useState } from 'react'
import { listAdminUsers, setUserDisabled } from './api'
import type { AdminUserView } from './types'

// SPEC-CLOUD.md §7: owner-only admin area. Deliberately minimal — a
// users table with per-user usage stats and the one urgent action
// (disable/re-enable) — at the same low-polish level Archive/Library
// shipped at well before the full nav redesign (M7). Browsing/moderating
// an individual user's gifs/templates has a backend (see api.ts's
// listAdminUsers-adjacent routes) but no UI here yet.
export function AdminPage() {
  const [users, setUsers] = useState<AdminUserView[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

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
              <td>{user.handle ? `@${user.handle}` : <span className="va-hint">(no handle)</span>}</td>
              <td>{user.email ?? <span className="va-hint">—</span>}</td>
              <td>{user.role}</td>
              <td>{user.gif_count}</td>
              <td>{user.latest_gif_at ? new Date(user.latest_gif_at).toLocaleDateString() : '—'}</td>
              <td>{new Date(user.created_at).toLocaleDateString()}</td>
              <td>
                <button className="va-btn" onClick={() => toggleDisabled(user)} disabled={pendingId === user.id}>
                  {user.disabled ? 'Enable' : 'Disable'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
