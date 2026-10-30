import { describe, expect, it } from 'vitest'
import { hasFeature } from './features'

describe('hasFeature', () => {
  it('gives mobile editing to insiders and admins but not plain users', () => {
    expect(hasFeature({ role: 'user' }, 'mobileEdit')).toBe(false)
    expect(hasFeature({ role: 'insider' }, 'mobileEdit')).toBe(true)
    expect(hasFeature({ role: 'admin' }, 'mobileEdit')).toBe(true)
  })

  it('treats signed-out and unknown roles as plain users', () => {
    expect(hasFeature(null, 'mobileEdit')).toBe(false)
    expect(hasFeature(undefined, 'mobileEdit')).toBe(false)
    expect(hasFeature({ role: 'something-else' }, 'mobileEdit')).toBe(false)
  })
})
