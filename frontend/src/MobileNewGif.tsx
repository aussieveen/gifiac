import { useState, type RefObject } from 'react'
import { templateThumbnailUrl } from './api'
import { BottomSheet } from './BottomSheet'
import { MoreIcon, PencilIcon, TrashIcon, UploadIcon } from './icons'
import type { TemplateDetail, TemplateSummary } from './types'

export type MobilePill = 'all' | 'mine' | 'shared'

export interface MobileTemplate extends TemplateSummary {
  isOwn: boolean
}

export interface MobileNewGifProps {
  pill: MobilePill
  counts: Record<MobilePill, number>
  onSelectPill: (pill: MobilePill) => void
  templates: MobileTemplate[]
  loading: boolean
  loadError: string | null
  uploadError: string | null
  fileInputRef: RefObject<HTMLInputElement | null>
  onFiles: (files: FileList | null) => void
  onOpenTemplate: (id: string) => void
  sheet: {
    open: boolean
    detail: TemplateDetail | null
    loading: boolean
    error: string | null
    actionError: string | null
    renaming: boolean
    nameDraft: string
    renameInputRef: RefObject<HTMLInputElement | null>
    togglingPublic: boolean
    deleting: boolean
    onClose: () => void
    onStart: (id: string) => void
    onStartRename: () => void
    onNameDraftChange: (value: string) => void
    onSaveRename: () => void
    onCancelRename: () => void
    onTogglePublic: () => void
    onDelete: () => void
  }
}

const PILLS: { key: MobilePill; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Mine' },
  { key: 'shared', label: 'Shared' },
]

function captionCount(t: TemplateSummary): string {
  return `${t.caption_count} caption${t.caption_count === 1 ? '' : 's'}`
}

function TemplateSheet({ sheet, onStart }: { sheet: MobileNewGifProps['sheet']; onStart: (id: string) => void }) {
  const { detail } = sheet
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <BottomSheet label="Template" onClose={sheet.onClose}>
      {sheet.loading || !detail ? (
        sheet.error ? (
          <p className="export-error">{sheet.error}</p>
        ) : (
          <p className="va-hint">Loading template…</p>
        )
      ) : (
        <>
          <div className="m-template-preview">
            <img src={templateThumbnailUrl(detail.id)} alt={`${detail.name} preview`} />
            {detail.captions[0] && <span className="m-template-preview-caption">{detail.captions[0].text.trim()}</span>}
            <span className="m-template-duration">{detail.duration_seconds.toFixed(1)}s</span>
          </div>

          <div className="m-template-title-row">
            <div className="m-template-title-block">
              {sheet.renaming ? (
                <input
                  ref={sheet.renameInputRef}
                  className="m-template-name-input"
                  aria-label="Template name"
                  value={sheet.nameDraft}
                  onChange={(e) => sheet.onNameDraftChange(e.target.value)}
                  onBlur={sheet.onSaveRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') sheet.onCancelRename()
                  }}
                />
              ) : (
                <h2 className="m-template-name">{detail.name}</h2>
              )}
              {!detail.is_own && detail.owner_handle && (
                <p className="m-template-owner">
                  Shared by <strong>@{detail.owner_handle}</strong>
                </p>
              )}
            </div>
            {detail.is_own && (
              <div className="m-template-menu-wrap">
                <button
                  type="button"
                  className="m-icon-btn"
                  aria-label="Template actions"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((o) => !o)}
                >
                  <MoreIcon size={18} />
                </button>
                {menuOpen && (
                  <div className="m-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="m-menu-item"
                      onClick={() => {
                        setMenuOpen(false)
                        sheet.onStartRename()
                      }}
                    >
                      <PencilIcon size={14} /> Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="m-menu-item"
                      disabled={sheet.togglingPublic}
                      onClick={() => {
                        setMenuOpen(false)
                        sheet.onTogglePublic()
                      }}
                    >
                      {detail.is_public ? 'Stop sharing' : 'Share template'}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="m-menu-item m-menu-item-danger"
                      disabled={sheet.deleting}
                      onClick={() => {
                        setMenuOpen(false)
                        sheet.onDelete()
                      }}
                    >
                      <TrashIcon size={14} /> Delete template
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {sheet.actionError && <p className="export-error">{sheet.actionError}</p>}

          {detail.captions.length > 0 && (
            <div className="m-template-captions">
              <p className="m-template-captions-label">Captions · you can change them</p>
              <div className="m-template-chips">
                {detail.captions.map((c) => (
                  <span key={c.id} className="m-template-chip">
                    {c.text.trim() || '(empty)'}
                  </span>
                ))}
              </div>
            </div>
          )}

          <button type="button" className="btn btn-primary m-sheet-primary" onClick={() => onStart(detail.id)}>
            Start from template
          </button>
          <button type="button" className="m-sheet-text-btn" onClick={sheet.onClose}>
            Close
          </button>
        </>
      )}
    </BottomSheet>
  )
}

/** Phone layout of the New GIF page (MOBILE.md §2/§4): an upload card, the
 * All/Mine/Shared pills, a two-column template grid, and the template
 * bottom sheet in place of the desktop side panel. All state lives in
 * `NewGifPage`; this only renders it. */
export function MobileNewGif(props: MobileNewGifProps) {
  const { pill, counts, templates, sheet } = props

  return (
    <div className="m-newgif">
      <div className="m-newgif-heading">
        <h1 className="m-newgif-title">New GIF</h1>
        <p className="m-newgif-subtitle">Upload a video, or start from a template.</p>
      </div>

      <button type="button" className="m-upload-card" onClick={() => props.fileInputRef.current?.click()}>
        <span className="m-upload-card-icon">
          <UploadIcon size={22} />
        </span>
        <span className="m-upload-card-text">
          <span className="m-upload-card-title">Upload a video</span>
          <span className="m-upload-card-sub">From your photos or files · up to 200 MB</span>
        </span>
      </button>
      <input
        ref={props.fileInputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          props.onFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {props.uploadError && <p className="export-error">{props.uploadError}</p>}

      <div className="m-pills" role="tablist" aria-label="Template source">
        {PILLS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={pill === key}
            className={`m-pill ${pill === key ? 'selected' : ''}`}
            onClick={() => props.onSelectPill(key)}
          >
            {label}
            <span className="m-pill-count">{counts[key]}</span>
          </button>
        ))}
      </div>

      {props.loading && <p className="va-hint">Loading templates…</p>}
      {props.loadError && <p className="export-error">{props.loadError}</p>}

      <div className="m-template-grid">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            className="m-template-tile"
            aria-label={t.name}
            onClick={() => props.onOpenTemplate(t.id)}
          >
            <span className="m-template-thumb">
              <img src={templateThumbnailUrl(t.id)} alt="" />
              {t.first_caption_text && <span className="m-template-thumb-caption">{t.first_caption_text}</span>}
              <span className="m-template-thumb-duration">{t.duration_seconds.toFixed(1)}s</span>
            </span>
            <span className="m-template-tile-name">{t.name}</span>
            <span className="m-template-tile-sub">
              {captionCount(t)}
              {!t.isOwn && t.owner_handle ? ` · @${t.owner_handle}` : ''}
            </span>
          </button>
        ))}
      </div>

      {!props.loading && templates.length === 0 && (
        <p className="va-hint m-newgif-empty">
          {pill === 'shared' ? 'Nobody has shared a template yet.' : 'No templates yet.'}
        </p>
      )}

      {sheet.open && <TemplateSheet sheet={sheet} onStart={sheet.onStart} />}
    </div>
  )
}
