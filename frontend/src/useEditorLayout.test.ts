import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEditorLayout } from './useEditorLayout'

function setWide(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: wide,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('useEditorLayout', () => {
  it('is desktop at 1024px and up for every role', () => {
    setWide(true)
    for (const role of ['user', 'insider', 'admin']) {
      expect(renderHook(() => useEditorLayout({ role })).result.current).toBe('desktop')
    }
  })

  it('is mobile below 1024px for insiders and admins only', () => {
    setWide(false)
    expect(renderHook(() => useEditorLayout({ role: 'insider' })).result.current).toBe('mobile')
    expect(renderHook(() => useEditorLayout({ role: 'admin' })).result.current).toBe('mobile')
    expect(renderHook(() => useEditorLayout({ role: 'user' })).result.current).toBe('unavailable')
    expect(renderHook(() => useEditorLayout(null)).result.current).toBe('unavailable')
  })
})
