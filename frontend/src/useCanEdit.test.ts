import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { resizeTo } from './testUtils'
import { useCanEdit } from './useCanEdit'

describe('useCanEdit', () => {
  afterEach(() => {
    resizeTo(1440)
  })

  it('is true at desktop widths', () => {
    resizeTo(1280)
    const { result } = renderHook(() => useCanEdit())
    expect(result.current).toBe(true)
  })

  it('is false at phone widths', () => {
    resizeTo(390)
    const { result } = renderHook(() => useCanEdit())
    expect(result.current).toBe(false)
  })

  it('updates live when the viewport crosses the breakpoint', () => {
    resizeTo(390)
    const { result } = renderHook(() => useCanEdit())
    expect(result.current).toBe(false)

    act(() => resizeTo(1280))
    expect(result.current).toBe(true)

    act(() => resizeTo(390))
    expect(result.current).toBe(false)
  })
})
