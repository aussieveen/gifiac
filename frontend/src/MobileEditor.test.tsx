import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptionEditor } from './CaptionEditor'
import type { Caption, FilmstripMeta, TemplateDetail, Video } from './types'

vi.mock('./api', () => ({
  createExport: vi.fn(),
  createTemplateExport: vi.fn(),
  subscribeExportProgress: vi.fn(),
  videoFileUrl: (id: string) => `/api/videos/${id}/file`,
  templateClipUrl: (id: string) => `/api/templates/${id}/clip`,
  getTemplate: vi.fn(),
  putTemplate: vi.fn(),
}))

import { createExport, getTemplate, subscribeExportProgress } from './api'

const video: Video = {
  id: 'v1',
  original_filename: 'deploy-day.mp4',
  extension: 'mp4',
  file_size_bytes: 12345,
  duration_seconds: 8,
  width: 1920,
  height: 1080,
  uploaded_at: '2026-01-01T00:00:00Z',
}

const filmstrip: FilmstripMeta = {
  frameCount: 32,
  cols: 6,
  rows: 6,
  frameWidth: 160,
  frameHeight: 90,
  interval: 0.25,
  imageUrl: '/api/videos/v1/filmstrip.jpg',
}

function caption(id: string, text: string, startTime: number, endTime: number, patch: Partial<Caption> = {}): Caption {
  return {
    id,
    text,
    startTime,
    endTime,
    fontFamily: 'Anton, sans-serif',
    fontSize: 28,
    color: '#fcfcfc',
    align: 'center',
    x: 0.5,
    y: 0.88,
    width: 0.6,
    outlineColor: '#000000',
    lineHeight: 1.1,
    ...patch,
  }
}

const template: TemplateDetail = {
  id: 't1',
  name: 'One-line change',
  is_public: false,
  saved_at: '2026-01-01T00:00:00Z',
  duration_seconds: 8,
  width: 160,
  height: 90,
  captions: [caption('c1', 'ONE-LINE CHANGE', 1, 2.4), caption('c2', 'THE PIPELINE', 2.5, 3.4), caption('c3', 'STAGING', 3.5, 4.4)],
  owner_handle: null,
  is_own: true,
}

function renderVideoEditor() {
  return render(
    <CaptionEditor layout="mobile" source={{ kind: 'video', video }} filmstrip={filmstrip} onBack={() => {}} />,
  )
}

function renderTemplateEditor(onBack = () => {}) {
  return render(
    <CaptionEditor layout="mobile" source={{ kind: 'template', template }} filmstrip={filmstrip} onBack={onBack} />,
  )
}

function stepperValue(name: RegExp): string {
  const button = screen.getByRole('button', { name })
  return button.parentElement!.querySelector('.m-stepper-value')!.textContent!
}

