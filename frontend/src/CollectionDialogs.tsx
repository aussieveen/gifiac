import { useRef, useState } from 'react'

interface DialogProps {
  titleId: string
  onClose: () => void
  children: React.ReactNode
}

/** Shared chrome for the rename/delete confirm dialogs (collections-
 * design/COLLECTIONS.md §4) — same overlay/focus-trap/Escape pattern as
 * `ImportGifsModal`, just a much smaller box. */
function Dialog({ titleId, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null)

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = ref.current
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

  return (
    <div className="app-dialog-overlay" onMouseDown={onClose}>
      <div
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  )
}

interface RenameProps {
  initialName: string
  onRename: (name: string) => Promise<void>
  onClose: () => void
}

export function RenameCollectionDialog({ initialName, onRename, onClose }: RenameProps) {
  const [name, setName] = useState(initialName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSaving(true)
    setError(null)
    try {
      await onRename(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog titleId="rename-collection-title" onClose={onClose}>
      <h2 id="rename-collection-title" className="app-dialog-title">
        Rename collection
      </h2>
      <label className="app-dialog-field">
        <span className="app-dialog-label">Name</span>
        <input
          autoFocus
          className="app-dialog-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </label>
      {error && <p className="export-error">{error}</p>}
      <div className="app-dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={saving || !name.trim()}>
          Save
        </button>
      </div>
    </Dialog>
  )
}

interface DeleteProps {
  name: string
  gifCount: number
  onDelete: () => Promise<void>
  onClose: () => void
}

export function DeleteCollectionDialog({ name, gifCount, onDelete, onClose }: DeleteProps) {
  const [deleting, setDeleting] = useState(false)

  async function submit() {
    setDeleting(true)
    try {
      await onDelete()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog titleId="delete-collection-title" onClose={onClose}>
      <h2 id="delete-collection-title" className="app-dialog-title">
        Delete &lsquo;{name}&rsquo;?
      </h2>
      <p className="app-dialog-body">
        The collection goes, but its <strong>{gifCount === 1 ? '1 GIF stays' : `${gifCount} GIFs stay`} in your library</strong> and in any
        other collections they're in.
      </p>
      <div className="app-dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger-fill" onClick={submit} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete collection'}
        </button>
      </div>
    </Dialog>
  )
}
