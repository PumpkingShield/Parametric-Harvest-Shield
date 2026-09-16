import { DayState } from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import { daysInWindow, spellInWindow } from './day-window.ts'
import type { DayRow } from './interval-store.ts'

const CELL_ID = 613_196_570_331_971_583n

function day(dayIndex: number, state: DayRow['state']): DayRow {
  return {
    cellId: CELL_ID,
    dayIndex,
    state,
    rainfallX100: state === DayState.NoCoverage ? null : 0,
    coveredHours: state === DayState.NoCoverage ? 0 : 24,
    merkleRoot: null,
    txSignature: 'tx',
  }
}

describe('daysInWindow', () => {
  it('orders the window by day index, whatever order the rows arrived in', () => {
    const days = [day(2, DayState.Wet), day(0, DayState.Dry), day(1, DayState.Dry)]
    expect(daysInWindow(days, 0, 2)).toEqual([DayState.Dry, DayState.Dry, DayState.Wet])
  })

  it('fills a day the store has no row for with no coverage', () => {
    expect(daysInWindow([day(0, DayState.Dry)], 0, 2)).toEqual([
      DayState.Dry,
      DayState.NoCoverage,
      DayState.NoCoverage,
    ])
  })

  it('covers both ends of the window', () => {
    expect(daysInWindow([], 4, 4)).toHaveLength(1)
    expect(daysInWindow([], 4, 6)).toHaveLength(3)
  })
})

describe('spellInWindow', () => {
  it('counts the longest run of dry days inside the window', () => {
    const days = [
      day(0, DayState.Dry),
      day(1, DayState.Dry),
      day(2, DayState.Wet),
      day(3, DayState.Dry),
      day(4, DayState.Dry),
      day(5, DayState.Dry),
    ]
    expect(spellInWindow(days, 0, 5)).toBe(3)
  })

  /**
   * The same answer the on-chain ring gives for a day it cannot speak for, and
   * it errs in the only safe direction: a missing row makes the worker decline
   * to call, never makes it pay.
   */
  it('reads a day the store has no row for as no coverage', () => {
    const days = [day(0, DayState.Dry), day(1, DayState.Dry), day(3, DayState.Dry)]
    expect(spellInWindow(days, 0, 3)).toBe(2)
  })

  it('has no spell in a window nothing was recorded for', () => {
    expect(spellInWindow([], 0, 9)).toBe(0)
  })

  it('ignores days outside the window it was asked about', () => {
    const days = [day(0, DayState.Dry), day(1, DayState.Dry), day(2, DayState.Dry)]
    expect(spellInWindow(days, 1, 2)).toBe(2)
  })
})
