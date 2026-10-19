import type {
  PendingReferenceDay,
  ReferenceHourRow,
  ReferenceStore,
  ReferenceVerdictRow,
} from '@pumpking/db'
import { cellCenter, cellIdFromH3Index, DayState, type ReferenceHour } from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import type { PoolClock } from './interval.ts'
import {
  openMeteoSource,
  REFERENCE_SETTLE_MS,
  type ReferenceSource,
  referenceApplies,
  referenceChecker,
  verdictsFor,
} from './reference.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const CELL = cellIdFromH3Index('871e701b3ffffff')
const OTHER = cellIdFromH3Index('872681a02ffffff')

/** A real-day pool whose day 0 is 1 October 2026. */
const clock: PoolClock = {
  genesisTs: new Date('2026-10-01T00:00:00Z'),
  secondsPerDay: 86_400,
  intervalsPerDay: 24,
}
const startOf = (day: number) => new Date(clock.genesisTs.getTime() + day * DAY_MS)
const dayOf = (at: Date) => Math.round((at.getTime() - clock.genesisTs.getTime()) / DAY_MS)
const params = { dryThresholdX100: 100, toleranceX100: 500 }

/** Every hour of `days` (inclusive range), each with `valueX100(day)`. */
function hoursOf(first: number, last: number, valueX100: (day: number) => number | null) {
  const hours: ReferenceHour[] = []
  for (let day = first; day <= last; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      hours.push({
        hourStart: new Date(startOf(day).getTime() + hour * HOUR_MS),
        valueX100: valueX100(day),
      })
    }
  }
  return hours
}

const dry = (cellId: bigint, dayIndex: number): PendingReferenceDay => ({
  cellId,
  dayIndex,
  state: DayState.Dry,
  rainfallX100: 0,
})

describe('referenceApplies', () => {
  it('asks the weather only about real days that start on the hour', () => {
    expect(referenceApplies(clock)).toBe(true)
    // The demo pool: a day in two seconds has no weather of its own (`FR-049`).
    expect(referenceApplies({ ...clock, secondsPerDay: 2 })).toBe(false)
    // A real day that starts at :30 straddles hours the source does not split.
    expect(referenceApplies({ ...clock, genesisTs: new Date('2026-10-01T00:30:00Z') })).toBe(false)
  })
})

describe('verdictsFor', () => {
  it('judges each day the source answered for in full, and leaves the rest pending', () => {
    // 60 hundredths an hour is 14.4 mm a day: rain the cell called dry.
    const hours = hoursOf(3, 4, () => 60).filter(
      (hour) => hour.hourStart.getTime() !== startOf(4).getTime() + 5 * HOUR_MS,
    )
    expect(verdictsFor([dry(CELL, 3), dry(CELL, 4)], hours, clock, params)).toEqual([
      { cellId: CELL, dayIndex: 3, state: 'disputed', rainfallX100: 1_440 },
    ])
  })

  it('keeps the reference total for a day the network did not measure, unchecked', () => {
    const silent = { cellId: CELL, dayIndex: 3, state: DayState.NoCoverage, rainfallX100: null }
    expect(
      verdictsFor(
        [silent],
        hoursOf(3, 3, () => 0),
        clock,
        params,
      ),
    ).toEqual([{ cellId: CELL, dayIndex: 3, state: 'unchecked', rainfallX100: 0 }])
  })
})

