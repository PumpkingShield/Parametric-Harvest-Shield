import { drySpell } from '@pumpking/shared/index-math'
import { describe, expect, it } from 'vitest'
import { PAID_BRACKET, PAID_WINDOW } from './rainfall.ts'

/**
 * `longestDryRun` exists only to place the bracket. Its length is the index,
 * and the index is defined once — `drySpell` in `@pumpking/shared`, twin of
 * `programs/pumpking/src/index.rs`. These tests are the seam between the two:
 * a screen that draws a longer run than the chain would count is a payout the
 * interface promised and the program refuses.
 */
describe('the strip agrees with the index', () => {
  it('brackets the run drySpell counts on the closed policy', () => {
    expect(PAID_BRACKET?.length).toBe(drySpell(PAID_WINDOW.days))
  })

  it('draws the run that paid: 21 days ending 14 July, day 61 of the window', () => {
    expect(PAID_BRACKET).toEqual({ start: 40, end: 60, length: 21, label: '21 days' })
  })
})

describe('the window is the one the policy bought', () => {
  it('keeps the closed policy inside MAX_COVERAGE_DAYS', () => {
    expect(PAID_WINDOW.cells).toHaveLength(90)
  })

  it('breaks a run on the day nobody measured', () => {
    expect(PAID_WINDOW.cells[18]?.state).toBe('none')
  })

  it('splits dry from wet on the side of the threshold the chain uses', () => {
    // 16 May measured 0.0 mm — dry; 15 May measured 6.4 mm — wet
    expect(PAID_WINDOW.cells[1]?.state).toBe('dry')
    expect(PAID_WINDOW.cells[0]?.state).toBe('wet')
  })
})
