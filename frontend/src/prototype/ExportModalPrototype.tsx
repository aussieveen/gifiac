// DESIGN REFERENCE — wayfinder gifiac#39 (child of map #32). Not wired
// into the live app: export doesn't encode gif/mp4/webm in parallel yet
// (today it's one sequential stage, relayed via `exportProgress` in
// CaptionEditor.tsx), so there's nothing real for this modal to drive
// off until that Lambda work lands. This is the agreed design — a
// centered modal, consistent with the ingest modal's pattern (gifiac#38)
// — to wire up for real once the 3 parallel per-format jobs exist. See
// NOTES-export-modal.md.

import { useEffect, useState } from 'react'
import { CheckIcon } from '../icons'

export type ExportFormat = 'gif' | 'mp4' | 'webm'
export type FormatState = { status: 'pending' | 'running' | 'done' | 'error'; percent: number }
export type ExportProgressState = Record<ExportFormat, FormatState>

const FORMAT_LABEL: Record<ExportFormat, string> = { gif: 'GIF', mp4: 'MP4', webm: 'WebM' }
const FORMATS: ExportFormat[] = ['gif', 'mp4', 'webm']

/** Demo-only: fakes 3 formats encoding in parallel at different speeds,
 * so the design can be eyeballed without a real export behind it.
 * Replace with the real per-format status (from the export job's SSE
 * stream) when wiring this up for real. */
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

/** Centered blocking overlay with one row per format — the agreed
 * design for export progress, consistent with the ingest modal's
 * winning pattern. `progress` drives each row's icon/label; pass
 * `allDone` to hide the modal once every format has finished. */
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

/** Demo wrapper driving `ExportProgressModal` off the fake timer above —
 * only for eyeballing the design in isolation. The real usage is just
 * `<ExportProgressModal progress={realProgressFromSSE} allDone={...} />`. */
export function ExportProgressModalDemo({ active }: { active: boolean }) {
  const progress = useFakeExportProgress(active)
  if (!active) return null
  const allDone = FORMATS.every((f) => progress[f].status === 'done')
  return <ExportProgressModal progress={progress} allDone={allDone} />
}
