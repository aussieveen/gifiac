import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createExport, getTemplate, putTemplate, subscribeExportProgress, videoFileUrl } from './api'
import mark from './assets/brand/strewthgif-mark.svg'
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ArrowLeftIcon,
  MinusIcon,
  PauseIcon,
  PencilIcon,
  PlayheadIcon,
  PlayIcon,
  PlusIcon,
  XIcon,
} from './icons'
import { suggestNameFrom } from './suggestName'
import { centeredScrollLeft, clamp, linesFromCharTops, snapValue, spriteBackgroundStyle, timeToX, xToTime } from './timeline'
import type { Caption, FilmstripMeta, Gif, TemplatePayload, Video } from './types'
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
// SPEC.md §14: dragging a caption/range edge snaps into alignment with the
// playhead or another caption's/the range's edge once within this many
// on-screen pixels, converted to a time threshold at the current zoom.
const SNAP_PX = 8
// Bounds how fast a single wheel gesture can step through the zoom levels —
// a fast trackpad swipe fires many wheel events per gesture, and without
// this it would blow through several levels instead of feeling like one
// deliberate zoom step (SPEC.md §14).
const WHEEL_ZOOM_COOLDOWN_MS = 150
// SPEC.md §14: quick-select swatches shown alongside the native color
// pickers for caption text and outline color.
const SWATCH_COLORS = ['#fff35c', '#00ff99', '#00ccff', '#ff6666', '#9933ff', '#fcfcfc', '#000000']
// The live preview box is sized from the film-strip's frame dimensions
// (see backend/src/scale.rs MAX_WIDTH) — the same scaled-down size the
// export pipeline burns captions into — so caption font-size/position in
// this preview matches the real export pixel-for-pixel (once scaled back
// down by the current zoom — see the ZoomMode/scale logic below), even
// though the preview itself plays the actual <video> (full source
// resolution, CSS-scaled to fit the box) rather than a cropped film-strip
// frame.
type ZoomMode = '1x' | '2x' | 'fit'
// Below this output width, starting at 1x would make the preview too
// small to work with, so the default zoom is 'fit' instead (the largest
// whole-number scale — never a fraction, so pixels stay crisp — that fits
// the stage) rather than the usual 1x.
const TINY_OUTPUT_WIDTH = 320
// The inspector's own fixed width (.editor-inspector in index.css) and
// the preview stage's padding on each side — subtracted from the
// viewport to estimate how much room 'fit' actually has to work with.
const INSPECTOR_WIDTH = 400
const STAGE_PADDING = 32
// The transport row (play button + timecode + zoom control) has its own
// floor so it doesn't cramp at 1x on a small output, even though it
// otherwise matches the preview's width.
const MIN_TRANSPORT_WIDTH = 480

interface Props {
  video: Video
  filmstrip: FilmstripMeta
  onBack: () => void
  /** Called once an export finishes — lets the caller jump straight to
   * the new GIF (e.g. in the archive) instead of leaving the user to find
   * it themselves. */
  onGifCreated?: (gif: Gif) => void
  /** True once the window has shrunk below the editor's minimum width
   * while this instance stays mounted (see useCanEdit) — shows a slim
   * banner instead of losing in-progress edits. */
  belowBreakpoint?: boolean
}

/** Mirrors the backend's optional ASS outline: `null` renders no border. */
function outlineTextShadow(outlineColor: string | null, scale: number): string {
  if (!outlineColor) return 'none'
  const o = 2 * scale
  return `${o}px ${o}px 0 ${outlineColor}, -${o}px -${o}px 0 ${outlineColor}, ${o}px -${o}px 0 ${outlineColor}, -${o}px ${o}px 0 ${outlineColor}`
}

/** `0:05.18` — minutes:seconds.hundredths, design brief §6's transport
 * timecode format. */
function formatTimecode(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const minutes = Math.floor(clamped / 60)
  const rest = (clamped - minutes * 60).toFixed(2).padStart(5, '0')
  return `${minutes}:${rest}`
}

