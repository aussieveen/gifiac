import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  deleteGif,
  favouriteGif,
  importGifs,
  linkGif,
  listFavourites,
  listGifs,
  recordGifUse,
  renameGif,
  setGifOneOff,
  setGifPublic,
  unfavouriteGif,
} from './api'
import { GifThumbnail } from './GifThumbnail'
import { profileUrl } from './handles'
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LinkIcon,
  LockIcon,
  SearchIcon,
  ShareIcon,
  StarIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from './icons'
import type { Gif, LibraryEntry } from './types'
import { useCanEdit } from './useCanEdit'
import { useClickOutside } from './useClickOutside'
import { useCurrentUser } from './useCurrentUser'
import { useToast } from './useToast'

// SPEC-CLOUD.md §14: a Favourites-mode row is `LibraryEntry`-shaped (owner
// attribution included); a My-GIFs-mode row is a plain `Gif` (no
// attribution — reusing `LibraryEntry`'s own field types keeps the two
// owner fields' shape in one place rather than re-declared here). One
// state type covers both modes rather than juggling two differently-typed
// arrays.
type ArchiveItem = Gif & Partial<Pick<LibraryEntry, 'owner_handle' | 'owner_slug'>>

type Mode = 'mine' | 'favourites'

/** `navigator.clipboard` only exists in secure contexts (HTTPS, or
 * localhost) — StrewthGif is a self-hosted LAN tool typically served over plain
 * HTTP on a local hostname/IP, so it's routinely unavailable. Falls back to
 * the older `execCommand('copy')` path, which isn't secure-context-gated. */
async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy failed')
    }
  } finally {
    document.body.removeChild(textarea)
  }
}

/** Escapes characters that would break an HTML attribute value, so a GIF's
 * free-text (user-renameable) name can be safely interpolated into a copied
 * `<img alt="...">` snippet. */
function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

type Filter = 'all' | 'public' | 'private' | 'one-offs'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'public', label: 'Public' },
  { id: 'private', label: 'Private' },
  { id: 'one-offs', label: 'One-offs' },
]

interface Props {
  /** Pre-selects this GIF in the detail panel once it loads — used when
   * arriving here right after making a GIF, so its link/download/rename
   * actions are immediately at hand instead of the user having to find it
   * in the grid themselves. */
  initialSelectedId?: string | null
  /** Called whenever the selection changes (a thumbnail click, or a
   * delete clearing it back to none) so a caller that mirrors selection
   * into the URL (`/library/:gifId`) can keep it in sync — optional since
   * not every caller needs a shareable selection. */
  onSelectGif?: (id: string | null) => void
}

