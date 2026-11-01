import { useEffect, useMemo, useRef, useState } from 'react'
import mark from './assets/brand/strewthgif-mark.svg'
import { MAX_LINE_HEIGHT, MIN_LINE_HEIGHT, outlineTextShadow, SWATCH_COLORS } from './captionStyle'
import { ExportProgressModal } from './ExportProgressModal'
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  MoreIcon,
  PauseIcon,
  PlayIcon,
} from './icons'
import { MobileMakeSheet } from './MobileMakeSheet'
import { MobileStepper } from './MobileStepper'
import { MobileTrimStrip } from './MobileTrimStrip'
import { clamp } from './timeline'
import type { Caption } from './types'
import { useClickOutside } from './useClickOutside'
import {
  type CaptionEditorState,
  formatTimecode,
  FONTS,
  MAX_CAPTION_WIDTH,
  MIN_CAPTION_DURATION,
  MIN_CAPTION_WIDTH,
} from './useCaptionEditor'

type Tab = 'text' | 'style' | 'timing'

const TABS: { key: Tab; label: string }[] = [
  { key: 'text', label: 'Text' },
  { key: 'style', label: 'Style' },
  { key: 'timing', label: 'Timing' },
]

/** Scrolling the panel past this collapses the trim strip to a slim bar. */
const COLLAPSE_SCROLL_PX = 24
/** Ignore scroll events this long after the strip changes size: the panel
 * grows/shrinks with it, which would otherwise re-trigger the toggle. */
const COLLAPSE_SETTLE_MS = 300

const NUDGE = 0.01

function round2(value: number): number {
  return Number(value.toFixed(2))
}

function sentenceCase(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return '(empty)'
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase()
}

const ALIGN_ICONS = { left: AlignLeftIcon, center: AlignCenterIcon, right: AlignRightIcon } as const

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

/**
 * The phone layout of the caption editor (MOBILE.md §6/§7). It renders the
 * same state and handlers as `DesktopEditor` — captions, trim, playhead,
 * export — only arranged for a thumb: video, trim strip, caption chips, a
 * Text/Style/Timing panel, and a bottom bar with play, the playhead stepper
 * and Make GIF.
 */
