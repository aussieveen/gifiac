import { useEffect, useRef } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

const HOLD_DELAY_MS = 400
const REPEAT_MS = 70

/** Pointer handlers that fire `action` once on press, then repeatedly while
 * the press is held. The latest `action` is read through a ref so a held
 * button doesn't keep calling a stale closure as state changes under it. */
function useHoldRepeat(action: () => void) {
  const actionRef = useRef(action)
  useEffect(() => {
    actionRef.current = action
  })
  const delayRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const repeatRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  function stop() {
    clearTimeout(delayRef.current)
    clearInterval(repeatRef.current)
    delayRef.current = undefined
    repeatRef.current = undefined
  }
  useEffect(() => stop, [])

  return {
    onPointerDown(e: React.PointerEvent) {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      actionRef.current()
      stop()
      delayRef.current = setTimeout(() => {
        repeatRef.current = setInterval(() => actionRef.current(), REPEAT_MS)
      }, HOLD_DELAY_MS)
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onContextMenu(e: React.SyntheticEvent) {
      e.preventDefault()
    },
    onKeyDown(e: React.KeyboardEvent) {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault()
        actionRef.current()
      }
    },
  }
}

/**
 * `‹ 2.40s ›`: tap a chevron for one step, hold it to repeat. Used for the
 * playhead and for each caption edge. `label` prefixes the buttons' accessible
 * names ("Playhead back 0.01 seconds").
 */
export function MobileStepper({
  label,
  value,
  onStep,
}: {
  label: string
  value: string
  onStep: (direction: -1 | 1) => void
}) {
  const back = useHoldRepeat(() => onStep(-1))
  const forward = useHoldRepeat(() => onStep(1))

  return (
    <div className="m-stepper">
      <button type="button" className="m-stepper-btn" aria-label={`${label} back 0.01 seconds`} {...back}>
        <ChevronLeftIcon size={16} />
      </button>
      <span className="m-stepper-value">{value}</span>
      <button type="button" className="m-stepper-btn" aria-label={`${label} forward 0.01 seconds`} {...forward}>
        <ChevronRightIcon size={16} />
      </button>
    </div>
  )
}
