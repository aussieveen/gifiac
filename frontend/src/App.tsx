import { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { AdminPage } from './AdminPage'
import { Archive } from './Archive'
import { LOGIN_URL, getFilmstripMeta, getVideo, logout } from './api'
import { CaptionEditor } from './CaptionEditor'
import { HandlePicker } from './HandlePicker'
import { Library } from './Library'
import type { FilmstripMeta, Gif, Video } from './types'
import { useCurrentUser } from './useCurrentUser'
import { VideoPicker } from './VideoPicker'

/** `/library` and `/library/:gifId` both land here — the id (if any)
 * pre-selects that GIF in the detail panel, and selecting a different one
 * pushes the id into the URL (`replace`d, so browsing the grid doesn't
 * spam history the way a real navigation would) so the current selection
 * is always a shareable link, not just in-memory state. */
function ArchiveRoute() {
  const { gifId } = useParams<{ gifId: string }>()
  const navigate = useNavigate()
  return (
    <Archive
      initialSelectedId={gifId ?? null}
      onSelectGif={(id) => navigate(id ? `/library/${id}` : '/library', { replace: true })}
      onNewGif={() => navigate('/new')}
    />
  )
}

function NewGifRoute() {
  const navigate = useNavigate()
  return <VideoPicker onSelect={(video) => navigate(`/edit/${video.id}`)} />
}

/** Loads its own video + film-strip from `:videoId` (via `getVideo`,
 * same as any other video lookup) rather than trusting an object handed
 * down from wherever the link was clicked — this route has to work the
 * same way whether it was reached from the video picker just now, or a
 * page refresh / shared link landed here directly. */
function EditRoute({ onGifCreated }: { onGifCreated: (gif: Gif) => void }) {
  const { videoId } = useParams<{ videoId: string }>()
  const navigate = useNavigate()
  const [video, setVideo] = useState<Video | null>(null)
  const [filmstrip, setFilmstrip] = useState<FilmstripMeta | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!videoId) return
    let cancelled = false
    // Reset before fetching so a video switch can't render the new video
    // against the previous one's stale data while the new one loads.
    setVideo(null)
    setFilmstrip(null)
    setLoadError(null)
    ;(async () => {
      try {
        const v = await getVideo(videoId)
        if (cancelled) return
        setVideo(v)
        const meta = await getFilmstripMeta(v.id)
        if (!cancelled) setFilmstrip(meta)
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [videoId])

  function backToPicker() {
    navigate('/new')
  }

  if (loadError) {
    return (
      <div className="page">
        <button className="back-link" onClick={backToPicker}>
          ← back to library
        </button>
        <p className="export-error">Failed to load film-strip: {loadError}</p>
      </div>
    )
  }

  if (!video || !filmstrip) {
    return (
      <div className="page">
        <p className="va-hint">Loading film-strip…</p>
      </div>
    )
  }

  return <CaptionEditor video={video} filmstrip={filmstrip} onBack={backToPicker} onGifCreated={onGifCreated} />
}

export default function App() {
  // SPEC-CLOUD.md §2: nothing else renders until we know whether there's
  // a valid session.
  const { user, loading: authLoading, setUser } = useCurrentUser()
  const navigate = useNavigate()
  const location = useLocation()

  if (authLoading) {
    return (
      <div className="page">
        <p className="va-hint">Loading…</p>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="page">
        <a className="app-nav-btn" href={LOGIN_URL}>
          Sign in with Google
        </a>
      </div>
    )
  }

  if (user.handle === null) {
    return <HandlePicker suggestedHandle={user.suggestedHandle} onHandleSet={setUser} />
  }

  // SPEC-CLOUD.md §9: one fixed header — a wordmark, exactly three flat
  // tabs (Admin only for an admin account), and an avatar/handle button on
  // the right that opens the current user's own public profile. "New GIF"
  // isn't one of the three tabs; it's a toolbar action inside My Library
  // (Archive's onNewGif prop) that starts the video-picker/editor sub-flow
  // (`/new`, `/edit/:videoId`) — still conceptually nested under My
  // Library, so that tab stays highlighted while on either of those paths
  // too, not just on `/library` itself.
  const libraryActive =
    location.pathname === '/' ||
    location.pathname.startsWith('/library') ||
    location.pathname === '/new' ||
    location.pathname.startsWith('/edit/')

  const nav = (
    <nav className="app-nav">
      <div className="app-nav-group">
        <span className="app-logo">Gifiac</span>
        <Link className={`app-nav-btn ${libraryActive ? 'active' : ''}`} to="/library">
          My Library
        </Link>
        <Link
          className={`app-nav-btn ${location.pathname.startsWith('/explore') ? 'active' : ''}`}
          to="/explore"
        >
          Global Library
        </Link>
        {user.role === 'admin' && (
          <Link
            className={`app-nav-btn ${location.pathname.startsWith('/admin') ? 'active' : ''}`}
            to="/admin"
          >
            Admin
          </Link>
        )}
      </div>
      <div className="app-nav-group">
        <Link className="app-nav-btn app-avatar-btn" to={`/u/${user.handle}`}>
          {user.avatarUrl && <img src={user.avatarUrl} alt="" className="app-avatar" />}
          {user.handle}
        </Link>
        <button className="app-nav-btn" onClick={() => logout().then(() => window.location.reload())}>
          Sign out
        </button>
      </div>
    </nav>
  )

  return (
    <>
      {nav}
      <Routes>
        <Route path="/" element={<Navigate to="/library" replace />} />
        <Route path="/library" element={<ArchiveRoute />} />
        <Route path="/library/:gifId" element={<ArchiveRoute />} />
        <Route path="/explore" element={<Library />} />
        <Route path="/new" element={<NewGifRoute />} />
        <Route path="/edit/:videoId" element={<EditRoute onGifCreated={(gif) => navigate(`/library/${gif.id}`)} />} />
        {user.role === 'admin' && <Route path="/admin" element={<AdminPage />} />}
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </>
  )
}
