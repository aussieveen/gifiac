// Wired up for real (wayfinder gifiac#32) — promoted from the design
// reference at prototype/IngestModalPrototype.tsx (gifiac#38), which
// chose this centered-modal + vertical-stepper design. Mounted in
// NewGifPage.tsx, fed by the real ingest job's SSE stream
// (subscribeIngestProgress in api.ts) instead of a fake timer.

import type { UploadProgress } from './api'
import { CheckIcon } from './icons'

type RealStage = 'uploading' | 'analyzing' | 'building_filmstrip'
export type IngestStage = RealStage | 'done' | 'error'

const STAGE_LABEL: Record<RealStage, string> = {
  uploading: 'Uploading',
  analyzing: 'Analyzing',
  building_filmstrip: 'Building filmstrip',
}

const STAGE_ORDER: RealStage[] = ['uploading', 'analyzing', 'building_filmstrip']

export function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

function StageSpinner() {
  return <span className="ingest-modal-spinner" aria-hidden="true" />
}

function UploadBytes({ progress }: { progress: UploadProgress }) {
  const percent = Math.min(100, Math.round((progress.loaded / progress.total) * 100))
  return (
    <span className="ingest-modal-upload">
      <span
        className="ingest-modal-upload-bar"
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span className="ingest-modal-upload-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="ingest-modal-upload-text">
        {percent}% · {formatMegabytes(progress.loaded)} of {formatMegabytes(progress.total)} MB
      </span>
    </span>
  )
}

/** Centered overlay modal with a vertical 3-step list (✓ / spinner /
 * pending per step) — the agreed design for the upload/ingest loading
 * experience. `stage` drives which steps show as done/active/pending;
 * pass `'done'` to hide the modal, or `'error'` to show a failure state
 * instead of the stepper (the design prototype never had to model this,
 * since it only ever ran a fake timer that always "succeeded"). */
export function IngestLoadingModal({
  stage,
  errorMessage,
  onDismissError,
  uploadProgress,
}: {
  stage: IngestStage
  errorMessage?: string
  onDismissError?: () => void
  /** Bytes sent so far; only shown while the Uploading step is active. */
  uploadProgress?: UploadProgress | null
}) {
  if (stage === 'done') return null

  if (stage === 'error') {
    return (
      <div className="ingest-modal-overlay" role="dialog" aria-modal="true" aria-label="Upload failed">
        <div className="ingest-modal">
          <h2 className="ingest-modal-title">Upload failed</h2>
          <p className="ingest-modal-error">{errorMessage ?? 'Something went wrong processing your video.'}</p>
          <button type="button" className="btn btn-secondary ingest-modal-dismiss" onClick={onDismissError}>
            Dismiss
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="ingest-modal-overlay" role="dialog" aria-modal="true" aria-label="Uploading video">
      <div className="ingest-modal">
        <h2 className="ingest-modal-title">Getting your video ready</h2>
        <ul className="ingest-modal-steps">
          {STAGE_ORDER.map((s) => {
            const order = STAGE_ORDER.indexOf(s)
            const current = STAGE_ORDER.indexOf(stage as RealStage)
            const state = order < current ? 'done' : order === current ? 'active' : 'pending'
            return (
              <li key={s} className={`ingest-modal-step ingest-modal-step-${state}`}>
                <span className="ingest-modal-step-icon">
                  {state === 'done' ? <CheckIcon size={14} /> : state === 'active' ? <StageSpinner /> : null}
                </span>
                <span className="ingest-modal-step-body">
                  <span className="ingest-modal-step-label">{STAGE_LABEL[s]}…</span>
                  {s === 'uploading' && state === 'active' && uploadProgress && uploadProgress.total > 0 && (
                    <UploadBytes progress={uploadProgress} />
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
