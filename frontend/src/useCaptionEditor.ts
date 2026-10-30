import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createExport, createTemplateExport, getTemplate, subscribeExportProgress, templateClipUrl, videoFileUrl } from './api'
import { type ExportProgressState } from './ExportProgressModal'
import { centeredScrollLeft, clamp, linesFromCharTops, snapValue, timeToX, xToTime } from './timeline'
import type { Caption, FilmstripMeta, Gif, TemplateDetail, Video } from './types'
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
const INITIAL_EXPORT_PROGRESS: ExportProgressState = {
  gif: { status: 'pending', percent: 0 },
  mp4: { status: 'pending', percent: 0 },
  webm: { status: 'pending', percent: 0 },
}

export const FONTS = ['Anton, sans-serif', 'Impact, sans-serif', 'Georgia, serif', 'system-ui, sans-serif', "'Courier New', monospace"]
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
const DEFAULT_LINE_HEIGHT = 1.1
const BASE_TIMELINE_WIDTH = 700
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3]
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

/**
 * What the editor is sourcing its clip from — flow A (editing an
 * uploaded video directly: adjustable trim range, can save/overwrite a
 * template) or flow B ("start from a template," own or someone else's
 * public one: trim range and output dimensions always locked, no
 * save/overwrite option at all, not even for the template's own
 * creator). One component handles both since the timeline/drag/style
 * inspector logic is identical either way — only the trim-range editing
 * UI, media source, and the export call at the bottom differ.
 */
export type EditorSource =
  | { kind: 'video'; video: Video }
  | {
      kind: 'template'
      template: TemplateDetail
      /** Set only when this template was reached via a GIF's "Remix this
       * GIF" button (as opposed to picking it from the New GIF page) —
       * the originating GIF's own name, threaded through so the header
       * can read "Remix of: <name>" instead of "From template: <name>".
       * `undefined` for every other way of reaching flow B. */
      remixOfName?: string
    }

