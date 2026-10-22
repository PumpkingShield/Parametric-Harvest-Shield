import { type DayClassification, DayState } from './day.ts'

/**
 * The public weather reference a cell's day is compared with — `FR-013`,
 * `FR-043`, `FR-044`.
 *
 * **It marks, it never decides.** The day the chain holds is the sensors'
 * median, whatever the reference says (`FR-043`): a model on a grid of
 * kilometres cannot overrule a gauge in the field, or the product is back to
 * the gap it exists to close. A disputed day still counts in every policy's run
 * (`FR-017`); the dispute is a supervision signal that only ever moves future
 * underwriting (`FR-045`, `T044`).
 *
 * **A day, not an hour.** The index is a run of dry and wet days, so the only
 * disagreement that can matter is a disagreement about the class of a day.
 * Hour by hour a model moves a storm by an hour or two and would dispute
 * nearly every wet day it agrees about.
 *
 * **The tolerance is measured, not chosen.** CoCoRaHS gauges in
 * `fixtures/sc003-gauges.json` (40 cells, April–September 2025) against
 * Open-Meteo's forecast archive for the same cell centres, each gauge day being
 * the 24 hours to its morning reading:
 *
 * | tolerance | honest days disputed | worst cell | a 14-day fake drought in the wettest fortnight |
 * |---|---|---|---|
 * | none      | 15.2 % | —      | — |
 * | 2 mm      | 8.1 %  | 12.7 % | 3–6 days of 14 |
 * | 5 mm      | 3.2 %  | 6.7 %  | 2–5 days of 14 |
 *
 * Five millimetres keeps honest noise to about one day in thirty while a cell
 * that reports a drought through real rain still shows it. ERA5 on the same
 * gauges disputes 24.4 % of days without a tolerance; the forecast archive is
 * both closer to the gauges and available without ERA5's five-day delay.
 */
export const DISPUTE_TOLERANCE_X100 = 500

/** Where the numbers come from, said wherever they are shown — CC BY 4.0. */
export const REFERENCE_SOURCE = {
  name: 'Open-Meteo',
  url: 'https://open-meteo.com/',
  licence: 'CC BY 4.0',
  variable: 'precipitation, hourly sum',
} as const

/**
 * Where a day stands against the reference.
 *
 * - `pending` — not compared yet; the reference may still answer.
 * - `agrees` — the same class, or a different one within the tolerance.
 * - `disputed` — a different class, apart by at least the tolerance.
 * - `unchecked` — will not be compared: the network had no value for the day,
 *   the reference never answered within the window, or the pool's clock does
 *   not count real days (`FR-044` — "without a check", and the day stands).
 */
export const ReferenceState = {
  Pending: 'pending',
  Agrees: 'agrees',
  Disputed: 'disputed',
  Unchecked: 'unchecked',
} as const

export type ReferenceStateName = (typeof ReferenceState)[keyof typeof ReferenceState]

/** A day of the reference, one hour at a time. */
export type ReferenceHour = {
  /** Start of the hour, UTC. */
  hourStart: Date
  /** Precipitation over the hour in hundredths of a millimetre; null when the source had none. */
  valueX100: number | null
}

const HOUR_MS = 3_600_000
export const REFERENCE_DAY_HOURS = 24

/**
 * The reference total of the 24 hours from `dayStart`, or null unless every one
 * of them has a value. A day with a hole is not a smaller day: it is a day the
 * reference has not finished answering for.
 */
export function referenceDayX100(hours: readonly ReferenceHour[], dayStart: Date): number | null {
  const from = dayStart.getTime()
  const values = new Map<number, number | null>()
  for (const hour of hours) values.set(hour.hourStart.getTime(), hour.valueX100)

  let total = 0
  for (let hour = 0; hour < REFERENCE_DAY_HOURS; hour += 1) {
    const value = values.get(from + hour * HOUR_MS)
    if (value === undefined || value === null) return null
    total += value
  }
  return total
}

/**
 * The verdict on one day of one cell. Only `agrees`, `disputed` or `unchecked`:
 * a day with no reference value yet is the caller's to keep pending or give up.
 *
 * Dry is `<= threshold`, the same comparison `classifyDay` makes, so the two
 * sides are classed by one rule.
 */
export function judgeDay(
  cell: { state: DayClassification; rainfallX100: number | null },
  referenceX100: number,
  params: { dryThresholdX100: number; toleranceX100: number },
): Exclude<ReferenceStateName, 'pending'> {
  if (cell.state === DayState.NoCoverage || cell.rainfallX100 === null) {
    return ReferenceState.Unchecked
  }
  const cellDry = cell.state === DayState.Dry
  const referenceDry = referenceX100 <= params.dryThresholdX100
  if (cellDry === referenceDry) return ReferenceState.Agrees
  return Math.abs(cell.rainfallX100 - referenceX100) >= params.toleranceX100
    ? ReferenceState.Disputed
    : ReferenceState.Agrees
}

/**
 * `FR-045` — when a cell's disagreement with the reference is systematic.
 *
 * **Days the cell called dry that the reference disputed**, at least
 * `INVESTIGATION_DISPUTED_DAYS` of them within `INVESTIGATION_WINDOW_DAYS`
 * back from today. One-sided, because a faked drought is the only lie that
 * pays: of the 135 honest days disputed in the measurement behind
 * `DISPUTE_TOLERANCE_X100`, only 27 go this way, and no honest cell has more
 * than two of them in any window up to a whole season. Measured on the same
 * gauges (`T044`):
 *
 * | rule (dry-side disputes) | honest cells alarmed | one faked 14-day run caught | two | three |
 * |---|---|---|---|---|
 * | 2 in 90 days  | 6 of 40 | 38.5 % | 68.9 % | 82.5 % |
 * | **3 in 90 days** | **0 of 40** | 14.5 % | 42.3 % | 64.1 % |
 * | 3 in 60 days  | 0 of 40 | 11.3 % | 32.1 % | 52.5 % |
 *
 * **What it cannot see.** In 41.9 % of the placements where a faked run
 * changes the outcome, no faked day had the reference at the tolerance or
 * above: the model saw no rain worth disputing either. An operator who reads
 * the reference can pick such a fortnight. The lever catches the cell that
 * does it again, not the first time — which is what it is for: it moves
 * future underwriting, and a policy already sold is paid by the median
 * (`FR-043`).
 *
 * Twinned with the program, which checks its half of the rule on chain: the
 * days are named, inside the window, and dry in the cell's own log.
 */
export const INVESTIGATION_WINDOW_DAYS = 90
export const INVESTIGATION_DISPUTED_DAYS = 3

/**
 * The days that put a cell under investigation on `today`, oldest first — or
 * null when the rule has not fired. `disputedDryDays` are the cell's days with
 * a dry class and a `disputed` verdict; any order, repeats ignored.
 */
export function investigationDays(
  disputedDryDays: readonly number[],
  today: number,
): number[] | null {
  const inWindow = [
    ...new Set(
      disputedDryDays.filter((day) => day < today && today - day <= INVESTIGATION_WINDOW_DAYS),
    ),
  ].sort((a, b) => a - b)
  return inWindow.length >= INVESTIGATION_DISPUTED_DAYS ? inWindow : null
}
