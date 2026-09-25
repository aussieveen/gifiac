import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { AdminPage } from './AdminPage'
import { Archive } from './Archive'
import lockup from './assets/brand/strewthgif-lockup-on-dark.svg'
import { LOGIN_URL, getFilmstripMeta, getVideo, logout } from './api'
import { AuthShell } from './AuthShell'
import { CaptionEditor } from './CaptionEditor'
import { EditorUnavailable } from './EditorUnavailable'
import { profileUrl } from './handles'
import { HandlePicker } from './HandlePicker'
import { ChevronDownIcon, LogInIcon, PlusIcon } from './icons'
import { Library } from './Library'
import { consumeReturnTo, saveReturnTo } from './returnTo'
import type { CurrentUser, FilmstripMeta, Gif, Video } from './types'
import { useCanEdit } from './useCanEdit'
import { useClickOutside } from './useClickOutside'
import { useCurrentUser } from './useCurrentUser'
import { VideoPicker } from './VideoPicker'

/** The avatar/handle pill in the header — clicking it opens a small menu
 * (design brief §2) with a link to the user's own profile and sign-out,
 * closing on an outside click. */
function AccountMenu({ user }: { user: CurrentUser }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useClickOutside(rootRef, open, () => setOpen(false))

  // AccountMenu is only ever rendered once App has confirmed
  // user.handle !== null — handle and slug are always set together
  // (db::set_handle), so this also proves user.slug to TypeScript, for
  // profileUrl below.
  if (!user.handle || !user.slug) return null

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        type="button"
        className="account-pill"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {user.avatarUrl && <img src={user.avatarUrl} alt="" className="account-avatar" />}
        <span className="account-handle">{user.handle}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="account-dropdown" role="menu">
          <Link
            className="account-dropdown-item"
            to={profileUrl(user.slug)}
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            View profile
          </Link>
          <Link className="account-dropdown-item" to="/privacy" role="menuitem" onClick={() => setOpen(false)}>
            Privacy policy
          </Link>
          <button
            type="button"
            className="account-dropdown-item"
            role="menuitem"
            onClick={() => logout().then(() => window.location.reload())}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

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
    />
  )
}

