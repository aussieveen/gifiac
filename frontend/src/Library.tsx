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

// SPEC-CLOUD.md §8: the global library — every user's public gifs, no
// sign-in required to view (this page still lives behind App's own login
// gate for now, since the full nav redesign making it reachable
// independently of sign-in is M7's job).
export function Library() {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
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
      .then((result) => {
        if (!cancelled) setEntries(result)
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
        .then((updated) => setEntries((es) => es.map((e) => (e.id === updated.id ? { ...e, ...updated } : e))))
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
      {!loading && entries.length === 0 && !loadError && <p className="va-hint">No public GIFs yet.</p>}
      <div className="archive-grid">
        {entries.map((entry) => (
          <div key={entry.id} className="library-tile">
            <img src={entry.gif_url ?? ''} alt={entry.name} title={entry.name} className="profile-gif-tile" />
            <div className="library-tile-caption">
              <span>{entry.name}</span>
              {entry.owner_handle && <Link to={`/u/${entry.owner_handle}`}>@{entry.owner_handle}</Link>}
            </div>
            <div className="library-tile-actions">
              <button className="va-btn" onClick={() => copyLink(entry)}>
                🔗 Copy link
              </button>
              <span className="va-hint">{entry.use_count === 1 ? '1 use' : `${entry.use_count} uses`}</span>
            </div>
          </div>
        ))}
      </div>
      {toast && <p className="archive-toast">{toast}</p>}
    </div>
  )
}
