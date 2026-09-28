import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewGifPage } from './NewGifPage'
import type { TemplateDetail, TemplateSummary, Video } from './types'

/** Renders the current URL's search string as text, so a test can assert
 * on it without reaching into react-router's internals. */
function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location-search">{location.search}</span>
}

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

// Newer than sharedTemplate below — "All" sorts newest first, so this is
// the default auto-selected template most tests build on. A template's
// own name shows up twice on screen once selected (its grid tile, and the
// detail panel heading) — every query below is scoped by role (`button`
// for the tile, `heading` for the panel) rather than bare text to stay
// unambiguous against that duplication.
const myTemplate: TemplateSummary = {
  id: 't1',
  name: 'One-line change',
  is_public: false,
  saved_at: '2026-01-02T00:00:00Z',
  duration_seconds: 8.2,
  caption_count: 2,
  first_caption_text: 'ONE-LINE CHANGE',
  owner_handle: null,
}

const sharedTemplate: TemplateSummary = {
  id: 't2',
  name: 'Wait what',
  is_public: true,
  saved_at: '2026-01-01T00:00:00Z',
  duration_seconds: 3.5,
  caption_count: 1,
  first_caption_text: 'WAIT, WHAT?!',
  owner_handle: 'jess',
}

const myTemplateDetail: TemplateDetail = {
  id: 't1',
  name: 'One-line change',
  is_public: false,
  saved_at: '2026-01-02T00:00:00Z',
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

const sharedTemplateDetail: TemplateDetail = {
  ...myTemplateDetail,
  id: 't2',
  name: 'Wait what',
  is_own: false,
  owner_handle: 'jess',
  captions: [{ ...myTemplateDetail.captions[0], text: 'WAIT, WHAT?!' }],
}

function renderPage(
  props: { onUploaded?: (v: Video) => void; onStartFromTemplate?: (id: string) => void; initialPath?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={[props.initialPath ?? '/new']}>
      <NewGifPage onUploaded={props.onUploaded ?? (() => {})} onStartFromTemplate={props.onStartFromTemplate ?? (() => {})} />
      <LocationProbe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(listMyTemplates).mockReset().mockResolvedValue([myTemplate])
  vi.mocked(listOtherTemplates).mockReset().mockResolvedValue([sharedTemplate])
  vi.mocked(getTemplateDetail).mockReset().mockImplementation((id: string) =>
    Promise.resolve(id === 't2' ? sharedTemplateDetail : myTemplateDetail),
  )
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
  it('defaults to "All", listing both own and shared templates, with All = Mine + Shared counts', async () => {
    renderPage()

    expect(await screen.findByRole('button', { name: /one-line change/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /wait what/i })).toBeInTheDocument()
    const allTab = screen.getByRole('tab', { name: /^all/i })
    expect(allTab).toHaveAttribute('aria-selected', 'true')
    expect(allTab).toHaveTextContent('2')
    expect(screen.getByRole('tab', { name: /^mine/i })).toHaveTextContent('1')
    expect(screen.getByRole('tab', { name: /^shared/i })).toHaveTextContent('1')
  })

  it('switching to "Mine" filters to just the caller\'s own', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('button', { name: /wait what/i })

    await user.click(screen.getByRole('tab', { name: /^mine/i }))

    expect(screen.getByRole('button', { name: /one-line change/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /wait what/i })).not.toBeInTheDocument()
  })

  it('switching to "Shared" shows templates other people have shared, with a "shared by @handle" sub-line and no owner controls', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('button', { name: /one-line change/i })

    await user.click(screen.getByRole('tab', { name: /^shared/i }))

    // Switching pills auto-selects the new list's first template, so the
    // panel already shows "Wait what" without a further click.
    expect(await screen.findByRole('heading', { name: 'Wait what' })).toBeInTheDocument()
    expect(screen.getByText(/shared by/i, { selector: '.newgif-panel-owner' })).toBeInTheDocument()
    expect(screen.getByText('@jess', { selector: '.newgif-panel-owner-handle' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete template' })).not.toBeInTheDocument()
  })

  it('"All" shows the owner handle on shared tiles so you can tell whose is whose', async () => {
    renderPage()

    await screen.findByRole('button', { name: /one-line change/i })
    expect(screen.getByText(/1 caption · shared by @jess/)).toBeInTheDocument()
  })

  it('your own templates\' sub-line has no "shared by" attribution', async () => {
    renderPage()

    const ownTile = await screen.findByRole('button', { name: /one-line change/i })
    expect(ownTile).toHaveTextContent('2 captions')
    expect(ownTile).not.toHaveTextContent('shared by')
  })

  it('auto-selects the first template on load, so the detail panel is never empty', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { name: 'One-line change' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start from template/i })).toBeInTheDocument()
  })

  it('switching pills keeps the current selection if it is still in the new list', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'One-line change' })

    await user.click(screen.getByRole('tab', { name: /^mine/i }))

    // "One-line change" is in both "All" and "Mine" — selection carries over.
    expect(screen.getByRole('heading', { name: 'One-line change' })).toBeInTheDocument()
    expect(getTemplateDetail).toHaveBeenCalledTimes(1)
  })

  it('switching pills selects the first template of the new list when the current selection drops out of it', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'One-line change' })

    await user.click(screen.getByRole('tab', { name: /^shared/i }))

    expect(await screen.findByRole('heading', { name: 'Wait what' })).toBeInTheDocument()
  })

  it('writes the selected pill to the URL', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('button', { name: /one-line change/i })
    expect(screen.getByTestId('location-search')).toHaveTextContent('')

    await user.click(screen.getByRole('tab', { name: /^shared/i }))
    expect(screen.getByTestId('location-search')).toHaveTextContent('?show=shared')

    await user.click(screen.getByRole('tab', { name: /^mine/i }))
    expect(screen.getByTestId('location-search')).toHaveTextContent('?show=mine')

    // Back to the default pill clears the param rather than writing
    // ?show=all — keeps the URL clean for the common case.
    await user.click(screen.getByRole('tab', { name: /^all/i }))
    expect(screen.getByTestId('location-search')).toHaveTextContent('')
  })

  it('reads the initial pill from the URL, so a reload or Back keeps it', async () => {
    renderPage({ initialPath: '/new?show=shared' })

    expect(await screen.findByRole('button', { name: /wait what/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /one-line change/i })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^shared/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows an empty state next to the upload tile when "Mine" has nothing', async () => {
    vi.mocked(listMyTemplates).mockResolvedValue([])
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('button', { name: /wait what/i })

    await user.click(screen.getByRole('tab', { name: /^mine/i }))

    expect(await screen.findByText('No templates yet')).toBeInTheDocument()
    expect(
      screen.getByText(/tick "also save as a template" to keep its captions for next time/i),
    ).toBeInTheDocument()
    expect(screen.getByText('Upload a video')).toBeInTheDocument()
  })

  it('shows an empty state for "Shared" when nobody has shared a template', async () => {
    vi.mocked(listOtherTemplates).mockResolvedValue([])
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('button', { name: /one-line change/i })

    await user.click(screen.getByRole('tab', { name: /^shared/i }))

    expect(await screen.findByText('Nobody has shared a template yet.')).toBeInTheDocument()
    expect(screen.getByText(/public templates from other people will show up here/i)).toBeInTheDocument()
  })

  it('the upload tile is always present, even when the list is empty', async () => {
    vi.mocked(listMyTemplates).mockResolvedValue([])
    vi.mocked(listOtherTemplates).mockResolvedValue([])
    renderPage()

    expect(await screen.findByText('Upload a video')).toBeInTheDocument()
  })

  it('selecting a template shows its detail panel and captions', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /wait what/i }))

    expect(await screen.findByRole('heading', { name: 'Wait what' })).toBeInTheDocument()
    expect(screen.getByText('WAIT, WHAT?!', { selector: '.newgif-caption-chip' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete template' })).not.toBeInTheDocument()
  })

  it('closing the panel deselects and collapses back to a single column', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'One-line change' })

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('heading', { name: 'One-line change' })).not.toBeInTheDocument()
  })

  it('"Start from template" calls onStartFromTemplate with the template id', async () => {
    const onStartFromTemplate = vi.fn()
    const user = userEvent.setup()
    renderPage({ onStartFromTemplate })
    await screen.findByRole('heading', { name: 'One-line change' })

    await user.click(screen.getByRole('button', { name: /start from template/i }))

    expect(onStartFromTemplate).toHaveBeenCalledWith('t1')
  })

  it('the pencil rename button is only shown for your own templates', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'One-line change' })
    expect(screen.getByRole('button', { name: 'Rename template' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /^shared/i }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Wait what' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Rename template' })).not.toBeInTheDocument()
  })

  it('renaming saves via the API and updates the tile', async () => {
    vi.mocked(renameTemplate).mockResolvedValue({ ...myTemplateDetail, name: 'Renamed' })
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'One-line change' })

    await user.click(screen.getByRole('button', { name: 'Rename template' }))
    const input = screen.getByLabelText('Template name')
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.tab()

    await waitFor(() => expect(renameTemplate).toHaveBeenCalledWith('t1', 'Renamed'))
    expect(await screen.findByRole('button', { name: /renamed/i })).toBeInTheDocument()
  })

  it('toggling Share template calls setTemplatePublic', async () => {
    vi.mocked(setTemplatePublic).mockResolvedValue({ ...myTemplateDetail, is_public: true })
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'One-line change' })

    await user.click(screen.getByRole('switch', { name: 'Share template' }))

    await waitFor(() => expect(setTemplatePublic).toHaveBeenCalledWith('t1', true))
  })

  it('deleting a template confirms, calls the API, and clears the selection', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'One-line change' })

    await user.click(screen.getByRole('button', { name: 'Delete template' }))

    await waitFor(() => expect(deleteTemplateById).toHaveBeenCalledWith('t1'))
    expect(screen.queryByRole('heading', { name: 'One-line change' })).not.toBeInTheDocument()
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
    renderPage({ onUploaded })
    await screen.findByRole('button', { name: /one-line change/i })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }))

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(video))
  })
})
