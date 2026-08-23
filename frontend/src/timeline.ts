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

/**
 * Groups `text` into visual lines from a callback that returns the
 * vertical position ("top") of the character at index `i`, or `null` if
 * that position can't be measured (e.g. a collapsed character). A new
 * "top" value more than 1px from the previous measurable one marks the
 * start of a new visual line.
 *
 * This is how a caption's *auto-wrapped* line breaks — the ones the
 * browser inserts because the caption box is too narrow, not ones the
 * user typed — get reconstructed from real rendered layout, so the export
 * (which has no text-layout engine of its own; see backend/src/ass.rs's
 * `line_height` doc comment) can be told exactly where they fall instead
 * of re-wrapping independently and drifting from what the preview showed.
 * The real DOM measurement lives in CaptionEditor's `measureWrappedLines`,
 * which supplies `topForChar` via the Range API — kept out of this
 * function so the grouping logic itself stays unit-testable without a
 * real browser layout engine (jsdom's `getClientRects` doesn't lay out
 * text at all).
 */
export function linesFromCharTops(text: string, topForChar: (i: number) => number | null): string[] {
  if (text.length === 0) return ['']
  const lines: string[] = []
  let lineStart = 0
  let lastTop: number | null = null
  for (let i = 0; i < text.length; i++) {
    const top = topForChar(i)
    if (top === null) continue
    if (lastTop !== null && top > lastTop + 1) {
      lines.push(text.slice(lineStart, i).replace(/\n/g, ''))
      lineStart = i
    }
    lastTop = top
  }
  lines.push(text.slice(lineStart).replace(/\n/g, ''))
  return lines
}

export interface SpriteSheetGrid extends SpriteGrid {
  rows: number
}

/**
 * The full CSS background-* shorthand for cropping one sprite-sheet frame,
 * scaled up or down by `scale`. Shared by the live preview and the
 * film-strip scrubber so their tile math can't drift apart.
 */
export function spriteBackgroundStyle(
  frameIndex: number,
  grid: SpriteSheetGrid,
  imageUrl: string,
  scale: number,
): { backgroundImage: string; backgroundSize: string; backgroundPosition: string } {
  const tile = spriteTileOffset(frameIndex, grid)
  return {
    backgroundImage: `url(${imageUrl})`,
    backgroundSize: `${grid.cols * grid.frameWidth * scale}px ${grid.rows * grid.frameHeight * scale}px`,
    backgroundPosition: `${tile.backgroundPositionX * scale}px ${tile.backgroundPositionY * scale}px`,
  }
}
