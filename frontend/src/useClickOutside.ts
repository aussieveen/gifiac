import { useEffect, type RefObject } from 'react'

/** Calls `onOutside` on any pointerdown outside `ref`'s element, only
 * while `active` — the "close this dropdown when you click away from it"
 * behavior shared by every menu/popover the redesign added (the header's
 * account menu, My Library's import menu, ...). */
export function useClickOutside(ref: RefObject<HTMLElement | null>, active: boolean, onOutside: () => void) {
  useEffect(() => {
    if (!active) return
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [active, ref, onOutside])
}
