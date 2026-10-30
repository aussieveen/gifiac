import { useEffect, useState } from 'react'
import { BottomSheet } from './BottomSheet'
import { BookmarkIcon, CheckIcon } from './icons'
import type { CaptionEditorState } from './useCaptionEditor'

/** The visible viewport's height while the on-screen keyboard is up, so the
 * sheet can shrink to what's actually visible and keep its field and main
 * button on screen. `null` where `visualViewport` isn't available. */
function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(() => window.visualViewport?.height ?? null)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    function onResize() {
      setHeight(viewport!.height)
      document.activeElement?.scrollIntoView?.({ block: 'nearest' })
    }
    viewport.addEventListener('resize', onResize)
    return () => viewport.removeEventListener('resize', onResize)
  }, [])
  return height
}

/** The Make GIF dialog as a bottom sheet (MOBILE.md §7): same fields, checks
 * and actions as the desktop popover. */
export function MobileMakeSheet({ editor }: { editor: CaptionEditorState }) {
  const {
    source,
    captions,
    outputWidth,
    outputHeight,
    trimmedDuration,
    name,
    setName,
    nameError,
    setNameError,
    nameInputRef,
    saveAsTemplate,
    setSaveAsTemplate,
    templateName,
    setTemplateName,
    templateNameError,
    setTemplateNameError,
    templateNameInputRef,
    templateIsPublic,
    setTemplateIsPublic,
    closeMakeGifPopover,
    makeGif,
  } = editor
  const viewportHeight = useVisualViewportHeight()

  return (
    <BottomSheet
      label="Make GIF"
      onClose={closeMakeGifPopover}
      maxHeight={viewportHeight ? Math.floor(viewportHeight * 0.9) : undefined}
    >
      <div className="m-make-header">
        <h2 className="m-make-title">Make GIF</h2>
        <span className="m-make-summary">
          {trimmedDuration.toFixed(2)}s · {captions.length} caption{captions.length === 1 ? '' : 's'} · {outputWidth}×
          {outputHeight}
        </span>
      </div>

      <div className="m-field">
        <label className="m-field-label" htmlFor="m-make-name">
          GIF name
        </label>
        <input
          id="m-make-name"
          ref={nameInputRef}
          className={`m-field-input ${nameError ? 'error' : ''}`}
          value={name}
          autoFocus
          onChange={(e) => {
            setName(e.target.value)
            if (nameError) setNameError(false)
          }}
          aria-invalid={nameError || undefined}
        />
        {nameError && (
          <p className="m-field-error" role="alert">
            Give your GIF a name before making it
          </p>
        )}
      </div>

      {source.kind === 'video' && (
        <div className={`m-template-card ${saveAsTemplate ? 'checked' : ''}`}>
          <button
            type="button"
            role="checkbox"
            aria-checked={saveAsTemplate}
            className="m-template-card-toggle"
            onClick={() => setSaveAsTemplate((v) => !v)}
          >
            <span className={`m-checkbox ${saveAsTemplate ? 'checked' : ''}`} aria-hidden="true">
              {saveAsTemplate && <CheckIcon size={13} />}
            </span>
            <span className="m-template-card-copy">
              <span className="m-template-card-title">
                <BookmarkIcon size={14} />
                Also save as a template
              </span>
              <span className="m-template-card-help">Keep the trim and captions for next time</span>
            </span>
          </button>

          {saveAsTemplate && (
            <div className="m-template-card-fields">
              <div className="m-field">
                <label className="m-field-label" htmlFor="m-make-template-name">
                  Template name
                </label>
                <input
                  id="m-make-template-name"
                  ref={templateNameInputRef}
                  className={`m-field-input ${templateNameError ? 'error' : ''}`}
                  value={templateName}
                  onChange={(e) => {
                    setTemplateName(e.target.value)
                    if (templateNameError) setTemplateNameError(false)
                  }}
                  aria-invalid={templateNameError || undefined}
                />
                {templateNameError && (
                  <p className="m-field-error" role="alert">
                    Give your template a name before saving it
                  </p>
                )}
              </div>
              <div className="m-share-row">
                <div>
                  <p className="m-share-title">Share template</p>
                  <p className="m-share-help">Everyone can find it under Shared</p>
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

      <button type="button" className="btn btn-primary m-sheet-primary" onClick={makeGif}>
        {saveAsTemplate ? 'Make GIF & save template' : 'Make GIF'}
      </button>
      <button type="button" className="m-sheet-text-btn" onClick={closeMakeGifPopover}>
        Cancel
      </button>
    </BottomSheet>
  )
}
