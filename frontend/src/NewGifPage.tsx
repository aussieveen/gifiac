import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  deleteTemplateById,
  getTemplateDetail,
  listMyTemplates,
  listOtherTemplates,
  renameTemplate,
  setTemplatePublic,
  templateThumbnailUrl,
  uploadVideo,
} from './api'
import { PencilIcon, PlusIcon, TrashIcon, XIcon } from './icons'
import { IngestModalPrototype, IngestPrototypeSwitcher, type VariantKey } from './prototype/IngestModalPrototype'
import type { TemplateDetail, TemplateSummary, Video } from './types'

interface Props {
  /** A fresh upload always starts flow A (fresh edit, full timeline). */
  onUploaded: (video: Video) => void
  /** Picking a template (own or someone else's) always starts flow B
   * (locked trim range/dimensions, "start from a template"). */
  onStartFromTemplate: (templateId: string) => void
}

type Pill = 'all' | 'mine' | 'shared'

/** A `TemplateSummary` tagged with whether the current viewer owns it —
 * needed once "All" merges both lists, since the sub-line and detail-pane
 * owner controls both depend on it. */
interface DisplayTemplate extends TemplateSummary {
  isOwn: boolean
}

function parsePill(value: string | null): Pill {
  return value === 'mine' || value === 'shared' ? value : 'all'
}

/**
 * The redesigned "New GIF" page — public templates, pass 2 (Flow 2 mock).
 * Three pills (All / Mine / Shared, URL-synced via `?show=`) over a
 * borderless thumbnail grid — the "Upload a video" tile always leads —
 * with a detail panel showing the selected template's preview, captions,
 * and (owner-only) rename/share/delete controls.
 */
