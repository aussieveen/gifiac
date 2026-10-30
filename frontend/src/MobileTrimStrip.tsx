import { useEffect, useRef, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, LockIcon } from './icons'
import { clamp, spriteBackgroundStyle, xToTime } from './timeline'
import type { Caption, FilmstripMeta } from './types'
import { MIN_GIF_RANGE } from './useCaptionEditor'

const MIN_FRAME_WIDTH = 40
const NUDGE_SECONDS = 0.1

type Drag = 'start' | 'end' | 'scrub' | null

interface Props {
  duration: number
  filmstrip: FilmstripMeta
  gifRange: { start: number; end: number }
  setGifRange: (update: (r: { start: number; end: number }) => { start: number; end: number }) => void
  currentTime: number
  seekTo: (time: number) => void
  pauseVideo: () => void
  /** Captions in time order; the badge number is the position in this list. */
  captions: Caption[]
  selectedId: string | null
  /** Template-sourced clips come pre-trimmed: no handles, no dimming. */
  locked: boolean
}

/**
 * The phone trim strip (MOBILE.md §6): a filmstrip of the whole clip with
 * blue trim handles, numbered caption-start markers and a white playhead.
 * Tap or drag on the strip to move the playhead; drag the handles to trim.
 */
export function MobileTrimStrip(props: Props) {
  const { duration, filmstrip, gifRange, setGifRange, currentTime, seekTo, pauseVideo, captions, selectedId, locked } =
    props
  const stripRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  function timeAt(clientX: number): number {
    const rect = stripRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return xToTime(clientX - rect.left, duration, rect.width)
  }

  function trimTo(edge: 'start' | 'end', time: number) {
    setGifRange((r) =>
      edge === 'start'
        ? { start: clamp(time, 0, r.end - MIN_GIF_RANGE), end: r.end }
        : { start: r.start, end: clamp(time, r.start + MIN_GIF_RANGE, duration) },
    )
  }

  function onStripPointerDown(e: React.PointerEvent) {
    pauseVideo()
    dragRef.current = 'scrub'
    e.currentTarget.setPointerCapture?.(e.pointerId)
    seekTo(timeAt(e.clientX))
  }
  function onStripPointerMove(e: React.PointerEvent) {
    if (dragRef.current === 'scrub') seekTo(timeAt(e.clientX))
  }
  function onPointerEnd() {
    dragRef.current = null
  }

  function handlePointerDown(edge: 'start' | 'end') {
    return (e: React.PointerEvent) => {
      e.stopPropagation()
      pauseVideo()
      dragRef.current = edge
      e.currentTarget.setPointerCapture?.(e.pointerId)
    }
  }
  function handlePointerMove(edge: 'start' | 'end') {
    return (e: React.PointerEvent) => {
      if (dragRef.current === edge) trimTo(edge, timeAt(e.clientX))
    }
  }
  function handleKeyDown(edge: 'start' | 'end') {
    return (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const delta = e.key === 'ArrowLeft' ? -NUDGE_SECONDS : NUDGE_SECONDS
      trimTo(edge, gifRange[edge] + delta)
    }
  }

  const pct = (time: number) => `${(duration > 0 ? (time / duration) * 100 : 0).toFixed(3)}%`
  const frameCount = clamp(Math.floor((width || 358) / MIN_FRAME_WIDTH), 1, filmstrip.frameCount)
  const frameIndices =
    frameCount === 1
      ? [0]
      : Array.from({ length: frameCount }, (_, i) => Math.round((i * (filmstrip.frameCount - 1)) / (frameCount - 1)))
  const frameWidth = (width || 358) / frameCount
  const scale = 52 / filmstrip.frameHeight

  return (
    <div className="m-strip">
      <p className="m-strip-hint">
        {locked
          ? 'Trim comes from the template · tap the strip to move the playhead'
          : 'Drag ends to trim · tap the strip to move the playhead'}
      </p>
      <div
        ref={stripRef}
        className="m-strip-track"
        data-testid="trim-strip"
        onPointerDown={onStripPointerDown}
        onPointerMove={onStripPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div className="m-strip-frames" aria-hidden="true">
          {frameIndices.map((frameIndex, i) => (
            <div
              key={i}
              style={{
                width: frameWidth,
                height: 52,
                ...spriteBackgroundStyle(frameIndex, filmstrip, filmstrip.imageUrl, scale),
              }}
            />
          ))}
        </div>

        {!locked && (
          <>
            <div className="m-strip-dim" style={{ left: 0, width: pct(gifRange.start) }} />
            <div className="m-strip-dim" style={{ right: 0, width: pct(duration - gifRange.end) }} />
            <div className="m-strip-range" style={{ left: pct(gifRange.start), right: pct(duration - gifRange.end) }} />
            <button
              type="button"
              className="m-strip-handle start"
              aria-label="Trim start"
              style={{ left: pct(gifRange.start) }}
              onPointerDown={handlePointerDown('start')}
              onPointerMove={handlePointerMove('start')}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onKeyDown={handleKeyDown('start')}
            >
              <ChevronLeftIcon size={16} />
            </button>
            <button
              type="button"
              className="m-strip-handle end"
              aria-label="Trim end"
              style={{ left: pct(gifRange.end) }}
              onPointerDown={handlePointerDown('end')}
              onPointerMove={handlePointerMove('end')}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onKeyDown={handleKeyDown('end')}
            >
              <ChevronRightIcon size={16} />
            </button>
          </>
        )}

        {captions.map((c, i) => (
          <span key={c.id} className={`m-strip-marker ${c.id === selectedId ? 'selected' : ''}`} style={{ left: pct(c.startTime) }}>
            <span className="m-strip-marker-badge">{i + 1}</span>
          </span>
        ))}

        <span className="m-strip-playhead" data-testid="strip-playhead" style={{ left: pct(currentTime) }} />

        {locked && (
          <span className="m-strip-locked">
            <LockIcon size={12} /> Trim locked
          </span>
        )}
      </div>
    </div>
  )
}
