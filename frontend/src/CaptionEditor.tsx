import { useEffect, useRef, useState } from 'react'
import { createExport, subscribeExportProgress, videoFileUrl } from './api'
import { clamp, linesFromCharTops, spriteBackgroundStyle, timeToX, xToTime } from './timeline'
import type { Caption, FilmstripMeta, Gif, Video } from './types'
import { useWindowDrag } from './useWindowDrag'

/**
 * Reconstructs a caption's real visual line breaks — including ones the
 * browser inserted by auto-wrapping, which aren't present as literal '\n'
 * characters in `el`'s text — from its actual rendered layout, via the
 * Range API's per-character bounding rects. `el` must render exactly one
 * text node whose box matches the live preview caption's (see the hidden
 * measurement container this is called against): same width, font, and
 * padding, so the wrap points it finds are the ones the user is actually
 * seeing. Falls back to the raw text if there's no text node (e.g. empty
 * caption) since there's nothing to measure — same as in a test/jsdom
 * environment, which has no real layout engine and doesn't implement
 * `Range.getClientRects` at all (every character measures as
 * unmeasurable, so `linesFromCharTops` returns the text unchanged).
 */
function measureWrappedLines(el: HTMLElement): string {
  const textNode = el.firstChild
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return el.textContent ?? ''
  const text = textNode.textContent ?? ''
  const range = document.createRange()
  const lines = linesFromCharTops(text, (i) => {
    range.setStart(textNode, i)
    range.setEnd(textNode, i + 1)
    const rect = range.getClientRects?.()[0]
    return rect ? rect.top : null
  })
  return lines.join('\n')
}

// "Impact" (SPEC.md §4's example) is proprietary and often not installed
// (browser or libass, which burns in captions) — silent OS-level font
// substitution is unreliable across environments, so "Anton" (a free,
// visually similar bold display font — see backend font-provisioning
// notes) is offered as an explicit, real option and the default, while
// Impact stays selectable for anyone whose system does have it.
const FONTS = ['Anton, sans-serif', 'Impact, sans-serif', 'Georgia, serif', 'system-ui, sans-serif', "'Courier New', monospace"]
const MIN_CAPTION_DURATION = 0.25
const MIN_GIF_RANGE = 0.1
const DEFAULT_CAPTION_WIDTH = 0.6
const MIN_CAPTION_WIDTH = 0.05
const MAX_CAPTION_WIDTH = 1
// Matches the backend default (models.rs `default_line_height`) — ASS has
// no line-spacing control independent of font size, so the backend lays
// multi-line captions out line-by-line using this same multiplier. It only
// does that for *explicit* line breaks in `text` (backend/src/ass.rs splits
// on literal '\n'), not text the browser happens to auto-wrap because the
// box is too narrow — CSS line-height applies to auto-wrapped lines too, so
// a caption that only auto-wraps (no typed line break) can preview tighter
// than it actually exports. Typing Enter to force the break keeps the two
// in sync.
const DEFAULT_LINE_HEIGHT = 0.65
const MIN_LINE_HEIGHT = 0.3
const MAX_LINE_HEIGHT = 1.5
const BASE_TIMELINE_WIDTH = 700
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3]
const DEFAULT_ZOOM_INDEX = 2 // ZOOM_LEVELS[2] === 1
// The live preview box is sized from the film-strip's frame dimensions
// (see backend/src/scale.rs MAX_WIDTH) — the same scaled-down size the
// export pipeline burns captions into — so caption font-size/position in
// this preview matches the real export pixel-for-pixel, even though the
// preview itself plays the actual <video> (full source resolution,
// CSS-scaled to fit the box) rather than a cropped film-strip frame.
const PREVIEW_SCALE = 1

interface Props {
  video: Video
  filmstrip: FilmstripMeta
  onBack: () => void
  /** Called once an export finishes — lets the caller jump straight to
   * the new GIF (e.g. in the archive) instead of leaving the user to find
   * it themselves. */
  onGifCreated?: (gif: Gif) => void
}

