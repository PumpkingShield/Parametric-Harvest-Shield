import type { PendingReferenceDay, ReferenceStore, ReferenceVerdictRow } from '@pumpking/db'
import {
  cellCenter,
  DISPUTE_TOLERANCE_X100,
  judgeDay,
  type ReferenceHour,
  referenceDayX100,
} from '@pumpking/shared'
import { z } from 'zod'
import { dayIndexAt, dayStart, type PoolClock } from './interval.ts'

/**
 * The reference check, turned by the worker — `FR-013`, `FR-043`, `FR-044`,
 * `T042`.
 *
 * Every day the chain holds is compared, once, with what a public weather
 * service says fell at the cell's centre over the same 24 hours, and marked
 * `agrees` or `disputed` (the rule and its measured tolerance are in
 * `@pumpking/shared/reference`). Nothing else changes: the day is on chain
 * before it is compared, and its verdict is written beside it, not into it.
 *
 * **Never in the way of a payout.** A step of its own, after the days and the
 * money, never inside closing a day: an outside service that is slow or down
 * would otherwise be a reason a day — and the payout it completes — did not
 * reach the chain (`FR-044`). A source that fails leaves the day `pending`
 * for the next attempt; one that has not answered within the window leaves it
 * `unchecked` for good.
 *
 * **Only on a clock that counts real days.** A compressed pool (`FR-049`)
 * counts a day in seconds, and its day has no 24 hours of weather to be
 * compared with. Laying its days over the calendar would invent a check, so
 * on such a pool every day is `unchecked`, said once per attempt.
 *
 * **After the forecast settles.** The source is a forecast archive: an hour
 * just past is still the last run's guess and is replaced by the next run.
 * A day is asked about once its end is `settleMs` behind, so the verdict is
 * made on the hours that stay.
 *
 * **Within a budget.** The step runs inside the cycle, and a cycle that waits
 * is a day — and a payout — that waits with it. A source that does not answer
 * is not one that fails fast: each request may take its timeout, and cells are
 * asked one by one. So an attempt has `budgetMs` in all, whatever the source
 * does with its signal; a cell still waiting when it runs out fails, the cells
 * not reached stay `pending`, and the next attempt starts after the last cell
 * asked, so one source that hangs on one cell cannot starve the rest (`FR-044`).
 */

export const REFERENCE_EVERY_MS = 600_000
/** How long the reference has to answer for a day before it is `unchecked`. */
export const REFERENCE_WINDOW_DAYS = 7
/** Two runs of a six-hourly model. */
export const REFERENCE_SETTLE_MS = 12 * 3_600_000
/** All the time one attempt may keep a cycle waiting. */
export const REFERENCE_BUDGET_MS = 20_000

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

const HOUR_MS = 3_600_000
const DAY_SECONDS = 86_400

export interface ReferenceSource {
  /**
   * The hours that start in `[from, to)` at the cell's centre. `signal` aborts
   * when the attempt's budget is spent; a source that ignores it is let go of
   * anyway.
   */
  hours(cellId: bigint, from: Date, to: Date, signal?: AbortSignal): Promise<ReferenceHour[]>
}

const openMeteoSchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    precipitation: z.array(z.number().nullable()),
  }),
})