describe('openMeteoSource', () => {
  function answering(body: unknown, status = 200) {
    const urls: string[] = []
    const call = (async (url: string | URL | Request) => {
      urls.push(String(url))
      return new Response(JSON.stringify(body), { status })
    }) as typeof fetch
    return { urls, source: openMeteoSource('https://reference.test/v1/forecast', call) }
  }

  it("asks for the cell's centre over the dates the hours fall in, in UTC", async () => {
    const { urls, source } = answering({ hourly: { time: [], precipitation: [] } })
    await source.hours(CELL, startOf(3), startOf(5))
    const url = new URL(urls[0] ?? '')
    expect(url.origin + url.pathname).toBe('https://reference.test/v1/forecast')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      hourly: 'precipitation',
      start_date: '2026-10-04',
      // The last hour of day 4 is labelled 00:00 on the 6th.
      end_date: '2026-10-06',
      timezone: 'UTC',
    })
    const centre = cellCenter(CELL)
    expect(Number(url.searchParams.get('latitude'))).toBeCloseTo(centre.lat, 4)
    expect(Number(url.searchParams.get('longitude'))).toBeCloseTo(centre.lng, 4)
  })

  it('turns a label at the end of its hour into the hour that starts an hour earlier', async () => {
    const { source } = answering({
      hourly: {
        // Day 3 is 4 October. 00:00 on the 5th is its last hour; 02:00 is outside the range asked.
        time: ['2026-10-05T00:00', '2026-10-05T01:00', '2026-10-05T02:00'],
        precipitation: [9.9, 0.3, null],
      },
    })
    const hours = await source.hours(CELL, startOf(3), new Date(startOf(3).getTime() + HOUR_MS))
    expect(hours).toEqual([])
    const across = await source.hours(CELL, startOf(3), new Date(startOf(4).getTime() + HOUR_MS))
    expect(across).toEqual([
      { hourStart: new Date('2026-10-04T23:00:00Z'), valueX100: 990 },
      { hourStart: new Date('2026-10-05T00:00:00Z'), valueX100: 30 },
    ])
  })

  it('keeps an hour the source has no value for as null, not as a dry hour', async () => {
    const { source } = answering({ hourly: { time: ['2026-10-04T01:00'], precipitation: [null] } })
    expect(await source.hours(CELL, startOf(3), startOf(5))).toEqual([
      { hourStart: new Date('2026-10-04T00:00:00Z'), valueX100: null },
    ])
  })

  it('lets go of the request when the attempt does', async () => {
    let seen: AbortSignal | undefined
    const call = ((_: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }) as typeof fetch
    const controller = new AbortController()
    void openMeteoSource('https://reference.test/v1/forecast', call)
      .hours(CELL, startOf(3), startOf(4), controller.signal)
      .catch(() => {})
    await Promise.resolve()
    expect(seen?.aborted).toBe(false)
    controller.abort(new Error('out of budget'))
    // The request's own timeout still stands beside it.
    expect(seen?.aborted).toBe(true)
  })

  it('fails on an answer that is not one', async () => {
    await expect(
      answering({ error: true, reason: 'x' }, 400).source.hours(CELL, startOf(3), startOf(4)),
    ).rejects.toThrow(/400/)
    await expect(
      answering({ hourly: { time: ['x'] } }).source.hours(CELL, startOf(3), startOf(4)),
    ).rejects.toThrow()
  })
})

/** A store that remembers what the checker did to it. */
function memoryStore(pending: PendingReferenceDay[]) {
  const saved: { hours: ReferenceHourRow[]; verdicts: ReferenceVerdictRow[] }[] = []
  const gaveUp: (number | null)[] = []
  let left = [...pending]
  const store: ReferenceStore = {
    async pendingDays(fromDay) {
      return left.filter((day) => day.dayIndex >= fromDay)
    },
    async saveReference(hours, verdicts) {
      saved.push({ hours: [...hours], verdicts: [...verdicts] })
      left = left.filter(
        (day) =>
          !verdicts.some((one) => one.cellId === day.cellId && one.dayIndex === day.dayIndex),
      )
    },
    async giveUp(beforeDay) {
      gaveUp.push(beforeDay)
      const before = left.length
      left = left.filter((day) => beforeDay !== null && day.dayIndex >= beforeDay)
      return before - left.length
    },
  }
  return { store, saved, gaveUp, left: () => left }
}

function countingSource(answer: (cellId: bigint, from: Date, to: Date) => ReferenceHour[]) {
  const asked: { cellId: bigint; from: Date; to: Date }[] = []
  const source: ReferenceSource = {
    async hours(cellId, from, to) {
      asked.push({ cellId, from, to })
      return answer(cellId, from, to)
    },
  }
  return { source, asked }
}