function NewGifRoute() {
  const navigate = useNavigate()
  const canEdit = useCanEdit()
  if (!canEdit) return <EditorUnavailable />
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
  const canEdit = useCanEdit()
  // Once the editor has actually mounted, shrinking the window shouldn't
  // unmount it and lose in-progress work — CaptionEditor shows a slim
  // banner instead. Only a direct link opened below the breakpoint (editor
  // never mounted) shows the full "bigger screen" message.
  const [hasMountedEditor, setHasMountedEditor] = useState(false)
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

  useEffect(() => {
    // Only counts as "mounted" if the editor was actually about to render
    // (canEdit true) — data quietly finishing a background load while the
    // "bigger screen" message is showing must not flip this on its own.
    if (video && filmstrip && canEdit) setHasMountedEditor(true)
  }, [video, filmstrip, canEdit])

  function backToPicker() {
    navigate('/new')
  }

  if (!canEdit && !hasMountedEditor) {
    return <EditorUnavailable />
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

  return (
    <CaptionEditor
      video={video}
      filmstrip={filmstrip}
      onBack={backToPicker}
      onGifCreated={onGifCreated}
      belowBreakpoint={!canEdit}
    />
  )
}

export default function App() {
  // SPEC-CLOUD.md §2: nothing else renders until we know whether there's
  // a valid session.
  const { user, loading: authLoading, setUser } = useCurrentUser()
  const navigate = useNavigate()
  const location = useLocation()

  if (authLoading) {
    return (
      <AuthShell>
        <p className="va-hint">Loading…</p>
      </AuthShell>
    )
  }

  if (!user) {
    return (
      <AuthShell>
        <div className="auth-tiles-wrap">
          <div className="auth-tiles">
            <div className="auth-tile auth-tile-left">
              <span className="caption-text auth-tile-caption">INDEED.</span>
            </div>
            <div className="auth-tile auth-tile-center">
              <span className="caption-text auth-tile-caption auth-tile-caption-accent">WELL. YES.</span>
            </div>
            <div className="auth-tile auth-tile-right">
              <span className="caption-text auth-tile-caption">FAIR.</span>
            </div>
          </div>
        </div>
        <h1 className="auth-headline">
          <span className="caption-text auth-headline-line1 auth-headline-accent">STREWTH!</span>
          <span className="caption-text auth-headline-line2">THERE'S A GIF FOR THAT.</span>
        </h1>
        <p className="auth-subline">Clip it, caption it, send it. Sign in to get to your library.</p>
        <a
          className="btn btn-primary btn-hero"
          href={LOGIN_URL}
          onClick={() => saveReturnTo(location.pathname + location.search)}
        >
          <LogInIcon />
          Sign in with Google
        </a>
      </AuthShell>
    )
  }

  if (user.handle === null) {
    return <HandlePicker suggestedHandle={user.suggestedHandle} onHandleSet={setUser} />
  }

  return <AuthenticatedApp user={user} location={location} navigate={navigate} />
}

/** Split out so the return_to redirect effect only ever runs for an
 * authenticated user with a handle — the earlier gates above (loading,
 * signed-out, handle picker) all return before this component exists. */
function AuthenticatedApp({
  user,
  location,
  navigate,
}: {
  user: CurrentUser
  location: ReturnType<typeof useLocation>
  navigate: ReturnType<typeof useNavigate>
}) {
  const returnToConsumed = useRef(false)
  useEffect(() => {
    if (returnToConsumed.current) return
    returnToConsumed.current = true
    const returnTo = consumeReturnTo()
    if (returnTo) navigate(returnTo, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const canEdit = useCanEdit()

  // SPEC-CLOUD.md §9 / design brief §2: one fixed header — a wordmark,
  // exactly three flat tabs (Admin only for an admin account), a primary
  // "New GIF" button, and an account pill (avatar/handle) that opens a
  // small menu with the profile link and sign-out. "New GIF" still isn't
  // one of the three tabs, and the video-picker/editor sub-flow it starts
  // (`/new`, `/edit/:videoId`) stays conceptually nested under My Library,
  // so that tab keeps highlighting on those paths too, not just `/library`.
  // (Archive's own toolbar copy of this action is gone as of the My
  // Library redesign pass — this header button is the only entry point now.)
  // The caption editor renders its own full header bar (back button,
  // wordmark, title, Make GIF) — the global app header would just be a
  // second, redundant one stacked above it.
  const isEditorRoute = location.pathname.startsWith('/edit/')

  const libraryActive =
    location.pathname === '/' || location.pathname.startsWith('/library') || location.pathname === '/new' || isEditorRoute

  const nav = (
    <header className="app-header">
      <div className="app-header-row1">
        <Link to="/library" className="app-header-brand" aria-label="StrewthGif — My Library">
          <img src={lockup} alt="StrewthGif" />
        </Link>
        <div className="app-header-right">
          {canEdit && (
            <Link to="/new" className="btn btn-primary">
              <PlusIcon />
              New GIF
            </Link>
          )}
          <AccountMenu user={user} />
        </div>
      </div>
      <nav className="app-header-tabs" aria-label="Main">
        <Link className={`app-header-tab ${libraryActive ? 'active' : ''}`} to="/library">
          <span className="app-header-tab-full">My Library</span>
          <span className="app-header-tab-short" aria-hidden="true">
            Mine
          </span>
        </Link>
        <Link className={`app-header-tab ${location.pathname.startsWith('/explore') ? 'active' : ''}`} to="/explore">
          <span className="app-header-tab-full">Global Library</span>
          <span className="app-header-tab-short" aria-hidden="true">
            Global
          </span>
        </Link>
        {user.role === 'admin' && (
          <Link className={`app-header-tab ${location.pathname.startsWith('/admin') ? 'active' : ''}`} to="/admin">
            <span className="app-header-tab-full">Admin</span>
            <span className="app-header-tab-short" aria-hidden="true">
              Admin
            </span>
          </Link>
        )}
      </nav>
    </header>
  )

  return (
    <>
      {!isEditorRoute && nav}
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
