import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  breachesOutlierShare,
  isOutlier,
  judgeInterval,
  OUTLIER_MIN_JUDGED,
  outlierShareBps,
} from './outlier.ts'

const fixtures = JSON.parse(
  readFileSync(new URL('../../../fixtures/outlier-cases.json', import.meta.url), 'utf8'),
) as {
  distance: { name: string; valueX100: number; medianX100: number; outlier: boolean }[]
  share: { name: string; judged: number; outliers: number; breaches: boolean }[]
}

/**
 * `distance` runs here only; `share` runs here and in
 * `programs/pumpking/src/outlier.rs`, because the program excludes on it.
 */
describe('isOutlier — fixtures/outlier-cases.json', () => {
  for (const one of fixtures.distance) {
    it(one.name, () => {
      expect(isOutlier(one.valueX100, one.medianX100)).toBe(one.outlier)
    })
  }

  it('refuses a value that is not integer hundredths', () => {
    expect(() => isOutlier(1.5, 0)).toThrow(RangeError)
  })
})

describe('breachesOutlierShare — fixtures/outlier-cases.json', () => {
  for (const one of fixtures.share) {
    it(one.name, () => {
      expect(breachesOutlierShare({ judged: one.judged, outliers: one.outliers })).toBe(
        one.breaches,
      )
    })
  }

  it('refuses counts that cannot be a record', () => {
    expect(() => breachesOutlierShare({ judged: 3, outliers: 4 })).toThrow(RangeError)
    expect(() => breachesOutlierShare({ judged: 3, outliers: -1 })).toThrow(RangeError)
  })
})

describe('outlierShareBps', () => {
  it('has no share before anything was judged', () => {
    expect(outlierShareBps({ judged: 0, outliers: 0 })).toBeNull()
  })

  it('rounds the displayed share down, and the rule does not depend on it', () => {
    // 15 of 72 is 2083.33 bps: shown as 2083, and over the line.
    expect(outlierShareBps({ judged: OUTLIER_MIN_JUDGED, outliers: 15 })).toBe(2083)
    expect(breachesOutlierShare({ judged: OUTLIER_MIN_JUDGED, outliers: 15 })).toBe(true)
  })
})

describe('judgeInterval', () => {
  it('judges nobody in an interval without a value', () => {
    // FR-010: no median, nothing to be off from — neither clean nor dirty.
    expect(judgeInterval([{ sensor: 'a', valueX100: 0 }], null)).toEqual([])
  })

  it('judges a sensor once, by the median of its own readings', () => {
    // Sixty agreeable readings and one wild one are one sensor in one
    // interval; the flood buys nothing and the wild one costs nothing.
    const flood = Array.from({ length: 60 }, () => ({ sensor: 'loud', valueX100: 300 }))
    const verdicts = judgeInterval([...flood, { sensor: 'loud', valueX100: 0 }], 300)
    expect(verdicts).toEqual([{ sensor: 'loud', valueX100: 300, medianX100: 300, outlier: false }])
  })

  it('marks the sensor that reports a drought through rain', () => {
    const verdicts = judgeInterval(
      [
        { sensor: 'c', valueX100: 0 },
        { sensor: 'a', valueX100: 310 },
        { sensor: 'b', valueX100: 290 },
        { sensor: 'c', valueX100: 0 },
      ],
      300,
    )
    expect(verdicts.map((one) => [one.sensor, one.valueX100, one.outlier])).toEqual([
      ['a', 310, false],
      ['b', 290, false],
      ['c', 0, true],
    ])
  })

  it('gives the same verdicts whatever order the readings came in', () => {
    const readings = [
      { sensor: 'b', valueX100: 100 },
      { sensor: 'a', valueX100: 140 },
      { sensor: 'a', valueX100: 120 },
    ]
    expect(judgeInterval([...readings].reverse(), 110)).toEqual(judgeInterval(readings, 110))
  })
})
