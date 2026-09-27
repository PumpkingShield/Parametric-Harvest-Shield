import { describe, expect, it } from 'vitest'
import {
  CELL_HOURS_RETENTION_MONTHS,
  cutoffsBefore,
  READINGS_RETENTION_DAYS,
  retentionCutoffs,
} from './retention.ts'

describe('retentionCutoffs', () => {
  it('keeps readings thirty days and hourly medians twelve months — SC-012', () => {
    expect(READINGS_RETENTION_DAYS).toBe(30)
    expect(CELL_HOURS_RETENTION_MONTHS).toBe(12)

    expect(retentionCutoffs(new Date('2026-09-27T10:15:00Z'))).toEqual({
      readings: new Date('2026-08-28T10:15:00Z'),
      cellHours: new Date('2025-09-27T10:15:00Z'),
    })
  })

  it('counts thirty days of wall time, across a month boundary', () => {
    expect(retentionCutoffs(new Date('2026-03-01T00:00:00Z')).readings).toEqual(
      new Date('2026-01-30T00:00:00Z'),
    )
  })

  it('counts months on the calendar, so a leap day rolls over rather than failing', () => {
    // 29 February 2028 has no twin a year earlier; one day's difference in a
    // year of rows is the price of meaning what "twelve months" means.
    expect(retentionCutoffs(new Date('2028-02-29T12:00:00Z')).cellHours).toEqual(
      new Date('2027-03-01T12:00:00Z'),
    )
  })

  it('refuses an instant that is not one', () => {
    expect(() => retentionCutoffs(new Date(Number.NaN))).toThrow(RangeError)
  })
})

describe('cutoffsBefore', () => {
  const cutoffs = {
    readings: new Date('2026-08-28T00:00:00Z'),
    cellHours: new Date('2025-09-27T00:00:00Z'),
  }

  it('pulls a cutoff back to the horizon when the horizon is older', () => {
    const horizon = new Date('2026-08-20T00:00:00Z')
    expect(cutoffsBefore(cutoffs, horizon)).toEqual({
      readings: horizon,
      cellHours: cutoffs.cellHours,
    })
  })

  it('never pushes a cutoff forward — a newer horizon sweeps nothing extra', () => {
    expect(cutoffsBefore(cutoffs, new Date('2026-09-27T00:00:00Z'))).toEqual(cutoffs)
  })

  it('refuses a horizon that is not an instant', () => {
    expect(() => cutoffsBefore(cutoffs, new Date(Number.NaN))).toThrow(RangeError)
  })
})