beforeEach(() => {
  vi.mocked(createExport).mockReset()
  vi.mocked(subscribeExportProgress).mockReset().mockReturnValue(() => {})
  vi.mocked(getTemplate).mockReset().mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MobileEditor', () => {
  it('shows the bar with the source line, caption chips and the Make GIF button with the trim length', () => {
    renderTemplateEditor()

    expect(screen.getByText('From template: One-line change · 160×90 · 8.0s')).toBeInTheDocument()
    const chips = screen.getAllByRole('option')
    expect(chips.map((c) => c.textContent)).toEqual(['1One-line change', '2The pipeline', '3Staging'])
    expect(screen.getByRole('button', { name: 'Make GIF' })).toHaveTextContent('8.00s')
    expect(screen.getByRole('button', { name: 'Back to library' })).toBeInTheDocument()
  })

  it('selects the first caption on open, and switching chips moves the playhead to its start', async () => {
    const user = userEvent.setup()
    renderTemplateEditor()
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Caption text')).toHaveValue('ONE-LINE CHANGE')

    await user.click(screen.getAllByRole('option')[2])

    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Caption text')).toHaveValue('STAGING')
    expect(stepperValue(/Playhead back/)).toBe('0:03.50')
  })

  it('switches between the Text, Style and Timing tabs', async () => {
    const user = userEvent.setup()
    renderTemplateEditor()

    await user.click(screen.getByRole('tab', { name: 'Style' }))
    expect(screen.getByLabelText('Font family')).toBeInTheDocument()
    expect(screen.queryByLabelText('Caption text')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Timing' }))
    expect(screen.getByText('Caption in')).toBeInTheDocument()
    expect(screen.getByText('Caption out')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Text' }))
    expect(screen.getByLabelText('Caption text')).toBeInTheDocument()
  })

  it('edits caption text from the Text tab and keeps the chip in step', async () => {
    const user = userEvent.setup()
    renderTemplateEditor()

    const box = screen.getByLabelText('Caption text')
    await user.clear(box)
    await user.type(box, 'HELLO')

    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Hello')
  })

  it('adds and deletes captions from the ⋯ menu', async () => {
    const user = userEvent.setup()
    renderVideoEditor()
    expect(screen.queryAllByRole('option')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Caption options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add caption at playhead' }))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByLabelText('Caption text')).toHaveValue('New caption')

    await user.click(screen.getByRole('button', { name: 'Caption options' }))
    expect(screen.queryByRole('menuitem', { name: /duplicate/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Delete caption' }))
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('Timing steppers change the in/out times by 0.01s, Set to playhead jumps to the playhead', async () => {
    const user = userEvent.setup()
    renderTemplateEditor()
    await user.click(screen.getByRole('tab', { name: 'Timing' }))
    expect(stepperValue(/Caption in back/)).toBe('1.00s')
    expect(stepperValue(/Caption out back/)).toBe('2.40s')

    await user.click(screen.getByRole('button', { name: 'Caption in forward 0.01 seconds' }))
    await user.click(screen.getByRole('button', { name: 'Caption out back 0.01 seconds' }))
    expect(stepperValue(/Caption in back/)).toBe('1.01s')
    expect(stepperValue(/Caption out back/)).toBe('2.39s')
    expect(screen.getByText(/Shows 1\.01s → 2\.39s · 1\.38s long · 0\.11s gap to #2/)).toBeInTheDocument()

    // The playhead is at 0.01s, before the caption: "out" can't go below
    // in + the minimum caption length.
    await user.click(screen.getByRole('button', { name: 'Playhead forward 0.01 seconds' }))
    await user.click(screen.getByRole('button', { name: /Set to playhead.*caption out/ }))
    expect(stepperValue(/Caption out back/)).toBe('1.26s')
  })

  it('selects a caption from the numbered timing bar', async () => {
    const user = userEvent.setup()
    renderTemplateEditor()
    await user.click(screen.getByRole('tab', { name: 'Timing' }))

    await user.click(screen.getByRole('button', { name: 'Caption 3' }))

    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
  })

  it('the playhead stepper moves the playhead by 0.01s, and holding it repeats', async () => {
    vi.useFakeTimers()
    renderTemplateEditor()
    const forward = screen.getByRole('button', { name: 'Playhead forward 0.01 seconds' })

    fireEvent.pointerDown(forward, { button: 0, pointerType: 'touch' })
    fireEvent.pointerUp(forward)
    expect(stepperValue(/Playhead back/)).toBe('0:00.01')

    fireEvent.pointerDown(forward, { button: 0, pointerType: 'touch' })
    act(() => {
      vi.advanceTimersByTime(400 + 70 * 5)
    })
    fireEvent.pointerUp(forward)
    const held = stepperValue(/Playhead back/)
    expect(held).not.toBe('0:00.02')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(stepperValue(/Playhead back/)).toBe(held) // released: no more repeating
  })

  it('moves the playhead when the strip is tapped', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 52, width: 400, height: 52, x: 0, y: 0, toJSON: () => ({}),
    })
    renderVideoEditor()

    fireEvent.pointerDown(screen.getByTestId('trim-strip'), { clientX: 200, pointerId: 1 })

    expect(stepperValue(/Playhead back/)).toBe('0:04.00')
  })

  it('drags the trim handles, updating the Make GIF length, and cannot cross', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 52, width: 400, height: 52, x: 0, y: 0, toJSON: () => ({}),
    })
    renderVideoEditor()
    expect(screen.getByRole('button', { name: 'Make GIF' })).toHaveTextContent('8.00s')

    const start = screen.getByRole('button', { name: 'Trim start' })
    fireEvent.pointerDown(start, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(start, { clientX: 100, pointerId: 1 })
    fireEvent.pointerUp(start, { pointerId: 1 })
    expect(screen.getByRole('button', { name: 'Make GIF' })).toHaveTextContent('6.00s')

    const end = screen.getByRole('button', { name: 'Trim end' })
    fireEvent.pointerDown(end, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(end, { clientX: 0, pointerId: 1 })
    fireEvent.pointerUp(end, { pointerId: 1 })
    expect(screen.getByRole('button', { name: 'Make GIF' })).toHaveTextContent('0.10s')
  })

  it('locks the trim for a template: no handles, a Trim locked chip and the template hint', () => {
    renderTemplateEditor()

    expect(screen.queryByRole('button', { name: 'Trim start' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Trim end' })).not.toBeInTheDocument()
    expect(screen.getByText('Trim locked')).toBeInTheDocument()
    expect(screen.getByText(/trim comes from the template/i)).toBeInTheDocument()
  })

  it('shows the trim hint and handles for an uploaded video', () => {
    renderVideoEditor()

    expect(screen.getByText(/drag ends to trim/i)).toBeInTheDocument()
    expect(screen.queryByText('Trim locked')).not.toBeInTheDocument()
  })

  it('collapses the strip when the panel scrolls, and restores it on tap', async () => {
    const user = userEvent.setup()
    renderVideoEditor()
    const panel = screen.getByRole('region', { name: 'Caption editor' })
    expect(screen.getByRole('button', { name: 'Trim start' })).toBeInTheDocument()

    fireEvent.scroll(panel, { target: { scrollTop: 40 } })

    expect(screen.queryByRole('button', { name: 'Trim start' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show trim strip' }))
    expect(screen.getByRole('button', { name: 'Trim start' })).toBeInTheDocument()
  })

  it('does not collapse for a small scroll, and restores when scrolled back to the top', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    renderVideoEditor()
    const panel = screen.getByRole('region', { name: 'Caption editor' })

    fireEvent.scroll(panel, { target: { scrollTop: 10 } })
    expect(screen.getByRole('button', { name: 'Trim start' })).toBeInTheDocument()

    fireEvent.scroll(panel, { target: { scrollTop: 40 } })
    expect(screen.queryByRole('button', { name: 'Trim start' })).not.toBeInTheDocument()

    now.mockReturnValue(1_001_000)
    fireEvent.scroll(panel, { target: { scrollTop: 0 } })
    expect(screen.getByRole('button', { name: 'Trim start' })).toBeInTheDocument()
  })

  it('Style tab: changes size, colour, outline and alignment, and Apply to all spreads them', async () => {
    const user = userEvent.setup()
    renderTemplateEditor()
    await user.click(screen.getByRole('tab', { name: 'Style' }))

    await user.click(screen.getByRole('button', { name: 'Bigger' }))
    expect(screen.getByText('30')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'No outline' }))
    expect(screen.getByRole('button', { name: 'No outline' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Align left' }))
    expect(screen.getByRole('button', { name: 'Align left' })).toHaveAttribute('aria-pressed', 'true')

    // Not applied to the others yet…
    await user.click(screen.getAllByRole('option')[1])
    expect(screen.getByRole('button', { name: 'Align center' })).toHaveAttribute('aria-pressed', 'true')

    // …until Apply to all is on.
    await user.click(screen.getByRole('checkbox', { name: 'Apply to all' }))
    await user.click(screen.getByRole('button', { name: 'Text colour #00ff99' }))
    await user.click(screen.getAllByRole('option')[2])
    expect(screen.getByRole('button', { name: 'Text colour #00ff99' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('resizes the selected caption from its edge handles, symmetrically and within limits', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 225, width: 400, height: 225, x: 0, y: 0, toJSON: () => ({}),
    })
    renderTemplateEditor()
    fireEvent.click(screen.getAllByRole('option')[0]) // selects caption 1 and moves the playhead to it
    const right = screen.getByRole('slider', { name: 'Caption width, right edge' })
    expect(right).toHaveAttribute('aria-valuenow', '0.6')

    fireEvent.pointerDown(right, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(right, { clientX: 340, pointerId: 1 }) // +10% of the frame, x2
    fireEvent.pointerUp(right, { pointerId: 1 })
    expect(right).toHaveAttribute('aria-valuenow', '0.8')

    const left = screen.getByRole('slider', { name: 'Caption width, left edge' })
    fireEvent.pointerDown(left, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(left, { clientX: 300, pointerId: 1 }) // far inward: clamps to the minimum
    fireEvent.pointerUp(left, { pointerId: 1 })
    expect(left).toHaveAttribute('aria-valuenow', '0.05')

    fireEvent.pointerDown(right, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(right, { clientX: 4000, pointerId: 1 }) // far outward: clamps to full width
    fireEvent.pointerUp(right, { pointerId: 1 })
    expect(right).toHaveAttribute('aria-valuenow', '1')
  })

  it('shows width handles only on the selected caption, and dragging them does not move it', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 225, width: 400, height: 225, x: 0, y: 0, toJSON: () => ({}),
    })
    renderTemplateEditor()
    expect(screen.queryAllByRole('slider', { name: /caption width/i })).toHaveLength(0) // no caption is active at 0s

    fireEvent.click(screen.getAllByRole('option')[0])
    expect(screen.getAllByRole('slider', { name: /caption width/i })).toHaveLength(2)
    const caption = screen.getByRole('slider', { name: 'Caption width, right edge' }).parentElement!
    const before = caption.style.left

    const right = screen.getByRole('slider', { name: 'Caption width, right edge' })
    fireEvent.pointerDown(right, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(right, { clientX: 350, pointerId: 1 })
    fireEvent.pointerUp(right, { pointerId: 1 })

    expect(caption.style.left).toBe(before)
  })

  it('keeps font size within 12–72', async () => {
    const user = userEvent.setup()
    renderTemplateEditor()
    await user.click(screen.getByRole('tab', { name: 'Style' }))

    for (let i = 0; i < 30; i++) await user.click(screen.getByRole('button', { name: 'Smaller' }))
    expect(screen.getByText('12')).toBeInTheDocument()
    for (let i = 0; i < 40; i++) await user.click(screen.getByRole('button', { name: 'Bigger' }))
    expect(screen.getByText('72')).toBeInTheDocument()
  })

  it('goes back with the bar button', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    renderTemplateEditor(onBack)

    await user.click(screen.getByRole('button', { name: 'Back to library' }))

    expect(onBack).toHaveBeenCalled()
  })
})

describe('MobileEditor — Make GIF sheet', () => {
  it('opens as a dialog with the summary and a focused name field', async () => {
    const user = userEvent.setup()
    renderTemplateEditor()

    await user.click(screen.getByRole('button', { name: 'Make GIF' }))

    const sheet = await screen.findByRole('dialog', { name: 'Make GIF' })
    expect(within(sheet).getByText('8.00s · 3 captions · 160×90')).toBeInTheDocument()
    expect(within(sheet).getByLabelText('GIF name')).toHaveFocus()
  })

  it('requires a name before making, without starting an export', async () => {
    const user = userEvent.setup()
    renderVideoEditor()
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    const sheet = await screen.findByRole('dialog', { name: 'Make GIF' })

    await user.click(within(sheet).getByRole('button', { name: 'Make GIF' }))

    expect(within(sheet).getByRole('alert')).toHaveTextContent('Give your GIF a name before making it')
    expect(within(sheet).getByLabelText('GIF name')).toHaveFocus()
    expect(createExport).not.toHaveBeenCalled()
  })

  it('exports an uploaded video with its trim and captions, and can also save a template', async () => {
    vi.mocked(createExport).mockResolvedValue({ export_id: 'e1' })
    const user = userEvent.setup()
    renderVideoEditor()
    await user.click(screen.getByRole('button', { name: 'Caption options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add caption at playhead' }))

    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    const sheet = await screen.findByRole('dialog', { name: 'Make GIF' })
    await user.type(within(sheet).getByLabelText('GIF name'), 'Deploy day')
    expect(within(sheet).queryByLabelText('Template name')).not.toBeInTheDocument()
    await user.click(within(sheet).getByRole('checkbox', { name: /also save as a template/i }))
    await user.type(within(sheet).getByLabelText('Template name'), 'Deploy day')
    await user.click(within(sheet).getByRole('switch', { name: 'Share template' }))
    await user.click(within(sheet).getByRole('button', { name: 'Make GIF & save template' }))

    expect(createExport).toHaveBeenCalledWith(
      expect.objectContaining({
        video_id: 'v1',
        name: 'Deploy day',
        save_as_template: true,
        template_name: 'Deploy day',
        template_is_public: true,
        gif_range_start: 0,
        gif_range_end: 8,
        captions: [expect.objectContaining({ text: 'New caption' })],
      }),
    )
    expect(screen.queryByRole('dialog', { name: 'Make GIF' })).not.toBeInTheDocument()
  })

  it('offers no template card when starting from a template, and Cancel closes the sheet', async () => {
    const user = userEvent.setup()
    renderTemplateEditor()
    await user.click(screen.getByRole('button', { name: 'Make GIF' }))
    const sheet = await screen.findByRole('dialog', { name: 'Make GIF' })

    expect(within(sheet).queryByRole('checkbox')).not.toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make GIF' })).toHaveFocus()
  })
})
