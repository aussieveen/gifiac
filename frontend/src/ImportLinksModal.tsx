import { useEffect, useRef, useState } from 'react'
import { checkLink, linkGif } from './api'
import { AlertIcon, PlusIcon, XIcon } from './icons'
import type { Gif } from './types'

let nextRowId = 0
function makeRowId(): string {
  nextRowId += 1
  return `link-row-${nextRowId}`
}

/** Splits pasted text into candidate URLs on whitespace or commas — "Paste
 * several at once and they'll each get their own row." */
function splitUrls(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Lowercases scheme/host, drops a trailing slash and fragment, keeps the
 * query string — mirrors the backend's `link_check::normalize_url`
 * closely enough for this modal's own "you've already added this link
 * above" check (the real against-your-library duplicate check runs
 * server-side in `checkLink`). Falls back to a trimmed/lowercased raw
 * comparison for a URL that fails to parse, same reasoning as the
 * backend. */
function normalizeUrlClient(raw: string): string {
  try {
    const url = new URL(raw)
    const port = url.port ? `:${url.port}` : ''
    let path = url.pathname
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
    return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}${url.search}`
  } catch {
    return raw.trim().toLowerCase()
  }
}

/** `monday-standup-final-v2.gif` → `Monday standup final v2` — strips the
 * extension, swaps `-`/`_` for spaces, and sentence-cases the result. */
function deriveNameFromUrl(rawUrl: string): string {
  let filename = ''
  try {
    const segments = new URL(rawUrl).pathname.split('/').filter(Boolean)
    filename = segments[segments.length - 1] ?? ''
  } catch {
    filename = rawUrl.split('/').filter(Boolean).pop() ?? ''
  }
  try {
    filename = decodeURIComponent(filename)
  } catch {
    // malformed percent-escape — use the raw segment as-is
  }
  const withoutExtension = filename.replace(/\.[a-zA-Z0-9]+$/, '')
  const spaced = withoutExtension.replace(/[-_]+/g, ' ').trim()
  if (!spaced) return ''
  const lower = spaced.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type RowStatus = 'empty' | 'checking' | 'ready' | 'error'

interface LinkRow {
  id: string
  url: string
  name: string
  /** Once the user edits the name directly, stop auto-prefilling it from
   * the URL — even if they clear it back to empty. */
  nameTouched: boolean
  isPublic: boolean
  status: RowStatus
  width?: number
  height?: number
  sizeBytes?: number
  errorMessage?: string
}

function makeRow(url = ''): LinkRow {
  // Name is deliberately left blank even when `url` is pre-filled (e.g.
  // from a multi-URL paste) — it's only derived once the link actually
  // checks out as a GIF (see `runCheck`), not from text that might turn
  // out to be unreachable or not a GIF at all.
  return { id: makeRowId(), url, name: '', nameTouched: false, isPublic: false, status: 'empty' }
}

/** A linked GIF's real first frame, frozen — a plain `<img>` would
 * animate. Drawing it to canvas once on load needs no CORS header from
 * the third-party host, since only pixel-reading (`getImageData`/
 * `toDataURL`) is CORS-gated, not rendering. */
function FrozenGifPreview({ url, alt }: { url: string; alt: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d')?.drawImage(img, 0, 0)
    }
    img.src = url
    return () => {
      cancelled = true
    }
  }, [url])

  return <canvas ref={canvasRef} className="import-link-row-preview-canvas" aria-label={alt} role="img" />
}

interface Props {
  onClose: () => void
  onAdded: (created: Gif[]) => void
}

/** SPEC.md §13's "From links" import, pulled out of the old inline
 * URL/title/Add form into its own modal — multiple rows at once, each
 * checked server-side (CORS rules out doing it from the browser) before
 * it can be added. Never uploads anything; every row is a pure hotlink. */
export function ImportLinksModal({ onClose, onAdded }: Props) {
  const [rows, setRows] = useState<LinkRow[]>(() => [makeRow()])
  const [committing, setCommitting] = useState(false)
  // A row that was just added (via "Add another link" or a multi-URL
  // paste) and should be focused once its input exists in the DOM — a
  // ref alone can't do this, since the input isn't mounted yet at the
  // moment the row is created.
  const [focusRowId, setFocusRowId] = useState<string | null>(null)

  const rowsRef = useRef(rows)
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  const urlInputRefs = useRef(new Map<string, HTMLInputElement>())
  const abortControllersRef = useRef(new Map<string, AbortController>())
  const debounceTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const checkSeqRef = useRef(new Map<string, number>())
  // The URL each row was last asked to check — lets a blur skip re-firing
  // a check for a value that's already in flight or resolved. Needed
  // because moving focus to a freshly-pasted row (via `focusRowId`) fires
  // a native blur on whichever row had focus before, and that row's URL
  // hasn't necessarily changed.
  const lastCheckedUrlRef = useRef(new Map<string, string>())
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focusRowId) return
    urlInputRefs.current.get(focusRowId)?.focus()
    setFocusRowId(null)
  }, [focusRowId])

  useEffect(() => {
    const firstId = rows[0]?.id
    if (firstId) urlInputRefs.current.get(firstId)?.focus()
    // Only on mount — this is the modal's initial-focus moment, not
    // something that should re-run as rows change afterward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const abortControllers = abortControllersRef.current
    const debounceTimers = debounceTimersRef.current
    return () => {
      for (const controller of abortControllers.values()) controller.abort()
      for (const timer of debounceTimers.values()) clearTimeout(timer)
    }
  }, [])

  async function runCheck(id: string, rawUrl: string) {
    abortControllersRef.current.get(id)?.abort()
    abortControllersRef.current.delete(id)

    const trimmed = rawUrl.trim()
    lastCheckedUrlRef.current.set(id, trimmed)
    if (!trimmed) {
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status: 'empty', errorMessage: undefined } : r)))
      return
    }

    const normalized = normalizeUrlClient(trimmed)
    // Only rows *above* this one count as the earlier, canonical copy —
    // pasting the same URL twice in one go must flag the second one, not
    // leave both mutually flagging each other and neither ever checked.
    const myIndex = rowsRef.current.findIndex((r) => r.id === id)
    const duplicate = rowsRef.current
      .slice(0, myIndex === -1 ? undefined : myIndex)
      .some((r) => r.url.trim() && normalizeUrlClient(r.url.trim()) === normalized)
    if (duplicate) {
      setRows((rs) =>
        rs.map((r) => (r.id === id ? { ...r, status: 'error', errorMessage: "You've already added this link above." } : r)),
      )
      return
    }

    const seq = (checkSeqRef.current.get(id) ?? 0) + 1
    checkSeqRef.current.set(id, seq)
    const controller = new AbortController()
    abortControllersRef.current.set(id, controller)

    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status: 'checking', errorMessage: undefined } : r)))

    try {
      const result = await checkLink(trimmed, controller.signal)
      if (checkSeqRef.current.get(id) !== seq) return // superseded by a newer check on this row
      setRows((rs) =>
        rs.map((r) =>
          r.id === id
            ? {
                ...r,
                status: 'ready',
                width: result.width,
                height: result.height,
                sizeBytes: result.sizeBytes,
                errorMessage: undefined,
                // Only now — confirmed a real GIF — and only if the user
                // hasn't already typed a name of their own.
                name: !r.nameTouched && !r.name.trim() ? deriveNameFromUrl(trimmed) : r.name,
              }
            : r,
        ),
      )
    } catch (err) {
      if (controller.signal.aborted) return // row removed, or a newer check took over
      if (checkSeqRef.current.get(id) !== seq) return
      setRows((rs) =>
        rs.map((r) => (r.id === id ? { ...r, status: 'error', errorMessage: err instanceof Error ? err.message : String(err) } : r)),
      )
    }
  }

  function scheduleCheck(id: string, url: string) {
    const existing = debounceTimersRef.current.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => runCheck(id, url), 400)
    debounceTimersRef.current.set(id, timer)
  }

  function handleUrlChange(id: string, value: string) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, url: value } : r)))
    scheduleCheck(id, value)
  }

  function handleUrlBlur(id: string, e: React.FocusEvent<HTMLInputElement>) {
    const value = e.target.value
    // Scrolled to the cursor's last position while typing — reset to the
    // start on blur so the domain (the useful part of a long URL) is what
    // shows, not wherever the cursor happened to end up.
    e.target.scrollLeft = 0
    const timer = debounceTimersRef.current.get(id)
    if (timer) clearTimeout(timer)
    if (lastCheckedUrlRef.current.get(id) === value.trim()) return // already checked (or in flight) for this exact value
    runCheck(id, value)
  }

  function handleUrlPaste(id: string, e: React.ClipboardEvent<HTMLInputElement>) {
    const urls = splitUrls(e.clipboardData.getData('text'))
    if (urls.length === 0) return
    e.preventDefault()

    const [first, ...rest] = urls
    const newRows = rest.map((u) => makeRow(u))
    const idx = rowsRef.current.findIndex((r) => r.id === id)
    if (idx === -1) return
    const current = rowsRef.current[idx]
    const updatedFirst: LinkRow = { ...current, url: first }
    const nextRows = [...rowsRef.current.slice(0, idx), updatedFirst, ...newRows, ...rowsRef.current.slice(idx + 1)]

    // Keep the ref in lockstep right away — the mirroring effect only
    // runs after this render commits, but the duplicate check below (via
    // runCheck) needs every row this paste just produced to already be
    // visible, including siblings created in this very call.
    rowsRef.current = nextRows
    setRows(nextRows)

    runCheck(id, first)
    for (const row of newRows) runCheck(row.id, row.url)

    const focusTarget = newRows.length > 0 ? newRows[newRows.length - 1].id : id
    setFocusRowId(focusTarget)
  }

  function handleNameChange(id: string, value: string) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, name: value, nameTouched: true } : r)))
  }

  function togglePublic(id: string) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, isPublic: !r.isPublic } : r)))
  }

  function removeRow(id: string) {
    abortControllersRef.current.get(id)?.abort()
    abortControllersRef.current.delete(id)
    const timer = debounceTimersRef.current.get(id)
    if (timer) clearTimeout(timer)
    debounceTimersRef.current.delete(id)
    setRows((rs) => rs.filter((r) => r.id !== id))
  }

  function addEmptyRow() {
    const row = makeRow()
    setRows((rs) => [...rs, row])
    setFocusRowId(row.id)
  }

  async function handleAdd() {
    const readyRows = rows.filter((r) => r.status === 'ready')
    if (readyRows.length === 0 || committing) return
    setCommitting(true)

    const results = await Promise.allSettled(
      readyRows.map((r) => linkGif(r.url.trim(), r.name.trim() || deriveNameFromUrl(r.url), r.isPublic)),
    )

    const created: Gif[] = []
    const failedMessages = new Map<string, string>()
    results.forEach((result, i) => {
      const row = readyRows[i]
      if (result.status === 'fulfilled') {
        created.push(result.value)
      } else {
        failedMessages.set(row.id, result.reason instanceof Error ? result.reason.message : String(result.reason))
      }
    })

    setRows((rs) =>
      rs
        .filter((r) => !readyRows.some((rr) => rr.id === r.id) || failedMessages.has(r.id))
        .map((r) => (failedMessages.has(r.id) ? { ...r, status: 'error' as const, errorMessage: failedMessages.get(r.id) } : r)),
    )
    setCommitting(false)
    if (created.length > 0) onAdded(created)

    const remaining = rows.length - created.length
    if (remaining <= 0) onClose()
  }

  function requestClose() {
    if (committing) return
    const hasWork = rows.some((r) => r.url.trim() !== '' || r.name.trim() !== '')
    if (hasWork && !window.confirm('Close without adding these GIFs? Any unadded links will be lost.')) return
    onClose()
  }

  function handleDialogKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      requestClose()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const checkingCount = rows.filter((r) => r.status === 'checking').length
  const needsFixingCount = rows.filter((r) => r.status === 'error').length
  const readyRows = rows.filter((r) => r.status === 'ready')
  const publicReadyCount = readyRows.filter((r) => r.isPublic).length

  const statusParts: string[] = []
  if (checkingCount > 0) statusParts.push(checkingCount === 1 ? '1 checking' : `${checkingCount} checking`)
  if (needsFixingCount > 0) statusParts.push(needsFixingCount === 1 ? '1 needs fixing' : `${needsFixingCount} need fixing`)
  if (readyRows.length > 0) statusParts.push(`${publicReadyCount} of ${readyRows.length} public`)

  return (
    <div className="import-link-overlay" onMouseDown={requestClose}>
      <div
        className="import-link-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-link-title"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="import-link-header">
          <h2 id="import-link-title" className="import-link-title">
            Add from URL
          </h2>
          <button type="button" className="import-link-close" aria-label="Close" onClick={requestClose}>
            <XIcon size={16} />
          </button>
        </div>

        <p className="import-link-intro">
          Paste one or more direct links to .gif files. Paste several at once and they'll each get their own row. Linked GIFs stay
          hosted where they are.
        </p>

        <div className="import-link-rows">
          <div className="import-link-row-grid import-link-row-header">
            <span>Preview</span>
            <span>Link</span>
            <span>Name</span>
            <span className="import-link-header-public">Public</span>
            <span />
          </div>
          {rows.map((row) => (
            <div key={row.id} className="import-link-row-grid import-link-row">
              <div className="import-link-row-preview">
                {row.status === 'checking' && <span className="import-link-spinner" aria-hidden="true" />}
                {row.status === 'error' && <AlertIcon size={18} className="import-link-row-error-icon" />}
                {row.status === 'ready' && <FrozenGifPreview url={row.url.trim()} alt={row.name || 'GIF preview'} />}
                {row.status === 'empty' && <div className="import-link-row-preview-empty" />}
              </div>

              <input
                ref={(el) => {
                  if (el) urlInputRefs.current.set(row.id, el)
                  else urlInputRefs.current.delete(row.id)
                }}
                className={`import-link-row-url ${row.status === 'error' ? 'danger' : ''}`}
                placeholder="https://…/example.gif"
                value={row.url}
                onChange={(e) => handleUrlChange(row.id, e.target.value)}
                onPaste={(e) => handleUrlPaste(row.id, e)}
                onBlur={(e) => handleUrlBlur(row.id, e)}
                aria-label="GIF link"
              />

              <input
                className="import-link-row-name"
                placeholder="Title…"
                value={row.name}
                onChange={(e) => handleNameChange(row.id, e.target.value)}
                aria-label="GIF name"
              />

              <button
                type="button"
                role="switch"
                aria-checked={row.isPublic}
                aria-label="Public"
                className={`import-link-switch ${row.isPublic ? 'on' : ''}`}
                onClick={() => togglePublic(row.id)}
              >
                <span className="import-link-switch-knob" />
              </button>

              <button type="button" className="import-link-row-remove" aria-label="Remove" onClick={() => removeRow(row.id)}>
                <XIcon size={14} />
              </button>

              {row.status === 'checking' && <p className="import-link-row-status">Checking link…</p>}
              {row.status === 'ready' && (
                <p className="import-link-row-status">
                  Looks good · {row.width}×{row.height} · {formatBytes(row.sizeBytes ?? 0)}
                </p>
              )}
              {row.status === 'error' && <p className="import-link-row-status error">{row.errorMessage}</p>}
            </div>
          ))}
        </div>

        <button type="button" className="import-link-add-row" onClick={addEmptyRow}>
          <PlusIcon size={16} /> Add another link
        </button>

        <div className="import-link-footer">
          <span className="import-link-footer-status">{statusParts.join(' · ')}</span>
          <div className="import-link-footer-actions">
            <button type="button" className="btn btn-secondary" onClick={requestClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={readyRows.length === 0 || committing} onClick={handleAdd}>
              {committing
                ? 'Adding…'
                : readyRows.length === 0
                  ? 'Add GIFs'
                  : `Add ${readyRows.length} GIF${readyRows.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
