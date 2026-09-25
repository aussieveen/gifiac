import { useEffect, useState } from 'react'

/** Below this width the GIF editor (trim, timeline, caption dragging) is
 * unavailable — it's a mouse-and-large-screen tool, and squeezing it onto a
 * phone would just make it worse, not usable. Width is the test, not
 * user-agent sniffing, so an iPad in landscape with a mouse is fine. */
export const EDITOR_MIN_WIDTH = 1024

function getCanEdit(): boolean {
  return window.matchMedia(`(min-width: ${EDITOR_MIN_WIDTH}px)`).matches
}

export function useCanEdit(): boolean {
  const [canEdit, setCanEdit] = useState(getCanEdit)

  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${EDITOR_MIN_WIDTH}px)`)
    const handleChange = () => setCanEdit(mql.matches)
    handleChange()
    mql.addEventListener('change', handleChange)
    return () => mql.removeEventListener('change', handleChange)
  }, [])

  return canEdit
}
