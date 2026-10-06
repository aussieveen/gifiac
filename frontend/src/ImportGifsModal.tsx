import { useEffect, useRef, useState } from 'react'
import { checkLink, deleteGif, getConfig, linkGif, renameGif, setGifPublic, uploadGifFile } from './api'
import { AlertIcon, PlusIcon, UploadIcon, XIcon } from './icons'
import type { Gif } from './types'

/** Until `getConfig()` resolves, assume the backend's own default (see
 * `MAX_GIF_BYTES` in lib.rs) so the client-side size check still works on
 * the very first file dropped before that round-trip completes. */
const DEFAULT_MAX_GIF_BYTES = 20 * 1024 * 1024

let nextRowId = 0
function makeRowId(): string {
  nextRowId += 1
  return `import-row-${nextRowId}`
}

/** Remembered across modal opens within this browser session — "Open on
 * whichever tab was used last." Resets on a page reload, which is fine:
 * there's nothing durable to restore anyway, since neither tab's rows
 * survive closing the modal. */
let lastTab: Tab = 'upload'

/** Test-only: resets the remembered tab between test cases, since
 * `lastTab` otherwise persists across every `render()` within a test
 * file's module instance. */
export function _resetLastTabForTests() {
  lastTab = 'upload'
}

type Tab = 'upload' | 'links'

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
 * extension, swaps `-`/`_` for spaces, and sentence-cases the result.
 * Shared by both tabs: a URL's last path segment, or a local file's own
 * `name`, falling into the same `split('/').pop()` fallback either way. */
