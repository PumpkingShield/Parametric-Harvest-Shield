import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DayState } from './day.ts'
import { medianX100 } from './median.ts'
import {
  DISPUTE_TOLERANCE_X100,
  INVESTIGATION_DISPUTED_DAYS,
  INVESTIGATION_WINDOW_DAYS,
  investigationDays,
  judgeDay,
  type ReferenceHour,
  ReferenceState,
  referenceDayX100,
} from './reference.ts'

const HOUR_MS = 3_600_000
const dayStart = new Date('2026-10-15T00:00:00Z')

function hours(values: readonly (number | null)[], from = dayStart): ReferenceHour[] {
  return values.map((valueX100, hour) => ({
    hourStart: new Date(from.getTime() + hour * HOUR_MS),
    valueX100,
  }))
}

describe('referenceDayX100', () => {
  it('sums the 24 hours from the start of the day', () => {
    expect(referenceDayX100(hours(Array.from({ length: 24 }, () => 10)), dayStart)).toBe(240)
  })

  it('ignores hours either side of the day', () => {
    const before = new Date(dayStart.getTime() - HOUR_MS)
    const all = hours(
      Array.from({ length: 26 }, (_, hour) => (hour === 0 || hour === 25 ? 9_999 : 1)),
      before,
    )
    expect(referenceDayX100(all, dayStart)).toBe(24)
  })

  it('has no total while any hour is missing or null — the reference has not finished', () => {
    expect(referenceDayX100(hours(Array.from({ length: 23 }, () => 0)), dayStart)).toBeNull()
    const withNull = Array.from({ length: 24 }, (_, hour) => (hour === 23 ? null : 0))
    expect(referenceDayX100(hours(withNull), dayStart)).toBeNull()
  })
})

describe('judgeDay', () => {
  const params = { dryThresholdX100: 100, toleranceX100: 500 }
  const dry = (rainfallX100: number) => ({ state: DayState.Dry, rainfallX100 })
  const wet = (rainfallX100: number) => ({ state: DayState.Wet, rainfallX100 })

  it('agrees when both sides are the same class, however far apart', () => {
    expect(judgeDay(wet(200), 9_000, params)).toBe(ReferenceState.Agrees)
    expect(judgeDay(dry(0), 100, params)).toBe(ReferenceState.Agrees)
  })

  it('classes the reference by the same rule as the cell: dry is at or below the threshold', () => {
    expect(judgeDay(dry(0), 100, { ...params, toleranceX100: 0 })).toBe(ReferenceState.Agrees)
    expect(judgeDay(dry(0), 101, { ...params, toleranceX100: 0 })).toBe(ReferenceState.Disputed)
  })

  it('disputes a different class only when the two are the tolerance apart', () => {
    expect(judgeDay(dry(0), 499, params)).toBe(ReferenceState.Agrees)
    expect(judgeDay(dry(0), 500, params)).toBe(ReferenceState.Disputed)
    expect(judgeDay(wet(599), 100, params)).toBe(ReferenceState.Agrees)
    expect(judgeDay(wet(600), 100, params)).toBe(ReferenceState.Disputed)
  })

  it('does not judge a day the network did not measure — there is nothing to dispute', () => {
    expect(judgeDay({ state: DayState.NoCoverage, rainfallX100: null }, 5_000, params)).toBe(
      ReferenceState.Unchecked,
    )
  })
})

/**
 * The measurement behind `DISPUTE_TOLERANCE_X100`, pinned: CoCoRaHS gauges
 * (`fixtures/sc003-gauges.json`) against Open-Meteo for the same cells and days
 * (`fixtures/reference-openmeteo.json`, `scripts/reference-openmeteo.mjs`). The
 * gauges are honest, so every dispute here is noise the tolerance has to keep
 * small. A change in these numbers means the rule or the data changed, and the
 * table in `reference.ts` has to change with it.
 */