export interface Props {
  source: EditorSource
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

/** `0:05.18` — minutes:seconds.hundredths, design brief §6's transport
 * timecode format. */
export function formatTimecode(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const minutes = Math.floor(clamped / 60)
  const rest = (clamped - minutes * 60).toFixed(2).padStart(5, '0')
  return `${minutes}:${rest}`
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
export function useCaptionEditor({ source, filmstrip, onBack, onGifCreated, belowBreakpoint }: Props) {
  const isTemplateSource = source.kind === 'template'
  const duration = isTemplateSource ? source.template.duration_seconds : source.video.duration_seconds
  // Matches the backend's scale.rs output size — computed server-side,
  // reflected here via the film-strip's own dimensions. Also true for a
  // template source: its filmstrip is generated from its own locked
  // width/height (`routes::templates::get_filmstrip_meta`), so this needs
  // no separate branch.
  const outputWidth = filmstrip.frameWidth
  const outputHeight = filmstrip.frameHeight
  // Flow B's clip is the template's own self-contained, already-trimmed
  // media — works even without access to the (possibly private, possibly
  // someone else's) source video.
  const clipUrl = isTemplateSource ? templateClipUrl(source.template.id) : videoFileUrl(source.video.id)
  const [captions, setCaptions] = useState<Caption[]>(() => (isTemplateSource ? source.template.captions : []))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  // Click-to-edit transport timecode (design brief §6 fine-control): typing
  // or arrow-stepping a value edits a local draft string, independent of
  // `currentTime`, so a mid-type invalid string never corrupts playback.
  const [isEditingTime, setIsEditingTime] = useState(false)
  const [timeDraft, setTimeDraft] = useState('')
  const editOriginalTimeRef = useRef(0)
  // Enter/Escape already drive their own commit/cancel — without this, the
  // blur that follows (from hiding the input or moving focus) would commit
  // or re-revert a second time.
  const skipTimeBlurRef = useRef(false)
  // Hover-to-nudge + tooltip state for the transport's stepper group.
  const [isTimecodeHovered, setIsTimecodeHovered] = useState(false)
  const [showTimecodeTooltip, setShowTimecodeTooltip] = useState(false)
  const timecodeWrapRef = useRef<HTMLDivElement>(null)
  const timeInputRef = useRef<HTMLInputElement>(null)
  const tooltipShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [gifRange, setGifRange] = useState({ start: 0, end: duration })
  const [applyToAll, setApplyToAll] = useState(false)
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX)
  // Naming lives entirely in the Make GIF dialog now — there is no
  // header-level name field or "name required" gate on opening it.
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportProgress, setExportProgress] = useState<ExportProgressState>(INITIAL_EXPORT_PROGRESS)
  const [exportAllDone, setExportAllDone] = useState(true)
  const [completedGif, setCompletedGif] = useState<Gif | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  // The "Make GIF" dialog's own state — opens for both flows (naming is
  // universal now), but the "Also save as a template" card only ever
  // renders for flow A (flow B never shows a save/overwrite option, not
  // even for the template's own creator).
  const [makeGifPopoverOpen, setMakeGifPopoverOpen] = useState(false)
  const [saveAsTemplate, setSaveAsTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [templateNameError, setTemplateNameError] = useState(false)
  const [templateIsPublic, setTemplateIsPublic] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const templateNameInputRef = useRef<HTMLInputElement>(null)
  const makeGifButtonRef = useRef<HTMLButtonElement>(null)
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

  // Focus moves into the dialog's own name field the moment it opens,
  // cursor at the end of whatever's already there (never at the start,
  // which would otherwise leave someone editing an existing name typing
  // into the middle of it).
  useEffect(() => {
    if (!makeGifPopoverOpen) return
    const el = nameInputRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [makeGifPopoverOpen])

  useEffect(
    () => () => {
      if (tooltipShowTimerRef.current) clearTimeout(tooltipShowTimerRef.current)
      if (tooltipHideTimerRef.current) clearTimeout(tooltipHideTimerRef.current)
    },
    [],
  )

  function closeMakeGifPopover() {
    setMakeGifPopoverOpen(false)
    makeGifButtonRef.current?.focus()
  }

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
  // anything afterwards — this only sets the initial state. Flow A only —
  // a flow-B source already arrives with its own captions (see the
  // `captions` initializer above) and never a "this video's own template"
  // to look up. Keyed on the video's own id rather than `source` itself,
  // which is a fresh object every render and would re-fire this on every
  // render if used directly as the dependency.
  const videoId = source.kind === 'video' ? source.video.id : null
  useEffect(() => {
    if (videoId === null) return
    let cancelled = false
    getTemplate(videoId)
      .then((template) => {
        if (cancelled || !template) return
        setCaptions(template.captions)
        setGifRange({ start: template.gif_range_start, end: template.gif_range_end })
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

  /** Accepts either the displayed `M:SS.ss` timecode or plain seconds
   * (e.g. "5.18"), matching whatever the user has `timeDraft`'d — the
   * colon is what disambiguates the two. */
  function parseTimecodeInput(raw: string): number | null {
    const str = raw.trim()
    if (!str) return null
    if (str.includes(':')) {
      const parts = str.split(':')
      if (parts.length !== 2 || !parts[0] || !parts[1]) return null
      const minutes = Number(parts[0])
      const seconds = Number(parts[1])
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
      return minutes * 60 + seconds
    }
    const seconds = Number(str)
    return Number.isFinite(seconds) ? seconds : null
  }

  function enterTimeEdit() {
    if (isEditingTime) return
    // Frame-accurate stepping against a moving playhead is close to
    // meaningless, so editing always starts from a still frame.
    videoRef.current?.pause()
    editOriginalTimeRef.current = currentTime
    setTimeDraft(formatTimecode(currentTime))
    setIsEditingTime(true)
    hideTimecodeTooltip()
  }

  function exitTimeEdit() {
    // Enter/Escape already drive their own commit/cancel via this —
    // without it, the blur that follows (from hiding the input or moving
    // focus) would commit or re-revert a second time.
    skipTimeBlurRef.current = true
    setIsEditingTime(false)
  }

  // useCallback (not a plain function, unlike its neighbours here) so the
  // hover-keydown effect below can list it as a dependency without
  // reattaching its document listener on every unrelated render.
  const stepTime = useCallback(
    (deltaSeconds: number) => {
      // Same reasoning as entering edit mode — nudging only makes sense
      // against a still frame.
      videoRef.current?.pause()
      const next = clamp(currentTime + deltaSeconds, 0, duration)
      seekTo(next)
      if (isEditingTime) setTimeDraft(formatTimecode(next))
    },
    [currentTime, duration, isEditingTime],
  )

  // Arrow-key nudging while the pointer merely hovers the stepper, without
  // clicking into edit mode first — edit mode has its own keydown handler
  // with the same mapping, so this only needs to apply while idle.
  useEffect(() => {
    if (!isTimecodeHovered || isEditingTime) return
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement
      // Don't hijack arrow keys meant for some other field (e.g. a
      // caption's text area) that just happens to be focused while the
      // pointer sits over the stepper.
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable) &&
        !timecodeWrapRef.current?.contains(active)
      ) {
        return
      }
      const forward = e.key === 'ArrowUp' || e.key === 'ArrowRight'
      const backward = e.key === 'ArrowDown' || e.key === 'ArrowLeft'
      if (!forward && !backward) return
      e.preventDefault()
      const step = e.shiftKey ? 0.1 : 0.01
      stepTime(forward ? step : -step)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isTimecodeHovered, isEditingTime, stepTime])

  /** Returns whether it actually committed (and exited edit mode) — an
   * out-of-range number is left uncommitted, with the input still focused
   * and `timeDraftOutOfRange`'s error shown, so the user can correct it
   * instead of having it silently clamped out from under them. */
  function commitTimeEdit(): boolean {
    const parsed = parseTimecodeInput(timeDraft)
    if (parsed === null) {
      // Unparseable text reverts fully, same as Escape.
      seekTo(editOriginalTimeRef.current)
      exitTimeEdit()
      return true
    }
    if (parsed < 0 || parsed > duration) return false
    seekTo(parsed)
    exitTimeEdit()
    return true
  }

  function cancelTimeEdit() {
    seekTo(editOriginalTimeRef.current)
    exitTimeEdit()
  }

  /** Live-seeks as soon as what's typed parses to a valid in-range time —
   * not just on commit — so an arrow press right after typing nudges from
   * the typed value, not wherever the playhead happened to be before you
   * started typing. An invalid or out-of-range draft just doesn't seek
   * (the red-border error already covers that case), leaving the playhead
   * at its last valid position. */
  function handleTimeDraftChange(value: string) {
    setTimeDraft(value)
    const parsed = parseTimecodeInput(value)
    if (parsed !== null && parsed >= 0 && parsed <= duration) seekTo(parsed)
  }

  function handleTimeInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelTimeEdit()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commitTimeEdit()
      return
    }
    // Left/right move the text cursor normally while typing — now that
    // typing live-seeks (see handleTimeDraftChange), also stepping on
    // left/right here would fight a correction mid-type (e.g. arrowing
    // left to fix a digit would itself nudge the now-live playhead).
    // Up/down nudge instead, same as hovering.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const step = e.shiftKey ? 0.1 : 0.01
      stepTime(e.key === 'ArrowUp' ? step : -step)
    }
  }

  function handleTimeInputBlur() {
    if (skipTimeBlurRef.current) {
      skipTimeBlurRef.current = false
      return
    }
    if (!commitTimeEdit()) {
      // Out-of-range — keep the user editing instead of losing focus on
      // an error they haven't fixed yet.
      timeInputRef.current?.focus()
    }
  }

  function hideTimecodeTooltip() {
    if (tooltipShowTimerRef.current) clearTimeout(tooltipShowTimerRef.current)
    if (tooltipHideTimerRef.current) clearTimeout(tooltipHideTimerRef.current)
    setShowTimecodeTooltip(false)
  }

  function handleTimecodeMouseEnter() {
    setIsTimecodeHovered(true)
    if (isEditingTime) return
    tooltipShowTimerRef.current = setTimeout(() => {
      setShowTimecodeTooltip(true)
      // Fades on its own even if the pointer never leaves.
      tooltipHideTimerRef.current = setTimeout(() => setShowTimecodeTooltip(false), 4000)
    }, 400)
  }

  function handleTimecodeMouseLeave() {
    setIsTimecodeHovered(false)
    hideTimecodeTooltip()
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

  const parsedTimeDraft = isEditingTime ? parseTimecodeInput(timeDraft) : null
  const timeDraftOutOfRange = parsedTimeDraft !== null && (parsedTimeDraft < 0 || parsedTimeDraft > duration)

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
  // Vertical room above the strip for the playhead's floating time label —
  // same reasoning as PLAYHEAD_ADD_CLEARANCE below it: real layout height
  // on .va-filmstrip-wrap (via .va-filmstrip's own marginTop, so its
  // internal range/playhead coordinates stay relative to its own box)
  // rather than overflow that'd get clipped by .va-timeline-scroll's
  // overflow-y: hidden.
  const PLAYHEAD_LABEL_CLEARANCE = 22
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

  // Opens the "Make GIF" dialog — for both flows, always, regardless of
  // whether the GIF has a name yet: the "name required" check lives
  // inside the dialog's own field, not gating whether it opens at all.
  // The template name field (flow A only) is prefilled with the GIF's
  // own name, matching the design ("prefilled from the editor's name
  // field").
  function openMakeGifPopover() {
    setTemplateName(name.trim())
    setTemplateIsPublic(false)
    setSaveAsTemplate(false)
    setNameError(false)
    setTemplateNameError(false)
    setMakeGifPopoverOpen(true)
  }

  async function makeGif() {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setNameError(true)
      nameInputRef.current?.focus()
      return
    }
    const trimmedTemplateName = templateName.trim()
    if (source.kind === 'video' && saveAsTemplate && !trimmedTemplateName) {
      setTemplateNameError(true)
      templateNameInputRef.current?.focus()
      return
    }
    setMakeGifPopoverOpen(false)
    setSubmitting(true)
    setExportError(null)
    setTemplateError(null)
    setCompletedGif(null)
    setExportProgress(INITIAL_EXPORT_PROGRESS)
    setExportAllDone(false)
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
      const result =
        source.kind === 'video'
          ? await createExport({
              video_id: source.video.id,
              name: trimmedName,
              // The "Also save as a template" checkbox — sent as part of
              // the export request itself, not a separate follow-up PUT
              // after it completes, since a video not saved as a
              // template doesn't survive past its own export
              // (SPEC-CLOUD.md §6), so a later call here would race that
              // cleanup and 404.
              save_as_template: saveAsTemplate,
              template_name: saveAsTemplate ? trimmedTemplateName : undefined,
              template_is_public: saveAsTemplate ? templateIsPublic : undefined,
              captions: captionsWithWrapping,
              gif_range_start: Number(gifRange.start.toFixed(2)),
              gif_range_end: Number(gifRange.end.toFixed(2)),
            })
          : // Flow B: no range/dimension fields at all — those are always
            // locked to the template's own saved values, enforced
            // server-side.
            await createTemplateExport(source.template.id, trimmedName, captionsWithWrapping)
      exportUnsubscribeRef.current = subscribeExportProgress(result.export_id, {
        onProgress: (format, percent) =>
          setExportProgress((prev) => ({ ...prev, [format]: { status: 'running', percent } })),
        onFormatDone: (format) =>
          setExportProgress((prev) => ({ ...prev, [format]: { status: 'done', percent: 100 } })),
        onFormatFailed: (format) =>
          setExportProgress((prev) => ({ ...prev, [format]: { status: 'error', percent: prev[format].percent } })),
        onComplete: (gif) => {
          setCompletedGif(gif)
          setExportAllDone(true)
          setSubmitting(false)
          onGifCreated?.(gif)
        },
        onError: (message) => {
          setExportError(message)
          setExportAllDone(true)
          setSubmitting(false)
        },
      })
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
      setExportAllDone(true)
      setSubmitting(false)
    }
  }

