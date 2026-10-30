import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { BottomSheet } from './BottomSheet'

function Harness({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <BottomSheet label="Test sheet" onClose={() => setOpen(false)} dismissible={dismissible}>
          <button>Inside</button>
        </BottomSheet>
      )}
    </>
  )
}

describe('BottomSheet', () => {
  it('is a labelled dialog that takes focus and gives it back to the trigger on close', async () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open' })
    await userEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: 'Test sheet' })
    expect(dialog).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes on a backdrop tap', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    await userEvent.click(screen.getByTestId('sheet-backdrop'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on a swipe down on the handle but not on a short drag', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    const grab = screen.getByTestId('sheet-grab')

    fireEvent.pointerDown(grab, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(grab, { clientY: 130, pointerId: 1 })
    fireEvent.pointerUp(grab, { clientY: 130, pointerId: 1 })
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.pointerDown(grab, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(grab, { clientY: 220, pointerId: 1 })
    fireEvent.pointerUp(grab, { clientY: 220, pointerId: 1 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ignores every dismiss gesture when not dismissible', async () => {
    const onClose = vi.fn()
    render(
      <BottomSheet label="Uploading" onClose={onClose} dismissible={false}>
        <button>Cancel upload</button>
      </BottomSheet>,
    )
    await userEvent.click(screen.getByTestId('sheet-backdrop'))
    await userEvent.keyboard('{Escape}')
    const grab = screen.getByTestId('sheet-grab')
    fireEvent.pointerDown(grab, { clientY: 0, pointerId: 1 })
    fireEvent.pointerUp(grab, { clientY: 300, pointerId: 1 })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps Tab focus inside the sheet', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    const inside = screen.getByRole('button', { name: 'Inside' })
    inside.focus()
    await userEvent.tab()
    expect(inside).toHaveFocus()
  })
})
