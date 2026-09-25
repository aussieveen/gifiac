import '@testing-library/jest-dom/vitest'

// jsdom implements neither matchMedia nor ResizeObserver. Both are used by
// the mobile-responsive code (useCanEdit, CaptionEditor's timeline
// measurement) so tests need minimal stand-ins rather than every test file
// mocking them individually.

type ChangeListener = (event: { matches: boolean }) => void

interface MockMediaQueryList {
  matches: boolean
  media: string
  addEventListener: (type: 'change', listener: ChangeListener) => void
  removeEventListener: (type: 'change', listener: ChangeListener) => void
  addListener: (listener: ChangeListener) => void
  removeListener: (listener: ChangeListener) => void
  __reevaluate: () => void
}

function parseMinWidth(query: string): number | null {
  const match = query.match(/min-width:\s*(\d+)px/)
  return match ? Number(match[1]) : null
}

window.__mediaQueryLists = window.__mediaQueryLists ?? []

window.matchMedia =
  window.matchMedia ??
  ((query: string) => {
    const minWidth = parseMinWidth(query)
    const listeners = new Set<ChangeListener>()
    const mql: MockMediaQueryList = {
      media: query,
      matches: minWidth === null ? false : window.innerWidth >= minWidth,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
      __reevaluate: () => {
        const next = minWidth === null ? false : window.innerWidth >= minWidth
        if (next === mql.matches) return
        mql.matches = next
        listeners.forEach((listener) => listener({ matches: next }))
      },
    }
    window.__mediaQueryLists?.push(mql)
    return mql as unknown as MediaQueryList
  })

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = window.ResizeObserver ?? MockResizeObserver
