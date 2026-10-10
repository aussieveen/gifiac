import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  addGifToCollection,
  createCollection,
  deleteCollection,
  deleteGif,
  favouriteGif,
  gifCollectionIds,
  listCollectionGifs,
  listCollections,
  listFavourites,
  listGifs,
  recordGifUse,
  removeGifFromCollection,
  renameCollection,
  renameGif,
  setGifOneOff,
  setGifPublic,
  unfavouriteGif,
} from './api'
import { CollectionPicker } from './CollectionPicker'
import { DeleteCollectionDialog, RenameCollectionDialog } from './CollectionDialogs'
import { swatchColor } from './collectionSwatch'
import { GifThumbnail } from './GifThumbnail'
import { profileUrl } from './handles'
import {
  ArrowLeftIcon,
  BookmarkIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GridIcon,
  LinkIcon,
  LockIcon,
  MoreIcon,
  PencilIcon,
  SearchIcon,
  ShareIcon,
  StarIcon,
  TrashIcon,
  XIcon,
} from './icons'
import type { LibraryView } from './LibrarySidebar'
import { LibrarySidebar } from './LibrarySidebar'
import type { CollectionWithCount, Gif, GifFilterCounts, LibraryEntry } from './types'
import { useCanEdit } from './useCanEdit'
import { useClickOutside } from './useClickOutside'
import { useCurrentUser } from './useCurrentUser'
import { useInfiniteScroll } from './useInfiniteScroll'
import { useToast } from './useToast'

export type { LibraryView } from './LibrarySidebar'

// A Favourites/collection row is `LibraryEntry`-shaped (owner attribution
// included); an All-GIFs row is a plain `Gif` (no attribution — reusing
// `LibraryEntry`'s own field types keeps the two owner fields' shape in
// one place rather than re-declared here). One state type covers every
// view rather than juggling differently-typed arrays per view.
type ArchiveItem = Gif & Partial<Pick<LibraryEntry, 'owner_handle' | 'owner_slug'>>

/** `navigator.clipboard` only exists in secure contexts (HTTPS, or
 * localhost) — StrewthGif is a self-hosted LAN tool typically served over plain
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

type Filter = 'all' | 'public' | 'private' | 'one-offs'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'public', label: 'Public' },
  { id: 'private', label: 'Private' },
  { id: 'one-offs', label: 'Hidden' },
]

interface Props {
  /** Which sidebar nav item is open — All GIFs, Favourites, or a custom
   * collection. Owned by the router (ArchiveRoute in App.tsx), not this
   * component, since it's derived from the URL. */
  view: LibraryView
  /** Pre-selects this GIF in the detail panel once it loads — used when
   * arriving here right after making a GIF, so its link/download/rename
   * actions are immediately at hand instead of the user having to find it
   * in the grid themselves. */
  initialSelectedId?: string | null
  /** Called whenever the selection changes (a thumbnail click, or a
   * delete clearing it back to none) so a caller that mirrors selection
   * into the URL (`/library/:gifId`) can keep it in sync — optional since
   * not every caller needs a shareable selection. */
  onSelectGif?: (id: string | null) => void
  /** Bumped by the global Import modal (App.tsx — Import now lives in the
   * header next to New GIF, not here) whenever it creates or removes a
   * gif, so this re-fetches the list even though it never hears about
   * that import directly. Optional since the archive is still perfectly
   * usable without ever importing anything in this session. */
  refreshToken?: number
}

