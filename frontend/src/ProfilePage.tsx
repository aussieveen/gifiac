import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getProfile } from './api'
import { ArrowLeftIcon } from './icons'
import type { Profile } from './types'

/** A public profile has no persistent nav of its own (SPEC-CLOUD.md §9 —
 * it deliberately replaces the whole page rather than nesting inside
 * App's shell, and it's reachable while signed out), but still carries
 * the wordmark and a real button-styled back link so it doesn't look
 * like a different, unbranded app to someone arriving from a shared
 * link. */
function ProfileTopBar() {
  return (
    <div className="profile-topbar">
      <span className="app-header-brand">Gifiac</span>
      <Link className="btn btn-secondary" to="/">
        <ArrowLeftIcon size={16} />
        Back
      </Link>
    </div>
  )
}

// SPEC-CLOUD.md §5: a public profile page — no sign-in required to view
// it. Only shows public gifs for now; templates join once they're
// servable independently of video ownership (M5d).
//
// SPEC-CLOUD.md §9: this is a separate top-level route (main.tsx), not
// nested inside App's tab-bar shell — "replaces the whole page ... with a
// simple back link to return." The link always goes to "/" (App's default
// landing tab) rather than restoring whatever tab was active before
// visiting: since navigating here unmounts App entirely, its `view` state
// is already gone by the time this renders, and preserving it across that
// boundary isn't something anything has asked for yet.
export function ProfilePage() {
  const { handle } = useParams<{ handle: string }>()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!handle) return
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    getProfile(handle)
      .then((result) => {
        if (!cancelled) setProfile(result)
      })
      .catch(() => {
        if (!cancelled) setNotFound(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [handle])

  if (loading) {
    return (
      <div className="page">
        <ProfileTopBar />
        <p className="va-hint">Loading…</p>
      </div>
    )
  }

  if (notFound || !profile) {
    return (
      <div className="page">
        <ProfileTopBar />
        <p className="va-hint">No such user.</p>
      </div>
    )
  }

  return (
    <div className="page">
      <ProfileTopBar />
      <div className="profile-header">
        {profile.avatarUrl && (
          <img src={profile.avatarUrl} alt={`${profile.handle}'s avatar`} className="profile-avatar" />
        )}
        <h1>@{profile.handle}</h1>
      </div>
      {profile.gifs.length === 0 ? (
        <p className="va-hint">No public GIFs yet.</p>
      ) : (
        <div className="archive-grid">
          {profile.gifs.map((gif) => (
            <img key={gif.id} src={gif.gif_url ?? ''} alt={gif.name} title={gif.name} className="profile-gif-tile" />
          ))}
        </div>
      )}
    </div>
  )
}
