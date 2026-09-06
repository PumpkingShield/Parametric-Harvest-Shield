import { DayState } from './day.ts'

/**
 * The index a policy is settled against — a deterministic function of the
 * classified days of its coverage window, and of nothing else (`FR-014`).
 *
 * The classification itself lives in `day.ts`. This file holds the part that
 * exists **twice**: `programs/pumpking/src/index.rs` is the other half, and
 * both are driven by `fixtures/index-cases.json`.
 */

/**
 * Longest unbroken run of dry days.
 *
 * The Rust twin lives in `programs/pumpking/src/index.rs`. Both are driven by
 * `fixtures/index-cases.json`; a divergence of one day is a payout the
 * interface never promised.
 *
 * Comparing the result against a policy is **inclusive**: `FR-046` says the
 * event happens when the spell *reaches* the policy threshold, so settlement
 * tests `spell >= spell_days_threshold`, never `>`. Same convention as the dry
 * threshold in `day.ts`, and for the same reason — a threshold means the value
 * it names, not one step short of it.
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
