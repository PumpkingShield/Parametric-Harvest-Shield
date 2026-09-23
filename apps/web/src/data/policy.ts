import { type DayClassification, DayState } from '@pumpking/shared/day'
import type { Day, Policy } from '../api/policy.ts'
import type { StripCell } from './rainfall.ts'

/**
 * The policy screen's numbers, turned from the wire into what the strip draws.
 *
 * Everything here is positional or textual. The **length** of the run is not
 * decided here and never is: it arrives as `policy.spell`, which the API took
 * from `spellInWindow`, which is `drySpell` over the same fill. `longestDryRun`
 * places the bracket, and `policy.test.ts` holds the two equal — a strip that
 * brackets a longer run than the index counts is a payout the interface
 * promised and the program refuses.
 *
 * **A day is an index, not a date.** The journal route has no clock and no
 * genesis on purpose, so nothing here can turn day 12 into a date without
 * inventing one.
 */

/** Day indices are labelled every ten squares, so a strip can be read. */
const LABEL_EVERY = 10

function millimetres(rainfallX100: number): string {
  return (rainfallX100 / 100).toFixed(1)
}

function detailOf(day: Day): string {
  if (day.rainfallX100 === null) {
    return `Day ${day.dayIndex} — no value — ${day.coveredHours} intervals, no coverage`
  }
  return `Day ${day.dayIndex} — ${millimetres(day.rainfallX100)} mm — ${day.coveredHours} intervals`
}

function stateOf(state: number): StripCell['state'] {
  if (state === DayState.Dry) return 'dry'
  if (state === DayState.Wet) return 'wet'
  return 'none'
}

function classificationOf(state: number): DayClassification {
  if (state === DayState.Dry) return DayState.Dry
  if (state === DayState.Wet) return DayState.Wet
  return DayState.NoCoverage
}

export interface PolicyWindow {
  cells: StripCell[]
  /** The window as the index reads it, gaps included. */
  days: DayClassification[]
}

/**
 * The window as a strip, one square per day from `windowStartDay` to
 * `windowEndDay`.
 *
 * A day with no row is drawn apart from a day recorded as no coverage, and
 * counted the same. Apart, because the two are different answers and the reader
 * has to see which one this is — the aggregator saying nobody measured, or the
 * aggregator not having got there. The same, because the on-chain ring makes no
 * such distinction: neither is an answer, and both break the run.
 */
export function policyWindow(policy: Policy, rows: readonly Day[]): PolicyWindow {
  const byDay = new Map(rows.map((row) => [row.dayIndex, row]))
  const cells: StripCell[] = []
  const days: DayClassification[] = []

  for (let index = policy.windowStartDay; index <= policy.windowEndDay; index += 1) {
    const topLabel =
      index === policy.windowStartDay || index % LABEL_EVERY === 0 ? String(index) : undefined
    const row = byDay.get(index)

    if (row === undefined) {
      days.push(DayState.NoCoverage)
      cells.push({ state: 'future', detail: `Day ${index} — not recorded yet`, topLabel })
      continue
    }

    days.push(classificationOf(row.state))
    cells.push({ state: stateOf(row.state), detail: detailOf(row), topLabel })
  }

  return { cells, days }
}

/**
 * Base units as a readable sum.
 *
 * `BigInt` and not division: `u64` passes `Number.MAX_SAFE_INTEGER`, and a
 * payout that loses its last digits on the way to the screen is a number the
 * owner and the chain do not agree on. Truncated rather than rounded, for the
 * same reason — the screen may show less precision than moved, never more
 * money.
 */
export function formatAmount(baseUnits: string, decimals: number): string {
  const units = BigInt(baseUnits)
  const scale = 10n ** BigInt(decimals)
  const whole = units / scale
  const hundredths = ((units % scale) * 100n) / scale
  return `${whole}.${String(hundredths).padStart(2, '0')}`
}

