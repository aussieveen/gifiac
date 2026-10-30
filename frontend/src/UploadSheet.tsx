import { useEffect, useState } from 'react'
import type { UploadProgress } from './api'
import { BottomSheet } from './BottomSheet'
import { CheckIcon } from './icons'
import { formatMegabytes, type IngestStage } from './IngestLoadingModal'

/** What went wrong, in terms of what the person can do about it. */
export type UploadFailure = 'too_large' | 'unsupported' | 'network' | 'failed'

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

const FAILURE_COPY: Record<UploadFailure, { message: string; action: string; kind: 'choose' | 'retry' }> = {
  too_large: {
    message: "That video's over 200 MB. Try trimming it on your phone first.",
    action: 'Choose another video',
    kind: 'choose',
  },
  unsupported: { message: "That file isn't a video we can use.", action: 'Choose another video', kind: 'choose' },
  network: { message: 'The upload stopped. Check your connection and try again.', action: 'Retry', kind: 'retry' },
  failed: { message: 'Something went wrong uploading that. Try again.', action: 'Retry', kind: 'retry' },
}

type Step = 'uploading' | 'analyzing' | 'building_filmstrip'
const STEPS: { key: Step; label: string }[] = [
  { key: 'uploading', label: 'Uploading' },
  { key: 'analyzing', label: 'Analysing' },
  { key: 'building_filmstrip', label: 'Building filmstrip' },
]

function formatLength(seconds: number): string {
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function FileRow({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  const [length, setLength] = useState<number | null>(null)

  useEffect(() => {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  return (
    <div className="m-upload-file">
      <span className="m-upload-thumb">
        {url && (
          <video
            src={`${url}#t=0.1`}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
          />
        )}
      </span>
      <span className="m-upload-file-text">
        <span className="m-upload-file-name">{file.name}</span>
        <span className="m-upload-file-meta">
          {formatMegabytes(file.size)} MB{length !== null && Number.isFinite(length) ? ` · ${formatLength(length)}` : ''}
        </span>
      </span>
    </div>
  )
}

/**
 * The mobile upload sheet: the three ingest steps while it runs, or a
 * plain-English error with the one action that fixes it. Only its own
 * buttons close it — a stray swipe must not drop a half-sent upload.
 */
export function UploadSheet({
  file,
  stage,
  progress,
  failure,
  onCancel,
  onRetry,
  onChooseAnother,
}: {
  file: File | null
  stage: IngestStage
  progress: UploadProgress | null
  failure: UploadFailure | null
  onCancel: () => void
  onRetry: () => void
  onChooseAnother: () => void
}) {
  if (stage === 'done') return null

  if (failure || stage === 'error') {
    const copy = FAILURE_COPY[failure ?? 'unsupported']
    return (
      <BottomSheet label="Upload failed" onClose={onCancel} dismissible={false}>
        {file && <FileRow file={file} />}
        <div className="m-upload-error" role="alert">
          <span className="m-upload-error-icon" aria-hidden="true">
            !
          </span>
          <p>{copy.message}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary m-sheet-primary"
          onClick={copy.kind === 'retry' ? onRetry : onChooseAnother}
        >
          {copy.action}
        </button>
        <button type="button" className="m-sheet-text-btn" onClick={onCancel}>
          Cancel
        </button>
      </BottomSheet>
    )
  }

  const current = STEPS.findIndex((s) => s.key === stage)
  const percent =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0

  return (
    <BottomSheet label="Uploading video" onClose={onCancel} dismissible={false}>
      {file && <FileRow file={file} />}
      <ul className="m-upload-steps">
        {STEPS.map((step, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : 'pending'
          return (
            <li key={step.key} className={`m-upload-step m-upload-step-${state}`}>
              <span className="m-upload-step-icon" aria-hidden="true">
                {state === 'done' ? <CheckIcon size={14} /> : state === 'active' ? <span className="ingest-modal-spinner" /> : null}
              </span>
              <span className="m-upload-step-body">
                <span className="m-upload-step-label">
                  {step.label}
                  {step.key === 'uploading' && state === 'active' && progress && progress.total > 0 && (
                    <span className="m-upload-step-percent">{percent}%</span>
                  )}
                </span>
                {step.key === 'uploading' && state === 'active' && progress && progress.total > 0 && (
                  <>
                    <span
                      className="m-upload-bar"
                      role="progressbar"
                      aria-label="Upload progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    >
                      <span className="m-upload-bar-fill" style={{ width: `${percent}%` }} />
                    </span>
                    <span className="m-upload-bytes">
                      {formatMegabytes(progress.loaded)} of {formatMegabytes(progress.total)} MB
                    </span>
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="m-upload-hint">Keep this page open. The editor opens on its own when it's ready.</p>
      <button type="button" className="btn btn-secondary m-sheet-secondary" onClick={onCancel}>
        Cancel upload
      </button>
    </BottomSheet>
  )
}
