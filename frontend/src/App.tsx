import { useEffect, useState } from 'react'
import { Archive } from './Archive'
import { LOGIN_URL, getFilmstripMeta, logout } from './api'
import { CaptionEditor } from './CaptionEditor'
import { HandlePicker } from './HandlePicker'
import { Library } from './Library'
import type { FilmstripMeta, Gif, Video } from './types'
import { useCurrentUser } from './useCurrentUser'
import { VideoPicker } from './VideoPicker'

type View = 'videos' | 'archive' | 'library'

export default function App() {
  // SPEC-CLOUD.md §2: nothing else renders until we know whether there's
  // a valid session — this is intentionally minimal (no routing, no tab
  // bar yet) since the full nav redesign is a later milestone.
  const { user, loading: authLoading, setUser } = useCurrentUser()

  // SPEC.md §8: the archive is the app's landing page — browsing/finding
  // existing GIFs is the more common action than starting a new one.
  const [view, setView] = useState<View>('archive')
  const [video, setVideo] = useState<Video | null>(null)
  const [filmstrip, setFilmstrip] = useState<FilmstripMeta | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Set right before switching to the archive view so it can arrive with
  // the just-created GIF already selected — see handleGifCreated.
  const [pendingGifId, setPendingGifId] = useState<string | null>(null)

  useEffect(() => {
    // Reset before fetching so a video switch can't render the new video
    // against the previous one's stale film-strip while the new one loads.
    setFilmstrip(null)
    if (!video) return
    let cancelled = false
    setLoadError(null)
    getFilmstripMeta(video.id)
      .then((meta) => {
        if (!cancelled) setFilmstrip(meta)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [video])

  function backToLibrary() {
    setVideo(null)
    setLoadError(null)
  }

  function handleGifCreated(gif: Gif) {
    setPendingGifId(gif.id)
    setView('archive')
  }

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

  const nav = (
    <nav className="app-nav">
      <button className={`app-nav-btn ${view === 'videos' ? 'active' : ''}`} onClick={() => setView('videos')}>
        New GIF
      </button>
      <button className={`app-nav-btn ${view === 'archive' ? 'active' : ''}`} onClick={() => setView('archive')}>
        Archive
      </button>
      <button className={`app-nav-btn ${view === 'library' ? 'active' : ''}`} onClick={() => setView('library')}>
        Global Library
      </button>
      <button className="app-nav-btn" onClick={() => logout().then(() => window.location.reload())}>
        Sign out
      </button>
    </nav>
  )

  if (view === 'archive') {
    return (
      <>
        {nav}
        <Archive initialSelectedId={pendingGifId} />
      </>
    )
  }

  if (view === 'library') {
    return (
      <>
        {nav}
        <Library />
      </>
    )
  }

  if (!video) {
    return (
      <>
        {nav}
        <VideoPicker onSelect={setVideo} />
      </>
    )
  }

  if (loadError) {
    return (
      <>
        {nav}
        <div className="page">
          <button className="back-link" onClick={backToLibrary}>
            ← back to library
          </button>
          <p className="export-error">Failed to load film-strip: {loadError}</p>
        </div>
      </>
    )
  }

  if (!filmstrip) {
    return (
      <>
        {nav}
        <div className="page">
          <p className="va-hint">Loading film-strip…</p>
        </div>
      </>
    )
  }

  return (
    <>
      {nav}
      <CaptionEditor video={video} filmstrip={filmstrip} onBack={backToLibrary} onGifCreated={handleGifCreated} />
    </>
  )
}
