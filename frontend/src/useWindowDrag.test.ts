import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useWindowDrag } from './useWindowDrag'

function fireMouseEvent(type: string, clientX = 0) {
  window.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }))
}

describe('useWindowDrag', () => {
  it('does not call onMove until a drag has started', () => {
    const onMove = vi.fn()
    renderHook(() => useWindowDrag(onMove))

    act(() => fireMouseEvent('mousemove', 10))

    expect(onMove).not.toHaveBeenCalled()
  })

  it('calls onMove with the event and the drag origin while dragging', () => {
    const onMove = vi.fn()
    const { result } = renderHook(() => useWindowDrag<{ id: string }>(onMove))

    act(() => result.current({ id: 'cap-1' }))
    act(() => fireMouseEvent('mousemove', 42))

    expect(onMove).toHaveBeenCalledTimes(1)
    const [event, origin] = onMove.mock.calls[0]
    expect(event.clientX).toBe(42)
    expect(origin).toEqual({ id: 'cap-1' })
  })

  it('stops calling onMove after mouseup', () => {
    const onMove = vi.fn()
    const { result } = renderHook(() => useWindowDrag<{ id: string }>(onMove))

    act(() => result.current({ id: 'cap-1' }))
    act(() => fireMouseEvent('mouseup'))
    act(() => fireMouseEvent('mousemove', 99))

    expect(onMove).not.toHaveBeenCalled()
  })

  it('always uses the latest onMove closure without re-binding listeners', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { result, rerender } = renderHook(({ onMove }) => useWindowDrag<{ id: string }>(onMove), {
      initialProps: { onMove: first },
    })

    act(() => result.current({ id: 'cap-1' }))
    rerender({ onMove: second })
    act(() => fireMouseEvent('mousemove', 5))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('removes its window listeners on unmount, even mid-drag', () => {
    const onMove = vi.fn()
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    const { result, unmount } = renderHook(() => useWindowDrag<{ id: string }>(onMove))
    act(() => result.current({ id: 'cap-1' }))

    const addedTypes = addSpy.mock.calls.map((call) => call[0])
    expect(addedTypes).toContain('mousemove')
    expect(addedTypes).toContain('mouseup')

    unmount()

    const removedTypes = removeSpy.mock.calls.map((call) => call[0])
    expect(removedTypes).toContain('mousemove')
    expect(removedTypes).toContain('mouseup')

    // A mid-drag unmount must not leave a live listener calling back into
    // an unmounted component's state setters.
    onMove.mockClear()
    act(() => fireMouseEvent('mousemove', 7))
    expect(onMove).not.toHaveBeenCalled()

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
