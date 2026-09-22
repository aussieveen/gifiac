import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listLibrary, listPublicTemplates, recordGifUse } from './api'
import type { LibraryEntry, LibrarySort, PublicTemplate } from './types'

/** `navigator.clipboard` only exists in secure contexts — see the matching
 * helper in Archive.tsx, which this mirrors for the library's copy-link
 * action. */
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

function formatUseCount(useCount: number): string {
  return useCount === 1 ? '1 use' : `${useCount} uses`
}

// SPEC-CLOUD.md §8: gifs and templates as peer tiles in one feed. Each
// tagged with its own kind so the grid can render either shape and the
// merged list can still be sorted as a single feed.
type LibraryItem = { kind: 'gif'; data: LibraryEntry } | { kind: 'template'; data: PublicTemplate }

function itemCreatedAt(item: LibraryItem): string {
  return item.kind === 'gif' ? item.data.created_at : item.data.saved_at
}

interface Props {
  /** SPEC-CLOUD.md §8: a template tile's primary action — opens the
   * caption editor against the template's own clip (M7b). */
  onUseTemplate: (template: PublicTemplate) => void
}

// SPEC-CLOUD.md §8: the global library — every user's public gifs and
// templates, no sign-in required to view (this page still lives behind
// App's own login gate for now, since the full nav redesign making it
// reachable independently of sign-in is a later milestone).
export function Library({ onUseTemplate }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<LibrarySort>('newest')
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    Promise.all([listLibrary(query, sort), listPublicTemplates(query, sort)])
      .then(([gifs, templates]) => {
        if (cancelled) return
        // Both arrays already come back correctly sorted on their own —
        // this just re-establishes one combined order across the two
        // (no backend merge needed for a friends-only library's size).
        const merged: LibraryItem[] = [
          ...gifs.map((data): LibraryItem => ({ kind: 'gif', data })),
          ...templates.map((data): LibraryItem => ({ kind: 'template', data })),
        ]
        merged.sort((a, b) => {
          if (sort === 'most-used') {
            const useDiff = b.data.use_count - a.data.use_count
            if (useDiff !== 0) return useDiff
          }
          return itemCreatedAt(b).localeCompare(itemCreatedAt(a))
        })
        setItems(merged)
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

  useEffect(() => {
    if (!toast) return
    const timeout = setTimeout(() => setToast(null), 2000)
    return () => clearTimeout(timeout)
  }, [toast])

  // SPEC-CLOUD.md §8: the library's primary action on a gif is "copy
  // link" — bumps the same use counter Archive.tsx's copy-link does.
  async function copyLink(entry: LibraryEntry) {
    if (!entry.gif_url) return
    try {
      await copyToClipboard(entry.gif_url)
      recordGifUse(entry.id)
        .then((updated) =>
          setItems((its) =>
            its.map((it) => (it.kind === 'gif' && it.data.id === updated.id ? { ...it, data: { ...it.data, ...updated } } : it)),
          ),
        )
        .catch(() => {})
      setToast('Link copied')
    } catch {
      setToast('Copy failed')
    }
  }

  return (
    <div className="page">
      <h1>Global Library</h1>
      <p className="subtitle">Browse public GIFs and templates from everyone.</p>
      <input
        className="archive-search"
        aria-label="Search the library"
        placeholder="Search by name or caption text…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="library-sort-pills" role="group" aria-label="Sort the library">
        <button
          className={`va-btn ${sort === 'newest' ? 'active' : ''}`}
          onClick={() => setSort('newest')}
        >
          Newest
        </button>
        <button
          className={`va-btn ${sort === 'most-used' ? 'active' : ''}`}
          onClick={() => setSort('most-used')}
        >
          Most-used
        </button>
      </div>
      {loadError && <p className="export-error">{loadError}</p>}
      {!loading && items.length === 0 && !loadError && <p className="va-hint">No public GIFs or templates yet.</p>}
      <div className="archive-grid">
        {items.map((item) =>
          item.kind === 'gif' ? (
            <div key={`gif-${item.data.id}`} className="library-tile">
              <span className="library-tile-badge">GIF</span>
              <img
                src={item.data.gif_url ?? ''}
                alt={item.data.name}
                title={item.data.name}
                className="profile-gif-tile"
              />
              <div className="library-tile-caption">
                <span>{item.data.name}</span>
                {item.data.owner_handle && <Link to={`/u/${item.data.owner_handle}`}>@{item.data.owner_handle}</Link>}
              </div>
              <p className="va-hint">{new Date(item.data.created_at).toLocaleDateString()}</p>
              <div className="library-tile-actions">
                <button className="va-btn" onClick={() => copyLink(item.data)}>
                  🔗 Copy link
                </button>
                <span className="va-hint">{formatUseCount(item.data.use_count)}</span>
              </div>
            </div>
          ) : (
            <div key={`template-${item.data.id}`} className="library-tile">
              <span className="library-tile-badge">Template</span>
              <img src={item.data.thumbnail_url} alt="" className="profile-gif-tile" />
              {/* Templates have no name (SPEC.md §12) — the badge above
                  already says "Template", so this stays a spacer (keeping
                  the handle right-aligned, matching gif tiles) rather than
                  repeating it. */}
              <div className="library-tile-caption">
                <span />
                {item.data.owner_handle && <Link to={`/u/${item.data.owner_handle}`}>@{item.data.owner_handle}</Link>}
              </div>
              <p className="va-hint">{new Date(item.data.saved_at).toLocaleDateString()}</p>
              <div className="library-tile-actions">
                <button className="va-btn" onClick={() => onUseTemplate(item.data)}>
                  📋 Use this template
                </button>
                <span className="va-hint">{formatUseCount(item.data.use_count)}</span>
              </div>
            </div>
          ),
        )}
      </div>
      {toast && <p className="archive-toast">{toast}</p>}
    </div>
  )
}
