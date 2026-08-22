import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * Shared plumbing for a "mousedown here, drag anywhere in the window"
 * interaction (moving/resizing a caption pill, dragging a GIF range handle,
 * repositioning a caption on the live preview). Binds its window listeners
 * once on mount and always cleans them up on unmount — a component that
 * bound `window.addEventListener('mousemove', ...)` imperatively from a
 * mousedown handler and unmounted mid-drag (e.g. navigating away) would
 * otherwise leak a listener still calling back into stale state setters.
 */
export function useWindowDrag<T>(onMove: (e: MouseEvent, origin: T) => void): (origin: T) => void {
  const dragRef = useRef<T | null>(null)
  const onMoveRef = useRef(onMove)

  // Refs shouldn't be written during render (React may retry/discard a
  // render pass); syncing in a layout effect keeps onMoveRef current
  // before the browser paints, with no stale-closure window for a
  // synchronous mousemove in between.
  useLayoutEffect(() => {
    onMoveRef.current = onMove
  })

  useEffect(() => {
    function handleMove(e: MouseEvent) {
      if (dragRef.current !== null) onMoveRef.current(e, dragRef.current)
    }
    function handleUp() {
      dragRef.current = null
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  return (origin: T) => {
    dragRef.current = origin
  }
}
