import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listLibrary, recordGifUse } from './api'
import type { LibraryEntry, LibrarySort } from './types'

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

// SPEC-CLOUD.md §8: the global library — every user's public gifs, no
// sign-in required to view (this page still lives behind App's own login
// gate for now, since the full nav redesign making it reachable
// independently of sign-in is a later milestone).
export function Library() {
  const [items, setItems] = useState<LibraryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<LibrarySort>('newest')
  const [toast, setToast] = useState<string | null>(null)

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
        .then((updated) => setItems((its) => its.map((it) => (it.id === updated.id ? { ...it, ...updated } : it))))
        .catch(() => {})
      setToast('Link copied')
    } catch {
      setToast('Copy failed')
    }
  }

  return (
    <div className="page">
      <h1>Global Library</h1>
      <p className="subtitle">Browse public GIFs from everyone.</p>
      <input
        className="archive-search"
        aria-label="Search the library"
        placeholder="Search by name or caption text…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="library-sort-pills" role="group" aria-label="Sort the library">
        <button className={`va-btn ${sort === 'newest' ? 'active' : ''}`} onClick={() => setSort('newest')}>
          Newest
        </button>
        <button className={`va-btn ${sort === 'most-used' ? 'active' : ''}`} onClick={() => setSort('most-used')}>
          Most-used
        </button>
      </div>
      {loadError && <p className="export-error">{loadError}</p>}
      {!loading && items.length === 0 && !loadError && <p className="va-hint">No public GIFs yet.</p>}
      <div className="archive-grid">
        {items.map((item) => (
          <div key={item.id} className="library-tile">
            <img src={item.gif_url ?? ''} alt={item.name} title={item.name} className="profile-gif-tile" />
            <div className="library-tile-caption">
              <span>{item.name}</span>
              {item.owner_handle && <Link to={`/u/${item.owner_handle}`}>@{item.owner_handle}</Link>}
            </div>
            <p className="va-hint">{new Date(item.created_at).toLocaleDateString()}</p>
            <div className="library-tile-actions">
              <button className="va-btn" onClick={() => copyLink(item)}>
                🔗 Copy link
              </button>
              <span className="va-hint">{formatUseCount(item.use_count)}</span>
            </div>
          </div>
        ))}
      </div>
      {toast && <p className="archive-toast">{toast}</p>}
    </div>
  )
}
