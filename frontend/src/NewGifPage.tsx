import { useEffect, useState } from 'react'
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
import { PlusIcon, TrashIcon } from './icons'
import type { TemplateDetail, TemplateSummary, Video } from './types'

interface Props {
  /** A fresh upload always starts flow A (fresh edit, full timeline). */
  onUploaded: (video: Video) => void
  /** Picking a template (own or someone else's) always starts flow B
   * (locked trim range/dimensions, "start from a template"). */
  onStartFromTemplate: (templateId: string) => void
}

type Tab = 'mine' | 'others'

/**
 * The redesigned "New GIF" page — public templates, pass 2. Replaces the
 * old video-picker's list of previously-uploaded videos entirely
 * (uploading is now a one-shot, single-session action; a saved template
 * is the only way to revisit footage later) with a templates browser: an
 * "Upload a video" tile plus two tabs, own templates and public ones from
 * other users, each opening a detail pane with a "Start from template"
 * action.
 */
export function NewGifPage({ onUploaded, onStartFromTemplate }: Props) {
  const [tab, setTab] = useState<Tab>('mine')
  const [myTemplates, setMyTemplates] = useState<TemplateSummary[]>([])
  const [otherTemplates, setOtherTemplates] = useState<TemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TemplateDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [togglingPublic, setTogglingPublic] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([listMyTemplates(), listOtherTemplates()])
      .then(([mine, others]) => {
        if (cancelled) return
        setMyTemplates(mine)
        setOtherTemplates(others)
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

  async function rename(newName: string) {
    if (!detail) return
    const trimmed = newName.trim()
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

  const templates = tab === 'mine' ? myTemplates : otherTemplates

  return (
    <div className="page">
      <h1 className="page-title">New GIF</h1>
      <p className="subtitle">Upload a video to start from scratch, or pick a template to change.</p>

      <div className="mode-toggle" role="group" aria-label="Template source">
        <button
          type="button"
          className={tab === 'mine' ? 'active' : ''}
          onClick={() => {
            setTab('mine')
            setSelectedId(null)
          }}
        >
          My templates
          <span className="archive-count">{myTemplates.length}</span>
        </button>
        <button
          type="button"
          className={tab === 'others' ? 'active' : ''}
          onClick={() => {
            setTab('others')
            setSelectedId(null)
          }}
        >
          From others
          <span className="archive-count">{otherTemplates.length}</span>
        </button>
      </div>

      {loading && <p className="va-hint">Loading templates…</p>}
      {loadError && <p className="export-error">{loadError}</p>}

      <div className={`archive-layout ${selectedId ? 'has-selection' : ''}`}>
        <div className="video-grid">
          {tab === 'mine' && (
            <div
              className="dropzone video-card video-card-upload"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                handleFiles(e.dataTransfer.files)
              }}
            >
              {uploading ? (
                <span>Uploading…</span>
              ) : (
                <label className="dropzone-label">
                  <PlusIcon size={20} />
                  Upload a video
                  <span className="va-hint">or drop it anywhere</span>
                  <input type="file" accept="video/*" onChange={(e) => handleFiles(e.target.files)} hidden />
                </label>
              )}
            </div>
          )}
          {templates.map((t) => (
            <div key={t.id} className={`video-card ${selectedId === t.id ? 'selected' : ''}`}>
              <button type="button" className="video-card-select" onClick={() => setSelectedId(t.id)}>
                <img src={templateThumbnailUrl(t.id)} alt={t.name} />
                <span className="video-card-badge-template">{t.duration_seconds.toFixed(1)}s</span>
                <span className="video-card-name">{t.name}</span>
                <span className="va-hint">
                  {t.caption_count} caption{t.caption_count === 1 ? '' : 's'}
                  {t.owner_handle ? ` · by ${t.owner_handle}` : ''}
                </span>
              </button>
            </div>
          ))}
          {!loading && templates.length === 0 && tab === 'others' && (
            <p className="va-hint">No public templates from other users yet.</p>
          )}
        </div>

        <div className="archive-panel">
          {uploadError && <p className="export-error">{uploadError}</p>}
          {!selectedId ? (
            <div className="archive-panel-empty">
              <p className="va-hint">Select a template to view details and start a GIF.</p>
            </div>
          ) : detailLoading ? (
            <p className="va-hint">Loading template…</p>
          ) : detailError ? (
            <p className="export-error">{detailError}</p>
          ) : detail ? (
            <>
              <div className="archive-panel-preview-wrap">
                <img
                  key={detail.id}
                  className="archive-panel-preview"
                  src={templateThumbnailUrl(detail.id)}
                  alt={`${detail.name} preview`}
                />
              </div>
              <div className="archive-panel-header">
                {detail.is_own ? (
                  <input
                    className="archive-panel-name"
                    aria-label="Template name"
                    defaultValue={detail.name}
                    key={`name-${detail.id}`}
                    onBlur={(e) => rename(e.target.value)}
                  />
                ) : (
                  <p className="archive-panel-title-text">{detail.name}</p>
                )}
              </div>

              {!detail.is_own && detail.owner_handle && <p className="va-hint">by {detail.owner_handle}</p>}

              {actionError && <p className="export-error">{actionError}</p>}

              {detail.captions.length > 0 && (
                <>
                  <p className="va-hint">Captions in this template — you can change them</p>
                  <div className="archive-chips" aria-hidden="true">
                    {detail.captions.map((c) => (
                      <span key={c.id} className="archive-chip">
                        {c.text || '(empty)'}
                      </span>
                    ))}
                  </div>
                </>
              )}

              <button type="button" className="btn btn-primary" onClick={() => onStartFromTemplate(detail.id)}>
                Start from template
              </button>

              {detail.is_own && (
                <>
                  <div className="archive-settings-list">
                    <div className="archive-settings-row">
                      <div>
                        <p className="archive-settings-title">Public</p>
                        <p className="archive-settings-help">Others can find it under "From others"</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={detail.is_public}
                        aria-label="Public"
                        className={`archive-switch ${detail.is_public ? 'on' : ''}`}
                        disabled={togglingPublic}
                        onClick={togglePublic}
                      >
                        <span className="archive-switch-knob" />
                      </button>
                    </div>
                  </div>
                  <button type="button" className="btn btn-secondary archive-panel-delete" disabled={deleting} onClick={handleDelete}>
                    <TrashIcon size={14} />
                    Delete template
                  </button>
                </>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
