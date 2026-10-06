import type {
  CellIntervalRow,
  OperatorStore,
  RegistryStore,
  SensorReadingRow,
  SensorVerdictRow,
} from '@pumpking/db'
import { decodeBase58, h3IndexFromCellId, ReadingKind, SENSOR_KEY_BYTES } from '@pumpking/shared'
import { Hono } from 'hono'
import { apiError } from '../errors.ts'

/**
 * `GET /v1/sensors/:pubkey/activity` — what the network made of a sensor's
 * readings, and what it paid for them. `T040`, `FR-036`, `FR-050`.
 *
 * The operator screen's half that is the aggregator's word. Every reading of
 * the last day, each with what happened to it — counted in the median, judged
 * an outlier, stored without a vote, or still waiting for its day to close —
 * and what each day earned, as the program logged it (`slot_rewards`).
 *
 * **What is waiting to be claimed is not here.** It is a field of the chain
 * (`CellRewards.accrued`) that a claim empties the moment it lands; a mirror of
 * it would show a sum already paid, and offer to pay it again. The page reads
 * it from the chain beside the button that claims it.
 *
 * **A reading is matched to its interval through the aggregator's own record**
 * (`cell_hours`), not through an interval length this process would have to be
 * told: the worker cuts the day (`INTERVALS_PER_DAY`), and its intervals are
 * written for every day it closes. The reading's interval is the last one of
 * its own pool day that starts at or before it; a day not closed yet has none,
 * and its readings are `pending` rather than guessed at.
 */

/** The pool's clock, as the chain publishes it. */
export type PoolClock = { genesisTs: Date; secondsPerDay: number }

/** What became of one reading. */
export type ReadingVerdict =
  /** Its interval was judged, and the sensor's value sat with the median. */
  | 'counted'
  /** Its interval was judged, and the sensor's value was off the median — `FR-011`. */
  | 'outlier'
  /** The interval had a median and this sensor no vote in it — `FR-050`, `FR-059`. */
  | 'not-counted'
  /** The interval fell short of the votes a median needs — `FR-010`. */
  | 'no-median'
  /** Its day has not been closed yet. */
  | 'pending'
  /** Arrived past the window, stored and never counted — `FR-004`. */
  | 'late'

export type ReadingWire = {
  measuredAt: string
  /** The cell the reading was stored under, hex. */
  cellId: string
  valueX100: number
  verdict: ReadingVerdict
  /** The cell's median it was judged against; null when not judged. */
  medianX100: number | null
}

export type EarnedDayWire = {
  cellId: string
  dayIndex: number
  /** Start of the pool day; null before the pool exists. */
  startsAt: string | null
  /** Base units of the pool's asset, decimal. */
  amount: string
}

export type ActivityWire = {
  pubkey: string
  since: string
  until: string
  readings: ReadingWire[]
  earned: { total: string; days: EarnedDayWire[] }
}

/** How far back the readings go. A day is what an operator checks a phone over. */
export const ACTIVITY_HOURS = 24
/** How far back the daily earnings go. */
export const EARNED_DAYS = 30
/** A phone sends a handful a day; a scenario sensor can send far more. */
export const ACTIVITY_READINGS = 200

const KIND = ReadingKind.PrecipitationMm

export function dayIndexOf(clock: PoolClock, at: Date): number | null {
  const elapsed = at.getTime() - clock.genesisTs.getTime()
  if (elapsed < 0) return null
  return Math.floor(elapsed / (clock.secondsPerDay * 1000))
}

export function dayStartOf(clock: PoolClock, dayIndex: number): Date {
  return new Date(clock.genesisTs.getTime() + dayIndex * clock.secondsPerDay * 1000)
}

/**
 * What became of each reading — a pure function of what the aggregator wrote,
 * so every branch is tested without a database.
 */