/** `FR-056`: the asset is a mock token, and it says so wherever a sum appears. */
const ASSET = 'mock USDC'

/**
 * The line under the figure — the run, and what it is short of.
 *
 * One branch per state the program has, and the two that mean money is owed
 * say so. `unclaimed` is the one worth being careful with: the drought
 * happened and the transfer did not land (`FR-029`), the payout is still
 * reserved, and telling that owner the policy closed without paying would be
 * the screen talking them out of money that is theirs.
 */
export function runCaption(policy: Policy): string {
  switch (policy.state) {
    case 'paidOut':
      return 'dry days in a row — this policy paid out'
    case 'unclaimed':
      return 'dry days in a row — the payout is yours and waiting to be claimed'
    case 'closedNoEvent':
      return 'dry days in a row — this policy closed without paying'
    case 'active':
      return policy.spell >= policy.spellDaysThreshold
        ? 'dry days in a row — the threshold is met'
        : `dry days in a row — ${policy.spellDaysThreshold - policy.spell} more and you are paid`
  }
}

/** The terms `FR-018` says a policy carries. */
export function policyFacts(policy: Policy, decimals: number): [string, string][] {
  return [
    ['Pays out', `${formatAmount(policy.payout, decimals)} ${ASSET}`],
    ['When', `${policy.spellDaysThreshold} dry days in a row`],
    [
      'Cover period',
      `days ${policy.windowStartDay}–${policy.windowEndDay} (${policy.windowDays} days)`,
    ],
    ['Premium paid', `${formatAmount(policy.premium, decimals)} ${ASSET}`],
    ['Days recorded', `${policy.recordedDays} of ${policy.windowDays}`],
  ]
}

/**
 * `FR-040` — what decides the money, and the two ways it can part from what
 * happened in the field.
 *
 * This is the one thing on the screen the owner cannot learn from the numbers:
 * a parametric policy pays on an index, and an index is not the damage. Said
 * as a paragraph it was deletable and nothing would have noticed, so it is
 * said as structure instead. Each case carries `paid` and `harmed` as flags,
 * and `FR-040` becomes an assertion: both cases exist, and in each of them the
 * two disagree — one pays a field that is fine, the other pays nothing to a
 * field that is lost.
 *
 * The numbers are this policy's own — its threshold, its cell, its payout —
 * because a disclosure written about parametric insurance in general is the
 * small print this requirement exists to refuse.
 */
export interface BasisRiskCase {
  /** What the index does. */
  index: string
  /** What the field does while it does it. */
  field: string
  /** What the money does. */
  money: string
  /** Does this policy pay in this case? */
  paid: boolean
  /** Is the crop lost in this case? */
  harmed: boolean
}

export interface BasisRisk {
  /** What the payout is decided by, and what it is not decided by. */
  trigger: string
  /** The divergence, both ways round. */
  cases: readonly [BasisRiskCase, BasisRiskCase]
  /** What the owner gets in exchange for carrying it. */
  trade: string
}

export function basisRisk(policy: Policy, decimals: number): BasisRisk {
  const threshold = `${policy.spellDaysThreshold} dry days in a row`

  return {
    trigger: `This policy pays on rainfall measured across cell ${policy.cellId}, not on what happens in your field. Nobody comes to look at the crop, and there is nothing to claim.`,
    cases: [
      {
        index: `The cell records ${threshold}`,
        field: 'while your crop comes through fine',
        money: `you are paid ${formatAmount(policy.payout, decimals)} ${ASSET}`,
        paid: true,
        harmed: false,
      },
      {
        index: `The cell never records ${threshold}`,
        field: 'while your crop is lost anyway',
        money: 'you are paid nothing',
        paid: false,
        harmed: true,
      },
    ],
    trade:
      'Both of these happen, and neither is a fault to be fixed. The gauges measure a cell, your field is smaller than the cell, and rain does not fall evenly across either. It is what a payout with no claim form, no inspector and no argument costs.',
  }
}
