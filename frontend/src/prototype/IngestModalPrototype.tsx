// DESIGN REFERENCE — wayfinder gifiac#38 (child of map #32). Not wired
// into the live app: the ingest Lambda job + its stage-tracking SSE
// stream (gifiac#35, #32's "Ingest flow" decision) don't exist yet, so
// there's nothing real for this modal to drive off today. This is the
// agreed design (centered modal + vertical stepper) to wire up for real
// once that backend work lands — see NOTES.md.

import { useEffect, useState } from 'react'
import { CheckIcon } from '../icons'

export type IngestStage = 'uploading' | 'analyzing' | 'filmstrip' | 'done'

const STAGE_LABEL: Record<IngestStage, string> = {
  uploading: 'Uploading',
  analyzing: 'Analyzing',
  filmstrip: 'Building filmstrip',
  done: 'Done',
}

const STAGE_ORDER: IngestStage[] = ['uploading', 'analyzing', 'filmstrip', 'done']

/** Demo-only: drives a fake stage progression on a timer so the design
 * can be eyeballed without a real upload/ingest job behind it. Replace
 * with the real ingest job's stage (from its SSE stream) when wiring
 * this up for real. */
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
  return <span className="ingest-modal-spinner" aria-hidden="true" />
}

/** Centered overlay modal with a vertical 3-step list (✓ / spinner /
 * pending per step) — the agreed design for the upload/ingest loading
 * experience. `stage` drives which steps show as done/active/pending;
 * pass `null`/omit once "done" to hide it. */
export function IngestLoadingModal({ stage }: { stage: IngestStage }) {
  if (stage === 'done') return null
  return (
    <div className="ingest-modal-overlay" role="dialog" aria-modal="true" aria-label="Uploading video">
      <div className="ingest-modal">
        <h2 className="ingest-modal-title">Getting your video ready</h2>
        <ul className="ingest-modal-steps">
          {STAGE_ORDER.slice(0, 3).map((s) => {
            const order = STAGE_ORDER.indexOf(s)
            const current = STAGE_ORDER.indexOf(stage)
            const state = order < current ? 'done' : order === current ? 'active' : 'pending'
            return (
              <li key={s} className={`ingest-modal-step ingest-modal-step-${state}`}>
                <span className="ingest-modal-step-icon">
                  {state === 'done' ? <CheckIcon size={14} /> : state === 'active' ? <StageSpinner /> : null}
                </span>
                <span className="ingest-modal-step-label">{STAGE_LABEL[s]}…</span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/** Demo wrapper driving `IngestLoadingModal` off the fake timer above —
 * only for eyeballing the design in isolation. The real usage is just
 * `<IngestLoadingModal stage={realStageFromSSE} />`. */
export function IngestLoadingModalDemo({ active }: { active: boolean }) {
  const stage = useFakeIngestStage(active)
  if (!active) return null
  return <IngestLoadingModal stage={stage} />
}