export function readingVerdicts(input: {
  readings: readonly SensorReadingRow[]
  intervals: readonly CellIntervalRow[]
  closedDays: readonly { cellId: bigint; dayIndex: number }[]
  verdicts: readonly SensorVerdictRow[]
  clock: PoolClock | null
}): ReadingWire[] {
  const closed = new Set(input.closedDays.map((day) => `${day.cellId}:${day.dayIndex}`))
  const verdictAt = new Map(
    input.verdicts.map((verdict) => [
      `${verdict.cellId}:${verdict.intervalStart.getTime()}`,
      verdict,
    ]),
  )

  return input.readings.map((reading) => {
    const wire = (verdict: ReadingVerdict, medianX100: number | null = null): ReadingWire => ({
      measuredAt: reading.measuredAt.toISOString(),
      cellId: h3IndexFromCellId(reading.cellId),
      valueX100: reading.valueX100,
      verdict,
      medianX100,
    })

    // Only `accepted` reaches a median. `late` is the one other status the
    // door writes; `outlier` and `rejected` are in the enum and set by nothing.
    if (reading.status !== 'accepted') return wire('late')
    const { clock } = input
    const day = clock === null ? null : dayIndexOf(clock, reading.measuredAt)
    if (clock === null || day === null || !closed.has(`${reading.cellId}:${day}`)) {
      return wire('pending')
    }

    const dayStart = dayStartOf(clock, day).getTime()
    let interval: CellIntervalRow | undefined
    for (const candidate of input.intervals) {
      const start = candidate.start.getTime()
      if (candidate.cellId !== reading.cellId) continue
      if (start < dayStart || start > reading.measuredAt.getTime()) continue
      if (interval === undefined || start > interval.start.getTime()) interval = candidate
    }
    if (interval === undefined) return wire('pending')

    const verdict = verdictAt.get(`${reading.cellId}:${interval.start.getTime()}`)
    if (verdict !== undefined) {
      return wire(verdict.outlier ? 'outlier' : 'counted', verdict.medianX100)
    }
    return interval.medianX100 === null
      ? wire('no-median')
      : wire('not-counted', interval.medianX100)
  })
}

export type ActivityRouteOptions = {
  registry: RegistryStore
  store: OperatorStore
  clock: () => Promise<PoolClock | null>
  now?: () => Date
}

export function createActivityRoute(options: ActivityRouteOptions): Hono {
  const now = options.now ?? (() => new Date())

  return new Hono().get('/:pubkey/activity', async (context) => {
    const pubkey = context.req.param('pubkey')
    if (decodeBase58(pubkey, SENSOR_KEY_BYTES) === null) {
      return apiError(context, 400, 'invalid sensor key', {
        fields: [
          {
            field: 'pubkey',
            message: `must be a base58-encoded ${SENSOR_KEY_BYTES}-byte ed25519 public key`,
          },
        ],
      })
    }
    const [row] = await options.registry.rowsOf([pubkey])
    if (row === undefined) {
      return apiError(context, 404, 'no sensor with that key in the registry')
    }

    const until = now()
    const since = new Date(until.getTime() - ACTIVITY_HOURS * 3_600_000)
    const clock = await options.clock()
    const cells = [row.cellId, ...(row.previousCellId === null ? [] : [row.previousCellId])]

    const readings = await options.store.sensorReadings(
      pubkey,
      KIND,
      since,
      until,
      ACTIVITY_READINGS,
    )
    const oldest = readings.at(-1)?.measuredAt ?? since
    const firstDay = clock === null ? null : (dayIndexOf(clock, oldest) ?? 0)
    const lastDay = clock === null ? null : dayIndexOf(clock, until)
    // The intervals of the oldest reading's whole day: its interval may have
    // started before `since`.
    const from = clock === null || firstDay === null ? since : dayStartOf(clock, firstDay)

    const [intervals, closedDays, verdicts, earnedDays, total] = await Promise.all([
      options.store.cellIntervals(cells, KIND, from, until),
      firstDay === null || lastDay === null
        ? Promise.resolve([])
        : options.store.closedDays(cells, firstDay, lastDay),
      options.store.sensorVerdicts(pubkey, KIND, from, until),
      options.store.earnedDays(
        pubkey,
        lastDay === null ? 0 : Math.max(0, lastDay - EARNED_DAYS + 1),
      ),
      options.store.earnedTotal(pubkey),
    ])

    const wire: ActivityWire = {
      pubkey,
      since: since.toISOString(),
      until: until.toISOString(),
      readings: readingVerdicts({ readings, intervals, closedDays, verdicts, clock }),
      earned: {
        total: total.toString(),
        days: earnedDays.map((day) => ({
          cellId: h3IndexFromCellId(day.cellId),
          dayIndex: day.dayIndex,
          startsAt: clock === null ? null : dayStartOf(clock, day.dayIndex).toISOString(),
          amount: day.earned.toString(),
        })),
      },
    }
    return context.json(wire, 200)
  })
}
