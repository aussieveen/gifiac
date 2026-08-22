import { useEffect, useRef, useState } from 'react'
import { deleteGif, listGifs, renameGif } from './api'
import type { Gif } from './types'

/** Auto-dismisses after a beat, matching the archive prototype's toast. */
function useToast() {
  const [message, setMessage] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function show(msg: string) {
    setMessage(msg)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setMessage(null), 2000)
  }

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  return { message, show }
}

export function Archive() {
  const [gifs, setGifs] = useState<Gif[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const toast = useToast()

  // Re-queries the backend on every keystroke — SPEC.md §8: "live-filtering
  // as you type, matching `GET /api/gifs?q={query}` exactly" — rather than
  // filtering a client-side copy, so this always reflects the same search
  // the API itself implements (name + caption_text together).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    listGifs(query)
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
  }, [query])

  const selected = gifs.find((g) => g.id === selectedId) ?? null

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

  async function copyLink() {
    if (!selected?.gif_url) return
    try {
      await navigator.clipboard.writeText(selected.gif_url)
      toast.show('Link copied')
    } catch {
      toast.show('Copy failed')
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
      <h1>Archive</h1>
      <p className="subtitle">Search, re-download, or delete GIFs you've made.</p>

      <input
        className="archive-search"
        placeholder="Search by name or caption text…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search archive"
      />

      {loading && <p className="va-hint">Loading…</p>}
      {loadError && <p className="export-error">{loadError}</p>}

      <div className="archive-layout">
        <div className="archive-grid">
          {gifs.map((g) => (
            <button
              key={g.id}
              className={`archive-thumb ${g.id === selectedId ? 'selected' : ''}`}
              onClick={() => setSelectedId(g.id)}
              aria-label={g.name}
            >
              {g.gif_url && <img src={g.gif_url} alt={g.name} />}
            </button>
          ))}
          {!loading && gifs.length === 0 && <p className="va-hint">No GIFs yet.</p>}
        </div>

        <div className="archive-panel">
          {!selected ? (
            <p className="va-hint">Select a GIF to view details and actions.</p>
          ) : (
            <>
              {/* `key` forces a fresh <img> per selection, so the GIF's
                  animation restarts from frame one every time — no manual
                  play/pause bookkeeping needed. */}
              <img
                key={selected.id}
                className="archive-panel-preview"
                src={selected.gif_url}
                alt={`${selected.name} preview`}
              />
              <input
                className="archive-panel-name"
                aria-label="GIF name"
                defaultValue={selected.name}
                key={`name-${selected.id}`}
                onBlur={(e) => rename(e.target.value)}
              />
              {selected.caption_text && <p className="archive-panel-caption">{selected.caption_text}</p>}
              <p className="va-hint">{new Date(selected.created_at).toLocaleString()}</p>
              <div className="archive-panel-actions">
                <button className="va-btn" onClick={copyLink}>
                  🔗 Copy link
                </button>
                <a className="va-btn" href={selected.gif_url} download={`${selected.name}.gif`}>
                  ⬇ Download
                </a>
                <button className="va-btn danger" onClick={remove} disabled={deleting}>
                  ✕ {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {toast.message && <p className="archive-toast">{toast.message}</p>}
    </div>
  )
}