export function MobileEditor({ editor }: { editor: CaptionEditorState }) {
  const {
    onBack,
    sourceInfo,
    isTemplateSource,
    filmstrip,
    duration,
    outputWidth,
    outputHeight,
    clipUrl,
    captions,
    selectedId,
    setSelectedId,
    selected,
    currentTime,
    gifRange,
    setGifRange,
    applyToAll,
    setApplyToAll,
    isPlaying,
    setIsPlaying,
    togglePlayback,
    handleVideoTimeUpdate,
    handleVideoEnded,
    handleVideoLoadedMetadata,
    videoRef,
    previewRef,
    measureRefs,
    activeCaptions,
    addCaption,
    deleteCaption,
    updateCaption,
    patchStyle,
    seekTo,
    setCaptionEdgeToPlayhead,
    stepTime,
    trimmedDuration,
    makeGifPopoverOpen,
    openMakeGifPopover,
    makeGifButtonRef,
    submitting,
    exportProgress,
    exportAllDone,
    exportError,
    templateError,
    completedGif,
  } = editor

  const [tab, setTab] = useState<Tab>('text')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useClickOutside(menuRef, menuOpen, () => setMenuOpen(false))

  const ordered = useMemo(() => [...captions].sort((a, b) => a.startTime - b.startTime), [captions])
  const selectedIndex = selected ? ordered.findIndex((c) => c.id === selected.id) : -1

  // A template arrives with its captions; start with the first one selected
  // so the panel has something to show.
  useEffect(() => {
    if (selectedId === null && ordered.length > 0) setSelectedId(ordered[0].id)
    // Mount only: later deselection (e.g. deleting the last-selected caption)
    // should not snap a selection back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Scale caption text from output pixels to the video as drawn on screen.
  const [frameWidth, setFrameWidth] = useState(0)
  useEffect(() => {
    const el = previewRef.current
    if (!el) return
    setFrameWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setFrameWidth(el.getBoundingClientRect().width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [previewRef])
  const previewScale = frameWidth > 0 ? frameWidth / outputWidth : 1

  // ----- caption dragging on the video (touch + mouse via pointer events)
  const positionDragRef = useRef<PositionDrag | null>(null)
  function onCaptionPointerDown(e: React.PointerEvent, c: Caption) {
    e.stopPropagation()
    setSelectedId(c.id)
    positionDragRef.current = { id: c.id, startX: e.clientX, startY: e.clientY, origX: c.x, origY: c.y }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  function onCaptionPointerMove(e: React.PointerEvent) {
    const drag = positionDragRef.current
    const rect = previewRef.current?.getBoundingClientRect()
    if (!drag || !rect || rect.width === 0 || rect.height === 0) return
    updateCaption(drag.id, {
      x: clamp(drag.origX + (e.clientX - drag.startX) / rect.width, 0, 1),
      y: clamp(drag.origY + (e.clientY - drag.startY) / rect.height, 0, 1),
    })
  }
  function onCaptionPointerEnd() {
    positionDragRef.current = null
  }

  // ----- resizing the selected caption from its edge handles. Symmetric
  // around the centre (the box is always centred on x), so a delta on one
  // edge changes the total width by twice that delta — same as desktop.
  const widthDragRef = useRef<WidthDrag | null>(null)
  function onWidthPointerDown(e: React.PointerEvent, c: Caption, edge: 'left' | 'right') {
    e.stopPropagation()
    setSelectedId(c.id)
    widthDragRef.current = { id: c.id, edge, startX: e.clientX, origWidth: c.width }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  function onWidthPointerMove(e: React.PointerEvent) {
    const drag = widthDragRef.current
    const rect = previewRef.current?.getBoundingClientRect()
    if (!drag || !rect || rect.width === 0) return
    const sign = drag.edge === 'right' ? 1 : -1
    const fraction = (e.clientX - drag.startX) / rect.width
    updateCaption(drag.id, {
      width: clamp(drag.origWidth + sign * fraction * 2, MIN_CAPTION_WIDTH, MAX_CAPTION_WIDTH),
    })
  }
  function onWidthPointerEnd() {
    widthDragRef.current = null
  }

  // ----- collapsing the trim strip while the panel is scrolled
  const [collapsed, setCollapsed] = useState(false)
  const lastToggleRef = useRef(0)
  function changeCollapsed(next: boolean) {
    if (next === collapsed) return
    lastToggleRef.current = Date.now()
    setCollapsed(next)
  }
  function onPanelScroll(e: React.UIEvent<HTMLElement>) {
    if (Date.now() - lastToggleRef.current < COLLAPSE_SETTLE_MS) return
    const top = e.currentTarget.scrollTop
    if (!collapsed && top > COLLAPSE_SCROLL_PX) changeCollapsed(true)
    else if (collapsed && top <= 0) changeCollapsed(false)
  }

  function selectChip(c: Caption) {
    setSelectedId(c.id)
    videoRef.current?.pause()
    seekTo(c.startTime)
    setMenuOpen(false)
  }

  function nudgeEdge(edge: 'start' | 'end', direction: -1 | 1) {
    if (!selected) return
    if (edge === 'start') {
      updateCaption(selected.id, {
        startTime: round2(clamp(selected.startTime + direction * NUDGE, 0, selected.endTime - MIN_CAPTION_DURATION)),
      })
    } else {
      updateCaption(selected.id, {
        endTime: round2(clamp(selected.endTime + direction * NUDGE, selected.startTime + MIN_CAPTION_DURATION, duration)),
      })
    }
  }

  const rangeLength = Math.max(gifRange.end - gifRange.start, 0.001)
  const pctOfRange = (time: number) => clamp(((time - gifRange.start) / rangeLength) * 100, 0, 100)
  const pctOfClip = (time: number) => `${((time / duration) * 100).toFixed(3)}%`
  const next = selectedIndex >= 0 ? ordered[selectedIndex + 1] : undefined

  return (
    <div className="m-editor">
      <header className="m-editor-bar">
        <button type="button" className="m-editor-back" onClick={onBack} aria-label="Back to library">
          <ArrowLeftIcon size={20} />
        </button>
        <img src={mark} alt="StrewthGif" className="m-editor-mark" />
        <div className="m-editor-title">
          <p className="m-editor-title-main">New GIF</p>
          <p className="m-editor-title-source">{sourceInfo}</p>
        </div>
      </header>

      <ExportProgressModal progress={exportProgress} allDone={exportAllDone} />
      {exportError && <div className="editor-toast editor-toast-error">{exportError}</div>}
      {templateError && <div className="editor-toast editor-toast-error">{templateError}</div>}
      {completedGif && (
        <div className="editor-toast">
          "{completedGif.name}" is ready ({completedGif.width}×{completedGif.height}).
        </div>
      )}

      <div className="m-editor-video">
        <div
          className="m-editor-frame"
          ref={previewRef}
          style={{ '--ar': outputWidth / outputHeight } as React.CSSProperties}
        >
          <video
            ref={videoRef}
            src={clipUrl}
            className="preview-video"
            preload="auto"
            playsInline
            onTimeUpdate={handleVideoTimeUpdate}
            onEnded={handleVideoEnded}
              onLoadedMetadata={handleVideoLoadedMetadata}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          />
          {activeCaptions.map((c) => (
            <div
              key={c.id}
              className={`preview-caption m-editor-caption ${selectedId === c.id ? 'selected' : ''}`}
              onPointerDown={(e) => onCaptionPointerDown(e, c)}
              onPointerMove={onCaptionPointerMove}
              onPointerUp={onCaptionPointerEnd}
              onPointerCancel={onCaptionPointerEnd}
              style={{
                left: `${c.x * 100}%`,
                top: `${c.y * 100}%`,
                width: `${c.width * 100}%`,
                fontFamily: c.fontFamily,
                fontSize: c.fontSize * previewScale,
                lineHeight: c.lineHeight,
                color: c.color,
                textAlign: c.align,
                textShadow: outlineTextShadow(c.outlineColor, previewScale),
              }}
            >
              {c.text}
              {selectedId === c.id &&
                (['left', 'right'] as const).map((edge) => (
                  <span
                    key={edge}
                    role="slider"
                    aria-label={`Caption width, ${edge} edge`}
                    aria-valuemin={MIN_CAPTION_WIDTH}
                    aria-valuemax={MAX_CAPTION_WIDTH}
                    aria-valuenow={Number(c.width.toFixed(2))}
                    className={`m-caption-handle ${edge}`}
                    onPointerDown={(e) => onWidthPointerDown(e, c, edge)}
                    onPointerMove={onWidthPointerMove}
                    onPointerUp={onWidthPointerEnd}
                    onPointerCancel={onWidthPointerEnd}
                  />
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* Off-screen twins of each caption, measured at export time to find
          the real wrap points — see useCaptionEditor's measureRefs. */}
      <div aria-hidden="true" style={{ position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }}>
        {captions.map((c) => (
          <div key={c.id} style={{ width: c.width * outputWidth }}>
            <div
              ref={(el) => {
                measureRefs.current[c.id] = el
              }}
              className="preview-caption-measure"
              style={{ width: '100%', fontFamily: c.fontFamily, fontSize: c.fontSize }}
            >
              {c.text}
            </div>
          </div>
        ))}
      </div>

      <div className={`m-strip-wrap ${collapsed ? 'collapsed' : ''}`} aria-hidden={collapsed || undefined}>
        <MobileTrimStrip
          duration={duration}
          filmstrip={filmstrip}
          gifRange={gifRange}
          setGifRange={setGifRange}
          currentTime={currentTime}
          seekTo={seekTo}
          pauseVideo={() => videoRef.current?.pause()}
          captions={ordered}
          selectedId={selectedId}
          locked={isTemplateSource}
        />
      </div>
      <button
        type="button"
        className={`m-strip-collapse ${collapsed ? '' : 'shown'}`}
        aria-label="Hide trim strip"
        tabIndex={collapsed ? -1 : 0}
        aria-hidden={collapsed || undefined}
        onClick={() => changeCollapsed(true)}
      >
        <ChevronDownIcon size={14} />
      </button>
      <button
        type="button"
        className={`m-strip-mini ${collapsed ? 'shown' : ''}`}
        aria-label="Show trim strip"
        tabIndex={collapsed ? 0 : -1}
        aria-hidden={!collapsed || undefined}
        onClick={() => changeCollapsed(false)}
      >
        <span className="m-strip-mini-bar">
          <span
            className="m-strip-mini-range"
            style={{ left: pctOfClip(gifRange.start), width: pctOfClip(gifRange.end - gifRange.start) }}
          />
          {ordered.map((c) => (
            <span key={c.id} className="m-strip-mini-tick" style={{ left: pctOfClip(c.startTime) }} />
          ))}
          <span className="m-strip-mini-playhead" style={{ left: pctOfClip(currentTime) }} />
        </span>
        <ChevronDownIcon size={14} />
      </button>

      <div className="m-chips" role="listbox" aria-label="Captions">
        {ordered.map((c, i) => (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={c.id === selectedId}
            className={`m-chip ${c.id === selectedId ? 'selected' : ''}`}
            onClick={() => selectChip(c)}
          >
            <span className="m-chip-num">{i + 1}</span>
            <span className="m-chip-label">{sentenceCase(c.text)}</span>
          </button>
        ))}
      </div>

      <section className="m-panel" onScroll={onPanelScroll} aria-label="Caption editor">
        <div className="m-panel-head">
          <div className="m-tabs" role="tablist">
            {TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={`m-tab ${tab === key ? 'selected' : ''}`}
                onClick={() => {
                  setTab(key)
                  setMenuOpen(false)
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="m-menu-anchor" ref={menuRef}>
            <button
              type="button"
              className="m-more-btn"
              aria-label="Caption options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <MoreIcon size={20} />
            </button>
            {menuOpen && (
              <div className="m-menu m-editor-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="m-menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    addCaption()
                  }}
                >
                  Add caption at playhead
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="m-menu-item m-menu-item-danger"
                  disabled={!selected}
                  onClick={() => {
                    setMenuOpen(false)
                    if (selected) deleteCaption(selected.id)
                  }}
                >
                  Delete caption
                </button>
              </div>
            )}
          </div>
        </div>

        {!selected ? (
          <p className="m-panel-empty">Select a caption above, or add one from the ⋯ menu.</p>
        ) : tab === 'text' ? (
          <div className="m-panel-body">
            <textarea
              className="m-caption-text"
              aria-label="Caption text"
              value={selected.text}
              onChange={(e) => updateCaption(selected.id, { text: e.target.value })}
            />
            <p className="m-hint">Drag the caption on the video to move it, or its edges to resize it.</p>
          </div>
        ) : tab === 'style' ? (
          <div className="m-panel-body">
            <div className="m-style-top">
              <select
                className="m-select"
                aria-label="Font family"
                value={selected.fontFamily}
                onChange={(e) => patchStyle({ fontFamily: e.target.value })}
              >
                {FONTS.map((f) => (
                  <option key={f} value={f}>
                    {f.split(',')[0].replace(/'/g, '')}
                  </option>
                ))}
              </select>
              <div className="m-size-stepper">
                <button
                  type="button"
                  aria-label="Smaller"
                  onClick={() => patchStyle({ fontSize: clamp(selected.fontSize - 2, 12, 72) })}
                >
                  −
                </button>
                <span className="m-size-value">
                  {selected.fontSize}
                  <small>size</small>
                </span>
                <button
                  type="button"
                  aria-label="Bigger"
                  onClick={() => patchStyle({ fontSize: clamp(selected.fontSize + 2, 12, 72) })}
                >
                  +
                </button>
              </div>
            </div>

            <div className="m-swatch-row">
              <span className="m-swatch-label">Text</span>
              <div className="m-swatches">
                {SWATCH_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`m-swatch ${selected.color.toLowerCase() === color ? 'selected' : ''}`}
                    style={{ backgroundColor: color }}
                    aria-label={`Text colour ${color}`}
                    aria-pressed={selected.color.toLowerCase() === color}
                    onClick={() => patchStyle({ color })}
                  />
                ))}
              </div>
            </div>

            <div className="m-swatch-row">
              <span className="m-swatch-label">Outline</span>
              <div className="m-swatches">
                <button
                  type="button"
                  className={`m-swatch m-swatch-none ${selected.outlineColor === null ? 'selected' : ''}`}
                  aria-label="No outline"
                  aria-pressed={selected.outlineColor === null}
                  onClick={() => patchStyle({ outlineColor: null })}
                />
                {SWATCH_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`m-swatch ${selected.outlineColor?.toLowerCase() === color ? 'selected' : ''}`}
                    style={{ backgroundColor: color }}
                    aria-label={`Outline colour ${color}`}
                    aria-pressed={selected.outlineColor?.toLowerCase() === color}
                    onClick={() => patchStyle({ outlineColor: color })}
                  />
                ))}
              </div>
            </div>

            <div className="m-style-bottom">
              <div className="m-align" role="group" aria-label="Alignment">
                {(['left', 'center', 'right'] as const).map((a) => {
                  const Icon = ALIGN_ICONS[a]
                  return (
                    <button
                      key={a}
                      type="button"
                      className={`m-align-btn ${selected.align === a ? 'selected' : ''}`}
                      aria-label={`Align ${a}`}
                      aria-pressed={selected.align === a}
                      onClick={() => patchStyle({ align: a })}
                    >
                      <Icon size={18} />
                    </button>
                  )
                })}
              </div>
              <label className="m-apply-all">
                <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
                Apply to all
              </label>
            </div>

            <div className="m-line-height">
              <span className="m-swatch-label">Line height</span>
              <div className="m-size-stepper">
                <button
                  type="button"
                  aria-label="Tighter lines"
                  onClick={() => patchStyle({ lineHeight: round2(clamp(selected.lineHeight - 0.05, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT)) })}
                >
                  −
                </button>
                <span className="m-size-value">{selected.lineHeight.toFixed(2)}×</span>
                <button
                  type="button"
                  aria-label="Looser lines"
                  onClick={() => patchStyle({ lineHeight: round2(clamp(selected.lineHeight + 0.05, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT)) })}
                >
                  +
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="m-panel-body">
            <div className="m-timing-grid">
              <div className="m-timing-field">
                <span className="m-timing-label">Caption in</span>
                <MobileStepper
                  label="Caption in"
                  value={`${selected.startTime.toFixed(2)}s`}
                  onStep={(dir) => nudgeEdge('start', dir)}
                />
                <button type="button" className="m-link-btn" onClick={() => setCaptionEdgeToPlayhead(selected.id, 'start')}>
                  Set to playhead
                  <span className="sr-only"> for caption in</span>
                </button>
              </div>
              <div className="m-timing-field">
                <span className="m-timing-label">Caption out</span>
                <MobileStepper
                  label="Caption out"
                  value={`${selected.endTime.toFixed(2)}s`}
                  onStep={(dir) => nudgeEdge('end', dir)}
                />
                <button type="button" className="m-link-btn" onClick={() => setCaptionEdgeToPlayhead(selected.id, 'end')}>
                  Set to playhead
                  <span className="sr-only"> for caption out</span>
                </button>
              </div>
            </div>

            <div className="m-timing-bar" role="group" aria-label="Captions across the trim range">
              {ordered.map((c, i) => {
                const left = pctOfRange(c.startTime)
                const right = pctOfRange(c.endTime)
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`m-timing-block ${c.id === selectedId ? 'selected' : ''}`}
                    aria-label={`Caption ${i + 1}`}
                    aria-pressed={c.id === selectedId}
                    style={{ left: `${left}%`, width: `${Math.max(right - left, 1.5)}%` }}
                    onClick={() => setSelectedId(c.id)}
                  >
                    {i + 1}
                  </button>
                )
              })}
            </div>

            <p className="m-timing-readout">
              Shows {selected.startTime.toFixed(2)}s → {selected.endTime.toFixed(2)}s ·{' '}
              {(selected.endTime - selected.startTime).toFixed(2)}s long
              {next ? ` · ${Math.max(0, next.startTime - selected.endTime).toFixed(2)}s gap to #${selectedIndex + 2}` : ''}
            </p>
          </div>
        )}
      </section>

      <footer className="m-bottom-bar">
        <button
          type="button"
          className="m-play-btn"
          onClick={togglePlayback}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
        <MobileStepper
          label="Playhead"
          value={formatTimecode(currentTime)}
          onStep={(dir) => stepTime(dir * NUDGE)}
        />
        <button
          ref={makeGifButtonRef}
          type="button"
          className="m-make-btn"
          aria-label="Make GIF"
          disabled={submitting}
          onClick={openMakeGifPopover}
        >
          {submitting ? (
            'Making…'
          ) : (
            <>
              Make GIF
              <span className="m-make-btn-length">{trimmedDuration.toFixed(2)}s</span>
            </>
          )}
        </button>
      </footer>

      {makeGifPopoverOpen && <MobileMakeSheet editor={editor} />}
    </div>
  )
}
