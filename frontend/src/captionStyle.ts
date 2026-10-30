/** Quick-select swatches for caption text and outline colour. */
export const SWATCH_COLORS = ['#fff35c', '#00ff99', '#00ccff', '#ff6666', '#9933ff', '#fcfcfc', '#000000']

/** Mirrors the backend's optional ASS outline: `null` renders no border. */
export function outlineTextShadow(outlineColor: string | null, scale: number): string {
  if (!outlineColor) return 'none'
  const o = 2 * scale
  return `${o}px ${o}px 0 ${outlineColor}, -${o}px -${o}px 0 ${outlineColor}, ${o}px -${o}px 0 ${outlineColor}, -${o}px ${o}px 0 ${outlineColor}`
}

export const MIN_LINE_HEIGHT = 0.3
export const MAX_LINE_HEIGHT = 1.5
