import { describe, expect, it } from 'vitest'
import { suggestNameFrom } from './suggestName'

describe('suggestNameFrom', () => {
  it('sentence-cases the text', () => {
    expect(suggestNameFrom('pipelines after jack improvement')).toBe('Pipelines after jack improvement')
  })

  it('strips quote characters', () => {
    expect(suggestNameFrom(`"well that's odd"`)).toBe('Well thats odd')
  })

  it('truncates to 40 characters', () => {
    const long = 'a'.repeat(60)
    const result = suggestNameFrom(long)
    expect(result.length).toBe(40)
  })

  it('returns an empty string for blank input', () => {
    expect(suggestNameFrom('   ')).toBe('')
  })
})
