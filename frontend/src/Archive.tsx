import { useEffect, useRef, useState } from 'react'
import { deleteGif, importGifs, linkGif, listGifs, renameGif, setGifOneOff } from './api'
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

/** `navigator.clipboard` only exists in secure contexts (HTTPS, or
 * localhost) — Gifiac is a self-hosted LAN tool typically served over plain
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

interface Props {
  /** Pre-selects this GIF in the detail panel once it loads — used when
   * arriving here right after making a GIF, so its link/download/rename
   * actions are immediately at hand instead of the user having to find it
   * in the grid themselves. */
  initialSelectedId?: string | null
}

export function Archive({ initialSelectedId }: Props) {
  const [gifs, setGifs] = useState<Gif[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)
  const [deleting, setDeleting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [showLinkForm, setShowLinkForm] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkName, setLinkName] = useState('')
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
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
      await copyToClipboard(selected.gif_url)
      toast.show('Link copied')
    } catch {
      toast.show('Copy failed')
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
      toast.show('Embed copied')
    } catch {
      toast.show('Copy failed')
    }
  }

  // Flips `is_one_off` (SPEC.md §8) — the same button un-marks a GIF back
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
      <h1>Archive</h1>
      <p className="subtitle">Search, re-download, or delete GIFs you've made.</p>

      <div className="archive-toolbar">
        <input
          className="archive-search"
          placeholder="Search by name or caption text…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search archive"
        />
        <label className="va-btn archive-import-btn">
          {importing ? 'Importing…' : '+ Import GIFs'}
          <input
            type="file"
            accept="image/gif,video/*"
            multiple
            hidden
            disabled={importing}
            onChange={(e) => {
              handleImport(e.target.files)
              e.target.value = '' // allow re-selecting the same file(s) later
            }}
          />
        </label>
        <button className="va-btn" onClick={() => setShowLinkForm((s) => !s)}>
          + Add from URL
        </button>
      </div>

      {showLinkForm && (
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
          <button className="va-btn" type="submit" disabled={linking || !linkUrl.trim() || !linkName.trim()}>
            {linking ? 'Adding…' : 'Add'}
          </button>
        </form>
      )}

      {loading && <p className="va-hint">Loading…</p>}
      {loadError && <p className="export-error">{loadError}</p>}
      {importError && <p className="export-error">{importError}</p>}
      {linkError && <p className="export-error">{linkError}</p>}

      <div className="archive-layout">
        <div className="archive-grid">
          {gifs.map((g, i) => {
            // SPEC.md §8: the backend already sorts reusable GIFs before
            // one-offs (each group newest-first) — the divider goes
            // wherever the flag first flips to true in that single
            // ordered list, and only renders when a one-off actually
            // exists in the current results (search included).
            const showDivider = g.is_one_off && (i === 0 || !gifs[i - 1].is_one_off)
            return (
              <div key={g.id} className="archive-grid-item">
                {showDivider && <div className="archive-grid-divider">One-offs</div>}
                <button
                  className={`archive-thumb ${g.id === selectedId ? 'selected' : ''}`}
                  onClick={() => setSelectedId(g.id)}
                  aria-label={g.name}
                >
                  {g.gif_url && <img src={g.gif_url} alt={g.name} />}
                  {/* SPEC.md §13/§8: marks a GIF hotlinked to a third-party
                      URL — media outside our controlled R2 that could vanish
                      if the source does. File-based imports don't get this;
                      they're fully re-hosted, same as native GIFs. */}
                  {g.external_url && (
                    <span className="archive-badge-external" title="Linked — hosted externally, not by Gifiac">
                      🔗
                    </span>
                  )}
                </button>
              </div>
            )
          })}
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
              {selected.external_url && (
                <p className="va-hint archive-panel-external-note">🔗 Linked — hosted externally, not by Gifiac</p>
              )}
              <p className="va-hint">{new Date(selected.created_at).toLocaleString()}</p>
              <div className="archive-panel-actions">
                <button className="va-btn" onClick={copyLink}>
                  🔗 Copy link
                </button>
                <button className="va-btn" onClick={copyEmbed}>
                  {'</> Copy embed'}
                </button>
                <button className="va-btn" onClick={toggleOneOff}>
                  {selected.is_one_off ? '↩ Mark as reusable' : '⤵ Mark as one-off'}
                </button>
                {selected.external_url ? (
                  <a className="va-btn" href={selected.external_url} target="_blank" rel="noopener noreferrer">
                    ↗ Open original
                  </a>
                ) : (
                  <a className="va-btn" href={selected.gif_url} download={`${selected.name}.gif`}>
                    ⬇ Download
                  </a>
                )}
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
