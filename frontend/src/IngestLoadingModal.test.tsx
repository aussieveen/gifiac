import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IngestLoadingModal } from './IngestLoadingModal'

describe('IngestLoadingModal upload progress', () => {
  it('shows percentage and megabytes on the active Uploading step', () => {
    render(
      <IngestLoadingModal
        stage="uploading"
        uploadProgress={{ loaded: 12373196.8, total: 19293798.4 }}
      />,
    )

    expect(screen.getByRole('progressbar', { name: 'Upload progress' })).toHaveAttribute('aria-valuenow', '64')
    expect(screen.getByText('64% · 11.8 of 18.4 MB')).toBeInTheDocument()
  })

  it('shows no byte progress before any is reported or after uploading ends', () => {
    const { rerender } = render(<IngestLoadingModal stage="uploading" uploadProgress={null} />)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()

    rerender(<IngestLoadingModal stage="analyzing" uploadProgress={{ loaded: 10, total: 10 }} />)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})
