import { DayState } from './day.ts'

/**
 * What cover costs — `FR-021`. Deterministic, public, and the same for
 * everybody: the price of a policy is a function of the cell's own recorded
 * history and of the payout, and of nothing about the buyer.
 *
 * This file exists **twice**. `programs/pumpking/src/premium.rs` is the other
 * half, and both are driven by `fixtures/premium-cases.json` — the third pair
 * of twins in the project, after `dry_spell`. A divergence here is not a
 * display bug: the interface would quote one price and the chain charge
 * another, and the buyer would learn about it from their balance.
 *
 * `FR-038` requires an outsider to redo the arithmetic by hand from the
 * methodology page. That is why every step below is integer and why there are
 * exactly two roundings, in stated directions.
 */

/** Basis points, the unit every published share is expressed in. */
export const BPS_DENOMINATOR = 10_000

/**
 * Covered days a cell needs before it can be priced at all.
 *
 * Below this the share of dry days is noise rather than a rate — three days of
 * record can read as 0% or 100% and mean neither. Refusing to quote is the
 * honest answer; quoting off three days is a number with a decimal point and
 * nothing behind it.
 */
export const MIN_HISTORY_DAYS = 14

/**
 * The share of a cell's **recorded** days that were dry, in basis points, or
 * `null` when the record is too short to be a rate.
 *
 * Days without coverage are excluded from both sides rather than counted as
 * wet. Silence is not evidence that it rained — the same rule `FR-047` applies
 * to settlement, applied to pricing.
 *
 * Takes the day log as it is stored on chain, ring buffer and all: a slot the
 * log does not answer for reads as no coverage, so position never matters and
 * the caller does not have to unwrap the ring.
 *
 * Rounds **down**. This is a measurement, and the price rounds up later; doing
 * both in the same direction would charge for the same caution twice.
 */
export function dryDayFrequencyBps(days: readonly number[]): number | null {
  let dry = 0
  let covered = 0

  for (const day of days) {
    if (day === DayState.Dry) {
      dry += 1
      covered += 1
    } else if (day === DayState.Wet) {
      covered += 1
    }
  }

  if (covered < MIN_HISTORY_DAYS) return null
  return Math.floor((dry * BPS_DENOMINATOR) / covered)
}

/**
 * The rate the pool charges, in basis points of the payout.
 *
 * Two published parameters shape it. The **risk loading** is the difference
 * between a pool and a coin flip: a pool charging exactly its expected loss
 * breaks even on average and goes insolvent on variance. The **floor rate** is
 * what stops a thin or lucky record from pricing cover at nothing — fourteen
 * dry-free days are not proof that a cell never dries out, and `FR-021` gives
 * the formula no other way to say "we do not know yet".
 *
 * Rounds down: the rate is a published number, and the pool takes its dust in
 * the premium instead.
 */
export function premiumRateBps(
  frequencyBps: number,
  riskLoadingBps: number,
  minRateBps: number,
): number {
  const loaded = Math.floor((frequencyBps * (BPS_DENOMINATOR + riskLoadingBps)) / BPS_DENOMINATOR)
  return Math.max(loaded, minRateBps)
}

/**
 * The premium for a payout at a rate — rounded **up**, always towards the
 * pool.
 *
 * The buyer loses at most one unit of dust; a premium rounded the other way
 * takes that unit out of the capital standing behind every other policy. The
 * same choice, for the same reason, as the share rounding in `deposit_capital`.
 */
export function premiumFor(payout: bigint, rateBps: number): bigint {
  const denominator = BigInt(BPS_DENOMINATOR)
  const numerator = payout * BigInt(rateBps)
  return (numerator + denominator - 1n) / denominator
}
