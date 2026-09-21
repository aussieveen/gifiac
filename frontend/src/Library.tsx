import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listLibrary } from './api'
import type { LibraryEntry } from './types'

// SPEC-CLOUD.md §8: the global library — every user's public gifs, no
// sign-in required to view (this page still lives behind App's own login
// gate for now, since the full nav redesign making it reachable
// independently of sign-in is M7's job). "Most-used" sort joins once
// M5c makes use_count non-trivial.
export function Library() {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    listLibrary(query)
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
  }, [query])

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
          </div>
        ))}
      </div>
    </div>
  )
}