/** Mirrors the backend's optional ASS outline: `null` renders no border. */
function outlineTextShadow(outlineColor: string | null): string {
  if (!outlineColor) return 'none'
  return `2px 2px 0 ${outlineColor}, -2px -2px 0 ${outlineColor}, 2px -2px 0 ${outlineColor}, -2px 2px 0 ${outlineColor}`
}

function newCaptionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `cap-${Math.random().toString(36).slice(2)}`
}

function defaultCaption(id: string, start: number, end: number): Caption {
  return {
    id,
    startTime: start,
    endTime: end,
    text: 'New caption',
    fontFamily: FONTS[0],
    fontSize: 28,
    color: '#ffffff',
    align: 'center',
    // "defaults to bottom-center on creation" — SPEC.md §4.
    x: 0.5,
    y: 0.88,
    width: DEFAULT_CAPTION_WIDTH,
    outlineColor: '#000000',
    lineHeight: DEFAULT_LINE_HEIGHT,
  }
}

type PillDragKind = 'move' | 'left' | 'right'
interface PillDrag {
  kind: PillDragKind
  id: string
  startX: number
  orig: Caption
}
interface RangeDrag {
  edge: 'start' | 'end'
  startX: number
  orig: number
}
interface PlayheadDrag {
  startX: number
  orig: number
}
interface PositionDrag {
  id: string
  startX: number
  startY: number
  origX: number
  origY: number
}
interface WidthDrag {
  id: string
  edge: 'left' | 'right'
  startX: number
  origWidth: number
}