export function NewGifPage({ onUploaded, onStartFromTemplate }: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const pill = parsePill(searchParams.get('show'))

  const [myTemplates, setMyTemplates] = useState<TemplateSummary[]>([])
  const [otherTemplates, setOtherTemplates] = useState<TemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TemplateDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [togglingPublic, setTogglingPublic] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  // PROTOTYPE — wayfinder gifiac#38. Dev-only; see frontend/src/prototype/.
  const protoVariant = (searchParams.get('variant') as VariantKey) ?? 'A'
  const [protoReplayKey, setProtoReplayKey] = useState(0)
  const [protoPreviewing, setProtoPreviewing] = useState(false)

  const mine: DisplayTemplate[] = myTemplates.map((t) => ({ ...t, isOwn: true }))
  const shared: DisplayTemplate[] = otherTemplates.map((t) => ({ ...t, isOwn: false }))
  const all: DisplayTemplate[] = [...mine, ...shared].sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1))
  const listFor = (p: Pill) => (p === 'mine' ? mine : p === 'shared' ? shared : all)
  const templates = listFor(pill)

  useEffect(() => {
    let cancelled = false
    Promise.all([listMyTemplates(), listOtherTemplates()])
      .then(([myList, otherList]) => {
        if (cancelled) return
        setMyTemplates(myList)
        setOtherTemplates(otherList)
        const initial = pill === 'mine' ? myList : pill === 'shared' ? otherList : [...myList, ...otherList]
        setSelectedId(initial.length > 0 ? initial[0].id : null)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Only ever runs once on mount — the initial pill is read once here;
    // switching pills afterward goes through selectPill below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    setActionError(null)
    setRenaming(false)
    getTemplateDetail(selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus()
  }, [renaming])

  // Whole-page drop target, in addition to the upload tile itself.
  useEffect(() => {
    function onDragOver(e: DragEvent) {
      e.preventDefault()
      setDragActive(true)
    }
    function onDragLeave(e: DragEvent) {
      if (!e.relatedTarget) setDragActive(false)
    }
    function onDrop(e: DragEvent) {
      e.preventDefault()
      setDragActive(false)
      handleFiles(e.dataTransfer?.files ?? null)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function selectPill(next: Pill) {
    setSearchParams(next === 'all' ? {} : { show: next }, { replace: true })
    const list = listFor(next)
    // Keep the current selection if it's still in the new list; otherwise
    // fall back to that list's first template.
    setSelectedId((current) => {
      if (current && list.some((t) => t.id === current)) return current
      return list.length > 0 ? list[0].id : null
    })
  }

  async function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      const video = await uploadVideo(file)
      onUploaded(video)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  function startRename() {
    if (!detail) return
    setNameDraft(detail.name)
    setRenaming(true)
  }

  async function saveRename() {
    if (!detail) return
    const trimmed = nameDraft.trim()
    setRenaming(false)
    if (!trimmed || trimmed === detail.name) return
    setActionError(null)
    try {
      const updated = await renameTemplate(detail.id, trimmed)
      setDetail(updated)
      setMyTemplates((ts) => ts.map((t) => (t.id === updated.id ? { ...t, name: updated.name } : t)))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  async function togglePublic() {
    if (!detail) return
    setTogglingPublic(true)
    setActionError(null)
    try {
      const updated = await setTemplatePublic(detail.id, !detail.is_public)
      setDetail(updated)
      setMyTemplates((ts) => ts.map((t) => (t.id === updated.id ? { ...t, is_public: updated.is_public } : t)))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setTogglingPublic(false)
    }
  }

  async function handleDelete() {
    if (!detail) return
    if (!window.confirm(`Delete "${detail.name}"? This can't be undone.`)) return
    setDeleting(true)
    setActionError(null)
    try {
      await deleteTemplateById(detail.id)
      setMyTemplates((ts) => ts.filter((t) => t.id !== detail.id))
      setSelectedId(null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="page newgif-page">
      <h1 className="page-title">New GIF</h1>
      <p className="subtitle">Upload a video to start from scratch, or pick a template to change.</p>

      <div className="newgif-pills" role="tablist" aria-label="Template source">
        <button
          type="button"
          role="tab"
          aria-selected={pill === 'all'}
          className={`newgif-pill ${pill === 'all' ? 'selected' : ''}`}
          onClick={() => selectPill('all')}
        >
          All
          <span className="newgif-pill-count">{all.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pill === 'mine'}
          className={`newgif-pill ${pill === 'mine' ? 'selected' : ''}`}
          onClick={() => selectPill('mine')}
        >
          Mine
          <span className="newgif-pill-count">{mine.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pill === 'shared'}
          className={`newgif-pill ${pill === 'shared' ? 'selected' : ''}`}
          onClick={() => selectPill('shared')}
        >
          Shared
          <span className="newgif-pill-count">{shared.length}</span>
        </button>
      </div>

      {loading && <p className="va-hint">Loading templates…</p>}
      {loadError && <p className="export-error">{loadError}</p>}
      {uploadError && <p className="export-error">{uploadError}</p>}

      {/* PROTOTYPE — wayfinder gifiac#38, dev-only. Delete with the rest of frontend/src/prototype/. */}
      {import.meta.env.DEV && (
        <>
          <button
            type="button"
            className="proto-ingest-preview-btn"
            onClick={() => {
              setProtoReplayKey((k) => k + 1)
              setProtoPreviewing(true)
              setTimeout(() => setProtoPreviewing(false), 5000)
            }}
          >
            ▶ Preview ingest modal (variant {protoVariant})
          </button>
          <IngestPrototypeSwitcher
            variant={protoVariant}
            onChange={(v) => setSearchParams((prev) => ({ ...Object.fromEntries(prev), variant: v }), { replace: true })}
            onReplay={() => setProtoReplayKey((k) => k + 1)}
          />
        </>
      )}

      <div className="newgif-layout">
        <div className="newgif-grid">
          <div
            className={`newgif-upload-tile ${dragActive ? 'drag-active' : ''}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              handleFiles(e.dataTransfer.files)
            }}
          >
            {import.meta.env.DEV && (uploading || protoPreviewing) && protoVariant === 'B' ? (
              <IngestModalPrototype key={protoReplayKey} variant="B" active={true} />
            ) : uploading ? (
              <span className="newgif-upload-title">Uploading…</span>
            ) : (
              <label className="newgif-upload-label">
                <span className="newgif-upload-icon">
                  <PlusIcon size={18} />
                </span>
                <span className="newgif-upload-title">Upload a video</span>
                <span className="newgif-upload-subtitle">or drop it anywhere</span>
                <input type="file" accept="video/*" onChange={(e) => handleFiles(e.target.files)} hidden />
              </label>
            )}
          </div>

          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              className="newgif-template-tile"
              onClick={() => setSelectedId(t.id)}
              aria-pressed={selectedId === t.id}
            >
              <span className={`newgif-template-thumb-wrap ${selectedId === t.id ? 'selected' : ''}`}>
                <img src={templateThumbnailUrl(t.id)} alt="" className="newgif-template-thumb" />
                <span className="newgif-template-duration">{t.duration_seconds.toFixed(1)}s</span>
              </span>
              <span className="newgif-template-name">{t.name}</span>
              <span className="newgif-template-subline">
                {t.caption_count} caption{t.caption_count === 1 ? '' : 's'}
                {!t.isOwn && t.owner_handle ? ` · shared by @${t.owner_handle}` : ''}
              </span>
            </button>
          ))}

          {!loading && templates.length === 0 && (
            <div className="newgif-empty">
              {pill === 'shared' ? (
                <>
                  <p className="newgif-empty-title">Nobody has shared a template yet.</p>
                  <p className="newgif-empty-subtitle">Public templates from other people will show up here.</p>
                </>
              ) : (
                <>
                  <p className="newgif-empty-title">No templates yet</p>
                  <p className="newgif-empty-subtitle">
                    When you make a GIF, tick "Also save as a template" to keep its captions for next time.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {(detail || detailLoading || detailError) && (
          <div className="newgif-panel">
            {detailLoading ? (
              <p className="va-hint">Loading template…</p>
            ) : detailError ? (
              <p className="export-error">{detailError}</p>
            ) : detail ? (
              <>
                <div className="newgif-panel-preview-wrap">
                  <img
                    key={detail.id}
                    className="newgif-panel-preview"
                    src={templateThumbnailUrl(detail.id)}
                    alt={`${detail.name} preview`}
                  />
                  <button
                    type="button"
                    className="newgif-panel-close"
                    aria-label="Close"
                    onClick={() => setSelectedId(null)}
                  >
                    <XIcon size={14} />
                  </button>
                </div>

                <div className="newgif-panel-name-block">
                  <div className="newgif-panel-name-row">
                    {renaming ? (
                      <input
                        ref={renameInputRef}
                        className="newgif-panel-name-input"
                        aria-label="Template name"
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onBlur={saveRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') setRenaming(false)
                        }}
                      />
                    ) : (
                      <h2 className="newgif-panel-name">{detail.name}</h2>
                    )}
                    {detail.is_own && !renaming && (
                      <button type="button" className="newgif-panel-rename-btn" aria-label="Rename template" onClick={startRename}>
                        <PencilIcon size={14} />
                      </button>
                    )}
                  </div>
                  {!detail.is_own && detail.owner_handle && (
                    <p className="newgif-panel-owner">
                      Shared by <span className="newgif-panel-owner-handle">@{detail.owner_handle}</span>
                    </p>
                  )}
                </div>

                {actionError && <p className="export-error">{actionError}</p>}

                {detail.captions.length > 0 && (
                  <div className="newgif-panel-captions">
                    <p className="newgif-panel-captions-label">Captions in this template · you can change them</p>
                    <div className="newgif-caption-chips">
                      {detail.captions.map((c) => (
                        <span key={c.id} className="newgif-caption-chip">
                          {c.text.trim() || '(empty)'}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <button type="button" className="btn btn-primary newgif-start-btn" onClick={() => onStartFromTemplate(detail.id)}>
                  <PencilIcon size={16} />
                  Start from template
                </button>

                {detail.is_own && (
                  <>
                    <div className="archive-settings-list">
                      <div className="archive-settings-row">
                        <div>
                          <p className="archive-settings-title">Share template</p>
                          <p className="archive-settings-help">Everyone can find it under Shared</p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={detail.is_public}
                          aria-label="Share template"
                          className={`archive-switch ${detail.is_public ? 'on' : ''}`}
                          disabled={togglingPublic}
                          onClick={togglePublic}
                        >
                          <span className="archive-switch-knob" />
                        </button>
                      </div>
                    </div>
                    <hr className="newgif-panel-divider" />
                    <button type="button" className="btn btn-danger" disabled={deleting} onClick={handleDelete}>
                      <TrashIcon size={14} />
                      {deleting ? 'Deleting…' : 'Delete template'}
                    </button>
                  </>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* PROTOTYPE — wayfinder gifiac#38. Variants A/C render as overlays above everything else; variant B replaces the tile's own content instead (wired above). */}
      {import.meta.env.DEV && (uploading || protoPreviewing) && (protoVariant === 'A' || protoVariant === 'C') && (
        <IngestModalPrototype key={protoReplayKey} variant={protoVariant} active={true} />
      )}
    </div>
  )
}
