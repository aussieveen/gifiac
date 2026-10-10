import { useEffect } from 'react'
import type { RefObject } from 'react'

/** Fires `onLoadMore` when `sentinel` (an empty div at the end of a grid)
 * scrolls within 200px of the viewport — the shared "no Load More button,
 * ever" mechanism behind Archive.tsx's and Library.tsx's infinite scroll.
 * Callers gate `enabled` on their own `hasMore`/loading state so this
 * hook never has to know about either. */
export function useInfiniteScroll(sentinel: RefObject<Element | null>, enabled: boolean, onLoadMore: () => void) {
  useEffect(() => {
    const el = sentinel.current
    if (!el || !enabled) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore()
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [sentinel, enabled, onLoadMore])
}