describe('referenceChecker', () => {
  // Day 9 is today; day 8 ended at 00:00 and is still settling.
  const now = new Date(startOf(9).getTime() + 6 * HOUR_MS)

  it('asks once per cell, over every settled day it has waiting, and saves hours with verdicts', async () => {
    const memory = memoryStore([dry(CELL, 5), dry(CELL, 7), dry(CELL, 8), dry(OTHER, 6)])
    // Day 7 had 12 mm at the reference; the cell called it dry.
    const { source, asked } = countingSource((_, from, to) =>
      hoursOf(dayOf(from), dayOf(to) - 1, (day) => (day === 7 ? 50 : 0)),
    )
    const report = await referenceChecker({ store: memory.store, source }).checkIfDue(
      now,
      clock,
      100,
    )

    expect(asked).toEqual([
      { cellId: CELL, from: startOf(5), to: startOf(8) },
      { cellId: OTHER, from: startOf(6), to: startOf(7) },
    ])
    expect(report).toEqual({
      status: 'checked',
      gaveUp: 0,
      applies: true,
      cells: [
        { cellId: CELL, status: 'checked', agrees: 1, disputed: 1, unchecked: 0, pending: 0 },
        { cellId: OTHER, status: 'checked', agrees: 1, disputed: 0, unchecked: 0, pending: 0 },
      ],
      deferred: 0,
    })
    // Three days of hours for the first cell, all kept for the trace.
    expect(memory.saved[0]?.hours).toHaveLength(72)
    // Day 8 waits for the forecast to settle.
    expect(memory.left()).toEqual([dry(CELL, 8)])
    expect(startOf(9).getTime() + REFERENCE_SETTLE_MS).toBeGreaterThan(now.getTime())
  })

  it('gives up on days past the window as unchecked, and judges none of them', async () => {
    const memory = memoryStore([dry(CELL, 0), dry(CELL, 1), dry(CELL, 5)])
    const { source, asked } = countingSource(() => [])
    const report = await referenceChecker({
      store: memory.store,
      source,
      windowDays: 7,
    }).checkIfDue(now, clock, 100)
    expect(memory.gaveUp).toEqual([2])
    expect(report).toMatchObject({ status: 'checked', gaveUp: 2, applies: true })
    expect(asked.map((one) => one.cellId)).toEqual([CELL])
  })

  it('on a compressed clock asks nothing and marks every pending day unchecked — FR-049, FR-044', async () => {
    const memory = memoryStore([dry(CELL, 500), dry(CELL, 501)])
    const { source, asked } = countingSource(() => [])
    const report = await referenceChecker({ store: memory.store, source }).checkIfDue(
      now,
      { ...clock, secondsPerDay: 2 },
      100,
    )
    expect(asked).toEqual([])
    expect(memory.gaveUp).toEqual([null])
    expect(report).toEqual({
      status: 'checked',
      gaveUp: 2,
      applies: false,
      cells: [],
      deferred: 0,
    })
  })

  it('leaves a cell pending when the source fails, and still checks the others', async () => {
    const memory = memoryStore([dry(CELL, 5), dry(OTHER, 5)])
    const { source } = countingSource((cellId) => {
      if (cellId === CELL) throw new Error('503')
      return hoursOf(5, 5, () => 0)
    })
    const report = await referenceChecker({ store: memory.store, source }).checkIfDue(
      now,
      clock,
      100,
    )
    expect(report?.status === 'checked' && report.cells.map((cell) => cell.status)).toEqual([
      'failed',
      'checked',
    ])
    expect(memory.left()).toEqual([dry(CELL, 5)])
  })

  it('a store that fails fails the attempt, not the cycle', async () => {
    const memory = memoryStore([])
    const store = { ...memory.store, giveUp: () => Promise.reject(new Error('db down')) }
    const report = await referenceChecker({
      store,
      source: countingSource(() => []).source,
    }).checkIfDue(now, clock, 100)
    expect(report).toMatchObject({ status: 'failed', error: new Error('db down') })
  })

  it('runs once per period, failure or not', async () => {
    const memory = memoryStore([])
    const checker = referenceChecker({
      store: memory.store,
      source: countingSource(() => []).source,
      everyMs: 600_000,
    })
    expect(await checker.checkIfDue(now, clock, 100)).not.toBeNull()
    expect(await checker.checkIfDue(new Date(now.getTime() + 599_999), clock, 100)).toBeNull()
    expect(await checker.checkIfDue(new Date(now.getTime() + 600_000), clock, 100)).not.toBeNull()
  })
})

