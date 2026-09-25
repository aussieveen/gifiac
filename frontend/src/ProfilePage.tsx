import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { favouriteGif, getProfile, LOGIN_URL, unfavouriteGif } from './api'
import { StarIcon } from './icons'
import { PublicTopBar } from './PublicTopBar'
import type { Gif, Profile } from './types'
import { useCurrentUser } from './useCurrentUser'

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
  const [gifs, setGifs] = useState<Gif[]>([])
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)
  const { user } = useCurrentUser()

  useEffect(() => {
    if (!handle) return
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    getProfile(handle)
      .then((result) => {
        if (!cancelled) {
          setProfile(result)
          setGifs(result.gifs)
        }
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

  async function toggleFavourite(id: string, isFavourited: boolean) {
    try {
      const updated = isFavourited ? await unfavouriteGif(id) : await favouriteGif(id)
      setGifs((gs) => gs.map((g) => (g.id === updated.id ? updated : g)))
    } catch {
      // No toast infrastructure on this standalone public page — a failed
      // toggle just leaves the star showing its prior, still-correct state.
    }
  }

  if (loading) {
    return (
      <div className="page">
        <PublicTopBar />
        <p className="va-hint">Loading…</p>
      </div>
    )
  }

  if (notFound || !profile) {
    return (
      <div className="page">
        <PublicTopBar />
        <p className="va-hint">No such user.</p>
      </div>
    )
  }

  return (
    <div className="page">
      <PublicTopBar />
      <div className="profile-header">
        {profile.avatarUrl && (
          <img src={profile.avatarUrl} alt={`${profile.handle}'s avatar`} className="profile-avatar" />
        )}
        <h1>{profile.handle}</h1>
      </div>
      {gifs.length === 0 ? (
        <p className="va-hint">No public GIFs yet.</p>
      ) : (
        <div className="archive-grid">
          {gifs.map((gif) =>
            // SPEC-CLOUD.md §14: this page is reachable while logged out
            // (main.tsx routes it outside App's auth-gated shell) — an
            // anonymous visitor's star is a plain link to sign in, same
            // pattern as every other logged-out call-to-action in this app
            // (About.tsx, App.tsx's own sign-in link), rather than a
            // button that 401s or navigates imperatively.
            user ? (
              <div key={gif.id} className="profile-gif-tile-wrap">
                <img src={gif.gif_url ?? ''} alt={gif.name} title={gif.name} className="profile-gif-tile" />
                <button
                  type="button"
                  className={`archive-favourite-badge ${gif.is_favourited ? 'favourited' : ''}`}
                  aria-label="Favourite"
                  aria-pressed={gif.is_favourited}
                  onClick={() => toggleFavourite(gif.id, gif.is_favourited)}
                >
                  <StarIcon size={14} filled={gif.is_favourited} />
                </button>
              </div>
            ) : (
              <div key={gif.id} className="profile-gif-tile-wrap">
                <img src={gif.gif_url ?? ''} alt={gif.name} title={gif.name} className="profile-gif-tile" />
                <a className="archive-favourite-badge" aria-label="Sign in to save" href={LOGIN_URL}>
                  <StarIcon size={14} />
                </a>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )
}
