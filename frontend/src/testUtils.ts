/** jsdom has no layout engine, so `matchMedia` and `ResizeObserver` are
 * polyfilled in test-setup.ts with minimal stand-ins driven off
 * `window.innerWidth`. This helper changes that width and lets every live
 * `matchMedia` listener (e.g. from `useCanEdit`) re-evaluate and fire its
 * `change` event, the same way a real browser resize would. */
export function resizeTo(width: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width })
  window.__mediaQueryLists?.forEach((mql) => mql.__reevaluate())
}

declare global {
  interface Window {
    __mediaQueryLists?: Array<{ __reevaluate: () => void }>
  }
}
