/**
 * One day of a cell, classified from its intervals — `FR-047`, `FR-048`.
 *
 * A day is the unit the chain stores (`day_log`) and the unit `drySpell()`
 * counts. It is an index rather than a date: `seconds_per_day` is a pool
 * parameter, so a scenario run (`FR-049`) compresses the clock without
 * changing anything here. The number of intervals in a day is therefore
 * whatever the caller collected, not a hardcoded 24.
 */

/**
 * Classification of one day of a cell, mirroring the on-chain day log.
 *
 * A day without coverage is not "not dry" — it is unknown, and unknown breaks
 * a run. Treating silence as drought would let anyone manufacture an event by
 * switching their sensors off.
 */
export const DayState = {
  NoCoverage: 0,
  Dry: 1,
  Wet: 2,
} as const

export type DayClassification = (typeof DayState)[keyof typeof DayState]

export type DayParams = {
  /**
   * A day is dry when its rainfall did **not exceed** this — `FR-047`, and
   * `FR-046` repeats the wording for the spell the index is built from. The
   * comparison is therefore inclusive: at exactly the threshold the day is dry.
   *
   * Not a matter of taste. Under a strict comparison a threshold of zero —
   * "a dry day is one with no rain at all" — would classify a day that
   * measured no rain as wet, and every threshold would silently mean one
   * hundredth less than the number published on the methodology page.
   */
  dryThresholdX100: number
  /**
   * Hundredths of the day's intervals that must carry a value for the day to
   * count as measured — `FR-048`. `75` is three quarters of them. Published on
   * the methodology page and shown in the trace, because a day measured from
   * half its hours is a different claim than one measured from all of them.
   */
  minimumCoverageX100: number
}

export type DayResult = {
  state: DayClassification
  /**
   * Sum of the intervals that had a value, null when the day was not measured.
   * Null and not zero: zero is a real, dry reading of the sky, and silence is
   * not.
   */
  rainfallX100: number | null
  /** Intervals that carried a value. Shown in the trace — `FR-048`. */
  coveredIntervals: number
  /** Intervals the day had at all, covered or not. */
  totalIntervals: number
}

const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647

/**
 * Classifies a day from its intervals, null where an interval had no value
 * (`FR-010`).
 *
 * Three outcomes, in the order they are decided:
 *
 * 1. **No interval carried a value** — the day is unknown and breaks the run
 *    (`FR-047`). This is the rule that costs the insured, and it is deliberate:
 *    stitching a drought across the network going quiet would let anyone
 *    manufacture the event by switching sensors off. `FR-022` compensates by
 *    refusing to sell a policy on a cell without coverage in the first place.
 * 2. **Too few intervals carried a value** — below `minimumCoverageX100` the
 *    day is not measured either (`FR-048`). Same reasoning, softer edge.
 * 3. **Otherwise** the day is measured from the intervals it has, and it is dry
 *    when their sum did not exceed the threshold.
 *
 * The coverage test multiplies rather than divides, so there is no rounding to
 * disagree about: `covered * 100 >= minimum * total`.
 */
export function classifyDay(intervals: readonly (number | null)[], params: DayParams): DayResult {
  const totalIntervals = intervals.length
  let coveredIntervals = 0
  let rainfallX100 = 0

  for (const value of intervals) {
    if (value === null) continue
    if (!Number.isInteger(value)) {
      throw new RangeError(`interval value is not an integer: ${value}`)
    }
    coveredIntervals += 1
    rainfallX100 += value
  }

  const uncovered: DayResult = {
    state: DayState.NoCoverage,
    rainfallX100: null,
    coveredIntervals,
    totalIntervals,
  }

  if (coveredIntervals === 0) return uncovered
  if (coveredIntervals * 100 < params.minimumCoverageX100 * totalIntervals) return uncovered

  if (rainfallX100 < INT32_MIN || rainfallX100 > INT32_MAX) {
    throw new RangeError(`rainfall does not fit the i32 column: ${rainfallX100}`)
  }

  return {
    state: rainfallX100 <= params.dryThresholdX100 ? DayState.Dry : DayState.Wet,
    rainfallX100,
    coveredIntervals,
    totalIntervals,
  }
}
