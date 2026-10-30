import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const SWIPE_CLOSE_PX = 80
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The mobile bottom sheet used by the template sheet, upload progress and
 * Make GIF. Dismiss with a swipe down on the handle, a tap on the backdrop,
 * or Escape; pass `dismissible={false}` for a sheet that only its own
 * buttons may close (the upload sheet). Focus moves into the sheet when it
 * opens (unless a child already took it) and returns to the trigger on close.
 */
export function BottomSheet({
  label,
  onClose,
  dismissible = true,
  maxHeight,
  children,
}: {
  label: string
  onClose: () => void
  dismissible?: boolean
  /** Overrides the default 90dvh cap, e.g. to follow the on-screen keyboard. */
  maxHeight?: number
  children: ReactNode
}) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragStartY = useRef<number | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const sheet = sheetRef.current
    if (sheet && !sheet.contains(document.activeElement)) sheet.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      trigger?.focus()
    }
  }, [])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation()
      onCloseRef.current()
      return
    }
    if (e.key !== 'Tab') return
    const sheet = sheetRef.current
    if (!sheet) return
    const items = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  function onHandlePointerDown(e: React.PointerEvent) {
    if (!dismissible) return
    dragStartY.current = e.clientY
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  function onHandlePointerMove(e: React.PointerEvent) {
    if (dragStartY.current === null) return
    setDragOffset(Math.max(0, e.clientY - dragStartY.current))
  }
  function onHandlePointerEnd(e: React.PointerEvent) {
    if (dragStartY.current === null) return
    const dy = e.clientY - dragStartY.current
    dragStartY.current = null
    setDragOffset(0)
    if (dy > SWIPE_CLOSE_PX) onCloseRef.current()
  }

  return createPortal(
    <>
      <div className="m-sheet-backdrop" data-testid="sheet-backdrop" onClick={dismissible ? onClose : undefined} />
      <div
        ref={sheetRef}
        className="m-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        style={{
          ...(maxHeight ? { maxHeight } : null),
          ...(dragOffset ? { transform: `translateY(${dragOffset}px)`, transition: 'none' } : null),
        }}
        onKeyDown={onKeyDown}
      >
        <div
          className="m-sheet-grab"
          data-testid="sheet-grab"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerEnd}
          onPointerCancel={onHandlePointerEnd}
        >
          <span className="m-sheet-handle" aria-hidden="true" />
        </div>
        <div className="m-sheet-body">{children}</div>
      </div>
    </>,
    document.body,
  )
}
