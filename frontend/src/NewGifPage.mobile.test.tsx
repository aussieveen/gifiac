import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewGifPage } from './NewGifPage'
import type { TemplateDetail, TemplateSummary } from './types'
import { UploadError } from './uploadError'

vi.mock('./api', () => ({
  deleteTemplateById: vi.fn(),
  getTemplateDetail: vi.fn(),
  listMyTemplates: vi.fn(),
  listOtherTemplates: vi.fn(),
  renameTemplate: vi.fn(),
  setTemplatePublic: vi.fn(),
  subscribeIngestProgress: vi.fn(),
  templateThumbnailUrl: (id: string) => `/api/templates/${id}/thumbnail`,
  uploadVideo: vi.fn(),
}))

import {
  getTemplateDetail,
  listMyTemplates,
  listOtherTemplates,
  subscribeIngestProgress,
  uploadVideo,
} from './api'

const mine: TemplateSummary = {
  id: 't1',
  name: 'One-line change',
  is_public: false,
  saved_at: '2026-01-02T00:00:00Z',
  duration_seconds: 6.3,
  caption_count: 2,
  first_caption_text: 'ONE-LINE CHANGE',
  owner_handle: null,
}
const shared: TemplateSummary = {
  id: 't2',
  name: 'Monday stand-up',
  is_public: true,
  saved_at: '2026-01-01T00:00:00Z',
  duration_seconds: 5.1,
  caption_count: 1,
  first_caption_text: 'ME AT 9:01',
  owner_handle: 'jess',
}
const caption = {
  id: 'c1',
  startTime: 0,
  endTime: 1,
  text: 'ONE-LINE CHANGE',
  fontFamily: 'Anton, sans-serif',
  fontSize: 28,
  color: '#fff',
  align: 'center' as const,
  x: 0.5,
  y: 0.88,
  width: 0.6,
  outlineColor: null,
  lineHeight: 1.1,
}
const mineDetail: TemplateDetail = {
  id: 't1',
  name: 'One-line change',
  is_public: false,
  saved_at: '2026-01-02T00:00:00Z',
  duration_seconds: 6.3,
  width: 480,
  height: 270,
  captions: [caption, { ...caption, id: 'c2', text: 'THE PIPELINE' }],
  owner_handle: null,
  is_own: true,
}
const sharedDetail: TemplateDetail = {
  ...mineDetail,
  id: 't2',
  name: 'Monday stand-up',
  is_own: false,
  owner_handle: 'jess',
  captions: [{ ...caption, text: 'ME AT 9:01' }],
}

function renderMobile(props: { onStartFromTemplate?: (id: string) => void } = {}) {
  return render(
    <MemoryRouter initialEntries={['/new']}>
      <NewGifPage
        layout="mobile"
        onUploaded={() => {}}
        onStartFromTemplate={props.onStartFromTemplate ?? (() => {})}
      />
    </MemoryRouter>,
  )
}