/**
 * `FR-044` with a source that does not fail, but does not answer either. The
 * step runs inside the cycle, so the time it takes is time no day is closed
 * and no policy settled; what bounds it is the attempt's budget, not the
 * source's good behaviour.
 */
describe('referenceChecker — the budget of an attempt, FR-044', () => {
  const now = new Date(startOf(9).getTime() + 6 * HOUR_MS)
  // Three cells in the order the checker sorts them; no centre is needed.
  const [A, B, C] = [1n, 2n, 3n]
  const BUDGET_MS = 40

  /** A source that never answers for `stuck`, and ignores its signal while it does not. */
  function hangingOn(stuck: bigint) {
    const asked: bigint[] = []
    const signals: AbortSignal[] = []
    const source: ReferenceSource = {
      hours(cellId, _from, _to, signal) {
        asked.push(cellId)
        if (signal !== undefined) signals.push(signal)
        if (cellId === stuck) return new Promise(() => {})
        return Promise.resolve(hoursOf(5, 5, () => 0))
      },
    }
    return { source, asked, signals }
  }

  it('lets a cycle go after its budget however long the source would take', async () => {
    const memory = memoryStore([dry(A, 5), dry(B, 5), dry(C, 5)])
    const { source, signals } = hangingOn(A)
    const started = performance.now()
    const report = await referenceChecker({
      store: memory.store,
      source,
      budgetMs: BUDGET_MS,
    }).checkIfDue(now, clock, 100)
    const took = performance.now() - started

    // The source would have kept it for ever; the budget is what returned it.
    expect(took).toBeGreaterThanOrEqual(BUDGET_MS - 5)
    expect(took).toBeLessThan(1_000)
    expect(report).toMatchObject({
      status: 'checked',
      cells: [{ cellId: A, status: 'failed' }],
      deferred: 2,
    })
    expect(signals[0]?.aborted).toBe(true)
    // No day was decided for want of an answer: all three wait, none unchecked.
    expect(memory.left()).toEqual([dry(A, 5), dry(B, 5), dry(C, 5)])
    expect(memory.gaveUp).toEqual([2])
  })

  it('starts the next attempt after the cell it stopped at, so one cell cannot starve the rest', async () => {
    const memory = memoryStore([dry(A, 5), dry(B, 5), dry(C, 5)])
    const { source, asked } = hangingOn(A)
    const checker = referenceChecker({
      store: memory.store,
      source,
      budgetMs: BUDGET_MS,
      everyMs: 600_000,
    })
    await checker.checkIfDue(now, clock, 100)
    const second = await checker.checkIfDue(new Date(now.getTime() + 600_000), clock, 100)

    expect(asked).toEqual([A, B, C, A])
    expect(second).toMatchObject({
      status: 'checked',
      cells: [
        { cellId: B, status: 'checked', agrees: 1 },
        { cellId: C, status: 'checked', agrees: 1 },
        { cellId: A, status: 'failed' },
      ],
      deferred: 0,
    })
    expect(memory.left()).toEqual([dry(A, 5)])
  })

  it('asks no cell once the budget is spent, and says how many wait', async () => {
    const memory = memoryStore([dry(A, 5), dry(B, 5), dry(C, 5)])
    let clockMs = 0
    const { source, asked } = countingSource(() => {
      // Every answer takes half the budget.
      clockMs += 500
      return hoursOf(5, 5, () => 0)
    })
    const report = await referenceChecker({
      store: memory.store,
      source,
      budgetMs: 1_000,
      elapsed: () => clockMs,
    }).checkIfDue(now, clock, 100)

    expect(asked.map((one) => one.cellId)).toEqual([A, B])
    expect(report).toMatchObject({ status: 'checked', deferred: 1 })
    expect(memory.left()).toEqual([dry(C, 5)])
  })

  it('refuses a budget that is not a positive whole number of milliseconds', () => {
    const store = memoryStore([]).store
    const source = countingSource(() => []).source
    expect(() => referenceChecker({ store, source, budgetMs: 0 })).toThrow(RangeError)
    expect(() => referenceChecker({ store, source, budgetMs: 1.5 })).toThrow(RangeError)
  })
})
