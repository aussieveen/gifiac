// Pure time/pixel/sprite math shared by the timeline scrubber, the caption
// tracks, and the live-preview frame lookup. Kept dependency-free so it can
// be unit tested without mounting any component.

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function timeToX(time: number, duration: number, width: number): number {
  if (duration <= 0) return 0
  return (time / duration) * width
}

export function xToTime(x: number, duration: number, width: number): number {
  if (duration <= 0 || width <= 0) return 0
  return clamp((x / width) * duration, 0, duration)
}

/** Which sampled film-strip frame a given playhead time falls into. */
export function frameIndexForTime(time: number, interval: number, frameCount: number): number {
  const maxIndex = Math.max(0, frameCount - 1)
  if (time <= 0) return 0
  return clamp(Math.floor(time / interval), 0, maxIndex)
}

export interface SpriteGrid {
  cols: number
  frameWidth: number
  frameHeight: number
}

/** CSS `background-position` offset (in px) of a frame within the sprite sheet. */
export function spriteTileOffset(
  frameIndex: number,
  grid: SpriteGrid,
): { backgroundPositionX: number; backgroundPositionY: number } {
  const col = frameIndex % grid.cols
  const row = Math.floor(frameIndex / grid.cols)
  return {
    // `|| 0` normalizes `-0` (e.g. col/row 0) to `0` for clean equality
    // checks; CSS treats them identically either way.
    backgroundPositionX: -col * grid.frameWidth || 0,
    backgroundPositionY: -row * grid.frameHeight || 0,
  }
}
