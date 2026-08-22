import { useEffect, useState } from 'react'
import { getFilmstripMeta } from './api'
import { CaptionEditor } from './CaptionEditor'
import type { FilmstripMeta, Video } from './types'
import { VideoPicker } from './VideoPicker'

export default function App() {
  const [video, setVideo] = useState<Video | null>(null)
  const [filmstrip, setFilmstrip] = useState<FilmstripMeta | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    // Reset before fetching so a video switch can't render the new video
    // against the previous one's stale film-strip while the new one loads.
    setFilmstrip(null)
    if (!video) return
    let cancelled = false
    setLoadError(null)
    getFilmstripMeta(video.id)
      .then((meta) => {
        if (!cancelled) setFilmstrip(meta)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [video])

  function backToLibrary() {
    setVideo(null)
    setLoadError(null)
  }

  if (!video) {
    return <VideoPicker onSelect={setVideo} />
  }

  if (loadError) {
    return (
      <div className="page">
        <button className="back-link" onClick={backToLibrary}>
          ← back to library
        </button>
        <p className="export-error">Failed to load film-strip: {loadError}</p>
      </div>
    )
  }

  if (!filmstrip) {
    return (
      <div className="page">
        <p className="va-hint">Loading film-strip…</p>
      </div>
    )
  }

  return <CaptionEditor video={video} filmstrip={filmstrip} onBack={backToLibrary} />
}
