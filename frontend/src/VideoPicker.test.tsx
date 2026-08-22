import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPicker } from './VideoPicker'
import type { Video } from './types'

vi.mock('./api', () => ({
  listVideos: vi.fn(),
  uploadVideo: vi.fn(),
  thumbnailUrl: (id: string) => `/api/videos/${id}/thumbnail`,
}))

import { listVideos, uploadVideo } from './api'

const existingVideo: Video = {
  id: 'v1',
  original_filename: 'existing.mp4',
  extension: 'mp4',
  file_size_bytes: 100,
  duration_seconds: 5,
  width: 640,
  height: 480,
  uploaded_at: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.mocked(listVideos).mockReset()
  vi.mocked(uploadVideo).mockReset()
})

describe('VideoPicker', () => {
  it('lists videos returned by the backend', async () => {
    vi.mocked(listVideos).mockResolvedValue([existingVideo])

    render(<VideoPicker onSelect={() => {}} />)

    await screen.findByText('existing.mp4')
  })

  it('shows a load error if the video list request fails', async () => {
    vi.mocked(listVideos).mockRejectedValue(new Error('/api/videos failed (500): boom'))

    render(<VideoPicker onSelect={() => {}} />)

    await screen.findByText(/boom/)
  })

  it('selecting an existing video calls onSelect with it', async () => {
    vi.mocked(listVideos).mockResolvedValue([existingVideo])
    const onSelect = vi.fn()
    const user = userEvent.setup()

    render(<VideoPicker onSelect={onSelect} />)
    await user.click(await screen.findByRole('button', { name: /existing.mp4/i }))

    expect(onSelect).toHaveBeenCalledWith(existingVideo)
  })

  it('uploading a file calls the API and then onSelect with the created video', async () => {
    vi.mocked(listVideos).mockResolvedValue([])
    const uploaded: Video = { ...existingVideo, id: 'v2', original_filename: 'new.mp4' }
    vi.mocked(uploadVideo).mockResolvedValue(uploaded)
    const onSelect = vi.fn()
    const user = userEvent.setup()

    render(<VideoPicker onSelect={onSelect} />)
    await screen.findByText(/drop a video here/i)

    const file = new File(['bytes'], 'new.mp4', { type: 'video/mp4' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    await waitFor(() => expect(uploadVideo).toHaveBeenCalledWith(file))
    expect(onSelect).toHaveBeenCalledWith(uploaded)
  })

  it('shows an upload error without calling onSelect', async () => {
    vi.mocked(listVideos).mockResolvedValue([])
    vi.mocked(uploadVideo).mockRejectedValue(new Error('/api/videos failed (400): bad file'))
    const onSelect = vi.fn()
    const user = userEvent.setup()

    render(<VideoPicker onSelect={onSelect} />)
    await screen.findByText(/drop a video here/i)

    const file = new File(['bytes'], 'bad.mp4', { type: 'video/mp4' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    await screen.findByText(/bad file/)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
