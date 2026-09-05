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

/**
 * Longest unbroken run of dry days.
 *
 * The Rust twin lives in `programs/pumpking/src/index.rs`. Both are driven by
 * `fixtures/index-cases.json`; a divergence of one day is a payout the
 * interface never promised.
 */
export function drySpell(days: readonly number[]): number {
  let best = 0
  let run = 0

  for (const day of days) {
    if (day === DayState.Dry) {
      run += 1
      if (run > best) best = run
    } else {
      run = 0
    }
  }

  return best
}

/**
 * A day is dry when its rainfall stayed under the threshold. Values are
 * hundredths of a millimetre as integers: the median and the threshold have to
 * agree byte for byte between TypeScript and Rust, and floating point does not
 * give that guarantee.
 */
export function classifyDay(
  rainfallX100: number | null,
  dryThresholdX100: number,
): DayClassification {
  if (rainfallX100 === null) return DayState.NoCoverage
  return rainfallX100 < dryThresholdX100 ? DayState.Dry : DayState.Wet
}