describe('the dispute tolerance on real gauges', () => {
  type Gauges = {
    quorum: number
    cells: { cell: string; gauges: { values: (number | null)[] }[] }[]
  }
  type Reference = { cells: { cell: string; values: (number | null)[] }[] }
  const read = (name: string) =>
    readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8')
  const gauges: Gauges = JSON.parse(read('sc003-gauges.json'))
  const reference: Reference = JSON.parse(read('reference-openmeteo.json'))
  const DRY_THRESHOLD_X100 = 100

  const days = gauges.cells.flatMap(({ cell, gauges: inCell }, at) => {
    const values = reference.cells[at]?.cell === cell ? reference.cells[at].values : []
    return values.flatMap((referenceX100, day) => {
      const votes = inCell
        .map((gauge) => gauge.values[day])
        .filter((value): value is number => value !== null && value !== undefined)
      const rainfallX100 = medianX100(votes)
      if (votes.length < gauges.quorum || rainfallX100 === null || referenceX100 === null) {
        return []
      }
      const state = rainfallX100 <= DRY_THRESHOLD_X100 ? DayState.Dry : DayState.Wet
      return [{ cell, day, cellDay: { state, rainfallX100 }, referenceX100 }]
    })
  })

  const disputedAt = (toleranceX100: number) =>
    days.filter(
      (day) =>
        judgeDay(day.cellDay, day.referenceX100, {
          dryThresholdX100: DRY_THRESHOLD_X100,
          toleranceX100,
        }) === ReferenceState.Disputed,
    )

  it('compares the whole control set of SC-003', () => {
    expect(reference.cells.map(({ cell }) => cell)).toEqual(gauges.cells.map(({ cell }) => cell))
    expect(days).toHaveLength(4_163)
  })

  it('without a tolerance, disputes one honest day in seven', () => {
    expect(disputedAt(0)).toHaveLength(632)
  })

  it('at the published tolerance, disputes about one honest day in thirty', () => {
    const disputed = disputedAt(DISPUTE_TOLERANCE_X100)
    expect(disputed).toHaveLength(135)
    expect(disputed.length / days.length).toBeLessThan(0.035)

    // And no cell with a season of days behind it is disputed often enough to
    // look like a fake: the worst is under one day in fourteen.
    const worst = Math.max(
      ...gauges.cells.flatMap(({ cell }) => {
        const mine = days.filter((day) => day.cell === cell).length
        if (mine < 60) return []
        return [disputed.filter((day) => day.cell === cell).length / mine]
      }),
    )
    expect(worst).toBeLessThan(1 / 14)
  })

  /**
   * `FR-045`, `T044`: the rule that puts a cell under investigation, run over
   * the same honest season one day at a time. Every cell is evaluated on every
   * day of it, so "no honest cell fires" covers each day it could have.
   */
  const SEASON_DAYS = 183
  const dryDisputes = (toleranceX100: number) =>
    disputedAt(toleranceX100).filter((one) => one.cellDay.state === DayState.Dry)
  const firesOn = (disputed: readonly { cell: string; day: number }[], cell: string) => {
    const mine = disputed.filter((one) => one.cell === cell).map((one) => one.day)
    for (let today = 1; today <= SEASON_DAYS; today += 1) {
      if (investigationDays(mine, today) !== null) return true
    }
    return false
  }

  it('disputes a dry day on an honest cell only one time in 150', () => {
    expect(dryDisputes(DISPUTE_TOLERANCE_X100)).toHaveLength(27)
  })

  it('puts no honest cell under investigation over the season', () => {
    const disputed = dryDisputes(DISPUTE_TOLERANCE_X100)
    const fired = gauges.cells.filter(({ cell }) => firesOn(disputed, cell))
    expect(fired).toEqual([])
  })

  it('would put six honest cells under investigation one disputed day sooner', () => {
    // The published count is the lowest with no honest cell in it.
    const disputed = dryDisputes(DISPUTE_TOLERANCE_X100)
    const sooner = gauges.cells.filter(({ cell }) => {
      const mine = disputed.filter((one) => one.cell === cell).map((one) => one.day)
      for (let today = 1; today <= SEASON_DAYS; today += 1) {
        const inWindow = mine.filter(
          (day) => day < today && today - day <= INVESTIGATION_WINDOW_DAYS,
        )
        if (inWindow.length >= INVESTIGATION_DISPUTED_DAYS - 1) return true
      }
      return false
    })
    expect(sooner).toHaveLength(6)
  })
})

describe('investigationDays', () => {
  it('fires on the published count of disputed dry days inside the window', () => {
    expect(investigationDays([3, 8], 20)).toBeNull()
    expect(investigationDays([14, 3, 8], 20)).toEqual([3, 8, 14])
  })

  it('counts a day once however often it is named', () => {
    expect(investigationDays([3, 3, 8], 20)).toBeNull()
  })

  it('looks one coverage window back from today, and not at today', () => {
    expect(investigationDays([5, 9, 50], 95)).toEqual([5, 9, 50])
    expect(investigationDays([5, 9, 50], 96)).toBeNull()
    expect(investigationDays([9, 50, 96], 96)).toBeNull()
  })
})
