import { useRef, useState } from 'react'
import type { Gif } from './types'

/** Renders one gif's grid-tile preview. This is what the "disable gif
 * autoplay" preference (Preferences.tsx) actually changes — the detail
 * pane (Library.tsx/Archive.tsx's own `<img>`) always loops regardless.
 *
 * `disableAutoplay` off: the plain animating `<img>` every grid always
 * rendered before this existed.
 *
 * `disableAutoplay` on:
 * - A gif with mp4/webm (every uploaded/exported gif) becomes a paused
 *   `<video>`, seeked to its midpoint frame on load, that only plays
 *   while hovered.
 * - A linked gif (external_url set, no mp4/webm) shows its generated
 *   poster-frame thumbnail instead, swapping to the live animating `img`
 *   on hover.
 * - A linked gif with no thumbnail ready yet (still pending, or
 *   generation failed) falls back to the plain animating `<img>` — same
 *   as the preference being off — rather than showing nothing.
 *
 * Touch devices get no hover-preview at all (mouseenter/mouseleave don't
 * fire there the way they do for a mouse) — just the static frame until
 * the tile is tapped, which opens the detail pane.
 */
export function GifThumbnail({
  gif,
  disableAutoplay,
  alt,
  className,
}: {
  gif: Pick<Gif, 'gif_url' | 'mp4_url' | 'webm_url' | 'thumbnail_url'>
  disableAutoplay: boolean
  alt: string
  className?: string
}) {
  const [hovering, setHovering] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  if (!gif.gif_url) return null

  if (!disableAutoplay) {
    return <img src={gif.gif_url} alt={alt} className={className} />
  }

  if (gif.mp4_url && gif.webm_url) {
    return (
      <video
        ref={videoRef}
        className={className}
        muted
        loop
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => {
          const video = e.currentTarget
          video.currentTime = video.duration / 2
        }}
        onMouseEnter={() => videoRef.current?.play()}
        onMouseLeave={() => {
          const video = videoRef.current
          if (!video) return
          video.pause()
          video.currentTime = video.duration / 2
        }}
      >
        <source src={gif.webm_url} type="video/webm" />
        <source src={gif.mp4_url} type="video/mp4" />
      </video>
    )
  }

  if (gif.thumbnail_url) {
    return (
      <img
        src={hovering ? gif.gif_url : gif.thumbnail_url}
        alt={alt}
        className={className}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      />
    )
  }

  return <img src={gif.gif_url} alt={alt} className={className} />
}
