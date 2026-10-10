import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createCollection } from './api'
import { swatchColor } from './collectionSwatch'
import { GridIcon, PlusIcon, StarIcon } from './icons'
import type { CollectionWithCount } from './types'

export type LibraryView = { kind: 'all' } | { kind: 'favourites' } | { kind: 'collection'; id: string }

interface Props {
  view: LibraryView
  collections: CollectionWithCount[]
  /** A plain number once every page is loaded (or for a view other than
   * 'all', always); `"<n>+"` while there's at least one more unloaded
   * page — see Archive.tsx's `sidebarAllGifsCount`. */
  allGifsCount: number | string
  /** Bumped after a create/rename/delete so counts and the collection
   * list stay current — the parent owns the actual fetch. */
  onCollectionsChanged: () => void
  /** Called after any navigation (clicking a nav item, or creating a
   * collection) — used by the 1024-1199px dropdown variant to close
   * itself. The plain sidebar instance (always visible, never "open" to
   * begin with) has no use for this. */
  onNavigate?: () => void
}

export function LibrarySidebar({ view, collections, allGifsCount, onCollectionsChanged, onNavigate }: Props) {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const favourites = collections.find((c) => c.kind === 'favourites')
  const custom = collections.filter((c) => c.kind === 'custom')

  function go(path: string) {
    navigate(path)
    onNavigate?.()
  }

  async function submitNew() {
    const trimmed = newName.trim()
    if (!trimmed) {
      setCreating(false)
      setNewName('')
      return
    }
    try {
      const created = await createCollection(trimmed)
      setCreating(false)
      setNewName('')
      setError(null)
      onCollectionsChanged()
      go(`/library/c/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <nav className="library-sidebar" aria-label="Collections">
      <button
        type="button"
        className={`library-sidebar-item ${view.kind === 'all' ? 'active' : ''}`}
        aria-current={view.kind === 'all' ? 'page' : undefined}
        onClick={() => go('/library')}
      >
        <GridIcon size={16} />
        <span className="library-sidebar-item-name">My GIFs</span>
        <span className="library-sidebar-item-count">{allGifsCount}</span>
      </button>
      <button
        type="button"
        className={`library-sidebar-item ${view.kind === 'favourites' ? 'active' : ''}`}
        aria-current={view.kind === 'favourites' ? 'page' : undefined}
        onClick={() => go('/library/favourites')}
      >
        <StarIcon size={16} filled />
        <span className="library-sidebar-item-name">Favourites</span>
        <span className="library-sidebar-item-count">{favourites?.gifCount ?? 0}</span>
      </button>

      <div className="library-sidebar-divider" />
      <p className="library-sidebar-label">Collections</p>

      {custom.map((collection) => (
        <button
          key={collection.id}
          type="button"
          className={`library-sidebar-item ${view.kind === 'collection' && view.id === collection.id ? 'active' : ''}`}
          aria-current={view.kind === 'collection' && view.id === collection.id ? 'page' : undefined}
          onClick={() => go(`/library/c/${collection.id}`)}
        >
          <span className="library-sidebar-swatch" style={{ background: swatchColor(collection.id) }} aria-hidden="true" />
          <span className="library-sidebar-item-name">{collection.name}</span>
          <span className="library-sidebar-item-count">{collection.gifCount}</span>
        </button>
      ))}

      {creating ? (
        <div className="library-sidebar-new-form">
          <input
            ref={inputRef}
            autoFocus
            className="library-sidebar-new-input"
            value={newName}
            placeholder="Collection name"
            aria-label="New collection name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNew()
              if (e.key === 'Escape') {
                setCreating(false)
                setNewName('')
                setError(null)
              }
            }}
            onBlur={submitNew}
          />
          <p className="library-sidebar-new-hint">Enter to create · Esc to cancel</p>
          {error && <p className="export-error">{error}</p>}
        </div>
      ) : (
        <button type="button" className="library-sidebar-new" onClick={() => setCreating(true)}>
          <PlusIcon size={14} /> New collection
        </button>
      )}
    </nav>
  )
}