export function Archive({ view, initialSelectedId, onSelectGif, refreshToken }: Props) {
  const [gifs, setGifs] = useState<ArchiveItem[]>([])
  // Infinite scroll (never a "Load more" button) — only the 'all' view is
  // paginated server-side (`GET /api/gifs`); Favourites and a collection's
  // gifs stay unpaginated, so `hasMore` simply never goes true for them.
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // The 'all' view's real matching count from the backend — Favourites
  // and a collection aren't paginated, so this is only ever meaningful
  // there (see `sidebarAllGifsCount`).
  const [total, setTotal] = useState(0)
  // The All/Public/Private/Hidden chip counts — like `total`, only
  // meaningful for the 'all' view (the only one with these chips at all).
  const [filterCounts, setFilterCounts] = useState<GifFilterCounts>({ all: 0, public: 0, private: 0, hidden: 0 })
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [collections, setCollections] = useState<CollectionWithCount[]>([])
  const [allGifsCount, setAllGifsCount] = useState(0)
  const [collectionsRefreshToken, setCollectionsRefreshToken] = useState(0)
  const activeCollection = view.kind === 'collection' ? collections.find((c) => c.id === view.id) : undefined
  const [selectedId, setSelectedIdState] = useState<string | null>(initialSelectedId ?? null)
  function setSelectedId(id: string | null) {
    setSelectedIdState(id)
    onSelectGif?.(id)
  }
  // Keyed by gif id so `closeDetail` can return focus to whichever grid
  // tile was open — the tile itself stays mounted (only its `.selected`
  // class changes) while the panel is open, so the element a ref captured
  // earlier is still valid to focus after closing.
  const thumbRefs = useRef(new Map<string, HTMLDivElement>())
  // Shared by every way of closing the panel (the × button, Escape, and
  // deselecting a tile by clicking it again or clicking empty grid space)
  // so all four consistently return focus to the tile that was open.
  function closeDetail() {
    const tile = selectedId ? thumbRefs.current.get(selectedId) : null
    setSelectedId(null)
    tile?.focus()
  }
  const canEdit = useCanEdit()
  const { user } = useCurrentUser()
  const canShare = typeof navigator.share === 'function'
  const [deleting, setDeleting] = useState(false)
  const toast = useToast()
  const navigate = useNavigate()

  // The collection header's "⋯" menu (rename/delete) — custom collections
  // only, see the lock note shown for Favourites instead.
  const [collectionMenuOpen, setCollectionMenuOpen] = useState(false)
  const collectionMenuRef = useRef<HTMLDivElement>(null)
  useClickOutside(collectionMenuRef, collectionMenuOpen, () => setCollectionMenuOpen(false))
  const [renamingCollection, setRenamingCollection] = useState(false)
  const [deletingCollection, setDeletingCollection] = useState(false)

  // 1024-1199px only (CSS-gated — see .library-nav-dropdown): the sidebar
  // is hidden at that width, so the page title itself becomes a dropdown
  // trigger listing the same nav items. Harmless to keep mounted outside
  // that range; the CSS there just never shows it.
  const [navDropdownOpen, setNavDropdownOpen] = useState(false)
  const navDropdownRef = useRef<HTMLDivElement>(null)
  useClickOutside(navDropdownRef, navDropdownOpen, () => setNavDropdownOpen(false))

  // Re-queries the backend on every keystroke — SPEC.md §8: "live-filtering
  // as you type, matching `GET /api/gifs?q={query}` exactly" — rather than
  // filtering a client-side copy, so this always reflects the same search
  // the API itself implements (name + caption_text together). The
  // public/private/one-off chips are a second, client-side filter layered
  // on top of that same result set.
  //
  // collections-design/COLLECTIONS.md: Favourites and a custom collection
  // each swap the whole dataset via their own endpoint rather than
  // filtering this one — neither is a compatible client-side filter over
  // "my gifs" the way the chips are, since both can include other users'
  // gifs. Favourites' endpoint has no search param (no search for
  // Favourites yet); a collection's does.
  // `refreshToken` has no meaning of its own — it only exists to force
  // this effect to re-run when the global Import modal changes the
  // library out from under this already-mounted page.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setPage(1)
    if (view.kind === 'favourites' || view.kind === 'collection') {
      const request = view.kind === 'favourites' ? listFavourites() : listCollectionGifs(view.id, query)
      request
        .then((gs) => {
          if (cancelled) return
          setGifs(gs)
          setHasMore(false)
        })
        .catch((err) => {
          if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    } else {
      listGifs(query, 1)
        .then((result) => {
          if (cancelled) return
          setGifs(result.items)
          setHasMore(result.has_more)
          setTotal(result.total)
          setFilterCounts(result.filter_counts)
        })
        .catch((err) => {
          if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, view.kind, view.kind === 'collection' ? view.id : null, refreshToken])

  const loadMore = useCallback(() => {
    if (view.kind !== 'all') return
    setLoadingMore(true)
    const nextPage = page + 1
    listGifs(query, nextPage)
      .then((result) => {
        setGifs((gs) => [...gs, ...result.items])
        setHasMore(result.has_more)
        setTotal(result.total)
        setFilterCounts(result.filter_counts)
        setPage(nextPage)
      })
      .catch((err) => toast.show(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingMore(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.kind, query, page])

  useInfiniteScroll(sentinelRef, hasMore && !loading && !loadingMore, loadMore)

  // Sidebar's collections list — fetched independently of the active
  // view (every view needs the same sidebar) and refreshed whenever a
  // collection is created/renamed/deleted (`collectionsRefreshToken`) or
  // a collection's gif count might have changed (`refreshToken`).
  useEffect(() => {
    let cancelled = false
    listCollections()
      .then((cs) => {
        if (!cancelled) setCollections(cs)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [refreshToken, collectionsRefreshToken])

  // Sidebar's "All GIFs" count: while viewing All GIFs itself, `total`
  // above already has the answer (from the same paginated fetch) — no
  // need for a second request. Any other view needs its own fetch to
  // know that count; `listGifs`'s response carries the real total
  // regardless of page size, so this is exact, not has_more-derived.
  useEffect(() => {
    if (view.kind === 'all') return
    let cancelled = false
    listGifs()
      .then((result) => {
        if (!cancelled) setAllGifsCount(result.total)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [view.kind, refreshToken])
  const sidebarAllGifsCount = view.kind === 'all' ? total : allGifsCount

  // Desktop-only affordance (mobile's full-screen panel keeps its own back
  // arrow instead — see the `canEdit` gate on the × button below). Skipped
  // while focus is in a text input (the rename field or search box), so
  // Escape can still do its usual job there (e.g. clearing a native
  // `<input>`'s own state) without also closing the detail panel out from
  // under it. The Import modal handles its own Escape and stops it from
  // bubbling here (see ImportGifsModal's dialog keydown handler).
  useEffect(() => {
    if (!selectedId || !canEdit) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
      closeDetail()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, canEdit])

  // Mine/Others' — collections-design/COLLECTIONS.md §2: Favourites and a
  // custom collection can hold other people's gifs, so (unlike the
  // All-GIFs-only Public/Private/One-offs chips) they instead get this
  // simpler scope filter. A gif's own `owner_slug` is always present on
  // these rows (even for the caller's own), so "mine" is just an equality
  // check against the signed-in user.
  const [scope, setScope] = useState<'all' | 'mine' | 'others'>('all')
  useEffect(() => {
    setScope('all')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.kind, view.kind === 'collection' ? view.id : null])

  const filteredGifs = gifs.filter((g) => {
    if (view.kind === 'all') {
      // Hidden gifs are genuinely hidden — they only ever show up when
      // the Hidden chip itself is active, never mixed into All/Public/
      // Private (no more divider separating them out of an "All" that
      // included them).
      if (filter === 'one-offs') return g.is_one_off
      if (g.is_one_off) return false
      if (filter === 'public') return g.is_public
      if (filter === 'private') return !g.is_public
      return true
    }
    const isMine = !g.owner_slug || g.owner_slug === user?.slug
    if (scope === 'mine') return isMine
    if (scope === 'others') return !isMine
    return true
  })

  // The header's count: for the 'all' view this is the server-computed
  // total for whichever chip is active (`filterCounts`), not
  // `filteredGifs.length` — that's only however much of the paginated
  // list has been scrolled into, which undercounts once there's more
  // than one page. Favourites/a collection aren't paginated, so
  // `filteredGifs.length` is still exact for those.
  const displayCount =
    view.kind === 'all' ? filterCounts[filter === 'one-offs' ? 'hidden' : filter] : filteredGifs.length

  const selected = gifs.find((g) => g.id === selectedId) ?? null
  // SPEC-CLOUD.md §14: Favourites can hold someone else's gif — owner-only
  // controls (rename, Public/One-off, Delete) below all gate on this,
  // matching the backend's own ownership-scoped rename/delete/publish
  // endpoints, which 404 for a non-owner anyway. "Remix this GIF" is
  // deliberately NOT gated on this — it's keyed on template lineage
  // (`template_remixable`), so a public template's Remix can show on
  // someone else's gif too.
  const isOwnGif = !selected?.owner_slug || selected.owner_slug === user?.slug

  // Which of the caller's own collections the selected gif is in — drives
  // the "Save to collection" picker's checked state and the "In
  // collections" chips below the primary action row. Re-fetched whenever
  // the selection changes; cleared when nothing's selected.
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  useEffect(() => {
    if (!selected) {
      setMemberIds([])
      return
    }
    let cancelled = false
    gifCollectionIds(selected.id)
      .then((ids) => {
        if (!cancelled) setMemberIds(ids)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  // Shared by the picker's checkboxes and the detail panel's "Remove from
  // '<collection>'" shortcut. Favourites routes through the existing
  // favourite/unfavourite endpoints (keeps `is_favourited` and the star
  // icon in sync — collections-design/COLLECTIONS.md §3: "The star and
  // the Favourites checkbox in the picker are the same state"); every
  // other collection goes through the generic membership endpoints.
  async function toggleCollectionMembership(collectionId: string) {
    if (!selected) return
    const collection = collections.find((c) => c.id === collectionId)
    const isMember = memberIds.includes(collectionId)
    try {
      if (collection?.kind === 'favourites') {
        // Silent, matching the plain star button's existing behavior
        // everywhere else in the app — no toast on a favourite toggle.
        await toggleFavourite(selected.id, isMember)
      } else if (isMember) {
        await removeGifFromCollection(collectionId, selected.id)
        if (view.kind === 'collection' && view.id === collectionId) {
          setGifs((gs) => gs.filter((g) => g.id !== selected.id))
        }
        if (collection) toast.show(`Removed from '${collection.name}'`)
      } else {
        await addGifToCollection(collectionId, selected.id)
        if (collection) toast.show(`Saved to '${collection.name}'`)
      }
      setMemberIds((ids) => (isMember ? ids.filter((id) => id !== collectionId) : [...ids, collectionId]))
      setCollectionsRefreshToken((t) => t + 1)
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    }
  }

  async function createCollectionAndAdd(name: string) {
    if (!selected) return
    const created = await createCollection(name)
    await addGifToCollection(created.id, selected.id)
    setMemberIds((ids) => [...ids, created.id])
    setCollectionsRefreshToken((t) => t + 1)
    toast.show(`Saved to '${created.name}'`)
  }

  async function renameActiveCollection(name: string) {
    if (view.kind !== 'collection') return
    await renameCollection(view.id, name)
    setCollectionsRefreshToken((t) => t + 1)
    setRenamingCollection(false)
  }

  // Drops the collection and its membership rows only — the gifs
  // themselves are untouched (collections-design/COLLECTIONS.md §4).
  // Offers an 8-second "Undo" that recreates it (a fresh id; nothing
  // external depends on the old one persisting) and re-adds every gif
  // that was in it, from the list already loaded for this view.
  async function deleteActiveCollection() {
    if (view.kind !== 'collection' || !activeCollection) return
    const { name } = activeCollection
    const memberGifIds = gifs.map((g) => g.id)
    await deleteCollection(view.id)
    setDeletingCollection(false)
    setCollectionsRefreshToken((t) => t + 1)
    navigate('/library')
    toast.show(`Deleted '${name}'`, {
      durationMs: 8000,
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            const recreated = await createCollection(name)
            await Promise.all(memberGifIds.map((id) => addGifToCollection(recreated.id, id)))
            setCollectionsRefreshToken((t) => t + 1)
            navigate(`/library/c/${recreated.id}`)
          } catch (err) {
            toast.show(err instanceof Error ? err.message : String(err))
          }
        },
      },
    })
  }

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

  // SPEC-CLOUD.md §8: copy-link/copy-embed/download all bump the same
  // use counter — fire-and-forget, since a failed increment shouldn't
  // block the action it's attached to from succeeding.
  function recordUse(id: string) {
    recordGifUse(id)
      .then((updated) => setGifs((gs) => gs.map((g) => (g.id === updated.id ? updated : g))))
      .catch(() => {})
  }

  async function copyLink() {
    if (!selected?.gif_url) return
    try {
      await copyToClipboard(selected.gif_url)
      recordUse(selected.id)
      toast.show('Link copied')
    } catch {
      toast.show('Copy failed')
    }
  }

  async function share() {
    if (!selected?.gif_url) return
    try {
      await navigator.share({ title: selected.name, url: selected.gif_url })
      recordUse(selected.id)
    } catch {
      // AbortError on user-cancelled shares is expected, not an app error.
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
      recordUse(selected.id)
      toast.show('Embed copied')
    } catch {
      toast.show('Copy failed')
    }
  }

  // Flips `is_one_off` (SPEC.md §8) — the same switch un-marks a GIF back
  // to reusable, moving it from the bottom "One-offs" group back to the
  // main list.
  async function toggleOneOff() {
    if (!selected) return
    try {
      const updated = await setGifOneOff(selected.id, !selected.is_one_off)
      setGifs((gs) => gs.map((g) => (g.id === updated.id ? updated : g)))
      if (view.kind === 'all') {
        // Going hidden moves it out of `all` and its public/private
        // bucket into `hidden`; coming back reverses that — one chip
        // count changes by 1 each way, matching the server's own
        // `NOT is_one_off` exclusion (db::gif_filter_counts).
        const sign = updated.is_one_off ? -1 : 1
        const bucket = updated.is_public ? 'public' : 'private'
        setFilterCounts((c) => ({ ...c, all: c.all + sign, [bucket]: c[bucket] + sign, hidden: c.hidden - sign }))
      }
      toast.show(updated.is_one_off ? 'Marked as hidden' : 'Marked as visible')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    }
  }

  // SPEC-CLOUD.md §4/§8: opts a gif into (or out of) the global library
  // and the owner's public profile — same pattern as toggleOneOff.
  async function togglePublic() {
    if (!selected) return
    try {
      const updated = await setGifPublic(selected.id, !selected.is_public)
      setGifs((gs) => gs.map((g) => (g.id === updated.id ? updated : g)))
      // A hidden gif's public/private flip doesn't move it between the
      // `public`/`private` chip counts — both are already scoped to
      // `NOT is_one_off` server-side, same as `all`.
      if (view.kind === 'all' && !updated.is_one_off) {
        setFilterCounts((c) =>
          updated.is_public ? { ...c, public: c.public + 1, private: c.private - 1 } : { ...c, public: c.public - 1, private: c.private + 1 },
        )
      }
      toast.show(updated.is_public ? 'Made public' : 'Made private')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    }
  }

  // SPEC-CLOUD.md §14: toggles the star from either a grid thumbnail or
  // the detail panel — both funnel through here so the two stay in sync.
  // In Favourites mode, un-favouriting a gif removes it from view entirely
  // (Favourites only ever shows gifs you've favourited), clearing the
  // selection if that was the open one; elsewhere it's an in-place update.
  async function toggleFavourite(id: string, isFavourited: boolean) {
    try {
      const updated = isFavourited ? await unfavouriteGif(id) : await favouriteGif(id)
      if (view.kind === 'favourites' && !updated.is_favourited) {
        setGifs((gs) => gs.filter((g) => g.id !== updated.id))
        if (selectedId === updated.id) setSelectedId(null)
      } else {
        setGifs((gs) => gs.map((g) => (g.id === updated.id ? { ...g, ...updated } : g)))
      }
      setCollectionsRefreshToken((t) => t + 1)
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    }
  }

  async function remove() {
    if (!selected) return
    if (!window.confirm(`Delete "${selected.name}"? This can't be undone.`)) return
    setDeleting(true)
    try {
      await deleteGif(selected.id)
      setGifs((gs) => gs.filter((g) => g.id !== selected.id))
      if (view.kind === 'all') {
        setTotal((t) => t - 1)
        const bucket = selected.is_one_off ? 'hidden' : selected.is_public ? 'public' : 'private'
        setFilterCounts((c) => ({ ...c, [bucket]: c[bucket] - 1, all: selected.is_one_off ? c.all : c.all - 1 }))
      }
      setSelectedId(null)
      toast.show('Deleted')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const title = view.kind === 'all' ? 'My GIFs' : view.kind === 'favourites' ? 'Favourites' : activeCollection?.name ?? 'Collection'

  return (
    <div className="page">
      <div className={`library-grid ${selected ? 'has-selection' : ''}`}>
        <LibrarySidebar
          view={view}
          collections={collections}
          allGifsCount={sidebarAllGifsCount}
          onCollectionsChanged={() => setCollectionsRefreshToken((t) => t + 1)}
        />
        <div className="library-header">
          <div className="archive-title-row">
            <div className="library-nav-dropdown-wrap" ref={navDropdownRef}>
              {/* Only interactive/visible as a dropdown at 1024-1199px
                  (CSS-gated) — the sidebar is hidden there, so the title
                  itself becomes the nav trigger. Harmless everywhere else:
                  the chevron is hidden and the dropdown panel never shows. */}
              <button
                type="button"
                className="archive-title-dropdown-trigger"
                aria-haspopup="menu"
                aria-expanded={navDropdownOpen}
                onClick={() => setNavDropdownOpen((o) => !o)}
              >
                <div className="archive-title-group">
                  <h1 className="page-title">{title}</h1>
                  <span className="archive-count">{displayCount === 1 ? '1 GIF' : `${displayCount} GIFs`}</span>
                </div>
                <ChevronDownIcon size={18} className="archive-title-dropdown-chevron" />
              </button>
              {view.kind === 'favourites' && (
                <p className="library-collection-subtitle">
                  Your starred GIFs · <LockIcon size={12} /> Built in
                </p>
              )}
              {view.kind === 'collection' && activeCollection && (
                <p className="library-collection-subtitle">Created {new Date(activeCollection.createdAt).toLocaleDateString()}</p>
              )}
              {navDropdownOpen && (
                <div className="library-nav-dropdown">
                  <LibrarySidebar
                    view={view}
                    collections={collections}
                    allGifsCount={sidebarAllGifsCount}
                    onCollectionsChanged={() => setCollectionsRefreshToken((t) => t + 1)}
                    onNavigate={() => setNavDropdownOpen(false)}
                  />
                </div>
              )}
            </div>
            {view.kind === 'collection' && activeCollection && (
              <div className="library-collection-menu" ref={collectionMenuRef}>
                <button
                  type="button"
                  className="library-collection-menu-btn"
                  aria-label="Collection options"
                  aria-expanded={collectionMenuOpen}
                  onClick={() => setCollectionMenuOpen((o) => !o)}
                >
                  <MoreIcon size={16} />
                </button>
                {collectionMenuOpen && (
                  <div className="library-collection-menu-dropdown" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setCollectionMenuOpen(false)
                        setRenamingCollection(true)
                      }}
                    >
                      <PencilIcon size={14} /> Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="library-collection-menu-danger"
                      onClick={() => {
                        setCollectionMenuOpen(false)
                        setDeletingCollection(true)
                      }}
                    >
                      <TrashIcon size={14} /> Delete collection
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {renamingCollection && activeCollection && (
            <RenameCollectionDialog
              initialName={activeCollection.name}
              onRename={renameActiveCollection}
              onClose={() => setRenamingCollection(false)}
            />
          )}
          {deletingCollection && activeCollection && (
            <DeleteCollectionDialog
              name={activeCollection.name}
              gifCount={activeCollection.gifCount}
              onDelete={deleteActiveCollection}
              onClose={() => setDeletingCollection(false)}
            />
          )}

          <div className="archive-toolbar">
            {view.kind !== 'favourites' && (
              <div className="archive-search-wrap">
                <SearchIcon size={16} className="archive-search-icon" />
                <input
                  className="archive-search"
                  placeholder={view.kind === 'collection' ? `Search in ${title}` : 'Search names and captions'}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search archive"
                />
              </div>
            )}
            {view.kind === 'all' ? (
              <div className="archive-chips" role="group" aria-label="Filter GIFs">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`archive-chip ${filter === f.id ? 'active' : ''}`}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="archive-chips" role="group" aria-label="Filter by owner">
                {(['all', 'mine', 'others'] as const).map((s) => (
                  <button key={s} type="button" className={`archive-chip ${scope === s ? 'active' : ''}`} onClick={() => setScope(s)}>
                    {s === 'all' ? 'All' : s === 'mine' ? 'Mine' : 'Borrowed'}
                  </button>
                ))}
              </div>
            )}
          </div>

          {loading && <p className="va-hint">Loading…</p>}
          {loadError && <p className="export-error">{loadError}</p>}
        </div>

        <div
            className="archive-grid"
            onClick={(e) => {
              // Only when the click landed on the grid itself, not a child
              // (tile, divider, favourite badge) that bubbled up — those
              // all have their own click handling.
              if (canEdit && selectedId && e.target === e.currentTarget) closeDetail()
            }}
          >
          {filteredGifs.map((g) => {
            return (
              <div key={g.id} className="archive-grid-item">
                {/* A plain `div` (not `button`) — SPEC-CLOUD.md §14 nests a
                    real `<button>` star inside for the favourite toggle,
                    and a button-inside-a-button is invalid HTML that gets
                    silently hoisted out by the parser, breaking layout. */}
                <div
                  ref={(el) => {
                    if (el) thumbRefs.current.set(g.id, el)
                    else thumbRefs.current.delete(g.id)
                  }}
                  className={`archive-thumb ${g.id === selectedId ? 'selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => (g.id === selectedId ? closeDetail() : setSelectedId(g.id))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      g.id === selectedId ? closeDetail() : setSelectedId(g.id)
                    }
                  }}
                  aria-label={g.name}
                >
                  <GifThumbnail gif={g} alt={g.name} disableAutoplay={!!user?.preferences.disableGifAutoplay} />
                  {!g.is_public && (
                    <span className="archive-badge-lock" title="Private">
                      <LockIcon size={14} />
                    </span>
                  )}
                  {/* SPEC.md §13/§8: marks a GIF hotlinked to a third-party
                      URL — media outside our controlled R2 that could vanish
                      if the source does. File-based imports don't get this;
                      they're fully re-hosted, same as native GIFs. */}
                  {g.external_url && (
                    <span className="archive-badge-external" title="Linked — hosted externally, not by StrewthGif">
                      <LinkIcon size={14} />
                    </span>
                  )}
                  <button
                    type="button"
                    className={`archive-favourite-badge ${g.is_favourited ? 'favourited' : ''}`}
                    aria-label="Favourite"
                    aria-pressed={g.is_favourited}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleFavourite(g.id, g.is_favourited)
                    }}
                  >
                    <StarIcon size={14} filled={g.is_favourited} />
                  </button>
                </div>
              </div>
            )
          })}
          {hasMore && <div ref={sentinelRef} className="archive-grid-sentinel" aria-hidden="true" />}
          {loadingMore && <p className="va-hint">Loading more…</p>}
          {!loading && view.kind === 'all' && gifs.length === 0 && <p className="va-hint">No GIFs yet.</p>}
          {!loading && view.kind === 'all' && gifs.length > 0 && filteredGifs.length === 0 && (
            <p className="va-hint">No GIFs match this filter.</p>
          )}
          {!loading && view.kind === 'favourites' && gifs.length === 0 && (
            <div className="archive-favourites-empty">
              <StarIcon size={32} />
              <h3>No favourites yet</h3>
              <p className="va-hint">Hit the star on any GIF in the Global Library to keep it here for later.</p>
              <Link className="btn btn-primary" to="/explore">
                Browse Global Library
              </Link>
            </div>
          )}
          {!loading && view.kind === 'collection' && gifs.length === 0 && (
            <div className="archive-favourites-empty">
              <GridIcon size={32} />
              <h3>Nothing in &lsquo;{title}&rsquo; yet</h3>
              <p className="va-hint">Open any GIF and use the collection button next to the star to add it here.</p>
              <Link className="btn btn-primary" to="/library">
                Browse my GIFs
              </Link>
            </div>
          )}
        </div>

        <div className="archive-panel">
          {!selected ? (
            <div className="archive-panel-empty">
              <p className="va-hint">Select a GIF to view details and actions.</p>
            </div>
          ) : (
            <>
              {/* Below the editor's own breakpoint (<1024px, same as
                  useCanEdit) the panel becomes a full-screen view — same
                  markup as the desktop side panel via CSS, plus this top
                  bar, which desktop doesn't need since the grid alongside
                  the panel is already a visible "back" affordance. */}
              {!canEdit && (
                <div className="archive-panel-mobile-topbar">
                  <button
                    type="button"
                    className="archive-panel-back"
                    aria-label="Back to library"
                    onClick={() => setSelectedId(null)}
                  >
                    <ArrowLeftIcon />
                  </button>
                  <span className="archive-panel-mobile-title">{selected.name}</span>
                </div>
              )}
              <div className="archive-panel-preview-wrap">
                {/* `key` forces a fresh <img> per selection, so the GIF's
                    animation restarts from frame one every time — no manual
                    play/pause bookkeeping needed. */}
                <img
                  key={selected.id}
                  className="archive-panel-preview"
                  src={selected.gif_url}
                  alt={`${selected.name} preview`}
                />
                {/* Desktop only — mobile's full-screen panel keeps its own
                    back arrow (`archive-panel-mobile-topbar` above) instead. */}
                {canEdit && (
                  <button
                    type="button"
                    className="archive-panel-close"
                    aria-label="Close details"
                    onClick={closeDetail}
                  >
                    <XIcon size={16} />
                  </button>
                )}
              </div>
              <div className="archive-panel-header">
                {isOwnGif ? (
                  <input
                    className="archive-panel-name"
                    aria-label="GIF name"
                    placeholder="Untitled GIF"
                    defaultValue={selected.name}
                    key={`name-${selected.id}`}
                    onBlur={(e) => rename(e.target.value)}
                  />
                ) : (
                  <p className="archive-panel-title-text">
                    {selected.name || <span className="archive-panel-untitled">Untitled GIF</span>}
                  </p>
                )}
                <span className={`archive-visibility-pill ${selected.is_public ? 'public' : 'private'}`}>
                  {selected.is_public ? 'Public' : 'Private'}
                </span>
              </div>
              {/* SPEC-CLOUD.md §14: only present in Favourites mode, and only
                  meaningful there — Favourites can hold other users' gifs. */}
              {selected.owner_handle && selected.owner_slug && (
                <Link className="archive-owner-link" to={profileUrl(selected.owner_slug)}>
                  by @{selected.owner_handle}
                </Link>
              )}
              {selected.caption_text && <p className="archive-panel-caption">{selected.caption_text}</p>}
              <p className="archive-panel-meta">
                <span>{new Date(selected.created_at).toLocaleString()}</span>
                <span className="archive-panel-meta-sep">·</span>
                <span>{selected.use_count === 1 ? '1 use' : `${selected.use_count} uses`}</span>
              </p>
              {selected.external_url && (
                <p className="va-hint archive-panel-external-note">
                  <LinkIcon size={14} /> Linked — hosted externally, not by StrewthGif
                </p>
              )}

              {canEdit && (
                <div className="archive-panel-primary-row">
                  <button className="btn btn-primary archive-copy-link-btn" onClick={copyLink}>
                    <LinkIcon /> Copy link
                  </button>
                  <button
                    type="button"
                    className={`archive-favourite-btn ${selected.is_favourited ? 'on' : ''}`}
                    aria-label="Favourite"
                    aria-pressed={selected.is_favourited}
                    onClick={() => toggleFavourite(selected.id, selected.is_favourited)}
                  >
                    <StarIcon filled={selected.is_favourited} />
                  </button>
                  <div className="collection-picker-anchor">
                    <button
                      type="button"
                      className="archive-favourite-btn"
                      aria-label="Save to collection"
                      aria-expanded={pickerOpen}
                      onClick={() => setPickerOpen((o) => !o)}
                    >
                      <BookmarkIcon size={16} />
                    </button>
                    {pickerOpen && (
                      <CollectionPicker
                        collections={collections}
                        memberIds={memberIds}
                        onToggle={toggleCollectionMembership}
                        onCreateAndAdd={createCollectionAndAdd}
                        onClose={() => setPickerOpen(false)}
                      />
                    )}
                  </div>
                </div>
              )}

              {memberIds.length > 0 && (
                <div className="library-in-collections">
                  <p className="library-in-collections-label">In collections</p>
                  <div className="library-in-collections-chips">
                    {collections
                      .filter((c) => memberIds.includes(c.id))
                      .map((c) => (
                        <Link
                          key={c.id}
                          className="library-collection-chip"
                          to={c.kind === 'favourites' ? '/library/favourites' : `/library/c/${c.id}`}
                        >
                          {c.kind === 'favourites' ? (
                            <StarIcon size={12} filled />
                          ) : (
                            <span className="library-sidebar-swatch collection-picker-swatch" style={{ background: swatchColor(c.id) }} />
                          )}
                          {c.name}
                        </Link>
                      ))}
                  </div>
                </div>
              )}

              {view.kind === 'collection' && (
                <button type="button" className="btn btn-secondary library-remove-from-collection" onClick={() => toggleCollectionMembership(view.id)}>
                  <XIcon size={12} /> Remove from &lsquo;{title}&rsquo;
                </button>
              )}

              <div className="archive-panel-secondary-row">
                {!canEdit && canShare && (
                  <button className="btn btn-secondary" onClick={copyLink}>
                    <LinkIcon /> Copy link
                  </button>
                )}
                <button className="btn btn-secondary" onClick={copyEmbed}>
                  <CodeIcon /> Embed
                </button>
                {selected.external_url ? (
                  <a className="btn btn-secondary" href={selected.external_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLinkIcon /> Open original
                  </a>
                ) : (
                  <a
                    className="btn btn-secondary"
                    href={selected.gif_url}
                    download={`${selected.name}.gif`}
                    onClick={() => recordUse(selected.id)}
                  >
                    <DownloadIcon /> Download
                  </a>
                )}
                {/* Public templates, pass 2: shown only when this gif has
                    template lineage to a template still accessible to the
                    viewer (public, or owned by them) — `template_remixable`
                    is computed server-side so it disappears cleanly the
                    moment the template is deleted or made private, rather
                    than a stale link that 404s on click. Replaces the old
                    own-video-only remix entirely; unrelated to `isOwnGif`
                    (a public template from someone else can be remixed from
                    their gif too). */}
                {canEdit && selected.template_id && selected.template_remixable && (
                  <Link className="btn btn-secondary" to={`/from-template/${selected.template_id}`} state={{ remixOfName: selected.name }}>
                    <PencilIcon size={14} /> Remix
                  </Link>
                )}
              </div>

              {/* Pinned bottom bar, below the editor breakpoint only —
                  Share if available, else Copy link. Desktop keeps the
                  single Copy-link button above instead. */}
              {!canEdit && (
                <div className="archive-mobile-action-bar">
                  {canShare ? (
                    <button className="btn btn-primary" onClick={share}>
                      <ShareIcon /> Share
                    </button>
                  ) : (
                    <button className="btn btn-primary" onClick={copyLink}>
                      <LinkIcon /> Copy link
                    </button>
                  )}
                  <button
                    type="button"
                    className={`archive-favourite-btn ${selected.is_favourited ? 'on' : ''}`}
                    aria-label="Favourite"
                    aria-pressed={selected.is_favourited}
                    onClick={() => toggleFavourite(selected.id, selected.is_favourited)}
                  >
                    <StarIcon filled={selected.is_favourited} />
                  </button>
                  <div className="collection-picker-anchor">
                    <button
                      type="button"
                      className="archive-favourite-btn"
                      aria-label="Save to collection"
                      aria-expanded={pickerOpen}
                      onClick={() => setPickerOpen((o) => !o)}
                    >
                      <BookmarkIcon size={16} />
                    </button>
                    {pickerOpen && (
                      <CollectionPicker
                        collections={collections}
                        memberIds={memberIds}
                        onToggle={toggleCollectionMembership}
                        onCreateAndAdd={createCollectionAndAdd}
                        onClose={() => setPickerOpen(false)}
                      />
                    )}
                  </div>
                </div>
              )}

              {isOwnGif && (
                <div className="archive-settings-list">
                  <div className="archive-settings-row">
                    <div>
                      <p className="archive-settings-title">Public</p>
                      <p className="archive-settings-help">Show in the Global Library</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={selected.is_public}
                      aria-label="Public"
                      className={`archive-switch ${selected.is_public ? 'on' : ''}`}
                      onClick={togglePublic}
                    >
                      <span className="archive-switch-knob" />
                    </button>
                  </div>
                  <div className="archive-settings-row">
                    <div>
                      <p className="archive-settings-title">Hide</p>
                      <p className="archive-settings-help">Hide from GIF list</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={selected.is_one_off}
                      aria-label="Hide"
                      className={`archive-switch ${selected.is_one_off ? 'on' : ''}`}
                      onClick={toggleOneOff}
                    >
                      <span className="archive-switch-knob" />
                    </button>
                  </div>
                </div>
              )}

              {isOwnGif && (
                <button className="btn btn-danger" onClick={remove} disabled={deleting}>
                  <TrashIcon /> {deleting ? 'Deleting…' : 'Delete GIF'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {toast.message && (
        <div className="archive-toast">
          <CheckIcon size={16} />
          <span>{toast.message}</span>
          {toast.action && (
            <button type="button" className="archive-toast-action" onClick={toast.action.onClick}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
