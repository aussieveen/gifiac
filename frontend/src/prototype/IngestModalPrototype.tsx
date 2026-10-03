// PROTOTYPE — throwaway UI exploration for wayfinder gifiac#38 (child of
// map #32). Three radically different takes on the upload/ingest loading
// experience: Uploading → Analyzing → Building filmstrip. Mounted into
// NewGifPage via `?variant=` so it sits against the real page instead of
// a vacuum. Delete this whole directory (and the NewGifPage wiring) once
// a variant wins or the losing variants are folded away — see NOTES.md.

import { useEffect, useState } from 'react'
import { CheckIcon, UploadIcon } from '../icons'

export type IngestStage = 'uploading' | 'analyzing' | 'filmstrip' | 'done'

const STAGE_LABEL: Record<IngestStage, string> = {
  uploading: 'Uploading',
  analyzing: 'Analyzing',
  filmstrip: 'Building filmstrip',
  done: 'Done',
}

const STAGE_ORDER: IngestStage[] = ['uploading', 'analyzing', 'filmstrip', 'done']

/** Drives a fake stage progression on a timer so every variant can be
 * eyeballed end to end without a real upload. Not part of the real app. */
function useFakeIngestStage(active: boolean) {
  const [stage, setStage] = useState<IngestStage>('uploading')

  useEffect(() => {
    if (!active) {
      setStage('uploading')
      return
    }
    const timers = [
      setTimeout(() => setStage('analyzing'), 1400),
      setTimeout(() => setStage('filmstrip'), 2800),
      setTimeout(() => setStage('done'), 4600),
    ]
    return () => timers.forEach(clearTimeout)
  }, [active])

  return stage
}

function StageSpinner() {
  return <span className="proto-ingest-spinner" aria-hidden="true" />
}

// ---------- Variant A: centered overlay modal with a vertical stepper ----------

function VariantA({ stage }: { stage: IngestStage }) {
  if (stage === 'done') return null
  return (
    <div className="proto-ingest-overlay" role="dialog" aria-modal="true" aria-label="Uploading video">
      <div className="proto-ingest-modal">
        <h2 className="proto-ingest-modal-title">Getting your video ready</h2>
        <ul className="proto-ingest-steps">
          {STAGE_ORDER.slice(0, 3).map((s) => {
            const order = STAGE_ORDER.indexOf(s)
            const current = STAGE_ORDER.indexOf(stage)
            const state = order < current ? 'done' : order === current ? 'active' : 'pending'
            return (
              <li key={s} className={`proto-ingest-step proto-ingest-step-${state}`}>
                <span className="proto-ingest-step-icon">
                  {state === 'done' ? <CheckIcon size={14} /> : state === 'active' ? <StageSpinner /> : null}
                </span>
                <span className="proto-ingest-step-label">{STAGE_LABEL[s]}…</span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

// ---------- Variant B: the upload tile morphs in place, no overlay ----------

function VariantB({ stage }: { stage: IngestStage }) {
  return (
    <div className="newgif-upload-tile proto-ingest-tile-b">
      {stage === 'done' ? (
        <>
          <span className="newgif-upload-icon proto-ingest-tile-b-done">
            <CheckIcon size={18} />
          </span>
          <span className="newgif-upload-title">Ready</span>
        </>
      ) : (
        <>
          <span className="newgif-upload-icon">
            <StageSpinner />
          </span>
          <span className="newgif-upload-title">{STAGE_LABEL[stage]}…</span>
          <span className="proto-ingest-tile-b-trail">
            {STAGE_ORDER.slice(0, 3).map((s) => (
              <span
                key={s}
                className={`proto-ingest-dot ${STAGE_ORDER.indexOf(s) <= STAGE_ORDER.indexOf(stage) ? 'filled' : ''}`}
              />
            ))}
          </span>
        </>
      )}
    </div>
  )
}

// ---------- Variant C: bottom-corner toast, page stays fully usable ----------

function VariantC({ stage }: { stage: IngestStage }) {
  if (stage === 'done') return null
  const current = STAGE_ORDER.indexOf(stage)
  const pct = Math.round(((current + 1) / 3) * 100)
  return (
    <div className="proto-ingest-toast" role="status">
      <span className="proto-ingest-toast-icon">
        <UploadIcon size={16} />
      </span>
      <div className="proto-ingest-toast-body">
        <span className="proto-ingest-toast-label">{STAGE_LABEL[stage]}…</span>
        <div className="proto-ingest-toast-bar">
          <div className="proto-ingest-toast-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  )
}

const VARIANTS = {
  A: { Component: VariantA, name: 'Centered modal + stepper' },
  B: { Component: VariantB, name: 'Tile morphs in place' },
  C: { Component: VariantC, name: 'Corner toast' },
} as const

type VariantKey = keyof typeof VARIANTS

export function IngestModalPrototype({ variant, active }: { variant: VariantKey; active: boolean }) {
  const stage = useFakeIngestStage(active)
  if (!active) return null
  const { Component } = VARIANTS[variant]
  return <Component stage={stage} />
}

export function IngestPrototypeSwitcher({
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
    <div className="proto-switcher">
      <button
        type="button"
        className="proto-switcher-arrow"
        aria-label="Previous variant"
        onClick={() => onChange(keys[(idx - 1 + keys.length) % keys.length])}
      >
        ←
      </button>
      <span className="proto-switcher-label">
        {variant} — {VARIANTS[variant].name}
      </span>
      <button
        type="button"
        className="proto-switcher-arrow"
        aria-label="Next variant"
        onClick={() => onChange(keys[(idx + 1) % keys.length])}
      >
        →
      </button>
      <button type="button" className="proto-switcher-replay" onClick={onReplay}>
        ⟲ Replay
      </button>
    </div>
  )
}

export type { VariantKey }
