import { useEffect, useState } from 'react'
import { deleteVideo, listVideos, thumbnailUrl, uploadVideo } from './api'
import type { Video } from './types'

interface Props {
  onSelect: (video: Video) => void
}

export function VideoPicker({ onSelect }: Props) {
  const [videos, setVideos] = useState<Video[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    // `loading` already starts true and this effect only ever runs once
    // (empty deps), so there's no re-fetch case to reset it for.
    let cancelled = false
    listVideos()
      .then((vs) => {
        if (!cancelled) setVideos(vs)
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

  async function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      const video = await uploadVideo(file)
      setVideos((vs) => [video, ...vs])
      onSelect(video)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(video: Video) {
    if (!window.confirm(`Delete "${video.original_filename}"? This can't be undone.`)) return
    setDeletingId(video.id)
    setDeleteError(null)
    try {
      await deleteVideo(video.id)
      setVideos((vs) => vs.filter((v) => v.id !== video.id))
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="page">
      <h1>Gifiac</h1>
      <p className="subtitle">Pick a video to caption, or upload a new one.</p>

      <div
        className="dropzone"
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
            Drop a video here, or <span className="dropzone-browse">browse</span>
            <input type="file" accept="video/*" onChange={(e) => handleFiles(e.target.files)} hidden />
          </label>
        )}
      </div>
      {uploadError && <p className="export-error">{uploadError}</p>}

      {loading && <p className="va-hint">Loading videos…</p>}
      {loadError && <p className="export-error">{loadError}</p>}
      {deleteError && <p className="export-error">{deleteError}</p>}

      <div className="video-grid">
        {videos.map((v) => (
          <div key={v.id} className="video-card">
            <button className="video-card-select" onClick={() => onSelect(v)}>
              <img src={thumbnailUrl(v.id)} alt={v.original_filename} />
              {/* SPEC.md §12: "videos with a saved template display a
                  small badge/icon on their card in the video picker". */}
              {v.has_template && (
                <span className="video-card-badge-template" title="Has a saved template">
                  📋
                </span>
              )}
              <span className="video-card-name">{v.original_filename}</span>
              <span className="va-hint">{v.duration_seconds.toFixed(1)}s</span>
            </button>
            <button
              className="video-card-delete"
              aria-label={`Delete "${v.original_filename}"`}
              disabled={deletingId === v.id}
              onClick={() => handleDelete(v)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
