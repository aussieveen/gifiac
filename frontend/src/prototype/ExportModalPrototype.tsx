// PROTOTYPE — throwaway UI exploration for wayfinder gifiac#39 (child of
// map #32). Row content is locked by the map's "Export UI shape"
// decision (rotating icon + live percentage → checkmark, one row per
// format) — what's actually being explored here is WHERE that content
// lives, since CaptionEditor.tsx already has an existing toast pattern
// explicitly anchored near the Make GIF button (see `.editor-toast`'s
// comment), unlike NewGifPage which had no prior art. Mounted into
// CaptionEditor via `?variant=` so it sits against the real editor
// instead of a vacuum. Delete this whole directory (and the
// CaptionEditor wiring) once a variant wins or the losing variants are
// folded away — see NOTES.md.

import { useEffect, useState } from 'react'
import { CheckIcon } from '../icons'

export type ExportFormat = 'gif' | 'mp4' | 'webm'
export type FormatState = { status: 'pending' | 'running' | 'done' | 'error'; percent: number }
export type ExportProgressState = Record<ExportFormat, FormatState>

const FORMAT_LABEL: Record<ExportFormat, string> = { gif: 'GIF', mp4: 'MP4', webm: 'WebM' }
const FORMATS: ExportFormat[] = ['gif', 'mp4', 'webm']

/** Demo-only: fakes 3 formats encoding in parallel at different speeds,
 * so every variant can be eyeballed without a real export. */
function useFakeExportProgress(active: boolean) {
  const [state, setState] = useState<ExportProgressState>({
    gif: { status: 'pending', percent: 0 },
    mp4: { status: 'pending', percent: 0 },
    webm: { status: 'pending', percent: 0 },
  })

  useEffect(() => {
    if (!active) {
      setState({
        gif: { status: 'pending', percent: 0 },
        mp4: { status: 'pending', percent: 0 },
        webm: { status: 'pending', percent: 0 },
      })
      return
    }
    // gif is slowest (2-pass palette+encode), mp4/webm finish sooner. Values are total duration in ms.
    const durationMs: Record<ExportFormat, number> = { gif: 4500, mp4: 2200, webm: 3000 }
    const tickMs = 100
    const interval = setInterval(() => {
      setState((prev) => {
        const next = { ...prev }
        for (const fmt of FORMATS) {
          if (next[fmt].status === 'done') continue
          const percent = Math.min(100, next[fmt].percent + 100 / (durationMs[fmt] / tickMs))
          next[fmt] = { status: percent >= 100 ? 'done' : 'running', percent }
        }
        return next
      })
    }, tickMs)
    return () => clearInterval(interval)
  }, [active])

  return state
}

function RotatingIcon() {
  return <span className="export-modal-spinner" aria-hidden="true" />
}

/** The row content itself — locked by the map's decision, shared by
 * every variant below. */
function FormatRow({ format, state }: { format: ExportFormat; state: FormatState }) {
  const label = FORMAT_LABEL[format]
  return (
    <li className={`export-modal-row export-modal-row-${state.status}`}>
      <span className="export-modal-row-icon">
        {state.status === 'done' ? <CheckIcon size={14} /> : <RotatingIcon />}
      </span>
      <span className="export-modal-row-label">
        {state.status === 'done' ? `${label} encoded` : `Encoding ${label} ${Math.round(state.percent)}%`}
      </span>
    </li>
  )
}

// ---------- Variant A: expanded anchored panel (evolves the existing .editor-toast idiom) ----------

function VariantA({ progress, allDone }: { progress: ExportProgressState; allDone: boolean }) {
  if (allDone) return null
  return (
    <div className="export-modal-anchored-panel">
      <p className="export-modal-anchored-title">Making your GIF</p>
      <ul className="export-modal-rows">
        {FORMATS.map((f) => (
          <FormatRow key={f} format={f} state={progress[f]} />
        ))}
      </ul>
    </div>
  )
}

// ---------- Variant B: centered blocking overlay (consistent with the ingest modal's winning pattern) ----------

function VariantB({ progress, allDone }: { progress: ExportProgressState; allDone: boolean }) {
  if (allDone) return null
  return (
    <div className="export-modal-overlay" role="dialog" aria-modal="true" aria-label="Making your GIF">
      <div className="export-modal">
        <h2 className="export-modal-title">Making your GIF</h2>
        <ul className="export-modal-rows">
          {FORMATS.map((f) => (
            <FormatRow key={f} format={f} state={progress[f]} />
          ))}
        </ul>
      </div>
    </div>
  )
}

// ---------- Variant C: inline, morphs the already-open Make GIF popover in place ----------

function VariantC({ progress, allDone }: { progress: ExportProgressState; allDone: boolean }) {
  if (allDone) return null
  return (
    <div className="export-modal-inline-popover">
      <p className="export-modal-anchored-title">Making your GIF</p>
      <ul className="export-modal-rows">
        {FORMATS.map((f) => (
          <FormatRow key={f} format={f} state={progress[f]} />
        ))}
      </ul>
    </div>
  )
}

const VARIANTS = {
  A: { Component: VariantA, name: 'Anchored panel (evolves current toast)' },
  B: { Component: VariantB, name: 'Centered modal' },
  C: { Component: VariantC, name: 'Inline in the Make GIF popover' },
} as const

type VariantKey = keyof typeof VARIANTS

export function ExportModalPrototype({ variant, active }: { variant: VariantKey; active: boolean }) {
  const progress = useFakeExportProgress(active)
  if (!active) return null
  const allDone = FORMATS.every((f) => progress[f].status === 'done')
  const { Component } = VARIANTS[variant]
  return <Component progress={progress} allDone={allDone} />
}

export function ExportPrototypeSwitcher({
  variant,
  onChange,
  onReplay,
}: {
  variant: VariantKey
  onChange: (v: VariantKey) => void
  onReplay: () => void
}) {
  const keys = Object.keys(VARIANTS) as VariantKey[]

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return
      if (target?.isContentEditable) return
      const idx = keys.indexOf(variant)
      if (e.key === 'ArrowLeft') onChange(keys[(idx - 1 + keys.length) % keys.length])
      if (e.key === 'ArrowRight') onChange(keys[(idx + 1) % keys.length])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [variant, keys, onChange])

  const idx = keys.indexOf(variant)

  return (
    <div className="export-proto-switcher">
      <button
        type="button"
        className="export-proto-switcher-arrow"
        aria-label="Previous variant"
        onClick={() => onChange(keys[(idx - 1 + keys.length) % keys.length])}
      >
        ←
      </button>
      <span className="export-proto-switcher-label">
        {variant} — {VARIANTS[variant].name}
      </span>
      <button
        type="button"
        className="export-proto-switcher-arrow"
        aria-label="Next variant"
        onClick={() => onChange(keys[(idx + 1) % keys.length])}
      >
        →
      </button>
      <button type="button" className="export-proto-switcher-replay" onClick={onReplay}>
        ⟲ Replay
      </button>
    </div>
  )
}

export type { VariantKey }
