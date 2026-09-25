import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminDeleteGif, favouriteGif, listLibrary, recordGifUse, unfavouriteGif } from './api'
import { profileUrl } from './handles'
import {
  ArrowLeftIcon,
  CheckIcon,
  CodeIcon,
  DownloadIcon,
  ExternalLinkIcon,
  HeartIcon,
  LinkIcon,
  SearchIcon,
  ShareIcon,
  TrashIcon,
} from './icons'
import type { LibraryEntry, LibrarySort } from './types'
import { useCanEdit } from './useCanEdit'
import { useCurrentUser } from './useCurrentUser'
import { useToast } from './useToast'

/** `navigator.clipboard` only exists in secure contexts — see the matching
 * helper in Archive.tsx, which this mirrors for the library's copy-link
 * and copy-embed actions. */
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

/** Mirrors Archive.tsx's copyEmbed escaping — see its own comment. */
function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatUseCount(useCount: number): string {
  return useCount === 1 ? '1 use' : `${useCount} uses`
}

// SPEC-CLOUD.md §8: the global library — every user's public gifs, no
// sign-in required to view (this page still lives behind App's own login
// gate for now, since the full nav redesign making it reachable
// independently of sign-in is a later milestone). Design brief §5: reuses
// My Library's grid + detail-panel layout and CSS (Archive.tsx) so the two
// screens read as one product, rather than the old per-tile action row.
export function Library() {
  const { user } = useCurrentUser()
  const [items, setItems] = useState<LibraryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<LibrarySort>('newest')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const toast = useToast()
  const canEdit = useCanEdit()
  const canShare = typeof navigator.share === 'function'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    listLibrary(query, sort)
      .then((gifs) => {
        if (!cancelled) setItems(gifs)
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
  }, [query, sort])

  const selected = items.find((i) => i.id === selectedId) ?? null

  function recordUse(id: string) {
    recordGifUse(id)
      .then((updated) => setItems((its) => its.map((it) => (it.id === updated.id ? { ...it, ...updated } : it))))
      .catch(() => {})
  }

  // SPEC-CLOUD.md §14: toggles the heart from either a grid thumbnail or
  // the detail panel — both funnel through here so the two stay in sync.
  async function toggleFavourite(id: string, isFavourited: boolean) {
    try {
      const updated = isFavourited ? await unfavouriteGif(id) : await favouriteGif(id)
      setItems((its) => its.map((it) => (it.id === updated.id ? { ...it, ...updated } : it)))
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    }
  }

  // SPEC-CLOUD.md §8: the library's primary action on a gif is "copy
  // link" — bumps the same use counter Archive.tsx's copy-link does.
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

  // Admin-only (design brief §5) — everyone else's gifs in this list
  // aren't theirs to delete.
  async function remove() {
    if (!selected) return
    if (!window.confirm(`Delete "${selected.name}"? This can't be undone.`)) return
    setDeleting(true)
    try {
      await adminDeleteGif(selected.id)
      setItems((its) => its.filter((it) => it.id !== selected.id))
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
          <h1 className="page-title">Global Library</h1>
          <span className="archive-count">{items.length === 1 ? '1 GIF' : `${items.length} GIFs`}</span>
        </div>
      </div>

      <div className="archive-toolbar">
        <div className="archive-search-wrap">
          <SearchIcon size={16} className="archive-search-icon" />
          <input
            className="archive-search"
            placeholder="Search names and captions"
            aria-label="Search the library"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="archive-chips" role="group" aria-label="Sort the library">
          <button
            type="button"
            className={`archive-chip ${sort === 'newest' ? 'active' : ''}`}
            onClick={() => setSort('newest')}
          >
            Newest
          </button>
          <button
            type="button"
            className={`archive-chip ${sort === 'most-used' ? 'active' : ''}`}
            onClick={() => setSort('most-used')}
          >
            Most used
          </button>
        </div>
      </div>

      {loading && <p className="va-hint">Loading…</p>}
      {loadError && <p className="export-error">{loadError}</p>}

      <div className={`archive-layout ${selectedId ? 'has-selection' : ''}`}>
        <div className="archive-grid">
          {items.map((item) => (
            // A plain `div` (not `button`) — SPEC-CLOUD.md §14 nests a real
            // `<button>` heart inside for the favourite toggle, and a
            // button-inside-a-button is invalid HTML the parser silently
            // hoists out, breaking layout.
            <div
              key={item.id}
              className={`archive-thumb ${item.id === selectedId ? 'selected' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(item.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setSelectedId(item.id)
              }}
              aria-label={item.name}
            >
              {item.gif_url && <img src={item.gif_url} alt={item.name} />}
              {item.external_url && (
                <span className="archive-badge-external" title="Linked — hosted externally, not by StrewthGif">
                  <LinkIcon size={14} />
                </span>
              )}
              <button
                type="button"
                className={`archive-heart-btn ${item.is_favourited ? 'favourited' : ''}`}
                aria-label={item.is_favourited ? 'Remove from Saved' : 'Save'}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFavourite(item.id, item.is_favourited)
                }}
              >
                <HeartIcon size={14} filled={item.is_favourited} />
              </button>
            </div>
          ))}
          {!loading && items.length === 0 && <p className="va-hint">No public GIFs yet.</p>}
        </div>

        <div className="archive-panel">
          {!selected ? (
            <div className="archive-panel-empty">
              <p className="va-hint">Select a GIF to view details and actions.</p>
            </div>
          ) : (
            <>
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
              <img
                key={selected.id}
                className="archive-panel-preview"
                src={selected.gif_url ?? ''}
                alt={`${selected.name} preview`}
              />
              <div className="archive-panel-header">
                <p className="archive-panel-title-text">{selected.name}</p>
                {selected.owner_handle && selected.owner_slug && (
                  <Link className="archive-owner-link" to={profileUrl(selected.owner_slug)}>
                    {selected.owner_handle}
                  </Link>
                )}
              </div>
              <p className="archive-panel-meta">
                <span>{new Date(selected.created_at).toLocaleDateString()}</span>
                <span className="archive-panel-meta-sep">·</span>
                <span>{formatUseCount(selected.use_count)}</span>
              </p>

              {canEdit && (
                <div className="archive-panel-primary-row">
                  <button className="btn btn-primary archive-copy-link-btn" onClick={copyLink}>
                    <LinkIcon /> Copy link
                  </button>
                  <button
                    type="button"
                    className={`archive-favourite-btn ${selected.is_favourited ? 'on' : ''}`}
                    aria-label={selected.is_favourited ? 'Remove from Saved' : 'Save'}
                    onClick={() => toggleFavourite(selected.id, selected.is_favourited)}
                  >
                    <HeartIcon filled={selected.is_favourited} />
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
                    href={selected.gif_url ?? ''}
                    download={`${selected.name}.gif`}
                    onClick={() => recordUse(selected.id)}
                  >
                    <DownloadIcon /> Download
                  </a>
                )}
              </div>

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
                    aria-label={selected.is_favourited ? 'Remove from Saved' : 'Save'}
                    onClick={() => toggleFavourite(selected.id, selected.is_favourited)}
                  >
                    <HeartIcon filled={selected.is_favourited} />
                  </button>
                </div>
              )}

              {user?.role === 'admin' && (
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
