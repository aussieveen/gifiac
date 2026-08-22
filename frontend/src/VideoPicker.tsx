import { useEffect, useState } from 'react'
import { listVideos, thumbnailUrl, uploadVideo } from './api'
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

      <div className="video-grid">
        {videos.map((v) => (
          <button key={v.id} className="video-card" onClick={() => onSelect(v)}>
            <img src={thumbnailUrl(v.id)} alt={v.original_filename} />
            <span className="video-card-name">{v.original_filename}</span>
            <span className="va-hint">{v.duration_seconds.toFixed(1)}s</span>
          </button>
        ))}
      </div>
    </div>
  )
}
