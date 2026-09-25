import { beforeEach, describe, expect, it } from 'vitest'
import { consumeReturnTo, saveReturnTo } from './returnTo'

describe('returnTo', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('round-trips a relative path', () => {
    saveReturnTo('/library/abc123')
    expect(consumeReturnTo()).toBe('/library/abc123')
  })

  it('is one-shot', () => {
    saveReturnTo('/library/abc123')
    consumeReturnTo()
    expect(consumeReturnTo()).toBeNull()
  })

  it('rejects protocol-relative paths', () => {
    saveReturnTo('//evil.com/phish')
    expect(consumeReturnTo()).toBeNull()
  })

  it('rejects absolute URLs', () => {
    saveReturnTo('https://evil.com/phish')
    expect(consumeReturnTo()).toBeNull()
  })

  it('ignores the root path', () => {
    saveReturnTo('/')
    expect(consumeReturnTo()).toBeNull()
  })

  it('returns null when nothing was saved', () => {
    expect(consumeReturnTo()).toBeNull()
  })
})
