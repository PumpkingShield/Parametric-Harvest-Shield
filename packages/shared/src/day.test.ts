import { describe, expect, it } from 'vitest'
import { classifyDay, DayState } from './day.ts'

/** A full day of 24 intervals, all measured, all reporting `each`. */
const evenDay = (each: number) => Array.from({ length: 24 }, () => each)

const params = { dryThresholdX100: 200, minimumCoverageX100: 75 }

describe('classifyDay', () => {
  it('sums the intervals of the day', () => {
    const result = classifyDay(evenDay(10), params)
    expect(result.rainfallX100).toBe(240)
    expect(result.coveredIntervals).toBe(24)
    expect(result.totalIntervals).toBe(24)
  })

  it('is dry below the threshold and wet above it', () => {
    expect(classifyDay([100, 99], params).state).toBe(DayState.Dry)
    expect(classifyDay([100, 101], params).state).toBe(DayState.Wet)
  })

  it('is dry at exactly the threshold — FR-047 and FR-046 both say "did not exceed"', () => {
    expect(classifyDay([200], params).state).toBe(DayState.Dry)
    expect(classifyDay([200], params).rainfallX100).toBe(200)
    expect(classifyDay([201], params).state).toBe(DayState.Wet)
  })

  it('is dry at a threshold of zero — a day with no rain at all', () => {
    // The case that settles the boundary beyond the wording. Under a strict
    // comparison a day that measured no rain would come out wet, so the
    // parameter would be unusable at its most natural value and every other
    // threshold would silently mean one hundredth less than it says.
    const noRainIsDry = { dryThresholdX100: 0, minimumCoverageX100: 75 }
    expect(classifyDay([0, 0, 0], noRainIsDry).state).toBe(DayState.Dry)
    expect(classifyDay([0, 0, 1], noRainIsDry).state).toBe(DayState.Wet)
  })

  it('is dry, not unknown, when every interval measured no rain', () => {
    // Zero is a real reading of the sky. Silence is not, and the two must not
    // land in the same state.
    const result = classifyDay(evenDay(0), params)
    expect(result.state).toBe(DayState.Dry)
    expect(result.rainfallX100).toBe(0)
  })
})

describe('coverage', () => {
  it('is unknown when no interval carried a value — FR-047', () => {
    const result = classifyDay([null, null, null], params)
    expect(result.state).toBe(DayState.NoCoverage)
    expect(result.rainfallX100).toBeNull()
    expect(result.coveredIntervals).toBe(0)
    expect(result.totalIntervals).toBe(3)
  })

  it('is unknown for a day with no intervals at all', () => {
    const result = classifyDay([], params)
    expect(result.state).toBe(DayState.NoCoverage)
    expect(result.rainfallX100).toBeNull()
    expect(result.totalIntervals).toBe(0)
  })

  it('measures a partly covered day from the intervals it has — FR-048', () => {
    // 18 of 24 is exactly three quarters: measured, and the trace says so.
    const intervals = [...Array.from({ length: 18 }, () => 10), ...Array(6).fill(null)]
    const result = classifyDay(intervals, params)
    expect(result.state).toBe(DayState.Dry)
    expect(result.rainfallX100).toBe(180)
    expect(result.coveredIntervals).toBe(18)
    expect(result.totalIntervals).toBe(24)
  })

  it('is unknown below the minimum share of covered intervals — FR-048', () => {
    const intervals = [...Array.from({ length: 17 }, () => 10), ...Array(7).fill(null)]
    const result = classifyDay(intervals, params)
    expect(result.state).toBe(DayState.NoCoverage)
    expect(result.rainfallX100).toBeNull()
    expect(result.coveredIntervals).toBe(17)
  })

  it('does not let a gap turn a wet day dry', () => {
    // The rain fell in the hours that went missing. The day is unknown rather
    // than dry: stitching a drought across silence is how the event gets faked.
    const intervals = [0, 0, 0, null, null, null]
    expect(classifyDay(intervals, params).state).toBe(DayState.NoCoverage)
  })

  it('counts coverage without dividing', () => {
    // 1 of 3 is under a half but over a third; the comparison must be exact at
    // the edge rather than rounded into it.
    expect(classifyDay([10, null, null], { ...params, minimumCoverageX100: 33 }).state).toBe(
      DayState.Dry,
    )
    expect(classifyDay([10, null, null], { ...params, minimumCoverageX100: 34 }).state).toBe(
      DayState.NoCoverage,
    )
  })

  it('accepts a day of any length — the clock is a parameter, FR-049', () => {
    // A scenario run compresses seconds_per_day; the number of intervals in a
    // day is whatever the worker collected, not a hardcoded 24.
    const result = classifyDay([50, 50], params)
    expect(result.state).toBe(DayState.Dry)
    expect(result.totalIntervals).toBe(2)
  })
})

describe('rejections', () => {
  it('refuses a fractional interval value', () => {
    expect(() => classifyDay([12.5], params)).toThrow(RangeError)
  })

  it('refuses a sum that would not fit the column', () => {
    expect(() => classifyDay(evenDay(2_000_000_000), params)).toThrow(RangeError)
  })
})