export function CaptionEditor({ video, filmstrip, onBack, onGifCreated }: Props) {
  const duration = video.duration_seconds

  const [captions, setCaptions] = useState<Caption[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [gifRange, setGifRange] = useState({ start: 0, end: duration })
  const [applyToAll, setApplyToAll] = useState(false)
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportProgress, setExportProgress] = useState<{ stage: string; percent: number } | null>(null)
  const [completedGif, setCompletedGif] = useState<Gif | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  const previewRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const exportUnsubscribeRef = useRef<(() => void) | null>(null)
  // One hidden, off-screen element per caption — rendered with the exact
  // same box width/font as its live preview, purely so makeGif() can read
  // back its real auto-wrapped line breaks at export time (see
  // measureWrappedLines). Not `activeCaptions`: a caption outside the
  // current playhead has no visible preview element to measure, but still
  // needs measuring if it's included in the export.
  const measureRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // A component unmounting mid-export (e.g. "back to library" clicked
  // while exporting) must stop the SSE subscription instead of leaving it
  // calling back into torn-down state setters — same leak class fixed in
  // useWindowDrag.
  useEffect(() => () => exportUnsubscribeRef.current?.(), [])

  const timelineWidth = BASE_TIMELINE_WIDTH * ZOOM_LEVELS[zoomIndex]
  const selected = captions.find((c) => c.id === selectedId) ?? null

  function updateCaption(id: string, patch: Partial<Caption>) {
    setCaptions((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  function addCaption() {
    const id = newCaptionId()
    const start = clamp(currentTime, 0, Math.max(0, duration - MIN_CAPTION_DURATION))
    const end = clamp(start + 1, start + MIN_CAPTION_DURATION, duration)
    setCaptions((cs) => [...cs, defaultCaption(id, start, end)])
    setSelectedId(id)
  }

  function deleteCaption(id: string) {
    setCaptions((cs) => cs.filter((c) => c.id !== id))
    setSelectedId((current) => (current === id ? null : current))
  }

  function patchStyle(patch: Partial<Caption>) {
    if (!selected) return
    if (applyToAll) {
      setCaptions((cs) => cs.map((c) => ({ ...c, ...patch })))
    } else {
      updateCaption(selected.id, patch)
    }
  }

  const startPillWindowDrag = useWindowDrag<PillDrag>((e, drag) => {
    const deltaT = ((e.clientX - drag.startX) / timelineWidth) * duration
    if (drag.kind === 'move') {
      const dur = drag.orig.endTime - drag.orig.startTime
      const newStart = clamp(drag.orig.startTime + deltaT, 0, Math.max(0, duration - dur))
      updateCaption(drag.id, { startTime: newStart, endTime: newStart + dur })
    } else if (drag.kind === 'left') {
      const newStart = clamp(drag.orig.startTime + deltaT, 0, drag.orig.endTime - MIN_CAPTION_DURATION)
      updateCaption(drag.id, { startTime: newStart })
    } else {
      const newEnd = clamp(drag.orig.endTime + deltaT, drag.orig.startTime + MIN_CAPTION_DURATION, duration)
      updateCaption(drag.id, { endTime: newEnd })
    }
  })

  function startPillDrag(e: React.MouseEvent, id: string, kind: PillDragKind) {
    e.stopPropagation()
    const cap = captions.find((c) => c.id === id)
    if (!cap) return
    setSelectedId(id)
    startPillWindowDrag({ kind, id, startX: e.clientX, orig: cap })
  }

  const startRangeWindowDrag = useWindowDrag<RangeDrag>((e, drag) => {
    const deltaT = ((e.clientX - drag.startX) / timelineWidth) * duration
    const newVal = clamp(drag.orig + deltaT, 0, duration)
    setGifRange((r) =>
      drag.edge === 'start'
        ? { start: Math.min(newVal, r.end - MIN_GIF_RANGE), end: r.end }
        : { start: r.start, end: Math.max(newVal, r.start + MIN_GIF_RANGE) },
    )
  })

  function startRangeDrag(e: React.MouseEvent, edge: RangeDrag['edge']) {
    e.stopPropagation()
    startRangeWindowDrag({ edge, startX: e.clientX, orig: gifRange[edge] })
  }

  const startPlayheadWindowDrag = useWindowDrag<PlayheadDrag>((e, drag) => {
    const deltaT = ((e.clientX - drag.startX) / timelineWidth) * duration
    seekTo(clamp(drag.orig + deltaT, 0, duration))
  })

  function startPlayheadDrag(e: React.MouseEvent) {
    e.stopPropagation()
    videoRef.current?.pause()
    startPlayheadWindowDrag({ startX: e.clientX, orig: currentTime })
  }

  function setRangeStartToPlayhead() {
    setGifRange((r) => ({ start: Math.min(currentTime, r.end - MIN_GIF_RANGE), end: r.end }))
  }

  function setRangeEndToPlayhead() {
    setGifRange((r) => ({ start: r.start, end: Math.max(currentTime, r.start + MIN_GIF_RANGE) }))
  }

  function seekTo(time: number) {
    setCurrentTime(time)
    if (videoRef.current) videoRef.current.currentTime = time
  }

  function scrubTo(e: React.MouseEvent<HTMLDivElement>) {
    // Scrubbing implies "let me look at this exact frame" — pause first so
    // playback doesn't immediately carry the playhead away from it again.
    videoRef.current?.pause()
    const rect = e.currentTarget.getBoundingClientRect()
    seekTo(xToTime(e.clientX - rect.left, duration, timelineWidth))
  }

  function togglePlayback() {
    const video = videoRef.current
    if (!video) return
    // Driven off `isPlaying` (updated via onPlay/onPause) rather than
    // `video.paused` directly, so this stays correct even if something
    // else pauses the element without going through this state.
    if (isPlaying) {
      video.pause()
    } else {
      // Playback is confined to the GIF range (see handleVideoTimeUpdate) —
      // starting from outside it (or from its very end) would immediately
      // loop, which looks like nothing happened, so snap into range first.
      if (video.currentTime < gifRange.start || video.currentTime >= gifRange.end) {
        video.currentTime = gifRange.start
        setCurrentTime(gifRange.start)
      }
      video.play()
    }
  }

  // Confines playback to the GIF range: once the playhead reaches the
  // range's end, loop back to its start instead of continuing into
  // (or stopping at) footage outside the exported clip. Scrubbing/seeking
  // outside the range is still allowed — only *playback* is clamped, so
  // switching the range's edges can still be previewed by hand.
  function handleVideoTimeUpdate() {
    const video = videoRef.current
    if (!video) return
    if (isPlaying && video.currentTime >= gifRange.end) {
      video.currentTime = gifRange.start
      setCurrentTime(gifRange.start)
      return
    }
    setCurrentTime(video.currentTime)
  }

  // Covers the case where `gifRange.end` sits at (or past) the clip's real
  // duration: `timeupdate` may not catch the boundary before the browser's
  // own 'ended' event fires and pauses playback, which would otherwise stop
  // the loop instead of restarting it.
  function handleVideoEnded() {
    const video = videoRef.current
    if (!video) return
    video.currentTime = gifRange.start
    setCurrentTime(gifRange.start)
    video.play()
  }

  const startPositionWindowDrag = useWindowDrag<PositionDrag>((e, drag) => {
    const box = previewRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const deltaX = (e.clientX - drag.startX) / rect.width
    const deltaY = (e.clientY - drag.startY) / rect.height
    updateCaption(drag.id, {
      x: clamp(drag.origX + deltaX, 0, 1),
      y: clamp(drag.origY + deltaY, 0, 1),
    })
  })

  function startPositionDrag(e: React.MouseEvent, caption: Caption) {
    e.stopPropagation()
    setSelectedId(caption.id)
    startPositionWindowDrag({
      id: caption.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: caption.x,
      origY: caption.y,
    })
  }

  // Symmetric resize around the fixed center x — dragging either edge
  // changes only width, matching how the box is always centered on x
  // (translate(-50%, -50%)), so a delta on one edge moves the box's total
  // width by twice that delta.
  const startWidthWindowDrag = useWindowDrag<WidthDrag>((e, drag) => {
    const box = previewRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    if (rect.width === 0) return
    const deltaFraction = (e.clientX - drag.startX) / rect.width
    const sign = drag.edge === 'right' ? 1 : -1
    const newWidth = clamp(drag.origWidth + sign * deltaFraction * 2, MIN_CAPTION_WIDTH, MAX_CAPTION_WIDTH)
    updateCaption(drag.id, { width: newWidth })
  })

  function startWidthDrag(e: React.MouseEvent, caption: Caption, edge: WidthDrag['edge']) {
    e.stopPropagation()
    setSelectedId(caption.id)
    startWidthWindowDrag({ id: caption.id, edge, startX: e.clientX, origWidth: caption.width })
  }

  const activeCaptions = captions.filter((c) => currentTime >= c.startTime && currentTime <= c.endTime)
  const previewWidth = filmstrip.frameWidth * PREVIEW_SCALE
  const previewHeight = filmstrip.frameHeight * PREVIEW_SCALE

  // A fixed strip height, independent of zoom/frame count, so frames stay
  // clearly visible rather than shrinking (and letterboxing inside a
  // taller minimum-height container) once a longer clip's 0.25s sampling
  // makes each frame only a few pixels wide. Each frame's background tile
  // is scaled to *this* height (not its on-screen width) and cropped to
  // fill it — a "cover" crop instead of a fit — so there's never a gap
  // above/below a frame even though the sprite's own aspect ratio may not
  // match a single frame's narrow on-screen width.
  const FILMSTRIP_HEIGHT = 48
  // The sprite samples a frame every 0.25s, so a long clip has far more
  // frames than fit the timeline at a reasonable size — rendering all of
  // them at low zoom squeezed each one down to just a few px wide, an
  // unrecognizable sliver regardless of height (and a narrower box crops
  // more tightly out of each frame, compounding the problem). Instead,
  // show only as many as fit at a legible minimum width, evenly spaced
  // across the full sampled range — zooming in raises that count (up to
  // every sampled frame) the same way it already widens everything else
  // on the timeline. 40x48 keeps each frame closer to landscape than a
  // taller/narrower box would, so the crop isn't as severe.
  const MIN_FRAME_WIDTH = 40
  const visibleFrameCount = clamp(Math.floor(timelineWidth / MIN_FRAME_WIDTH), 1, filmstrip.frameCount)
  const frameIndices =
    visibleFrameCount === 1
      ? [0]
      : Array.from({ length: visibleFrameCount }, (_, i) =>
          Math.round((i * (filmstrip.frameCount - 1)) / (visibleFrameCount - 1)),
        )
  const filmstripFrameWidth = timelineWidth / visibleFrameCount
  const filmstripScale = FILMSTRIP_HEIGHT / filmstrip.frameHeight

  async function makeGif() {
    const trimmedName = name.trim()
    if (!trimmedName) return
    setSubmitting(true)
    setExportError(null)
    setCompletedGif(null)
    setExportProgress(null)
    try {
      // The backend can only space out lines it knows are separate (see
      // ass.rs's `line_height` doc comment) — it splits on literal '\n',
      // so an auto-wrapped caption (no typed line break, just a box too
      // narrow for the text) needs its real wrap points inserted here
      // first, or it burns in with libass's wider default spacing instead
      // of matching what was actually previewed.
      const captionsWithWrapping = captions.map((c) => {
        const el = measureRefs.current[c.id]
        return el ? { ...c, text: measureWrappedLines(el) } : c
      })
      const result = await createExport({
        video_id: video.id,
        name: trimmedName,
        captions: captionsWithWrapping,
        gif_range_start: Number(gifRange.start.toFixed(2)),
        gif_range_end: Number(gifRange.end.toFixed(2)),
      })
      exportUnsubscribeRef.current = subscribeExportProgress(result.export_id, {
        onProgress: (stage, percent) => setExportProgress({ stage, percent }),
        onComplete: (gif) => {
          setCompletedGif(gif)
          setExportProgress(null)
          setSubmitting(false)
          onGifCreated?.(gif)
        },
        onError: (message) => {
          setExportError(message)
          setExportProgress(null)
          setSubmitting(false)
        },
      })
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="page">
      <button className="back-link" onClick={onBack}>
        ← back to library
      </button>
      <h1>{video.original_filename}</h1>
      <p className="subtitle">
        {video.width}×{video.height} · {duration.toFixed(1)}s
      </p>

      <div className="va-top">
        <div className="preview-col">
        <div className="preview-frame" ref={previewRef} style={{ width: previewWidth, height: previewHeight }}>
          <video
            ref={videoRef}
            src={videoFileUrl(video.id)}
            className="preview-video"
            preload="auto"
            onTimeUpdate={handleVideoTimeUpdate}
            onEnded={handleVideoEnded}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          />
          {activeCaptions.map((c) => (
            <div
              key={c.id}
              className={`preview-caption ${selectedId === c.id ? 'selected' : ''}`}
              onMouseDown={(e) => startPositionDrag(e, c)}
              style={{
                left: `${c.x * 100}%`,
                top: `${c.y * 100}%`,
                width: `${c.width * 100}%`,
                fontFamily: c.fontFamily,
                fontSize: c.fontSize,
                lineHeight: c.lineHeight,
                color: c.color,
                textAlign: c.align,
                textShadow: outlineTextShadow(c.outlineColor),
              }}
            >
              {c.text}
              {selectedId === c.id && (
                <>
                  <div className="preview-caption-handle left" onMouseDown={(e) => startWidthDrag(e, c, 'left')} />
                  <div className="preview-caption-handle right" onMouseDown={(e) => startWidthDrag(e, c, 'right')} />
                </>
              )}
            </div>
          ))}
        </div>

        <div className="preview-controls">
          <button className="va-btn" onClick={togglePlayback}>
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
          <span className="va-hint">{currentTime.toFixed(2)}s</span>
        </div>

        {/* Off-screen twins of every caption's box, purely for
            measureWrappedLines to read real wrap points from at export
            time — see the measureRefs comment. Not `display: none`;
            layout (and therefore wrapping) only happens for elements the
            browser actually lays out. */}
        <div aria-hidden="true" style={{ position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }}>
          {captions.map((c) => (
            <div key={c.id} style={{ width: c.width * previewWidth }}>
              <div
                ref={(el) => {
                  measureRefs.current[c.id] = el
                }}
                className="preview-caption-measure"
                style={{
                  width: '100%',
                  fontFamily: c.fontFamily,
                  fontSize: c.fontSize,
                }}
              >
                {c.text}
              </div>
            </div>
          ))}
        </div>
        </div>

        <div className="va-style-panel">
          {selected ? (
            <>
              <textarea
                aria-label="Caption text"
                value={selected.text}
                onChange={(e) => patchStyle({ text: e.target.value })}
              />
              <div className="va-style-row">
                <select
                  aria-label="Font family"
                  value={selected.fontFamily}
                  onChange={(e) => patchStyle({ fontFamily: e.target.value })}
                >
                  {FONTS.map((f) => (
                    <option key={f} value={f}>
                      {f.split(',')[0]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Font size"
                  type="range"
                  min={12}
                  max={64}
                  value={selected.fontSize}
                  onChange={(e) => patchStyle({ fontSize: Number(e.target.value) })}
                />
                <span className="va-hint">{selected.fontSize}px</span>
              </div>
              <div className="va-style-row">
                <label className="va-hint" htmlFor="line-height-input">
                  Line height
                </label>
                <input
                  id="line-height-input"
                  aria-label="Line height"
                  type="range"
                  min={MIN_LINE_HEIGHT}
                  max={MAX_LINE_HEIGHT}
                  step={0.05}
                  value={selected.lineHeight}
                  onChange={(e) => patchStyle({ lineHeight: Number(e.target.value) })}
                />
                <span className="va-hint">{selected.lineHeight.toFixed(2)}×</span>
              </div>
              <div className="va-style-row">
                <input
                  aria-label="Caption color"
                  type="color"
                  value={selected.color}
                  onChange={(e) => patchStyle({ color: e.target.value })}
                />
                {(['left', 'center', 'right'] as const).map((a) => (
                  <button
                    key={a}
                    className={`va-align-btn ${selected.align === a ? 'active' : ''}`}
                    onClick={() => patchStyle({ align: a })}
                  >
                    {a}
                  </button>
                ))}
              </div>
              <div className="va-style-row">
                <label className="va-hint">
                  <input
                    type="checkbox"
                    checked={selected.outlineColor !== null}
                    onChange={(e) => patchStyle({ outlineColor: e.target.checked ? (selected.outlineColor ?? '#000000') : null })}
                  />{' '}
                  Outline
                </label>
                {selected.outlineColor !== null && (
                  <input
                    aria-label="Outline color"
                    type="color"
                    value={selected.outlineColor}
                    onChange={(e) => patchStyle({ outlineColor: e.target.value })}
                  />
                )}
              </div>
              <label className="va-hint">
                <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} /> All
                tracks
              </label>
            </>
          ) : (
            <span className="va-hint">Select a caption track to edit its style, or add one below.</span>
          )}
        </div>
      </div>

      <div className="va-timeline">
        <div className="va-timeline-scroll">
          <div className="va-timeline-tracks" style={{ width: timelineWidth + 40 }}>
          {captions.map((c) => (
            <div key={c.id} className="va-track-row" style={{ width: timelineWidth }}>
              <div
                className={`va-track-pill ${selectedId === c.id ? 'selected' : ''}`}
                style={{
                  left: timeToX(c.startTime, duration, timelineWidth),
                  width: Math.max(4, timeToX(c.endTime, duration, timelineWidth) - timeToX(c.startTime, duration, timelineWidth)),
                }}
                onMouseDown={(e) => startPillDrag(e, c.id, 'move')}
                onClick={() => setSelectedId(c.id)}
              >
                {c.text}
                <div className="va-track-handle left" onMouseDown={(e) => startPillDrag(e, c.id, 'left')} />
                <div className="va-track-handle right" onMouseDown={(e) => startPillDrag(e, c.id, 'right')} />
              </div>
              <button className="va-track-delete" aria-label={`Delete caption "${c.text}"`} onClick={() => deleteCaption(c.id)}>
                ✕
              </button>
            </div>
          ))}
          <button className="va-add-track" onClick={addCaption}>
            + add caption at playhead
          </button>

          <div className="va-filmstrip-wrap">
            <div
              className="va-filmstrip"
              style={{ width: timelineWidth, height: FILMSTRIP_HEIGHT }}
              onClick={scrubTo}
            >
              {frameIndices.map((frameIndex) => (
                <div
                  key={frameIndex}
                  className="va-frame"
                  style={{
                    width: filmstripFrameWidth,
                    height: FILMSTRIP_HEIGHT,
                    ...spriteBackgroundStyle(frameIndex, filmstrip, filmstrip.imageUrl, filmstripScale),
                  }}
                />
              ))}
              <div
                className="va-range-highlight"
                style={{
                  left: timeToX(gifRange.start, duration, timelineWidth),
                  width: timeToX(gifRange.end, duration, timelineWidth) - timeToX(gifRange.start, duration, timelineWidth),
                }}
              >
                <div className="va-range-handle" style={{ left: -5 }} onMouseDown={(e) => startRangeDrag(e, 'start')} />
                <div className="va-range-handle" style={{ right: -5 }} onMouseDown={(e) => startRangeDrag(e, 'end')} />
              </div>
              <div
                className="va-playhead"
                style={{ left: timeToX(currentTime, duration, timelineWidth) }}
                onMouseDown={startPlayheadDrag}
              >
                <div className="va-playhead-grip" />
              </div>
            </div>
          </div>
          </div>
        </div>

        <div className="va-controls">
            <button
              className="va-btn"
              disabled={zoomIndex === 0}
              onClick={() => setZoomIndex((z) => Math.max(0, z - 1))}
            >
              🔍−
            </button>
            <button
              className="va-btn"
              disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              onClick={() => setZoomIndex((z) => Math.min(ZOOM_LEVELS.length - 1, z + 1))}
            >
              🔍+
            </button>
            <span className="va-hint">
              GIF range: {gifRange.start.toFixed(2)}s – {gifRange.end.toFixed(2)}s ({(gifRange.end - gifRange.start).toFixed(2)}s)
            </span>
            <button className="va-btn" onClick={setRangeStartToPlayhead}>
              Set start
            </button>
            <button className="va-btn" onClick={setRangeEndToPlayhead}>
              Set end
            </button>
            <input
              className="va-name-input"
              placeholder="Name this GIF…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="GIF name"
            />
            <button className="va-make-gif" disabled={!name.trim() || submitting} onClick={makeGif}>
              {submitting ? 'Making…' : 'Make GIF'}
            </button>
        </div>
      </div>

      {exportProgress && (
        <p className="va-hint">
          {exportProgress.stage} — {exportProgress.percent}%
        </p>
      )}
      {exportError && <p className="export-error">{exportError}</p>}
      {completedGif && (
        <p className="export-success">
          "{completedGif.name}" is ready ({completedGif.width}×{completedGif.height}).
        </p>
      )}
    </div>
  )
}