export function Archive({ initialSelectedId, onSelectGif }: Props) {
  const [mode, setMode] = useState<Mode>('mine')
  const [gifs, setGifs] = useState<ArchiveItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedId, setSelectedIdState] = useState<string | null>(initialSelectedId ?? null)
  function setSelectedId(id: string | null) {
    setSelectedIdState(id)
    onSelectGif?.(id)
  }
  // Keyed by gif id so `closeDetail` can return focus to whichever grid
  // tile was open — the tile itself stays mounted (only its `.selected`
  // class changes) while the panel is open, so the element a ref captured
  // earlier is still valid to focus after closing.
  const thumbRefs = useRef(new Map<string, HTMLDivElement>())
  // Shared by every way of closing the panel (the × button, Escape, and
  // deselecting a tile by clicking it again or clicking empty grid space)
  // so all four consistently return focus to the tile that was open.
  function closeDetail() {
    const tile = selectedId ? thumbRefs.current.get(selectedId) : null
    setSelectedId(null)
    tile?.focus()
  }
  const canEdit = useCanEdit()
  const { user } = useCurrentUser()
  const canShare = typeof navigator.share === 'function'
  const [deleting, setDeleting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [showImportMenu, setShowImportMenu] = useState(false)
  const importMenuRef = useRef<HTMLDivElement>(null)
  useClickOutside(importMenuRef, showImportMenu, () => setShowImportMenu(false))
  const [showLinkForm, setShowLinkForm] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkName, setLinkName] = useState('')
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const toast = useToast()

  // Re-queries the backend on every keystroke — SPEC.md §8: "live-filtering
  // as you type, matching `GET /api/gifs?q={query}` exactly" — rather than
  // filtering a client-side copy, so this always reflects the same search
  // the API itself implements (name + caption_text together). The
  // public/private/one-off chips are a second, client-side filter layered
  // on top of that same result set.
  //
  // SPEC-CLOUD.md §14: Favourites mode swaps the whole dataset via its own
  // endpoint rather than filtering this one — it isn't a compatible
  // client-side filter over "my gifs" the way the chips are, since Favourites
  // can include other users' gifs. `query` has no effect there (no
  // search/sort for Favourites yet — see the map's "Not yet specified").
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    const request = mode === 'favourites' ? listFavourites() : listGifs(query)
    request
      .then((gs) => {
        if (!cancelled) setGifs(gs)
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
  }, [query, mode])

  // Desktop-only affordance (mobile's full-screen panel keeps its own back
  // arrow instead — see the `canEdit` gate on the × button below). Skipped
  // while focus is in a text input (the rename field, search box, or the
  // link-import form) or the Import dropdown is open, so Escape can still
  // do its usual job there (e.g. clearing a native `<input>`'s own state,
  // or dismissing the dropdown) without also closing the detail panel out
  // from under it.
  useEffect(() => {
    if (!selectedId || !canEdit) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (showImportMenu) return
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
      closeDetail()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, canEdit, showImportMenu])

  const filteredGifs = gifs.filter((g) => {
    if (mode === 'favourites') return true
    if (filter === 'public') return g.is_public
    if (filter === 'private') return !g.is_public
    if (filter === 'one-offs') return g.is_one_off
    return true
  })

  const selected = gifs.find((g) => g.id === selectedId) ?? null
  // SPEC-CLOUD.md §14: Favourites can hold someone else's gif — owner-only
  // controls (rename, Public/One-off, Delete, Remix) below all gate on
  // this, matching the map's "Remix scope" decision that remixing another
  // user's gif is out of scope, and the backend's own ownership-scoped
  // rename/delete/publish endpoints, which 404 for a non-owner anyway.
  const isOwnGif = !selected?.owner_slug || selected.owner_slug === user?.slug

  async function rename(name: string) {
    if (!selected) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === selected.name) return
    try {
      const updated = await renameGif(selected.id, trimmed)
      setGifs((gs) => gs.map((g) => (g.id === updated.id ? updated : g)))
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    }
  }

  // SPEC-CLOUD.md §8: copy-link/copy-embed/download all bump the same
  // use counter — fire-and-forget, since a failed increment shouldn't
  // block the action it's attached to from succeeding.
  function recordUse(id: string) {
    recordGifUse(id)
      .then((updated) => setGifs((gs) => gs.map((g) => (g.id === updated.id ? updated : g))))
      .catch(() => {})
  }

  async function copyLink() {
    if (!selected?.gif_url) return
    try {
      await copyToClipboard(selected.gif_url)
      recordUse(selected.id)
      toast.show('Link copied')
    } catch {
      toast.show('Copy failed')
    }
  }

  async function share() {
    if (!selected?.gif_url) return
    try {
      await navigator.share({ title: selected.name, url: selected.gif_url })
      recordUse(selected.id)
    } catch {
      // AbortError on user-cancelled shares is expected, not an app error.
    }
  }

  // Copies a minimal `<img>` tag suitable for pasting into a GitHub comment,
  // issue, or PR description — GitHub strips most attributes there anyway,
  // so we only emit `src`/`alt`.
  async function copyEmbed() {
    if (!selected?.gif_url) return
    const tag = `<img src="${selected.gif_url}" alt="${escapeHtml(selected.name)}">`
    try {
      await copyToClipboard(tag)
      recordUse(selected.id)
      toast.show('Embed copied')
    } catch {
      toast.show('Copy failed')
    }
  }

  // Flips `is_one_off` (SPEC.md §8) — the same switch un-marks a GIF back
  // to reusable, moving it from the bottom "One-offs" group back to the
  // main list.
  async function toggleOneOff() {
    if (!selected) return
    try {
      const updated = await setGifOneOff(selected.id, !selected.is_one_off)
      setGifs((gs) => gs.map((g) => (g.id === updated.id ? updated : g)))
      toast.show(updated.is_one_off ? 'Marked as one-off' : 'Marked as reusable')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    }
  }

  // SPEC-CLOUD.md §4/§8: opts a gif into (or out of) the global library
  // and the owner's public profile — same pattern as toggleOneOff.
  async function togglePublic() {
    if (!selected) return
    try {
      const updated = await setGifPublic(selected.id, !selected.is_public)
      setGifs((gs) => gs.map((g) => (g.id === updated.id ? updated : g)))
      toast.show(updated.is_public ? 'Made public' : 'Made private')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    }
  }

  // SPEC-CLOUD.md §14: toggles the star from either a grid thumbnail or
  // the detail panel — both funnel through here so the two stay in sync.
  // In Favourites mode, un-favouriting a gif removes it from view entirely
  // (Favourites only ever shows gifs you've favourited), clearing the
  // selection if that was the open one; elsewhere it's an in-place update.
  async function toggleFavourite(id: string, isFavourited: boolean) {
    try {
      const updated = isFavourited ? await unfavouriteGif(id) : await favouriteGif(id)
      if (mode === 'favourites' && !updated.is_favourited) {
        setGifs((gs) => gs.filter((g) => g.id !== updated.id))
        if (selectedId === updated.id) setSelectedId(null)
      } else {
        setGifs((gs) => gs.map((g) => (g.id === updated.id ? { ...g, ...updated } : g)))
      }
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleImport(files: FileList | null) {
    if (!files || files.length === 0) return
    setImporting(true)
    setImportError(null)
    try {
      const created = await importGifs(Array.from(files))
      setGifs((gs) => [...created, ...gs])
      toast.show(created.length === 1 ? '1 GIF imported' : `${created.length} GIFs imported`)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  // SPEC.md §13: creates a linked (hotlinked, never re-hosted) GIF from a
  // pasted URL + title.
  async function handleLink(e: React.FormEvent) {
    e.preventDefault()
    const url = linkUrl.trim()
    const name = linkName.trim()
    if (!url || !name) return
    setLinking(true)
    setLinkError(null)
    try {
      const created = await linkGif(url, name)
      setGifs((gs) => [created, ...gs])
      setLinkUrl('')
      setLinkName('')
      setShowLinkForm(false)
      toast.show('Linked')
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err))
    } finally {
      setLinking(false)
    }
  }

  async function remove() {
    if (!selected) return
    if (!window.confirm(`Delete "${selected.name}"? This can't be undone.`)) return
    setDeleting(true)
    try {
      await deleteGif(selected.id)
      setGifs((gs) => gs.filter((g) => g.id !== selected.id))
      setSelectedId(null)
      toast.show('Deleted')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="page">
      <div className="archive-title-row">
        <div className="archive-title-group">
          <h1 className="page-title">My Library</h1>
          <span className="archive-count">{filteredGifs.length === 1 ? '1 GIF' : `${filteredGifs.length} GIFs`}</span>
        </div>
        {/* SPEC-CLOUD.md §14: importing/linking only makes sense for gifs
            you're creating, not the Favourites view of gifs you've favourited. */}
        {mode === 'mine' && (
          <div className="archive-import-menu" ref={importMenuRef}>
            <button
              type="button"
              className="btn btn-secondary archive-import-btn"
              onClick={() => setShowImportMenu((o) => !o)}
              aria-haspopup="true"
              aria-expanded={showImportMenu}
              aria-label="Import GIFs"
            >
              <UploadIcon size={16} className="archive-import-btn-icon" />
              <span className="archive-import-btn-label">Import</span>
              <ChevronDownIcon size={14} className="archive-import-btn-label" />
            </button>
            {showImportMenu && (
              <div className="account-dropdown archive-import-dropdown" role="menu">
                <label className="account-dropdown-item" role="menuitem">
                  {importing ? 'Importing…' : 'Upload GIFs'}
                  <input
                    type="file"
                    accept="image/gif,video/*"
                    multiple
                    hidden
                    disabled={importing}
                    onChange={(e) => {
                      handleImport(e.target.files)
                      e.target.value = '' // allow re-selecting the same file(s) later
                      setShowImportMenu(false)
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="account-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setShowLinkForm((s) => !s)
                    setShowImportMenu(false)
                  }}
                >
                  Add from URL
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* SPEC-CLOUD.md §14: swaps the whole dataset/toolbar below, not a
          filter over one already-fetched list — see the fetch effect. */}
      <div className="mode-toggle" role="group" aria-label="My Library mode">
        <button
          type="button"
          className={mode === 'mine' ? 'active' : ''}
          onClick={() => {
            setMode('mine')
            setSelectedId(null)
          }}
        >
          My GIFs
        </button>
        <button
          type="button"
          className={mode === 'favourites' ? 'active' : ''}
          onClick={() => {
            setMode('favourites')
            setSelectedId(null)
          }}
        >
          Favourites
        </button>
      </div>

      {mode === 'mine' && (
        <div className="archive-toolbar">
          <div className="archive-search-wrap">
            <SearchIcon size={16} className="archive-search-icon" />
            <input
              className="archive-search"
              placeholder="Search names and captions"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search archive"
            />
          </div>
          <div className="archive-chips" role="group" aria-label="Filter GIFs">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`archive-chip ${filter === f.id ? 'active' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'mine' && showLinkForm && (
        <form className="archive-link-form" onSubmit={handleLink}>
          <input
            className="archive-link-url"
            placeholder="https://…/example.gif"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            aria-label="GIF URL"
          />
          <input
            className="archive-link-name"
            placeholder="Title…"
            value={linkName}
            onChange={(e) => setLinkName(e.target.value)}
            aria-label="Linked GIF title"
          />
          <button className="btn btn-primary" type="submit" disabled={linking || !linkUrl.trim() || !linkName.trim()}>
            {linking ? 'Adding…' : 'Add'}
          </button>
        </form>
      )}

      {loading && <p className="va-hint">Loading…</p>}
      {loadError && <p className="export-error">{loadError}</p>}
      {importError && <p className="export-error">{importError}</p>}
      {linkError && <p className="export-error">{linkError}</p>}

      <div className={`archive-layout ${selectedId ? 'has-selection' : ''}`}>
        <div
          className="archive-grid"
          onClick={(e) => {
            // Only when the click landed on the grid itself, not a child
            // (tile, divider, favourite badge) that bubbled up — those
            // all have their own click handling.
            if (canEdit && selectedId && e.target === e.currentTarget) closeDetail()
          }}
        >
          {filteredGifs.map((g, i) => {
            // SPEC.md §8: the backend already sorts reusable GIFs before
            // one-offs (each group newest-first) — the divider goes
            // wherever the flag first flips to true in that single
            // ordered list. Only shown for the "All" chip — once a chip
            // narrows the grid to a single group (or filters across both
            // groups by visibility), a divider inside it stops being
            // meaningful. Desktop only (CSS-hidden below 1024px) — on a
            // phone/tablet the One-offs chip is the only way to isolate
            // them, since the grid is too cramped for a divider to read.
            const showDivider =
              mode === 'mine' && filter === 'all' && g.is_one_off && (i === 0 || !filteredGifs[i - 1].is_one_off)
            return (
              <div key={g.id} className="archive-grid-item">
                {showDivider && <div className="archive-grid-divider">One-offs</div>}
                {/* A plain `div` (not `button`) — SPEC-CLOUD.md §14 nests a
                    real `<button>` star inside for the favourite toggle,
                    and a button-inside-a-button is invalid HTML that gets
                    silently hoisted out by the parser, breaking layout. */}
                <div
                  ref={(el) => {
                    if (el) thumbRefs.current.set(g.id, el)
                    else thumbRefs.current.delete(g.id)
                  }}
                  className={`archive-thumb ${g.id === selectedId ? 'selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => (g.id === selectedId ? closeDetail() : setSelectedId(g.id))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      g.id === selectedId ? closeDetail() : setSelectedId(g.id)
                    }
                  }}
                  aria-label={g.name}
                >
                  <GifThumbnail gif={g} alt={g.name} disableAutoplay={!!user?.preferences.disableGifAutoplay} />
                  {!g.is_public && (
                    <span className="archive-badge-lock" title="Private">
                      <LockIcon size={14} />
                    </span>
                  )}
                  {/* SPEC.md §13/§8: marks a GIF hotlinked to a third-party
                      URL — media outside our controlled R2 that could vanish
                      if the source does. File-based imports don't get this;
                      they're fully re-hosted, same as native GIFs. */}
                  {g.external_url && (
                    <span className="archive-badge-external" title="Linked — hosted externally, not by StrewthGif">
                      <LinkIcon size={14} />
                    </span>
                  )}
                  <button
                    type="button"
                    className={`archive-favourite-badge ${g.is_favourited ? 'favourited' : ''}`}
                    aria-label="Favourite"
                    aria-pressed={g.is_favourited}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleFavourite(g.id, g.is_favourited)
                    }}
                  >
                    <StarIcon size={14} filled={g.is_favourited} />
                  </button>
                </div>
              </div>
            )
          })}
          {!loading && mode === 'mine' && gifs.length === 0 && <p className="va-hint">No GIFs yet.</p>}
          {!loading && mode === 'mine' && gifs.length > 0 && filteredGifs.length === 0 && (
            <p className="va-hint">No GIFs match this filter.</p>
          )}
          {!loading && mode === 'favourites' && gifs.length === 0 && (
            <div className="archive-favourites-empty">
              <StarIcon size={32} />
              <h3>No favourites yet</h3>
              <p className="va-hint">Hit the star on any GIF in the Global Library to keep it here for later.</p>
              <Link className="btn btn-primary" to="/explore">
                Browse Global Library
              </Link>
            </div>
          )}
        </div>

        <div className="archive-panel">
          {!selected ? (
            <div className="archive-panel-empty">
              <p className="va-hint">Select a GIF to view details and actions.</p>
            </div>
          ) : (
            <>
              {/* Below the editor's own breakpoint (<1024px, same as
                  useCanEdit) the panel becomes a full-screen view — same
                  markup as the desktop side panel via CSS, plus this top
                  bar, which desktop doesn't need since the grid alongside
                  the panel is already a visible "back" affordance. */}
              {!canEdit && (
                <div className="archive-panel-mobile-topbar">
                  <button
                    type="button"
                    className="archive-panel-back"
                    aria-label="Back to library"
                    onClick={() => setSelectedId(null)}
                  >
                    <ArrowLeftIcon />
                  </button>
                  <span className="archive-panel-mobile-title">{selected.name}</span>
                </div>
              )}
              <div className="archive-panel-preview-wrap">
                {/* `key` forces a fresh <img> per selection, so the GIF's
                    animation restarts from frame one every time — no manual
                    play/pause bookkeeping needed. */}
                <img
                  key={selected.id}
                  className="archive-panel-preview"
                  src={selected.gif_url}
                  alt={`${selected.name} preview`}
                />
                {/* Desktop only — mobile's full-screen panel keeps its own
                    back arrow (`archive-panel-mobile-topbar` above) instead. */}
                {canEdit && (
                  <button
                    type="button"
                    className="archive-panel-close"
                    aria-label="Close details"
                    onClick={closeDetail}
                  >
                    <XIcon size={16} />
                  </button>
                )}
              </div>
              <div className="archive-panel-header">
                {isOwnGif ? (
                  <input
                    className="archive-panel-name"
                    aria-label="GIF name"
                    defaultValue={selected.name}
                    key={`name-${selected.id}`}
                    onBlur={(e) => rename(e.target.value)}
                  />
                ) : (
                  <p className="archive-panel-title-text">{selected.name}</p>
                )}
                <span className={`archive-visibility-pill ${selected.is_public ? 'public' : 'private'}`}>
                  {selected.is_public ? 'Public' : 'Private'}
                </span>
              </div>
              {/* SPEC-CLOUD.md §14: only present in Favourites mode, and only
                  meaningful there — Favourites can hold other users' gifs. */}
              {selected.owner_handle && selected.owner_slug && (
                <Link className="archive-owner-link" to={profileUrl(selected.owner_slug)}>
                  {selected.owner_handle}
                </Link>
              )}
              {selected.caption_text && <p className="archive-panel-caption">{selected.caption_text}</p>}
              <p className="archive-panel-meta">
                <span>{new Date(selected.created_at).toLocaleString()}</span>
                <span className="archive-panel-meta-sep">·</span>
                <span>{selected.use_count === 1 ? '1 use' : `${selected.use_count} uses`}</span>
              </p>
              {selected.external_url && (
                <p className="va-hint archive-panel-external-note">
                  <LinkIcon size={14} /> Linked — hosted externally, not by StrewthGif
                </p>
              )}

              {canEdit && (
                <div className="archive-panel-primary-row">
                  <button className="btn btn-primary archive-copy-link-btn" onClick={copyLink}>
                    <LinkIcon /> Copy link
                  </button>
                  <button
                    type="button"
                    className={`archive-favourite-btn ${selected.is_favourited ? 'on' : ''}`}
                    aria-label="Favourite"
                    aria-pressed={selected.is_favourited}
                    onClick={() => toggleFavourite(selected.id, selected.is_favourited)}
                  >
                    <StarIcon filled={selected.is_favourited} />
                  </button>
                </div>
              )}

              <div className="archive-panel-secondary-row">
                {!canEdit && canShare && (
                  <button className="btn btn-secondary" onClick={copyLink}>
                    <LinkIcon /> Copy link
                  </button>
                )}
                <button className="btn btn-secondary" onClick={copyEmbed}>
                  <CodeIcon /> Embed
                </button>
                {selected.external_url ? (
                  <a className="btn btn-secondary" href={selected.external_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLinkIcon /> Open original
                  </a>
                ) : (
                  <a
                    className="btn btn-secondary"
                    href={selected.gif_url}
                    download={`${selected.name}.gif`}
                    onClick={() => recordUse(selected.id)}
                  >
                    <DownloadIcon /> Download
                  </a>
                )}
                {canEdit && selected.video_id && isOwnGif && (
                  <Link className="btn btn-secondary" to={`/edit/${selected.video_id}`}>
                    Remix
                  </Link>
                )}
              </div>

              {/* Pinned bottom bar, below the editor breakpoint only —
                  Share if available, else Copy link. Desktop keeps the
                  single Copy-link button above instead. */}
              {!canEdit && (
                <div className="archive-mobile-action-bar">
                  {canShare ? (
                    <button className="btn btn-primary" onClick={share}>
                      <ShareIcon /> Share
                    </button>
                  ) : (
                    <button className="btn btn-primary" onClick={copyLink}>
                      <LinkIcon /> Copy link
                    </button>
                  )}
                  <button
                    type="button"
                    className={`archive-favourite-btn ${selected.is_favourited ? 'on' : ''}`}
                    aria-label="Favourite"
                    aria-pressed={selected.is_favourited}
                    onClick={() => toggleFavourite(selected.id, selected.is_favourited)}
                  >
                    <StarIcon filled={selected.is_favourited} />
                  </button>
                </div>
              )}

              {isOwnGif && (
                <div className="archive-settings-list">
                  <div className="archive-settings-row">
                    <div>
                      <p className="archive-settings-title">Public</p>
                      <p className="archive-settings-help">Show in the Global Library</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={selected.is_public}
                      aria-label="Public"
                      className={`archive-switch ${selected.is_public ? 'on' : ''}`}
                      onClick={togglePublic}
                    >
                      <span className="archive-switch-knob" />
                    </button>
                  </div>
                  <div className="archive-settings-row">
                    <div>
                      <p className="archive-settings-title">One-off</p>
                      <p className="archive-settings-help">Hide from search after use</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={selected.is_one_off}
                      aria-label="One-off"
                      className={`archive-switch ${selected.is_one_off ? 'on' : ''}`}
                      onClick={toggleOneOff}
                    >
                      <span className="archive-switch-knob" />
                    </button>
                  </div>
                </div>
              )}

              {isOwnGif && (
                <button className="btn btn-danger" onClick={remove} disabled={deleting}>
                  <TrashIcon /> {deleting ? 'Deleting…' : 'Delete GIF'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {toast.message && (
        <div className="archive-toast">
          <CheckIcon size={16} />
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  )
}