/** SPEC.md §14: quick-select swatches shown alongside a native color picker. */
function ColorSwatches({
  label,
  value,
  onSelect,
  disabled,
}: {
  label: string
  value: string
  onSelect: (color: string) => void
  disabled?: boolean
}) {
  return (
    <div className="va-swatches">
      {SWATCH_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={`va-swatch ${value.toLowerCase() === color.toLowerCase() ? 'active' : ''}`}
          style={{ backgroundColor: color }}
          aria-label={`${label} color ${color}`}
          onClick={() => onSelect(color)}
          disabled={disabled}
        />
      ))}
    </div>
  )
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
    color: '#fcfcfc',
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

export function CaptionEditor({ video, filmstrip, onBack, onGifCreated, belowBreakpoint }: Props) {
  const duration = video.duration_seconds
  // Matches the backend's scale.rs output size — computed server-side,
  // reflected here via the film-strip's own dimensions.
  const outputWidth = filmstrip.frameWidth
  const outputHeight = filmstrip.frameHeight
  const clipUrl = videoFileUrl(video.id)
  const [captions, setCaptions] = useState<Caption[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [gifRange, setGifRange] = useState({ start: 0, end: duration })
  const [applyToAll, setApplyToAll] = useState(false)
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportProgress, setExportProgress] = useState<{ stage: string; percent: number } | null>(null)
  const [completedGif, setCompletedGif] = useState<Gif | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  // SPEC.md §12: pre-fills from the video's saved template, if any —
  // `video.has_template` (from the video list) gives an immediate answer
  // for which export-form control to show (checkbox vs. button) without
  // waiting on the fetch below, which then corrects it if stale and
  // supplies the actual caption/range payload to pre-fill with.
  const [hasTemplate, setHasTemplate] = useState(video.has_template ?? false)
  const [createTemplate, setCreateTemplate] = useState(false)
  const [templateSaving, setTemplateSaving] = useState(false)
  const [templateSaved, setTemplateSaved] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  // SPEC.md §14: the on-screen x of the target a drag just snapped to, or
  // null when nothing's snapped — drives the vertical guide line.
  const [snapGuideX, setSnapGuideX] = useState<number | null>(null)
  // The preview's own zoom (1x/2x/Fit — not to be confused with
  // `zoomIndex` above, which zooms the *timeline*). Defaults to 'fit' for
  // a tiny output so it isn't rendered at an unusably small size; a
  // normal-sized output starts at a true 1x "actual size" preview.
  const [previewZoomMode, setPreviewZoomMode] = useState<ZoomMode>(() =>
    outputWidth < TINY_OUTPUT_WIDTH ? 'fit' : '1x',
  )
  // Tracks viewport width only to estimate how much room 'fit' has to
  // work with (see previewFitScale below) — not for any layout that
  // actually depends on exact reflow.
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerWidth,
  )
  useEffect(() => {
    function onResize() {
      setViewportWidth(window.innerWidth)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const previewRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const exportUnsubscribeRef = useRef<(() => void) | null>(null)
  const timelineScrollRef = useRef<HTMLDivElement | null>(null)
  const lastWheelZoomAtRef = useRef(0)
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

  // SPEC.md §12: "Opening a video that has a template loads the caption
  // editor with all template data pre-filled." The user can freely change
  // anything afterwards — this only sets the initial state. Keyed on the
  // video's own id rather than `video` itself, which is a fresh object
  // every render and would re-fire this on every render if used directly
  // as the dependency.
  const videoId = video.id
  useEffect(() => {
    let cancelled = false
    getTemplate(videoId)
      .then((template) => {
        if (cancelled) return
        setHasTemplate(template !== null)
        if (template) {
          setCaptions(template.captions)
          setGifRange({ start: template.gif_range_start, end: template.gif_range_end })
        }
      })
      .catch((err) => {
        if (!cancelled) setTemplateError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [videoId])

  // SPEC.md §14: hovering the timeline and scrolling vertically zooms
  // instead of scrolling the page — up zooms in, down zooms out — while a
  // horizontal trackpad swipe (deltaX, no deltaY) is left untouched so it
  // still pans the timeline natively. Bound as a real DOM listener (not
  // React's onWheel) with `passive: false`: React registers wheel handlers
  // as passive by default, which would silently ignore preventDefault and
  // let the page scroll anyway.
  useEffect(() => {
    const el = timelineScrollRef.current
    if (!el) return
    function handleWheel(e: WheelEvent) {
      if (e.deltaY === 0) return
      e.preventDefault()
      const now = Date.now()
      if (now - lastWheelZoomAtRef.current < WHEEL_ZOOM_COOLDOWN_MS) return
      lastWheelZoomAtRef.current = now
      if (e.deltaY < 0) {
        setZoomIndex((z) => Math.min(ZOOM_LEVELS.length - 1, z + 1))
      } else {
        setZoomIndex((z) => Math.max(0, z - 1))
      }
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // The timeline's 1x-zoom width used to be a flat BASE_TIMELINE_WIDTH
  // constant, which visibly under-filled the editor on any screen wider
  // than ~half that — measured against the scroll container instead, with
  // the constant kept only as a floor so nothing shrinks below the old
  // minimum on a narrower one.
  const [baseTimelineWidth, setBaseTimelineWidth] = useState(BASE_TIMELINE_WIDTH)
  useEffect(() => {
    const el = timelineScrollRef.current
    if (!el) return
    const measure = () => setBaseTimelineWidth(Math.max(el.clientWidth, BASE_TIMELINE_WIDTH))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const timelineWidth = baseTimelineWidth * ZOOM_LEVELS[zoomIndex]

  // SPEC.md §14: whenever the zoom level changes (buttons or wheel), keep
  // the playhead centered in view instead of leaving it — and its
  // add-caption button — scrolled out of sight. Deliberately fires only on
  // a zoomIndex change, not continuously as the playhead moves during
  // playback — so the values it reads (via this ref, synced every render
  // like useWindowDrag's onMoveRef) are current as of the render that
  // changed zoomIndex, without making them dependencies of the effect
  // itself.
  const centerOnZoomRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    centerOnZoomRef.current = () => {
      const el = timelineScrollRef.current
      if (!el) return
      const playheadX = timeToX(currentTime, duration, timelineWidth)
      el.scrollLeft = centeredScrollLeft(playheadX, el.clientWidth, timelineWidth)
    }
  })
  useEffect(() => {
    centerOnZoomRef.current()
  }, [zoomIndex])
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

  // SPEC.md §14: how close (in time) a dragged edge needs to land to a snap
  // target before it locks on — a fixed on-screen distance (SNAP_PX)
  // converted to time at the current zoom, so it feels the same regardless
  // of how zoomed in the timeline is.
  const snapThreshold = timelineWidth > 0 ? (SNAP_PX / timelineWidth) * duration : 0

  function captionSnapTargets(excludeId: string): number[] {
    return [
      currentTime,
      gifRange.start,
      gifRange.end,
      ...captions.filter((c) => c.id !== excludeId).flatMap((c) => [c.startTime, c.endTime]),
    ]
  }

  function rangeSnapTargets(): number[] {
    return [currentTime, ...captions.flatMap((c) => [c.startTime, c.endTime])]
  }

  function showSnapGuide(snappedTo: number | null) {
    setSnapGuideX(snappedTo === null ? null : timeToX(snappedTo, duration, timelineWidth))
  }

  // Shared shape for every single-edge drag (caption left/right handle, GIF
  // range handle): snap the raw dragged value against `targets`, then
  // re-clamp into [lo, hi] in case the snap target itself falls outside
  // what this particular edge is allowed to reach (e.g. snapping past the
  // opposite edge's minimum-duration bound).
  function snapAndClamp(raw: number, targets: number[], lo: number, hi: number) {
    const snap = snapValue(raw, targets, snapThreshold)
    return { value: clamp(snap.value, lo, hi), snappedTo: snap.snappedTo }
  }

  const startPillWindowDrag = useWindowDrag<PillDrag>(
    (e, drag) => {
      const deltaT = ((e.clientX - drag.startX) / timelineWidth) * duration
      const targets = captionSnapTargets(drag.id)
      if (drag.kind === 'move') {
        const dur = drag.orig.endTime - drag.orig.startTime
        const rawStart = clamp(drag.orig.startTime + deltaT, 0, Math.max(0, duration - dur))
        const startSnap = snapValue(rawStart, targets, snapThreshold)
        const endSnap = snapValue(rawStart + dur, targets, snapThreshold)
        const startDistance = startSnap.snappedTo === null ? Infinity : Math.abs(startSnap.value - rawStart)
        const endDistance = endSnap.snappedTo === null ? Infinity : Math.abs(endSnap.value - (rawStart + dur))
        let newStart = rawStart
        let snappedTo: number | null = null
        if (startDistance <= endDistance && startSnap.snappedTo !== null) {
          newStart = startSnap.value
          snappedTo = startSnap.snappedTo
        } else if (endSnap.snappedTo !== null) {
          newStart = endSnap.value - dur
          snappedTo = endSnap.snappedTo
        }
        newStart = clamp(newStart, 0, Math.max(0, duration - dur))
        updateCaption(drag.id, { startTime: newStart, endTime: newStart + dur })
        showSnapGuide(snappedTo)
      } else if (drag.kind === 'left') {
        const raw = clamp(drag.orig.startTime + deltaT, 0, drag.orig.endTime - MIN_CAPTION_DURATION)
        const { value, snappedTo } = snapAndClamp(raw, targets, 0, drag.orig.endTime - MIN_CAPTION_DURATION)
        updateCaption(drag.id, { startTime: value })
        showSnapGuide(snappedTo)
      } else {
        const raw = clamp(drag.orig.endTime + deltaT, drag.orig.startTime + MIN_CAPTION_DURATION, duration)
        const { value, snappedTo } = snapAndClamp(raw, targets, drag.orig.startTime + MIN_CAPTION_DURATION, duration)
        updateCaption(drag.id, { endTime: value })
        showSnapGuide(snappedTo)
      }
    },
    () => setSnapGuideX(null),
  )

  function startPillDrag(e: React.MouseEvent, id: string, kind: PillDragKind) {
    e.stopPropagation()
    const cap = captions.find((c) => c.id === id)
    if (!cap) return
    setSelectedId(id)
    startPillWindowDrag({ kind, id, startX: e.clientX, orig: cap })
  }

  const startRangeWindowDrag = useWindowDrag<RangeDrag>(
    (e, drag) => {
      const deltaT = ((e.clientX - drag.startX) / timelineWidth) * duration
      const raw = clamp(drag.orig + deltaT, 0, duration)
      const { value: newVal, snappedTo } = snapAndClamp(raw, rangeSnapTargets(), 0, duration)
      setGifRange((r) =>
        drag.edge === 'start'
          ? { start: Math.min(newVal, r.end - MIN_GIF_RANGE), end: r.end }
          : { start: r.start, end: Math.max(newVal, r.start + MIN_GIF_RANGE) },
      )
      showSnapGuide(snappedTo)
    },
    () => setSnapGuideX(null),
  )

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

  // SPEC.md §14: precise per-caption equivalent of Set start/end above.
  function setCaptionEdgeToPlayhead(id: string, edge: 'start' | 'end') {
    setCaptions((cs) =>
      cs.map((c) =>
        c.id !== id
          ? c
          : edge === 'start'
            ? { ...c, startTime: clamp(currentTime, 0, c.endTime - MIN_CAPTION_DURATION) }
            : { ...c, endTime: clamp(currentTime, c.startTime + MIN_CAPTION_DURATION, duration) },
      ),
    )
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

  // 'fit': the largest whole-number scale that still fits the stage —
  // never a fraction, so a pixel in the preview always maps to a whole
  // number of real output pixels. viewportWidth is only ever an estimate
  // of available room (see the state comment above), so this always
  // floors to at least 1x rather than ever going to 0 or negative.
  const previewFitScale = Math.max(
    1,
    Math.floor((viewportWidth - INSPECTOR_WIDTH - STAGE_PADDING * 2) / Math.max(1, outputWidth)),
  )
  const previewScale = previewZoomMode === '1x' ? 1 : previewZoomMode === '2x' ? 2 : previewFitScale
  const previewWidth = outputWidth * previewScale
  const previewHeight = outputHeight * previewScale
  const transportWidth = Math.max(previewWidth, MIN_TRANSPORT_WIDTH)

  // A fixed strip height, independent of zoom/frame count, so frames stay
  // clearly visible rather than shrinking (and letterboxing inside a
  // taller minimum-height container) once a longer clip's 0.25s sampling
  // makes each frame only a few pixels wide. Each frame's background tile
  // is scaled to *this* height (not its on-screen width) and cropped to
  // fill it — a "cover" crop instead of a fit — so there's never a gap
  // above/below a frame even though the sprite's own aspect ratio may not
  // match a single frame's narrow on-screen width.
  const FILMSTRIP_HEIGHT = 48
  // SPEC.md §14: vertical room below the strip for the playhead's
  // add-caption button. Given as real layout height (not just left to
  // absolute-position overflow) so .va-filmstrip-wrap's own box already
  // includes it — nothing needs to scroll or clip to show it.
  const PLAYHEAD_ADD_CLEARANCE = 26
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

  // SPEC.md §12: output dimensions are derived from the video the same
  // deterministic way the export pipeline does (backend/src/scale.rs) —
  // `outputWidth`/`outputHeight` are already computed from that exact
  // function server-side (see the PREVIEW_SCALE comment above), so this
  // needs no export to run first to know what they'd be. Shared by both
  // the standalone "Overwrite template" action and "Create template" on
  // export completion, which otherwise build the identical payload.
  function buildTemplatePayload(captionsForTemplate: Caption[]): TemplatePayload {
    return {
      captions: captionsForTemplate,
      gif_range_start: Number(gifRange.start.toFixed(2)),
      gif_range_end: Number(gifRange.end.toFixed(2)),
      width: outputWidth,
      height: outputHeight,
    }
  }

  // SPEC.md §12: "Overwriting is independent of exporting — the user can
  // update the template without triggering a new GIF export."
  async function overwriteTemplate() {
    setTemplateSaving(true)
    setTemplateError(null)
    setTemplateSaved(false)
    try {
      await putTemplate(video.id, buildTemplatePayload(captions))
      setHasTemplate(true)
      setTemplateSaved(true)
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : String(err))
    } finally {
      setTemplateSaving(false)
    }
  }

  async function makeGif() {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setNameError(true)
      nameInputRef.current?.focus()
      return
    }
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
        // SPEC.md §12: "Checking it saves the current export parameters
        // as the video's template when the GIF is exported." Sent as
        // part of the export request itself, not a separate follow-up
        // PUT after it completes — a video not saved as a template
        // doesn't survive past its own export (SPEC-CLOUD.md §6), so a
        // later call here would race that cleanup and 404.
        save_as_template: createTemplate,
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
          if (createTemplate) setHasTemplate(true)
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

  const trimmedDuration = gifRange.end - gifRange.start
  const suggestedName = captions.length > 0 ? suggestNameFrom(captions[0].text) : ''

  return (
    <div className="editor-shell">
      {belowBreakpoint && <div className="editor-shrink-banner">Widen the window to keep editing</div>}
      <header className="editor-header">
        <div className="editor-header-left">
          <button className="btn btn-secondary editor-back-btn" onClick={onBack} aria-label="Back to library">
            <ArrowLeftIcon />
          </button>
          <img src={mark} alt="StrewthGif" className="editor-brand" />
          <div className="editor-divider" />
          <div className="editor-title-block">
            <div className="editor-name-label-row">
              <label className="editor-name-label" htmlFor="editor-name-input">
                GIF name
              </label>
              {!name.trim() && <span className="editor-name-required-tag">Required</span>}
            </div>
            <div className="editor-name-input-wrap">
              <input
                id="editor-name-input"
                ref={nameInputRef}
                className={`editor-name-input ${nameError ? 'error' : ''}`}
                placeholder="Name your GIF"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (nameError) setNameError(false)
                }}
                aria-label="GIF name"
                aria-invalid={nameError || undefined}
                // Never pre-filled today (not even for Remix) — this always
                // autofocuses a freshly opened editor, which is the intent.
                autoFocus={!name}
              />
              <PencilIcon size={14} className="editor-name-input-icon" />
            </div>
            {nameError && (
              <p className="editor-name-error" role="alert">
                Give your GIF a name before making it
              </p>
            )}
            {!name.trim() && suggestedName && (
              <button type="button" className="editor-name-suggest" onClick={() => setName(suggestedName)}>
                Use "{suggestedName}"
              </button>
            )}
            <p className="editor-source-info">
              {video.original_filename} · {outputWidth}×{outputHeight} · {duration.toFixed(1)}s
            </p>
          </div>
        </div>
        <div className="editor-header-right">
          {/* SPEC.md §12: a video with no template gets a toggle that
              marks the *next* export as also saving a template; a video
              already working from one gets a standalone "Overwrite
              template" action instead, independent of exporting. */}
          {!hasTemplate ? (
            <button
              type="button"
              className="btn btn-secondary editor-template-btn"
              aria-pressed={createTemplate}
              onClick={() => setCreateTemplate((v) => !v)}
            >
              Save as template
            </button>
          ) : (
            <button className="btn btn-secondary" onClick={overwriteTemplate} disabled={templateSaving}>
              {templateSaving ? 'Saving…' : 'Overwrite template'}
            </button>
          )}
          <button
            className="btn btn-primary"
            aria-label="Make GIF"
            title={!name.trim() ? 'Name your GIF first' : undefined}
            disabled={submitting}
            onClick={makeGif}
          >
            {submitting ? (
              'Making…'
            ) : (
              <>
                Make GIF
                <span className="editor-make-gif-duration">{trimmedDuration.toFixed(1)}s</span>
              </>
            )}
          </button>
        </div>
      </header>

      {exportProgress && (
        <div className="editor-toast">
          {exportProgress.stage} — {exportProgress.percent}%
        </div>
      )}
      {exportError && <div className="editor-toast editor-toast-error">{exportError}</div>}
      {templateError && <div className="editor-toast editor-toast-error">{templateError}</div>}
      {templateSaved && <div className="editor-toast">Template saved.</div>}
      {completedGif && (
        <div className="editor-toast">
          "{completedGif.name}" is ready ({completedGif.width}×{completedGif.height}).
        </div>
      )}

      <div className="editor-main">
        <div className="editor-preview-stage">
          <div className="preview-frame" ref={previewRef} style={{ width: previewWidth, height: previewHeight }}>
            <video
              ref={videoRef}
              src={clipUrl}
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
                  // c.fontSize is in *output* pixels (what the backend
                  // actually burns in) — scaled up here by the preview's
                  // current zoom so it reads correctly on screen at 1x,
                  // 2x, or Fit alike.
                  fontSize: c.fontSize * previewScale,
                  lineHeight: c.lineHeight,
                  color: c.color,
                  textAlign: c.align,
                  textShadow: outlineTextShadow(c.outlineColor, previewScale),
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

          <div className="editor-transport" style={{ width: transportWidth }}>
            <button
              className="editor-play-btn"
              onClick={togglePlayback}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
            <span className="editor-timecode">
              <span className="editor-timecode-current">{formatTimecode(currentTime)}</span>
              <span className="editor-timecode-total"> / {formatTimecode(duration)}</span>
            </span>
            <div className="editor-preview-zoom">
              <div className="editor-segmented" role="group" aria-label="Preview zoom">
                <button
                  type="button"
                  className={`editor-segmented-btn ${previewZoomMode === '1x' ? 'active' : ''}`}
                  onClick={() => setPreviewZoomMode('1x')}
                >
                  1×
                </button>
                <button
                  type="button"
                  className={`editor-segmented-btn ${previewZoomMode === '2x' ? 'active' : ''}`}
                  onClick={() => setPreviewZoomMode('2x')}
                >
                  2×
                </button>
                <button
                  type="button"
                  className={`editor-segmented-btn ${previewZoomMode === 'fit' ? 'active' : ''}`}
                  onClick={() => setPreviewZoomMode('fit')}
                >
                  Fit
                </button>
              </div>
              {previewScale === 1 && <span className="field-label editor-preview-zoom-hint">Actual size</span>}
            </div>
          </div>

          {/* Off-screen twins of every caption's box, purely for
              measureWrappedLines to read real wrap points from at export
              time — see the measureRefs comment. Not `display: none`;
              layout (and therefore wrapping) only happens for elements the
              browser actually lays out. Sized from the real output width,
              not `previewWidth` — this has to measure the same wrap
              points the backend will actually burn in regardless of
              whatever zoom the preview happens to be showing. */}
          <div aria-hidden="true" style={{ position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }}>
            {captions.map((c) => (
              <div key={c.id} style={{ width: c.width * outputWidth }}>
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

        <aside className="editor-inspector">
          <div className="editor-inspector-section">
            <div className="editor-inspector-section-header">
              <span className="section-label">Captions</span>
              <button
                type="button"
                className="btn btn-secondary editor-icon-btn-sm"
                aria-label="Add caption"
                onClick={addCaption}
              >
                <PlusIcon size={14} />
              </button>
            </div>
            {selected && (
              <>
                <textarea
                  className="editor-caption-textarea"
                  aria-label="Caption text"
                  value={selected.text}
                  onChange={(e) => patchStyle({ text: e.target.value })}
                />
                <div className="editor-caption-io-row">
                  <div className="editor-caption-io">
                    <span className="field-label">Caption in</span>
                    <button
                      type="button"
                      className="editor-io-btn"
                      aria-label="Set start to playhead"
                      onClick={() => setCaptionEdgeToPlayhead(selected.id, 'start')}
                    >
                      <PlayheadIcon />
                      {selected.startTime.toFixed(2)}s
                    </button>
                  </div>
                  <div className="editor-caption-io">
                    <span className="field-label">Caption out</span>
                    <button
                      type="button"
                      className="editor-io-btn"
                      aria-label="Set end to playhead"
                      onClick={() => setCaptionEdgeToPlayhead(selected.id, 'end')}
                    >
                      <PlayheadIcon />
                      {selected.endTime.toFixed(2)}s
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="editor-inspector-section">
            <span className="section-label">Style</span>
            {selected ? (
              <>
                <div className="editor-style-row">
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
                  <label className="field-label" htmlFor="font-size-input">
                    Size
                  </label>
                  <input
                    id="font-size-input"
                    type="range"
                    min={12}
                    max={64}
                    value={selected.fontSize}
                    onChange={(e) => patchStyle({ fontSize: Number(e.target.value) })}
                  />
                  <span className="editor-field-value">{selected.fontSize}px</span>
                </div>

                <div className="editor-field-row">
                  <label className="field-label" htmlFor="line-height-input">
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
                  <span className="editor-field-value">{selected.lineHeight.toFixed(2)}×</span>
                </div>

                <div className="editor-field-row">
                  <span className="field-label">Text colour</span>
                  <input
                    aria-label="Caption color"
                    type="color"
                    value={selected.color}
                    onChange={(e) => patchStyle({ color: e.target.value })}
                  />
                </div>
                <ColorSwatches label="Text" value={selected.color} onSelect={(color) => patchStyle({ color })} />

                <div className="editor-field-row">
                  <label className="field-label" htmlFor="outline-switch">
                    Outline
                  </label>
                  <button
                    id="outline-switch"
                    type="button"
                    role="switch"
                    aria-checked={selected.outlineColor !== null}
                    aria-label="Outline"
                    className={`archive-switch ${selected.outlineColor !== null ? 'on' : ''}`}
                    onClick={() =>
                      patchStyle({ outlineColor: selected.outlineColor !== null ? null : (selected.outlineColor ?? '#000000') })
                    }
                  >
                    <span className="archive-switch-knob" />
                  </button>
                </div>
                {selected.outlineColor !== null && (
                  <>
                    <div className="editor-field-row">
                      <span className="field-label">Outline colour</span>
                      <input
                        aria-label="Outline color"
                        type="color"
                        value={selected.outlineColor}
                        onChange={(e) => patchStyle({ outlineColor: e.target.value })}
                      />
                    </div>
                    <ColorSwatches
                      label="Outline"
                      value={selected.outlineColor}
                      onSelect={(color) => patchStyle({ outlineColor: color })}
                    />
                  </>
                )}

                <div className="editor-field-row">
                  <span className="field-label">Alignment</span>
                  <div className="editor-segmented" role="group" aria-label="Alignment">
                    {(
                      [
                        ['left', AlignLeftIcon],
                        ['center', AlignCenterIcon],
                        ['right', AlignRightIcon],
                      ] as const
                    ).map(([a, Icon]) => (
                      <button
                        key={a}
                        type="button"
                        className={`editor-segmented-btn ${selected.align === a ? 'active' : ''}`}
                        aria-label={`Align ${a}`}
                        onClick={() => patchStyle({ align: a })}
                      >
                        <Icon size={15} />
                      </button>
                    ))}
                  </div>
                </div>

                <label className="editor-apply-all">
                  <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
                  Apply this style to every caption
                </label>
              </>
            ) : (
              <div className="editor-inspector-empty">
                <p className="va-hint">Select a caption on the timeline, or add one.</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      <div className="va-timeline">
        <div className="editor-timeline-toolbar">
          <span className="section-label">Timeline</span>
          <div className="editor-trim-pill">
            <span className="editor-trim-swatch" />
            Trim {gifRange.start.toFixed(2)}s → {gifRange.end.toFixed(2)}s · {trimmedDuration.toFixed(2)}s
          </div>
          <button className="btn btn-secondary" onClick={setRangeStartToPlayhead}>
            Trim start
          </button>
          <button className="btn btn-secondary" onClick={setRangeEndToPlayhead}>
            Trim end
          </button>
          <div className="editor-zoom-controls">
            <button
              type="button"
              className="editor-zoom-btn"
              aria-label="Zoom out"
              disabled={zoomIndex === 0}
              onClick={() => setZoomIndex((z) => Math.max(0, z - 1))}
            >
              <MinusIcon size={14} />
            </button>
            <button
              type="button"
              className="editor-zoom-btn"
              aria-label="Zoom in"
              disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              onClick={() => setZoomIndex((z) => Math.min(ZOOM_LEVELS.length - 1, z + 1))}
            >
              <PlusIcon size={14} />
            </button>
          </div>
        </div>

        <div className="va-timeline-scroll" ref={timelineScrollRef}>
          <div className="va-timeline-tracks" style={{ width: timelineWidth + 40 }}>
            {snapGuideX !== null && <div className="va-snap-guide" style={{ left: snapGuideX }} />}
            {captions.map((c) => (
              <div key={c.id} className="va-track-row" style={{ width: timelineWidth }}>
                <div
                  className={`va-track-pill ${selectedId === c.id ? 'selected' : ''}`}
                  style={{
                    left: timeToX(c.startTime, duration, timelineWidth),
                    width: Math.max(
                      4,
                      timeToX(c.endTime, duration, timelineWidth) - timeToX(c.startTime, duration, timelineWidth),
                    ),
                  }}
                  onMouseDown={(e) => startPillDrag(e, c.id, 'move')}
                  onClick={() => setSelectedId(c.id)}
                >
                  {c.text}
                  <div className="va-track-handle left" onMouseDown={(e) => startPillDrag(e, c.id, 'left')} />
                  <div className="va-track-handle right" onMouseDown={(e) => startPillDrag(e, c.id, 'right')} />
                </div>
                <button
                  className="va-track-delete"
                  aria-label={`Delete caption "${c.text}"`}
                  onClick={() => deleteCaption(c.id)}
                >
                  <XIcon size={11} />
                </button>
              </div>
            ))}

            <div className="va-filmstrip-wrap" style={{ height: FILMSTRIP_HEIGHT + PLAYHEAD_ADD_CLEARANCE }}>
              <div className="va-filmstrip" style={{ width: timelineWidth, height: FILMSTRIP_HEIGHT }} onClick={scrubTo}>
                {filmstrip &&
                  frameIndices.map((frameIndex) => (
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
                <div className="va-range-dim" style={{ left: 0, width: timeToX(gifRange.start, duration, timelineWidth) }} />
                <div
                  className="va-range-dim"
                  style={{
                    left: timeToX(gifRange.end, duration, timelineWidth),
                    width: timelineWidth - timeToX(gifRange.end, duration, timelineWidth),
                  }}
                />
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
              {/* SPEC.md §14: rendered as a sibling of .va-filmstrip (which
                  clips overflow) rather than nested inside it, so it's never
                  clipped — always visible and following the playhead,
                  including once you've scrolled/zoomed to find a spot. */}
              <button
                type="button"
                className="va-playhead-add"
                style={{ left: timeToX(currentTime, duration, timelineWidth), top: FILMSTRIP_HEIGHT + 4 }}
                aria-label="Add caption at playhead"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={addCaption}
              >
                +
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
