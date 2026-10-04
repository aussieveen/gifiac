// Wired up for real (wayfinder gifiac#32) — promoted from the design
// reference at prototype/ExportModalPrototype.tsx (gifiac#39), which
// chose this centered-modal, one-row-per-format design. Mounted in
// CaptionEditor.tsx, fed by the real export job's SSE stream
// (subscribeExportProgress in api.ts) instead of a fake timer.

import { CheckIcon, XIcon } from './icons'

export type ExportFormat = 'gif' | 'mp4' | 'webm'
export type FormatState = { status: 'pending' | 'running' | 'done' | 'error'; percent: number }
export type ExportProgressState = Record<ExportFormat, FormatState>

const FORMAT_LABEL: Record<ExportFormat, string> = { gif: 'GIF', mp4: 'MP4', webm: 'WebM' }
const FORMATS: ExportFormat[] = ['gif', 'mp4', 'webm']

function RotatingIcon() {
  return <span className="export-modal-spinner" aria-hidden="true" />
}

function FormatRow({ format, state }: { format: ExportFormat; state: FormatState }) {
  const label = FORMAT_LABEL[format]
  return (
    <li className={`export-modal-row export-modal-row-${state.status}`}>
      <span className="export-modal-row-icon">
        {state.status === 'done' ? <CheckIcon size={14} /> : state.status === 'error' ? <XIcon size={14} /> : <RotatingIcon />}
      </span>
      <span className="export-modal-row-label">
        {state.status === 'done'
          ? `${label} encoded`
          : state.status === 'error'
            ? `${label} failed`
            : `Encoding ${label} ${Math.round(state.percent)}%`}
      </span>
    </li>
  )
}

/** Centered blocking overlay with one row per format — the agreed
 * design for export progress, consistent with the ingest modal's
 * winning pattern. `progress` drives each row's icon/label; pass
 * `allDone` to hide the modal once the job has reached a terminal state
 * (every format done, or the whole job failed — gif failing fails the
 * whole job even if mp4/webm succeeded, per gifiac#36). */
export function ExportProgressModal({ progress, allDone }: { progress: ExportProgressState; allDone: boolean }) {
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
