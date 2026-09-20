import { useEffect, useState } from 'react'
import { getCurrentUser } from './api'
import type { CurrentUser } from './types'

export interface UseCurrentUserResult {
  user: CurrentUser | null
  loading: boolean
}

// SPEC-CLOUD.md §2: `GET /api/auth/me` is the frontend's only way to learn
// whether a session cookie is valid — there's no client-side way to
// inspect an HttpOnly cookie directly.
export function useCurrentUser(): UseCurrentUserResult {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getCurrentUser()
      .then((result) => {
        if (!cancelled) setUser(result)
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { user, loading }
}