function deriveName(raw: string): string {
  let filename = ''
  try {
    const segments = new URL(raw).pathname.split('/').filter(Boolean)
    filename = segments[segments.length - 1] ?? ''
  } catch {
    filename = raw.split('/').filter(Boolean).pop() ?? ''
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

type LinkRowStatus = 'empty' | 'checking' | 'ready' | 'error'

interface LinkRow {
  id: string
  url: string
  name: string
  /** Once the user edits the name directly, stop auto-prefilling it from
   * the URL — even if they clear it back to empty. */
  nameTouched: boolean
  isPublic: boolean
  status: LinkRowStatus
  width?: number
  height?: number
  sizeBytes?: number
  errorMessage?: string
}

function makeLinkRow(url = ''): LinkRow {
  // Name is deliberately left blank even when `url` is pre-filled (e.g.
  // from a multi-URL paste) — it's only derived once the link actually
  // checks out as a GIF (see `runLinkCheck`), not from text that might
  // turn out to be unreachable or not a GIF at all.
  return { id: makeRowId(), url, name: '', nameTouched: false, isPublic: false, status: 'empty' }
}

type UploadRowStatus = 'uploading' | 'ready' | 'error'

interface UploadRow {
  id: string
  file: File
  name: string
  isPublic: boolean
  status: UploadRowStatus
  progressPct: number
  /** Set once the upload succeeds — this row's gif already exists in the
   * backend from that moment on (SPEC.md §7's "accept the asymmetry":
   * unlike a link row, an upload row commits immediately, not at "Add"
   * time), so further Name/Public edits are live `PATCH` calls and
   * removing the row is a live `DELETE`, not just a local discard. */
  gif?: Gif
  errorMessage?: string
  /** Only a genuine upload failure (network/server) offers Retry — a
   * "too big" rejection never even started an upload, so retrying it
   * would just fail the same way again. */
  canRetry: boolean
}

function makeUploadRow(file: File): UploadRow {
  return { id: makeRowId(), file, name: deriveName(file.name), isPublic: false, status: 'uploading', progressPct: 0, canRetry: false }
}

/** A GIF's real first frame, frozen — a plain `<img>` would animate.
 * Drawing it to canvas once on load needs no CORS header from the host
 * (third-party for a link, our own R2 for an upload), since only
 * pixel-reading (`getImageData`/`toDataURL`) is CORS-gated, not
 * rendering. */
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
  /** Fired once an already-created (ready) upload row is removed and its
   * `DELETE /api/gifs/{id}` succeeds — Archive.tsx uses this to pull it
   * back out of the grid it was optimistically added to. */
  onRemoved: (id: string) => void
}

/** The Import GIFs modal — "Upload files" (SPEC.md §7) and "From links"
 * (SPEC.md §13) side by side. Both tabs' rows live in their own list for
 * the whole time the modal is open, regardless of which tab is active,
 * so switching tabs never loses work; the footer and "Add N GIFs" button
 * count ready rows across both. */
export function ImportGifsModal({ onClose, onAdded, onRemoved }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>(lastTab)
  const [maxGifBytes, setMaxGifBytes] = useState(DEFAULT_MAX_GIF_BYTES)
  const [dragActive, setDragActive] = useState(false)
  const [committing, setCommitting] = useState(false)

  const [linkRows, setLinkRows] = useState<LinkRow[]>(() => [makeLinkRow()])
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([])

  // A row that was just added (via "Add another link" or a multi-URL
  // paste) and should be focused once its input exists in the DOM — a
  // ref alone can't do this, since the input isn't mounted yet at the
  // moment the row is created.
  const [focusRowId, setFocusRowId] = useState<string | null>(null)

  const linkRowsRef = useRef(linkRows)
  useEffect(() => {
    linkRowsRef.current = linkRows
  }, [linkRows])
  const uploadRowsRef = useRef(uploadRows)
  useEffect(() => {
    uploadRowsRef.current = uploadRows
  }, [uploadRows])

  const urlInputRefs = useRef(new Map<string, HTMLInputElement>())
  const dropzoneRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Shared by both tabs — link-check requests and in-flight uploads alike
  // — so one unmount-cleanup effect covers everything, and removing a row
  // of either kind cancels whatever request it's keyed to.
  const abortControllersRef = useRef(new Map<string, AbortController>())
  const debounceTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const checkSeqRef = useRef(new Map<string, number>())
  // The URL each row was last asked to check — lets a blur skip re-firing
  // a check for a value that's already in flight or resolved.
  const lastCheckedUrlRef = useRef(new Map<string, string>())
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getConfig()
      .then((config) => setMaxGifBytes(config.maxGifBytes))
      .catch(() => {}) // keep the default ceiling if this fails
  }, [])

  useEffect(() => {
    if (!focusRowId) return
    urlInputRefs.current.get(focusRowId)?.focus()
    setFocusRowId(null)
  }, [focusRowId])

  useEffect(() => {
    if (lastTab === 'links') urlInputRefs.current.get(linkRows[0]?.id)?.focus()
    else dropzoneRef.current?.focus()
    // Only on mount — this is the modal's initial-focus moment, not
    // something that should re-run as rows or tabs change afterward.
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

  function switchTab(tab: Tab) {
    lastTab = tab
    setActiveTab(tab)
  }

  // ---------- From links ----------

  async function runLinkCheck(id: string, rawUrl: string) {
    abortControllersRef.current.get(id)?.abort()
    abortControllersRef.current.delete(id)

    const trimmed = rawUrl.trim()
    lastCheckedUrlRef.current.set(id, trimmed)
    if (!trimmed) {
      setLinkRows((rs) => rs.map((r) => (r.id === id ? { ...r, status: 'empty', errorMessage: undefined } : r)))
      return
    }

    const normalized = normalizeUrlClient(trimmed)
    // Only rows *above* this one count as the earlier, canonical copy —
    // pasting the same URL twice in one go must flag the second one, not
    // leave both mutually flagging each other and neither ever checked.
    const myIndex = linkRowsRef.current.findIndex((r) => r.id === id)
    const duplicate = linkRowsRef.current
      .slice(0, myIndex === -1 ? undefined : myIndex)
      .some((r) => r.url.trim() && normalizeUrlClient(r.url.trim()) === normalized)
    if (duplicate) {
      setLinkRows((rs) =>
        rs.map((r) => (r.id === id ? { ...r, status: 'error', errorMessage: "You've already added this link above." } : r)),
      )
      return
    }

    const seq = (checkSeqRef.current.get(id) ?? 0) + 1
    checkSeqRef.current.set(id, seq)
    const controller = new AbortController()
    abortControllersRef.current.set(id, controller)

    setLinkRows((rs) => rs.map((r) => (r.id === id ? { ...r, status: 'checking', errorMessage: undefined } : r)))

    try {
      const result = await checkLink(trimmed, controller.signal)
      if (checkSeqRef.current.get(id) !== seq) return // superseded by a newer check on this row
      setLinkRows((rs) =>
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
                name: !r.nameTouched && !r.name.trim() ? deriveName(trimmed) : r.name,
              }
            : r,
        ),
      )
    } catch (err) {
      if (controller.signal.aborted) return // row removed, or a newer check took over
      if (checkSeqRef.current.get(id) !== seq) return
      setLinkRows((rs) =>
        rs.map((r) => (r.id === id ? { ...r, status: 'error', errorMessage: err instanceof Error ? err.message : String(err) } : r)),
      )
    }
  }

  function scheduleLinkCheck(id: string, url: string) {
    const existing = debounceTimersRef.current.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => runLinkCheck(id, url), 400)
    debounceTimersRef.current.set(id, timer)
  }

  function handleUrlChange(id: string, value: string) {
    setLinkRows((rs) => rs.map((r) => (r.id === id ? { ...r, url: value } : r)))
    scheduleLinkCheck(id, value)
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
    runLinkCheck(id, value)
  }

  function handleUrlPaste(id: string, e: React.ClipboardEvent<HTMLInputElement>) {
    const urls = splitUrls(e.clipboardData.getData('text'))
    if (urls.length === 0) return
    e.preventDefault()

    const [first, ...rest] = urls
    const newRows = rest.map((u) => makeLinkRow(u))
    const idx = linkRowsRef.current.findIndex((r) => r.id === id)
    if (idx === -1) return
    const current = linkRowsRef.current[idx]
    const updatedFirst: LinkRow = { ...current, url: first }
    const nextRows = [...linkRowsRef.current.slice(0, idx), updatedFirst, ...newRows, ...linkRowsRef.current.slice(idx + 1)]

    // Keep the ref in lockstep right away — the mirroring effect only
    // runs after this render commits, but the duplicate check below (via
    // runLinkCheck) needs every row this paste just produced to already
    // be visible, including siblings created in this very call.
    linkRowsRef.current = nextRows
    setLinkRows(nextRows)

    runLinkCheck(id, first)
    for (const row of newRows) runLinkCheck(row.id, row.url)

    const focusTarget = newRows.length > 0 ? newRows[newRows.length - 1].id : id
    setFocusRowId(focusTarget)
  }

  function handleLinkNameChange(id: string, value: string) {
    setLinkRows((rs) => rs.map((r) => (r.id === id ? { ...r, name: value, nameTouched: true } : r)))
  }

  function toggleLinkPublic(id: string) {
    setLinkRows((rs) => rs.map((r) => (r.id === id ? { ...r, isPublic: !r.isPublic } : r)))
  }

  function removeLinkRow(id: string) {
    abortControllersRef.current.get(id)?.abort()
    abortControllersRef.current.delete(id)
    const timer = debounceTimersRef.current.get(id)
    if (timer) clearTimeout(timer)
    debounceTimersRef.current.delete(id)
    setLinkRows((rs) => rs.filter((r) => r.id !== id))
  }

  function addEmptyLinkRow() {
    const row = makeLinkRow()
    setLinkRows((rs) => [...rs, row])
    setFocusRowId(row.id)
  }

  // ---------- Upload files ----------

  async function startUpload(row: UploadRow) {
    const controller = new AbortController()
    abortControllersRef.current.set(row.id, controller)
    try {
      const gif = await uploadGifFile(
        row.file,
        row.name,
        (pct) => setUploadRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, progressPct: pct } : r))),
        controller.signal,
      )
      abortControllersRef.current.delete(row.id)
      setUploadRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, status: 'ready', gif, name: gif.name } : r)))
      onAdded([gif])
    } catch (err) {
      abortControllersRef.current.delete(row.id)
      if (err instanceof DOMException && err.name === 'AbortError') return // row was removed mid-upload
      setUploadRows((rs) =>
        rs.map((r) =>
          r.id === row.id ? { ...r, status: 'error', canRetry: true, errorMessage: err instanceof Error ? err.message : String(err) } : r,
        ),
      )
    }
  }

  function handleFilesSelected(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    if (files.length === 0) return
    if (activeTab !== 'upload') switchTab('upload')

    const tooBigMessage = `That's too big. GIFs can be up to ${Math.round(maxGifBytes / (1024 * 1024))}MB.`
    const newRows: UploadRow[] = files.map((file) =>
      file.size > maxGifBytes
        ? { id: makeRowId(), file, name: deriveName(file.name), isPublic: false, status: 'error', progressPct: 0, canRetry: false, errorMessage: tooBigMessage }
        : makeUploadRow(file),
    )
    setUploadRows((rs) => [...rs, ...newRows])
    for (const row of newRows) {
      if (row.status === 'uploading') startUpload(row)
    }
  }

  function retryUpload(id: string) {
    setUploadRows((rs) => rs.map((r) => (r.id === id ? { ...r, status: 'uploading', progressPct: 0, errorMessage: undefined } : r)))
    const row = uploadRowsRef.current.find((r) => r.id === id)
    if (row) startUpload({ ...row, status: 'uploading', progressPct: 0 })
  }

  function handleUploadNameChange(id: string, value: string) {
    setUploadRows((rs) => rs.map((r) => (r.id === id ? { ...r, name: value } : r)))
  }

  function commitUploadNameChange(id: string) {
    const row = uploadRowsRef.current.find((r) => r.id === id)
    if (!row || row.status !== 'ready' || !row.gif) return
    const trimmed = row.name.trim()
    if (!trimmed || trimmed === row.gif.name) return
    renameGif(row.gif.id, trimmed)
      .then((updated) => setUploadRows((rs) => rs.map((r) => (r.id === id ? { ...r, gif: updated, name: updated.name } : r))))
      .catch(() => {
        // Leave the typed text as-is — the row stays "ready" and the user
        // can edit again; a failed rename here isn't worth a modal-level
        // error state over.
      })
  }

  function toggleUploadPublic(id: string) {
    const row = uploadRowsRef.current.find((r) => r.id === id)
    if (!row || row.status !== 'ready' || !row.gif) return
    const next = !row.isPublic
    setUploadRows((rs) => rs.map((r) => (r.id === id ? { ...r, isPublic: next } : r)))
    setGifPublic(row.gif.id, next)
      .then((updated) => setUploadRows((rs) => rs.map((r) => (r.id === id ? { ...r, gif: updated, isPublic: updated.is_public } : r))))
      .catch(() => setUploadRows((rs) => rs.map((r) => (r.id === id ? { ...r, isPublic: !next } : r)))) // revert on failure
  }

  async function removeUploadRow(id: string) {
    const row = uploadRowsRef.current.find((r) => r.id === id)
    if (!row) return
    if (row.status === 'uploading') {
      abortControllersRef.current.get(id)?.abort()
      abortControllersRef.current.delete(id)
      setUploadRows((rs) => rs.filter((r) => r.id !== id))
      return
    }
    // A gif that's already been created — whether the row is still
    // "ready" or landed in "error" from a previous failed delete attempt
    // — must be deleted server-side before the row can go away. Clicking
    // × again after a failed delete retries it, since `row.gif` is kept.
    if (row.gif) {
      try {
        await deleteGif(row.gif.id)
      } catch (err) {
        setUploadRows((rs) =>
          rs.map((r) => (r.id === id ? { ...r, status: 'error', canRetry: false, errorMessage: err instanceof Error ? err.message : String(err) } : r)),
        )
        return
      }
      onRemoved(row.gif.id)
      setUploadRows((rs) => rs.filter((r) => r.id !== id))
      return
    }
    setUploadRows((rs) => rs.filter((r) => r.id !== id)) // nothing was ever created for this row
  }

  // ---------- Shared modal chrome ----------

  function handleDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragActive(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragActive(false)
  }

  function handleDrop(e: React.DragEvent) {
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return
    e.preventDefault()
    setDragActive(false)
    handleFilesSelected(e.dataTransfer.files)
  }

  async function handleAdd() {
    const readyLinkRows = linkRows.filter((r) => r.status === 'ready')
    const readyUploadRows = uploadRows.filter((r) => r.status === 'ready')
    if (readyLinkRows.length + readyUploadRows.length === 0 || committing) return
    setCommitting(true)

    const results = await Promise.allSettled(
      readyLinkRows.map((r) => linkGif(r.url.trim(), r.name.trim() || deriveName(r.url), r.isPublic)),
    )
    const createdFromLinks: Gif[] = []
    const failedLinkMessages = new Map<string, string>()
    results.forEach((result, i) => {
      const row = readyLinkRows[i]
      if (result.status === 'fulfilled') {
        createdFromLinks.push(result.value)
      } else {
        failedLinkMessages.set(row.id, result.reason instanceof Error ? result.reason.message : String(result.reason))
      }
    })

    setLinkRows((rs) =>
      rs
        .filter((r) => !readyLinkRows.some((rr) => rr.id === r.id) || failedLinkMessages.has(r.id))
        .map((r) => (failedLinkMessages.has(r.id) ? { ...r, status: 'error' as const, errorMessage: failedLinkMessages.get(r.id) } : r)),
    )
    if (createdFromLinks.length > 0) onAdded(createdFromLinks)

    // Upload rows are already created — "Add" just dismisses them from
    // the modal's review list, nothing left to do server-side.
    const readyUploadIds = new Set(readyUploadRows.map((r) => r.id))
    setUploadRows((rs) => rs.filter((r) => !readyUploadIds.has(r.id)))

    setCommitting(false)

    const remainingLinks = linkRows.length - createdFromLinks.length
    const remainingUploads = uploadRows.length - readyUploadRows.length
    if (remainingLinks <= 0 && remainingUploads <= 0) onClose()
  }

  function requestClose() {
    if (committing) return
    const hasLinkWork = linkRows.some((r) => r.url.trim() !== '' || r.name.trim() !== '')
    // A "ready" upload row's gif already exists in the library — closing
    // without clicking Add doesn't lose it, so only an upload still in
    // flight (which would be aborted) is worth confirming over.
    const hasUploadingInFlight = uploadRows.some((r) => r.status === 'uploading')
    if ((hasLinkWork || hasUploadingInFlight) && !window.confirm('Close this import? Any unfinished work will be lost.')) return
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

  const checkingCount = linkRows.filter((r) => r.status === 'checking').length
  const uploadingCount = uploadRows.filter((r) => r.status === 'uploading').length
  const needsFixingCount = linkRows.filter((r) => r.status === 'error').length + uploadRows.filter((r) => r.status === 'error').length
  const readyLinkRows = linkRows.filter((r) => r.status === 'ready')
  const readyUploadRows = uploadRows.filter((r) => r.status === 'ready')
  const totalReady = readyLinkRows.length + readyUploadRows.length
  const publicReadyCount = readyLinkRows.filter((r) => r.isPublic).length + readyUploadRows.filter((r) => r.isPublic).length

  const statusParts: string[] = []
  if (uploadingCount > 0) statusParts.push(uploadingCount === 1 ? '1 uploading' : `${uploadingCount} uploading`)
  if (checkingCount > 0) statusParts.push(checkingCount === 1 ? '1 checking' : `${checkingCount} checking`)
  if (needsFixingCount > 0) statusParts.push(needsFixingCount === 1 ? '1 needs fixing' : `${needsFixingCount} need fixing`)
  if (totalReady > 0) statusParts.push(`${publicReadyCount} of ${totalReady} public`)

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
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="import-link-header">
          <h2 id="import-link-title" className="import-link-title">
            Import GIFs
          </h2>
          <button type="button" className="import-link-close" aria-label="Close" onClick={requestClose}>
            <XIcon size={16} />
          </button>
        </div>

        <div className="import-tabs" role="tablist" aria-label="Import method">
          <button
            type="button"
            role="tab"
            id="import-tab-upload"
            aria-selected={activeTab === 'upload'}
            aria-controls="import-tabpanel-upload"
            className={`import-tab ${activeTab === 'upload' ? 'active' : ''}`}
            onClick={() => switchTab('upload')}
          >
            Upload files
          </button>
          <button
            type="button"
            role="tab"
            id="import-tab-links"
            aria-selected={activeTab === 'links'}
            aria-controls="import-tabpanel-links"
            className={`import-tab ${activeTab === 'links' ? 'active' : ''}`}
            onClick={() => switchTab('links')}
          >
            From links
          </button>
        </div>

        {activeTab === 'upload' && (
          <div id="import-tabpanel-upload" role="tabpanel" aria-labelledby="import-tab-upload">
            <div
              ref={dropzoneRef}
              className={`import-upload-dropzone ${dragActive ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  fileInputRef.current?.click()
                }
              }}
            >
              <UploadIcon size={44} className="import-upload-dropzone-icon" />
              <p className="import-upload-dropzone-title">Drop GIFs here, or browse</p>
              <p className="import-upload-dropzone-sub">Pick as many as you like. GIFs or videos.</p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/gif,video/*"
                multiple
                hidden
                onChange={(e) => {
                  handleFilesSelected(e.target.files ?? [])
                  e.target.value = '' // allow re-selecting the same file(s) later
                }}
              />
            </div>

            {uploadRows.length > 0 && (
              <div className="import-link-rows">
                <div className="import-link-row-grid import-link-row-header">
                  <span>Preview</span>
                  <span>Name</span>
                  <span>File</span>
                  <span className="import-link-header-public">Public</span>
                  <span />
                </div>
                {uploadRows.map((row) => (
                  <div key={row.id} className="import-link-row-grid import-link-row">
                    <div className="import-link-row-preview">
                      {row.status === 'uploading' && <span className="import-link-spinner" aria-hidden="true" />}
                      {row.status === 'error' && <AlertIcon size={18} className="import-link-row-error-icon" />}
                      {row.status === 'ready' && row.gif?.gif_url && (
                        <FrozenGifPreview url={row.gif.gif_url} alt={row.name || 'GIF preview'} />
                      )}
                    </div>

                    <input
                      className="import-link-row-name"
                      placeholder="Title…"
                      value={row.name}
                      disabled={row.status === 'uploading'}
                      onChange={(e) => handleUploadNameChange(row.id, e.target.value)}
                      onBlur={() => commitUploadNameChange(row.id)}
                      aria-label="GIF name"
                    />

                    <div className="import-link-row-file" title={row.file.name}>
                      {row.file.name}
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={row.isPublic}
                      aria-label="Public"
                      disabled={row.status === 'uploading'}
                      className={`import-link-switch ${row.isPublic ? 'on' : ''}`}
                      onClick={() => toggleUploadPublic(row.id)}
                    >
                      <span className="import-link-switch-knob" />
                    </button>

                    <button type="button" className="import-link-row-remove" aria-label="Remove" onClick={() => removeUploadRow(row.id)}>
                      <XIcon size={14} />
                    </button>

                    {row.status === 'uploading' && (
                      <div className="import-link-row-status">
                        <div className="import-upload-progress-track">
                          <div className="import-upload-progress-fill" style={{ width: `${row.progressPct}%` }} />
                        </div>
                        <span className="import-upload-progress-pct">{row.progressPct}%</span>
                      </div>
                    )}
                    {row.status === 'ready' && row.gif && (
                      <p className="import-link-row-status">
                        {row.gif.width}×{row.gif.height} · {formatBytes(row.file.size)}
                      </p>
                    )}
                    {row.status === 'error' && (
                      <p className="import-link-row-status error">
                        {row.errorMessage}
                        {row.canRetry && (
                          <button type="button" className="import-link-row-retry" onClick={() => retryUpload(row.id)}>
                            Retry
                          </button>
                        )}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'links' && (
          <div id="import-tabpanel-links" role="tabpanel" aria-labelledby="import-tab-links">
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
              {linkRows.map((row) => (
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
                    onChange={(e) => handleLinkNameChange(row.id, e.target.value)}
                    aria-label="GIF name"
                  />

                  <button
                    type="button"
                    role="switch"
                    aria-checked={row.isPublic}
                    aria-label="Public"
                    className={`import-link-switch ${row.isPublic ? 'on' : ''}`}
                    onClick={() => toggleLinkPublic(row.id)}
                  >
                    <span className="import-link-switch-knob" />
                  </button>

                  <button type="button" className="import-link-row-remove" aria-label="Remove" onClick={() => removeLinkRow(row.id)}>
                    <XIcon size={14} />
                  </button>

                  {row.status === 'checking' && <p className="import-link-row-status">Checking link…</p>}
                  {row.status === 'ready' && (
                    <p className="import-link-row-status">
                      {row.width}×{row.height} · {formatBytes(row.sizeBytes ?? 0)}
                    </p>
                  )}
                  {row.status === 'error' && <p className="import-link-row-status error">{row.errorMessage}</p>}
                </div>
              ))}
            </div>

            <button type="button" className="import-link-add-row" onClick={addEmptyLinkRow}>
              <PlusIcon size={16} /> Add another link
            </button>
          </div>
        )}

        <div className="import-link-footer">
          <span className="import-link-footer-status">{statusParts.join(' · ')}</span>
          <div className="import-link-footer-actions">
            <button type="button" className="btn btn-secondary" onClick={requestClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={totalReady === 0 || committing} onClick={handleAdd}>
              {committing ? 'Adding…' : totalReady === 0 ? 'Add GIFs' : `Add ${totalReady} GIF${totalReady === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