/** `YYYY-MM-DD` of an instant, in UTC. */
function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * Open-Meteo's forecast API — public, no key, CC BY 4.0, free for
 * non-commercial use (a commercial launch needs its paid plan or another
 * `ReferenceSource`). `best_match` picks the finest model for the place.
 *
 * Open-Meteo labels an hourly sum by the **end** of its hour ("the preceding
 * hour"), so the hour starting at 00:00 is the one labelled 01:00, and a day
 * reaches into the first label of the next date.
 */
export function openMeteoSource(
  baseUrl: string = OPEN_METEO_FORECAST_URL,
  call: typeof fetch = fetch,
  timeoutMs = 15_000,
): ReferenceSource {
  return {
    async hours(cellId, from, to, signal) {
      const { lat, lng } = cellCenter(cellId)
      const params = new URLSearchParams({
        latitude: lat.toFixed(5),
        longitude: lng.toFixed(5),
        hourly: 'precipitation',
        start_date: utcDate(from),
        end_date: utcDate(to),
        timezone: 'UTC',
      })
      const response = await call(`${baseUrl}?${params}`, {
        signal:
          signal === undefined
            ? AbortSignal.timeout(timeoutMs)
            : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
      })
      if (!response.ok) {
        throw new Error(`the reference answered ${response.status}: ${await response.text()}`)
      }
      const { hourly } = openMeteoSchema.parse(await response.json())
      if (hourly.time.length !== hourly.precipitation.length) {
        throw new Error('the reference sent hours and values of different lengths')
      }

      const hours: ReferenceHour[] = []
      hourly.time.forEach((label, at) => {
        const end = Date.parse(`${label}:00Z`)
        if (!Number.isFinite(end))
          throw new Error(`the reference sent an hour that is not one: ${label}`)
        const hourStart = new Date(end - HOUR_MS)
        if (hourStart < from || hourStart >= to) return
        const mm = hourly.precipitation[at]
        // Tenths of a millimetre come back as binary fractions; rounding to
        // the hundredth is exact for every value the source can send.
        hours.push({
          hourStart,
          valueX100: mm === null || mm === undefined ? null : Math.round(mm * 100),
        })
      })
      return hours
    },
  }
}

/** Whether a pool's days are days the weather can be asked about. */
export function referenceApplies(clock: PoolClock): boolean {
  return clock.secondsPerDay === DAY_SECONDS && clock.genesisTs.getTime() % HOUR_MS === 0
}

export type CellReferenceOutcome =
  | {
      cellId: bigint
      status: 'checked'
      agrees: number
      disputed: number
      unchecked: number
      pending: number
    }
  | { cellId: bigint; status: 'failed'; error: Error }

export type ReferenceReport =
  | {
      status: 'checked'
      /** Days given up as `unchecked` this attempt. */
      gaveUp: number
      /** False on a clock that does not count real days — nothing was asked. */
      applies: boolean
      cells: CellReferenceOutcome[]
      /** Cells with days waiting that the budget ran out before. */
      deferred: number
    }
  | { status: 'failed'; error: Error }

export interface ReferenceChecker {
  /**
   * Compares if the period has passed since the last attempt; null otherwise.
   * `dryThresholdX100` is the pool's, read this cycle — both sides of a day are
   * classed by one threshold.
   */
  checkIfDue(now: Date, clock: PoolClock, dryThresholdX100: number): Promise<ReferenceReport | null>
}

export type ReferenceCheckerDeps = {
  store: ReferenceStore
  source: ReferenceSource
  toleranceX100?: number
  everyMs?: number
  windowDays?: number
  settleMs?: number
  budgetMs?: number
  /** Milliseconds on a clock that only moves forward; the budget is spent on it. */
  elapsed?: () => number
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** The attempt's time ran out while a cell was being asked. */
class BudgetSpent extends Error {
  constructor() {
    super('the reference did not answer within the budget of the attempt')
  }
}

/** `work`, or a `BudgetSpent` once `ms` have passed — whichever comes first. */
async function within<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new BudgetSpent()
      controller.abort(error)
      reject(error)
    }, ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/** Cells after `last` first, then the rest — where the previous attempt stopped. */
function fromAfter<T>(cells: readonly [bigint, T][], last: bigint | null): [bigint, T][] {
  if (last === null) return [...cells]
  const at = cells.findIndex(([cellId]) => cellId > last)
  return at === -1 ? [...cells] : [...cells.slice(at), ...cells.slice(0, at)]
}

/** The verdicts one answer of the source makes on one cell's pending days. */
export function verdictsFor(
  days: readonly PendingReferenceDay[],
  hours: readonly ReferenceHour[],
  clock: PoolClock,
  params: { dryThresholdX100: number; toleranceX100: number },
): ReferenceVerdictRow[] {
  return days.flatMap((day) => {
    const total = referenceDayX100(hours, dayStart(clock, day.dayIndex))
    if (total === null) return []
    return [
      {
        cellId: day.cellId,
        dayIndex: day.dayIndex,
        state: judgeDay(day, total, params),
        rainfallX100: total,
      },
    ]
  })
}

export function referenceChecker(deps: ReferenceCheckerDeps): ReferenceChecker {
  const everyMs = deps.everyMs ?? REFERENCE_EVERY_MS
  const windowDays = deps.windowDays ?? REFERENCE_WINDOW_DAYS
  const settleMs = deps.settleMs ?? REFERENCE_SETTLE_MS
  const toleranceX100 = deps.toleranceX100 ?? DISPUTE_TOLERANCE_X100
  const budgetMs = deps.budgetMs ?? REFERENCE_BUDGET_MS
  const elapsed = deps.elapsed ?? (() => performance.now())
  if (!Number.isInteger(everyMs) || everyMs < 1) {
    throw new RangeError(`everyMs must be a positive integer: ${everyMs}`)
  }
  if (!Number.isInteger(budgetMs) || budgetMs < 1) {
    throw new RangeError(`budgetMs must be a positive integer: ${budgetMs}`)
  }
  let lastAttemptAt: number | null = null
  let lastCellAsked: bigint | null = null

  return {
    async checkIfDue(now, clock, dryThresholdX100) {
      const at = now.getTime()
      if (lastAttemptAt !== null && at - lastAttemptAt < everyMs) return null
      // Recorded before the attempt, so a failure waits its period too: a
      // public service that is struggling is not asked again every few seconds.
      lastAttemptAt = at
      const deadline = elapsed() + budgetMs

      try {
        if (!referenceApplies(clock)) {
          return {
            status: 'checked',
            gaveUp: await deps.store.giveUp(null),
            applies: false,
            cells: [],
            deferred: 0,
          }
        }
        const today = dayIndexAt(clock, now)
        if (today === null) {
          return { status: 'checked', gaveUp: 0, applies: true, cells: [], deferred: 0 }
        }

        const fromDay = Math.max(0, today - windowDays)
        const gaveUp = await deps.store.giveUp(fromDay)

        const settled = (await deps.store.pendingDays(fromDay)).filter(
          (day) => dayStart(clock, day.dayIndex + 1).getTime() + settleMs <= at,
        )
        const byCell = new Map<bigint, PendingReferenceDay[]>()
        for (const day of settled) byCell.set(day.cellId, [...(byCell.get(day.cellId) ?? []), day])

        const cells: CellReferenceOutcome[] = []
        const queue = fromAfter([...byCell], lastCellAsked)
        let asked = 0
        for (const [cellId, days] of queue) {
          const left = deadline - elapsed()
          if (left <= 0) break
          asked += 1
          lastCellAsked = cellId
          try {
            const first = days[0]
            const last = days[days.length - 1]
            if (first === undefined || last === undefined) continue
            const from = dayStart(clock, first.dayIndex)
            const to = dayStart(clock, last.dayIndex + 1)
            // One request per cell, over every day it has waiting.
            const controller = new AbortController()
            const hours = await within(
              deps.source.hours(cellId, from, to, controller.signal),
              left,
              controller,
            )
            const verdicts = verdictsFor(days, hours, clock, { dryThresholdX100, toleranceX100 })
            const kept = hours.flatMap(({ hourStart, valueX100 }) =>
              valueX100 === null ? [] : [{ cellId, hourStart, valueX100 }],
            )
            await deps.store.saveReference(kept, verdicts)
            const count = (state: string) => verdicts.filter((one) => one.state === state).length
            cells.push({
              cellId,
              status: 'checked',
              agrees: count('agrees'),
              disputed: count('disputed'),
              unchecked: count('unchecked'),
              pending: days.length - verdicts.length,
            })
          } catch (cause) {
            cells.push({ cellId, status: 'failed', error: asError(cause) })
            // The timer is the budget's end, not a reading of the clock: a
            // timer may fire a fraction of a millisecond before `elapsed()`
            // agrees, and the cells after this one wait for the next attempt.
            if (cause instanceof BudgetSpent) break
          }
        }
        return { status: 'checked', gaveUp, applies: true, cells, deferred: queue.length - asked }
      } catch (cause) {
        return { status: 'failed', error: asError(cause) }
      }
    },
  }
}