function fileInput() {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

function bigFile(bytes: number) {
  const file = new File(['x'], 'big.mp4', { type: 'video/mp4' })
  Object.defineProperty(file, 'size', { value: bytes })
  return file
}

beforeEach(() => {
  vi.mocked(listMyTemplates).mockReset().mockResolvedValue([mine])
  vi.mocked(listOtherTemplates).mockReset().mockResolvedValue([shared])
  vi.mocked(getTemplateDetail)
    .mockReset()
    .mockImplementation((id: string) => Promise.resolve(id === 't2' ? sharedDetail : mineDetail))
  vi.mocked(uploadVideo).mockReset()
  vi.mocked(subscribeIngestProgress).mockReset().mockReturnValue(() => {})
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NewGifPage — mobile layout', () => {
  it('shows the upload card, pills with counts and a template grid, with no sheet open', async () => {
    renderMobile()

    expect(screen.getByRole('button', { name: /upload a video/i })).toBeInTheDocument()
    expect(fileInput()).toHaveAttribute('accept', 'video/*')
    await screen.findByRole('button', { name: 'One-line change' })
    expect(screen.getByRole('tab', { name: /^All\s*2$/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /^Mine\s*1$/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Shared\s*1$/ })).toBeInTheDocument()
    expect(screen.getByText('2 captions')).toBeInTheDocument()
    expect(screen.getByText('1 caption · @jess')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('filters with the pills', async () => {
    const user = userEvent.setup()
    renderMobile()
    await screen.findByRole('button', { name: 'One-line change' })

    await user.click(screen.getByRole('tab', { name: /^Shared/ }))

    expect(screen.queryByRole('button', { name: 'One-line change' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Monday stand-up' })).toBeInTheDocument()
  })

  it('opens the template sheet on tap and starts from the template', async () => {
    const onStart = vi.fn()
    const user = userEvent.setup()
    renderMobile({ onStartFromTemplate: onStart })

    await user.click(await screen.findByRole('button', { name: 'One-line change' }))

    const sheet = await screen.findByRole('dialog', { name: 'Template' })
    await within(sheet).findByRole('heading', { name: 'One-line change' })
    expect(within(sheet).getByText('THE PIPELINE')).toBeInTheDocument()
    expect(within(sheet).getByText(/captions · you can change them/i)).toBeInTheDocument()

    await user.click(within(sheet).getByRole('button', { name: 'Start from template' }))
    expect(onStart).toHaveBeenCalledWith('t1')
  })

  it('closes the sheet with Close, and returns focus to the tile', async () => {
    const user = userEvent.setup()
    renderMobile()
    const tile = await screen.findByRole('button', { name: 'One-line change' })
    await user.click(tile)
    const sheet = await screen.findByRole('dialog', { name: 'Template' })

    await user.click(within(sheet).getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(tile).toHaveFocus()
  })

  it('offers owner actions only on your own templates, and credits the owner on shared ones', async () => {
    const user = userEvent.setup()
    renderMobile()

    await user.click(await screen.findByRole('button', { name: 'Monday stand-up' }))
    let sheet = await screen.findByRole('dialog', { name: 'Template' })
    await within(sheet).findByText('@jess')
    expect(within(sheet).queryByRole('button', { name: 'Template actions' })).not.toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: 'Close' }))

    await user.click(screen.getByRole('button', { name: 'One-line change' }))
    sheet = await screen.findByRole('dialog', { name: 'Template' })
    await user.click(await within(sheet).findByRole('button', { name: 'Template actions' }))
    expect(within(sheet).getByRole('menuitem', { name: /rename/i })).toBeInTheDocument()
    expect(within(sheet).getByRole('menuitem', { name: /share template/i })).toBeInTheDocument()
    expect(within(sheet).getByRole('menuitem', { name: /delete template/i })).toBeInTheDocument()
  })
})

describe('NewGifPage — mobile upload sheet', () => {
  it('shows byte progress and the three steps, and moves to the next step', async () => {
    let onProgress: ((p: { loaded: number; total: number }) => void) | undefined
    vi.mocked(uploadVideo).mockImplementation((_file, options) => {
      onProgress = options?.onProgress
      return new Promise(() => {})
    })
    const user = userEvent.setup()
    renderMobile()
    await screen.findByRole('button', { name: 'One-line change' })

    await user.upload(fileInput(), new File(['bytes'], 'deploy-day.mp4', { type: 'video/mp4' }))
    const sheet = await screen.findByRole('dialog', { name: 'Uploading video' })
    expect(within(sheet).getByText('deploy-day.mp4')).toBeInTheDocument()
    expect(within(sheet).getByText('Analysing')).toBeInTheDocument()
    expect(within(sheet).getByText('Building filmstrip')).toBeInTheDocument()

    act(() => onProgress?.({ loaded: 12373196.8, total: 19293798.4 }))
    expect(within(sheet).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '64')
    expect(within(sheet).getByText('11.8 of 18.4 MB')).toBeInTheDocument()
    expect(within(sheet).getByText(/keep this page open/i)).toBeInTheDocument()
  })

  it('rejects an over-200 MB video before uploading, offering another choice', async () => {
    const user = userEvent.setup()
    renderMobile()
    await screen.findByRole('button', { name: 'One-line change' })

    await user.upload(fileInput(), bigFile(201 * 1024 * 1024))

    expect(await screen.findByText("That video's over 200 MB. Try trimming it on your phone first.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose another video' })).toBeInTheDocument()
    expect(uploadVideo).not.toHaveBeenCalled()
  })

  it('says a rejected file is not a usable video', async () => {
    vi.mocked(uploadVideo).mockRejectedValue(new UploadError('Request failed (400): bad', 'http', 400))
    const user = userEvent.setup()
    renderMobile()
    await screen.findByRole('button', { name: 'One-line change' })

    await user.upload(fileInput(), new File(['x'], 'broken.mov', { type: 'video/quicktime' }))

    expect(await screen.findByText("That file isn't a video we can use.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose another video' })).toBeInTheDocument()
  })

  it('treats a server 413 as too large', async () => {
    vi.mocked(uploadVideo).mockRejectedValue(new UploadError('Request failed (413)', 'http', 413))
    const user = userEvent.setup()
    renderMobile()
    await screen.findByRole('button', { name: 'One-line change' })

    await user.upload(fileInput(), new File(['x'], 'a.mp4', { type: 'video/mp4' }))

    expect(await screen.findByText(/over 200 MB/)).toBeInTheDocument()
  })

  it('shows the network error with Retry, and Retry restarts the upload', async () => {
    vi.mocked(uploadVideo).mockRejectedValueOnce(new UploadError('dropped', 'network'))
    vi.mocked(uploadVideo).mockImplementationOnce(() => new Promise(() => {}))
    const user = userEvent.setup()
    renderMobile()
    await screen.findByRole('button', { name: 'One-line change' })

    const file = new File(['x'], 'a.mp4', { type: 'video/mp4' })
    await user.upload(fileInput(), file)
    expect(await screen.findByText('The upload stopped. Check your connection and try again.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(uploadVideo).toHaveBeenCalledTimes(2)
    expect(vi.mocked(uploadVideo).mock.calls[1][0]).toBe(file)
    expect(await screen.findByRole('dialog', { name: 'Uploading video' })).toBeInTheDocument()
  })

  it('cancelling aborts the upload and returns to the page with no error', async () => {
    let signal: AbortSignal | undefined
    vi.mocked(uploadVideo).mockImplementation((_file, options) => {
      signal = options?.signal
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new UploadError('cancelled', 'aborted')))
      })
    })
    const user = userEvent.setup()
    renderMobile()
    await screen.findByRole('button', { name: 'One-line change' })
    await user.upload(fileInput(), new File(['x'], 'a.mp4', { type: 'video/mp4' }))

    await user.click(await screen.findByRole('button', { name: 'Cancel upload' }))

    expect(signal?.aborted).toBe(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByText(/stopped/i)).not.toBeInTheDocument()
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('asks before cancelling past 50%, and keeps uploading if you say no', async () => {
    let onProgress: ((p: { loaded: number; total: number }) => void) | undefined
    let signal: AbortSignal | undefined
    vi.mocked(uploadVideo).mockImplementation((_file, options) => {
      onProgress = options?.onProgress
      signal = options?.signal
      return new Promise(() => {})
    })
    vi.mocked(window.confirm).mockReturnValue(false)
    const user = userEvent.setup()
    renderMobile()
    await screen.findByRole('button', { name: 'One-line change' })
    await user.upload(fileInput(), new File(['x'], 'a.mp4', { type: 'video/mp4' }))
    act(() => onProgress?.({ loaded: 60, total: 100 }))

    await user.click(await screen.findByRole('button', { name: 'Cancel upload' }))

    expect(window.confirm).toHaveBeenCalled()
    expect(signal?.aborted).toBe(false)
    expect(screen.getByRole('dialog', { name: 'Uploading video' })).toBeInTheDocument()
  })

  it('cannot be dismissed by tapping the backdrop', async () => {
    vi.mocked(uploadVideo).mockImplementation(() => new Promise(() => {}))
    const user = userEvent.setup()
    renderMobile()
    await screen.findByRole('button', { name: 'One-line change' })
    await user.upload(fileInput(), new File(['x'], 'a.mp4', { type: 'video/mp4' }))
    await screen.findByRole('dialog', { name: 'Uploading video' })

    await user.click(screen.getByTestId('sheet-backdrop'))

    expect(screen.getByRole('dialog', { name: 'Uploading video' })).toBeInTheDocument()
  })
})
