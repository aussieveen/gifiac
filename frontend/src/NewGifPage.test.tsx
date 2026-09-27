import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewGifPage } from './NewGifPage'
import type { TemplateDetail, TemplateSummary, Video } from './types'

vi.mock('./api', () => ({
  deleteTemplateById: vi.fn(),
  getTemplateDetail: vi.fn(),
  listMyTemplates: vi.fn(),
  listOtherTemplates: vi.fn(),
  renameTemplate: vi.fn(),
  setTemplatePublic: vi.fn(),
  templateThumbnailUrl: (id: string) => `/api/templates/${id}/thumbnail`,
  uploadVideo: vi.fn(),
}))

import {
  deleteTemplateById,
  getTemplateDetail,
  listMyTemplates,
  listOtherTemplates,
  renameTemplate,
  setTemplatePublic,
  uploadVideo,
} from './api'

const myTemplate: TemplateSummary = {
  id: 't1',
  name: 'One-line change',
  is_public: false,
  saved_at: '2026-01-01T00:00:00Z',
  duration_seconds: 8.2,
  caption_count: 2,
  owner_handle: null,
}

const otherTemplate: TemplateSummary = {
  id: 't2',
  name: 'Wait what',
  is_public: true,
  saved_at: '2026-01-02T00:00:00Z',
  duration_seconds: 3.5,
  caption_count: 1,
  owner_handle: 'jess',
}

const myTemplateDetail: TemplateDetail = {
  id: 't1',
  name: 'One-line change',
  is_public: false,
  saved_at: '2026-01-01T00:00:00Z',
  duration_seconds: 8.2,
  width: 480,
  height: 270,
  captions: [
    {
      id: 'c1',
      startTime: 0,
      endTime: 1,
      text: 'ONE-LINE CHANGE',
      fontFamily: 'Impact, sans-serif',
      fontSize: 28,
      color: '#fff',
      align: 'center',
      x: 0.5,
      y: 0.88,
      width: 0.6,
      outlineColor: null,
      lineHeight: 0.65,
    },
  ],
  owner_handle: null,
  is_own: true,
}

beforeEach(() => {
  vi.mocked(listMyTemplates).mockReset().mockResolvedValue([myTemplate])
  vi.mocked(listOtherTemplates).mockReset().mockResolvedValue([otherTemplate])
  vi.mocked(getTemplateDetail).mockReset().mockResolvedValue(myTemplateDetail)
  vi.mocked(renameTemplate).mockReset()
  vi.mocked(setTemplatePublic).mockReset()
  vi.mocked(deleteTemplateById).mockReset().mockResolvedValue(undefined)
  vi.mocked(uploadVideo).mockReset()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NewGifPage', () => {
  it('lists my templates by default, with the public ones tab available', async () => {
    render(<NewGifPage onUploaded={() => {}} onStartFromTemplate={() => {}} />)

    expect(await screen.findByRole('button', { name: /one-line change/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /wait what/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /my templates/i })).toHaveClass('active')
  })

  it('switching to "From others" shows public templates with attribution, no owner controls', async () => {
    const user = userEvent.setup()
    render(<NewGifPage onUploaded={() => {}} onStartFromTemplate={() => {}} />)
    await screen.findByRole('button', { name: /one-line change/i })

    await user.click(screen.getByRole('button', { name: /from others/i }))

    expect(await screen.findByRole('button', { name: /wait what/i })).toBeInTheDocument()
    expect(screen.getByText(/by jess/i)).toBeInTheDocument()
  })

  it('selecting a template shows its detail pane and captions', async () => {
    const user = userEvent.setup()
    render(<NewGifPage onUploaded={() => {}} onStartFromTemplate={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /one-line change/i }))

    expect(await screen.findByText('ONE-LINE CHANGE')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start from template' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete template' })).toBeInTheDocument()
  })

  it('"Start from template" calls onStartFromTemplate with the template id', async () => {
    const onStartFromTemplate = vi.fn()
    const user = userEvent.setup()
    render(<NewGifPage onUploaded={() => {}} onStartFromTemplate={onStartFromTemplate} />)
    await user.click(await screen.findByRole('button', { name: /one-line change/i }))
    await user.click(await screen.findByRole('button', { name: 'Start from template' }))

    expect(onStartFromTemplate).toHaveBeenCalledWith('t1')
  })

  it('toggling Public calls setTemplatePublic', async () => {
    vi.mocked(setTemplatePublic).mockResolvedValue({ ...myTemplateDetail, is_public: true })
    const user = userEvent.setup()
    render(<NewGifPage onUploaded={() => {}} onStartFromTemplate={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /one-line change/i }))
    await screen.findByText('ONE-LINE CHANGE')

    await user.click(screen.getByRole('switch', { name: 'Public' }))

    await waitFor(() => expect(setTemplatePublic).toHaveBeenCalledWith('t1', true))
  })

  it('deleting a template confirms, calls the API, and clears the selection', async () => {
    const user = userEvent.setup()
    render(<NewGifPage onUploaded={() => {}} onStartFromTemplate={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /one-line change/i }))
    await screen.findByRole('button', { name: 'Delete template' })

    await user.click(screen.getByRole('button', { name: 'Delete template' }))

    await waitFor(() => expect(deleteTemplateById).toHaveBeenCalledWith('t1'))
    expect(screen.queryByRole('button', { name: 'Start from template' })).not.toBeInTheDocument()
  })

  it('uploading a video calls onUploaded with the created video', async () => {
    const video: Video = {
      id: 'v1',
      original_filename: 'clip.mp4',
      extension: 'mp4',
      file_size_bytes: 100,
      duration_seconds: 8,
      width: 1920,
      height: 1080,
      uploaded_at: '2026-01-01T00:00:00Z',
    }
    vi.mocked(uploadVideo).mockResolvedValue(video)
    const onUploaded = vi.fn()
    const user = userEvent.setup()
    render(<NewGifPage onUploaded={onUploaded} onStartFromTemplate={() => {}} />)
    await screen.findByRole('button', { name: /one-line change/i })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }))

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(video))
  })
})