  const trimmedDuration = gifRange.end - gifRange.start
  const sourceInfo =
    source.kind === 'video'
      ? `${source.video.original_filename} · ${outputWidth}×${outputHeight} · ${duration.toFixed(1)}s`
      : source.remixOfName
        ? `Remix of: ${source.remixOfName} · ${outputWidth}×${outputHeight} · ${duration.toFixed(1)}s`
        : `From template: ${source.template.name} · ${outputWidth}×${outputHeight} · ${duration.toFixed(1)}s`
  return {
    source,
    filmstrip,
    onBack,
    belowBreakpoint,
    isTemplateSource,
    duration,
    outputWidth,
    outputHeight,
    clipUrl,
    captions,
    selectedId,
    setSelectedId,
    currentTime,
    isEditingTime,
    timeDraft,
    showTimecodeTooltip,
    timecodeWrapRef,
    timeInputRef,
    gifRange,
    applyToAll,
    setApplyToAll,
    zoomIndex,
    setZoomIndex,
    name,
    setName,
    nameError,
    setNameError,
    nameInputRef,
    submitting,
    exportError,
    exportProgress,
    exportAllDone,
    completedGif,
    isPlaying,
    setIsPlaying,
    makeGifPopoverOpen,
    saveAsTemplate,
    setSaveAsTemplate,
    templateName,
    setTemplateName,
    templateNameError,
    setTemplateNameError,
    templateIsPublic,
    setTemplateIsPublic,
    templateError,
    templateNameInputRef,
    makeGifButtonRef,
    snapGuideX,
    previewZoomMode,
    setPreviewZoomMode,
    closeMakeGifPopover,
    previewRef,
    videoRef,
    timelineScrollRef,
    measureRefs,
    timelineWidth,
    selected,
    addCaption,
    deleteCaption,
    patchStyle,
    startPillDrag,
    startRangeDrag,
    startPlayheadDrag,
    setRangeStartToPlayhead,
    setRangeEndToPlayhead,
    setCaptionEdgeToPlayhead,
    enterTimeEdit,
    stepTime,
    handleTimeDraftChange,
    handleTimeInputKeyDown,
    handleTimeInputBlur,
    handleTimecodeMouseEnter,
    handleTimecodeMouseLeave,
    scrubTo,
    togglePlayback,
    handleVideoTimeUpdate,
    handleVideoEnded,
    startPositionDrag,
    startWidthDrag,
    activeCaptions,
    timeDraftOutOfRange,
    previewScale,
    previewWidth,
    previewHeight,
    transportWidth,
    FILMSTRIP_HEIGHT,
    PLAYHEAD_ADD_CLEARANCE,
    PLAYHEAD_LABEL_CLEARANCE,
    frameIndices,
    filmstripFrameWidth,
    filmstripScale,
    openMakeGifPopover,
    makeGif,
    trimmedDuration,
    sourceInfo,
  }
}

export type CaptionEditorState = ReturnType<typeof useCaptionEditor>
