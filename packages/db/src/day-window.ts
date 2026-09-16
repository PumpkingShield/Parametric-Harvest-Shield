import { type DayClassification, DayState, drySpell } from '@pumpking/shared'
import type { DayRow } from './interval-store.ts'

/**
 * Reading a set of stored days as a **window** — `FR-047`.
 *
 * `dayRecords` returns the rows that exist and says nothing about the ones
 * that do not; this is the one place that decides what their absence means,
 * and it decides it once. Two callers already ask the question — the worker,
 * to know whether a policy is worth a transaction, and the API, to tell an
 * owner how long the current run is — and a second definition of "a day with
 * no row" is how the interface starts promising a payout the chain will not
 * make.
 *
 * The answer is the same one the on-chain ring gives for a day it cannot speak
 * for: not an answer, and a break in the run (`FR-047`). It errs in the only
 * safe direction — a missing row makes the worker decline to call and makes
 * the screen show a shorter run, never a longer one.
 */

/**
 * The window's days in order, `[from, to]` inclusive, with the days the store
 * has no row for filled in as no coverage.
 */
export function daysInWindow(
  rows: readonly DayRow[],
  fromDay: number,
  toDay: number,
): DayClassification[] {
  const byDay = new Map(rows.map((row) => [row.dayIndex, row.state]))
  const days: DayClassification[] = []
  for (let day = fromDay; day <= toDay; day += 1) {
    days.push(byDay.get(day) ?? DayState.NoCoverage)
  }
  return days
}

/** The run of dry days inside a window, as the aggregator's own rows see it. */
export function spellInWindow(
  rows: readonly DayRow[],
  windowStartDay: number,
  windowEndDay: number,
): number {
  return drySpell(daysInWindow(rows, windowStartDay, windowEndDay))
}
