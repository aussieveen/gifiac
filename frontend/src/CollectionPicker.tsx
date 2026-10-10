import { useRef, useState } from 'react'
import { swatchColor } from './collectionSwatch'
import { CheckIcon, PlusIcon, StarIcon } from './icons'
import type { CollectionWithCount } from './types'
import { useClickOutside } from './useClickOutside'

interface Props {
  collections: CollectionWithCount[]
  memberIds: string[]
  onToggle: (collectionId: string) => void
  onCreateAndAdd: (name: string) => Promise<void>
  onClose: () => void
}

/** The "Save to collection" popover (collections-design/COLLECTIONS.md
 * §3) — one row per collection (Favourites first, via `collections`'
 * own ordering), a checkbox toggling membership immediately
 * (optimistic — the caller owns rollback on failure), and a "New
 * collection" row that creates one and adds the open gif to it in the
 * same action. */
export function CollectionPicker({ collections, memberIds, onToggle, onCreateAndAdd, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, true, onClose)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submitNew() {
    const trimmed = newName.trim()
    if (!trimmed) return
    setCreating(true)
    setError(null)
    try {
      await onCreateAndAdd(trimmed)
      setNewName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      ref={ref}
      className="collection-picker"
      role="menu"
      aria-label="Save to collection"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <p className="collection-picker-title">Save to collection</p>
      <div className="collection-picker-list">
        {collections.map((c) => {
          const checked = memberIds.includes(c.id)
          return (
            <button
              key={c.id}
              type="button"
              role="checkbox"
              aria-checked={checked}
              className="collection-picker-row"
              onClick={() => onToggle(c.id)}
            >
              <span className={`collection-picker-checkbox ${checked ? 'checked' : ''}`}>
                {checked && <CheckIcon size={12} />}
              </span>
              {c.kind === 'favourites' ? (
                <StarIcon size={14} filled />
              ) : (
                <span className="library-sidebar-swatch collection-picker-swatch" style={{ background: swatchColor(c.id) }} />
              )}
              <span className="collection-picker-name">{c.name}</span>
            </button>
          )
        })}
      </div>
      <div className="collection-picker-divider" />
      <div className="collection-picker-new">
        <input
          className="collection-picker-new-input"
          placeholder="New collection"
          aria-label="New collection name"
          value={newName}
          disabled={creating}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitNew()
            }
          }}
        />
        <button type="button" className="btn btn-secondary collection-picker-create" disabled={creating || !newName.trim()} onClick={submitNew}>
          <PlusIcon size={14} /> Create
        </button>
      </div>
      {error && <p className="export-error collection-picker-error">{error}</p>}
    </div>
  )
}
