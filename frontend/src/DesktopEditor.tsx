import mark from './assets/brand/strewthgif-mark.svg'
import { ExportProgressModal } from './ExportProgressModal'
import { AlignCenterIcon, AlignLeftIcon, AlignRightIcon, ArrowLeftIcon, BookmarkIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, MinusIcon, PauseIcon, PlayheadIcon, PlayIcon, PlusIcon, XIcon } from './icons'
import { spriteBackgroundStyle, timeToX } from './timeline'
import { type CaptionEditorState, formatTimecode, FONTS, ZOOM_LEVELS } from './useCaptionEditor'

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
// SPEC.md §14: quick-select swatches shown alongside the native color
// pickers for caption text and outline color.
const SWATCH_COLORS = ['#fff35c', '#00ff99', '#00ccff', '#ff6666', '#9933ff', '#fcfcfc', '#000000']
const MAX_LINE_HEIGHT = 1.5
const MIN_LINE_HEIGHT = 0.3

/** Mirrors the backend's optional ASS outline: `null` renders no border. */
function outlineTextShadow(outlineColor: string | null, scale: number): string {
  if (!outlineColor) return 'none'
  const o = 2 * scale
  return `${o}px ${o}px 0 ${outlineColor}, -${o}px -${o}px 0 ${outlineColor}, ${o}px -${o}px 0 ${outlineColor}, -${o}px ${o}px 0 ${outlineColor}`
}
export function DesktopEditor({ editor }: { editor: CaptionEditorState }) {
  const {
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
  } = editor


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
            <p className="editor-static-title">New GIF</p>
            <p className="editor-source-info">{sourceInfo}</p>
          </div>
        </div>
        <div className="editor-header-right">
          <div className="editor-makegif-anchor">
            <button
              ref={makeGifButtonRef}
              className="btn btn-primary"
              aria-label="Make GIF"
              disabled={submitting}
              onClick={openMakeGifPopover}
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
            {makeGifPopoverOpen && (
              <div
                className="editor-makegif-popover"
                role="dialog"
                aria-label="Make GIF"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    closeMakeGifPopover()
                  }
                }}
              >
                <div className="editor-makegif-header">
                  <p className="editor-makegif-title">Make GIF</p>
                  <span className="editor-makegif-summary">
                    {trimmedDuration.toFixed(1)}s · {captions.length} caption{captions.length === 1 ? '' : 's'} ·{' '}
                    {outputWidth}×{outputHeight}
                  </span>
                </div>

                <div className="editor-makegif-field">
                  <label className="editor-makegif-field-label" htmlFor="makegif-name-input">
                    GIF name
                  </label>
                  <input
                    id="makegif-name-input"
                    ref={nameInputRef}
                    className={`editor-makegif-field-input ${nameError ? 'error' : ''}`}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      if (nameError) setNameError(false)
                    }}
                    aria-invalid={nameError || undefined}
                  />
                  {nameError && (
                    <p className="editor-makegif-field-error" role="alert">
                      Give your GIF a name before making it
                    </p>
                  )}
                </div>

                {/* Flow A only — flow B never shows a save/overwrite
                    option, not even for the template's own creator. */}
                {source.kind === 'video' && (
                  /* A plain <div> "card" — not itself a button, since it
                     needs to contain real interactive children (the
                     template-name input, the share switch) once expanded,
                     and a <button> can't legally contain those (the
                     browser silently breaks the DOM if it does). Only the
                     collapsed toggle row is the actual role="checkbox"
                     button. */
                  <div className={`editor-makegif-template-card ${saveAsTemplate ? 'checked' : ''}`}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={saveAsTemplate}
                      className="editor-makegif-template-card-toggle"
                      onClick={() => setSaveAsTemplate((v) => !v)}
                    >
                      <span className={`editor-makegif-checkbox ${saveAsTemplate ? 'checked' : ''}`} aria-hidden="true">
                        {saveAsTemplate && <CheckIcon size={13} />}
                      </span>
                      <span className="editor-makegif-template-card-copy">
                        <span className="editor-makegif-template-card-title">
                          <BookmarkIcon size={14} />
                          Also save as a template
                        </span>
                        <span className="editor-makegif-template-card-help">Keep the trim and captions for next time</span>
                      </span>
                    </button>

                    {saveAsTemplate && (
                      <div className="editor-makegif-template-fields">
                        <div className="editor-makegif-field">
                          <label className="editor-makegif-field-label" htmlFor="makegif-template-name">
                            Template name
                          </label>
                          <input
                            id="makegif-template-name"
                            ref={templateNameInputRef}
                            className={`editor-makegif-field-input ${templateNameError ? 'error' : ''}`}
                            value={templateName}
                            onChange={(e) => {
                              setTemplateName(e.target.value)
                              if (templateNameError) setTemplateNameError(false)
                            }}
                            aria-invalid={templateNameError || undefined}
                          />
                          {templateNameError && (
                            <p className="editor-makegif-field-error" role="alert">
                              Give your template a name before saving it
                            </p>
                          )}
                        </div>

                        <div className="editor-makegif-public-row">
                          <div>
                            <p className="archive-settings-title">Share template</p>
                            <p className="archive-settings-help">Everyone can find it under Shared</p>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={templateIsPublic}
                            aria-label="Share template"
                            className={`archive-switch ${templateIsPublic ? 'on' : ''}`}
                            onClick={() => setTemplateIsPublic((v) => !v)}
                          >
                            <span className="archive-switch-knob" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="editor-makegif-popover-actions">
                  <button type="button" className="btn btn-secondary" onClick={closeMakeGifPopover}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-primary" onClick={makeGif}>
                    {saveAsTemplate ? 'Make GIF & save template' : 'Make GIF'}
                  </button>
                </div>
              </div>
            )}
          </div>
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
            <div className="editor-timecode">
              <div
                ref={timecodeWrapRef}
                className={`editor-timecode-stepper ${isEditingTime ? 'editing' : ''} ${timeDraftOutOfRange ? 'invalid' : ''}`}
                onMouseEnter={handleTimecodeMouseEnter}
                onMouseLeave={handleTimecodeMouseLeave}
              >
                <button
                  type="button"
                  className="editor-timecode-step-btn"
                  aria-label="Back 0.01 seconds"
                  onClick={(e) => stepTime(e.shiftKey ? -0.1 : -0.01)}
                >
                  <ChevronLeftIcon size={14} />
                </button>

                {isEditingTime ? (
                  <input
                    ref={timeInputRef}
                    className="editor-timecode-value editor-timecode-input"
                    value={timeDraft}
                    onChange={(e) => handleTimeDraftChange(e.target.value)}
                    onKeyDown={handleTimeInputKeyDown}
                    onBlur={handleTimeInputBlur}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Edit current time"
                    autoFocus
                  />
                ) : (
                  <span
                    className="editor-timecode-value editor-timecode-current"
                    role="button"
                    tabIndex={0}
                    onClick={enterTimeEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        enterTimeEdit()
                      }
                    }}
                    aria-label="Current time, click to edit"
                  >
                    {formatTimecode(currentTime)}
                  </span>
                )}

                <button
                  type="button"
                  className="editor-timecode-step-btn"
                  aria-label="Forward 0.01 seconds"
                  onClick={(e) => stepTime(e.shiftKey ? 0.1 : 0.01)}
                >
                  <ChevronRightIcon size={14} />
                </button>

                {showTimecodeTooltip && !isEditingTime && (
                  <div className="editor-timecode-tooltip" role="tooltip">
                    <p className="editor-timecode-tooltip-title">Click to type a time</p>
                    <p className="editor-timecode-tooltip-subtitle">While your pointer is here:</p>
                    <p className="editor-timecode-tooltip-row">
                      <kbd>↑</kbd> <kbd>→</kbd> forward 0.01s
                    </p>
                    <p className="editor-timecode-tooltip-row">
                      <kbd>↓</kbd> <kbd>←</kbd> back 0.01s
                    </p>
                    <p className="editor-timecode-tooltip-row">
                      <kbd>Shift</kbd> + arrow: 0.1s
                    </p>
                  </div>
                )}

                {isEditingTime &&
                  (timeDraftOutOfRange ? (
                    <p className="editor-timecode-hint editor-timecode-hint-error">
                      Clip is {duration.toFixed(2)}s long. Try {formatTimecode(0)} – {formatTimecode(duration)}
                    </p>
                  ) : (
                    <p className="editor-timecode-hint">
                      <kbd>Enter</kbd> confirm · <kbd>Esc</kbd> cancel · <kbd>↑</kbd> <kbd>↓</kbd> nudge
                    </p>
                  ))}
              </div>
              <span className="editor-timecode-total"> / {formatTimecode(duration)}</span>
            </div>
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
            {isTemplateSource && <span className="editor-trim-locked-tag">Locked</span>}
          </div>
          {!isTemplateSource && (
            <>
              <button className="btn btn-secondary" onClick={setRangeStartToPlayhead}>
                Trim start
              </button>
              <button className="btn btn-secondary" onClick={setRangeEndToPlayhead}>
                Trim end
              </button>
            </>
          )}
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

            <div
              className="va-filmstrip-wrap"
              style={{ height: FILMSTRIP_HEIGHT + PLAYHEAD_ADD_CLEARANCE + PLAYHEAD_LABEL_CLEARANCE }}
            >
              <div
                className="va-filmstrip"
                style={{ width: timelineWidth, height: FILMSTRIP_HEIGHT, marginTop: PLAYHEAD_LABEL_CLEARANCE }}
                onClick={scrubTo}
              >
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
                  {!isTemplateSource && (
                    <>
                      <div className="va-range-handle" style={{ left: -5 }} onMouseDown={(e) => startRangeDrag(e, 'start')} />
                      <div className="va-range-handle" style={{ right: -5 }} onMouseDown={(e) => startRangeDrag(e, 'end')} />
                    </>
                  )}
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
                style={{
                  left: timeToX(currentTime, duration, timelineWidth),
                  top: PLAYHEAD_LABEL_CLEARANCE + FILMSTRIP_HEIGHT + 4,
                }}
                aria-label="Add caption at playhead"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={addCaption}
              >
                +
              </button>
              {/* Rides the playhead itself (same timeToX value) so the two
                  obviously move together as you step through the clip. */}
              <div
                className="va-playhead-label"
                style={{ left: timeToX(currentTime, duration, timelineWidth), top: 0 }}
              >
                {formatTimecode(currentTime)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
