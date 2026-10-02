import { lt } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { cellHours, readings, sensorVerdicts } from './schema.ts'

/**
 * How long the raw material stays — `SC-012`, `T055`.
 *
 * Two tables grow with every hour the network is up and nothing else does:
 * `readings` (one row per sensor per interval) and `cell_hours` (one per cell
 * per interval). `cell_days` is kept forever, because it is the row a payout is
 * explained from long after the readings behind it are gone — its Merkle root
 * is what still proves them.
 *
 * **Wall time, not the pool's clock.** The limit is bytes in a database, and
 * bytes do not know that a demo pool counts a day in two seconds. Swept by the
 * pool's days, a compressed run would lose its readings within a minute of
 * making them, while the storage it is protecting would barely have moved.
 *
 * **By when the row arrived, not by what it describes.** `received_at` is set
 * by the server; `measured_at` is whatever the sensor signed. A cutoff on the
 * second would let a sensor keep a row forever by claiming a future hour, or
 * have a fresh one swept by claiming an old one. For `cell_hours` the same role
 * is played by `created_at`.
 *
 * **A reading swept is not a replay reopened.** `FR-003` is held by the unique
 * index on `(sensor, counter)`, and the sweep removes rows from it. A signed
 * reading older than the window, sent again, is stored again — but it arrives
 * `late` by construction (`classifyArrival`), so it never counts towards a
 * median, and the next sweep takes it out again.
 */

export const READINGS_RETENTION_DAYS = 30
export const CELL_HOURS_RETENTION_MONTHS = 12

/** Rows that arrived before these instants are past their retention. */
export type RetentionCutoffs = {
  readings: Date
  cellHours: Date
}

/** How many rows a sweep removed from each table. */
export type SweepResult = {
  readings: number
  cellHours: number
  /**
   * `sensor_verdicts` (`T034`) go with the readings they were judged from, by
   * the same cutoff: thirty days on a real clock is twice the window outliers
   * are counted over, and a verdict outliving its readings would be a claim
   * about an interval nobody can check any more.
   */
  verdicts: number
}

const DAY_MS = 86_400_000

/**
 * The cutoffs retention alone would set at `now`.
 *
 * Months are calendar months in UTC rather than a fixed number of days, which
 * is what "twelve months" means to whoever reads `SC-012`. A 29 February rolls
 * over to 1 March a year earlier — a day's difference in a year of rows.
 */
export function retentionCutoffs(now: Date): RetentionCutoffs {
  const time = now.getTime()
  if (!Number.isFinite(time)) throw new RangeError('now is not a valid date')

  const cellHoursCutoff = new Date(time)
  cellHoursCutoff.setUTCMonth(cellHoursCutoff.getUTCMonth() - CELL_HOURS_RETENTION_MONTHS)

  return {
    readings: new Date(time - READINGS_RETENTION_DAYS * DAY_MS),
    cellHours: cellHoursCutoff,
  }
}

/**
 * The cutoffs pulled back so that nothing a caller may still read is swept.
 *
 * `horizon` is the earliest instant the caller can still need — for the worker,
 * the start of the oldest day its backlog would close. With `BACKLOG_DAYS = 30`
 * on a real clock that day is exactly as old as the reading window, and a day
 * whose readings were swept before it was closed would be closed as **no
 * coverage**: a break written into somebody's run that the network did not
 * have. Retention is the one that gives way, because the rows it keeps longer
 * cost bytes and the day it would break costs a payout.
 */
export function cutoffsBefore(cutoffs: RetentionCutoffs, horizon: Date): RetentionCutoffs {
  const limit = horizon.getTime()
  if (!Number.isFinite(limit)) throw new RangeError('horizon is not a valid date')
  const earlier = (cutoff: Date) => new Date(Math.min(cutoff.getTime(), limit))
  return { readings: earlier(cutoffs.readings), cellHours: earlier(cutoffs.cellHours) }
}

export interface RetentionStore {
  sweep(cutoffs: RetentionCutoffs): Promise<SweepResult>
}

/**
 * The `RetentionStore` backed by the real tables.
 *
 * Two plain deletes, and a count back rather than the rows: on the free
 * deployment the database's egress is the bandwidth that runs out first, and
 * the first sweep after a long gap can be tens of thousands of ids nobody reads.
 *
 * `readings` has `readings_received_idx` for this; `cell_hours` has no index on
 * `created_at`, and gets none: the sweep runs once an hour over a table
 * `PLAN.md` puts at 44 MB after a year, and an index would spend part of the
 * very budget the sweep exists to keep.
 */
export function pgRetentionStore(db: PostgresJsDatabase<Record<string, never>>): RetentionStore {
  return {
    async sweep(cutoffs) {
      const sweptReadings = await db
        .delete(readings)
        .where(lt(readings.receivedAt, cutoffs.readings))
      const sweptHours = await db
        .delete(cellHours)
        .where(lt(cellHours.createdAt, cutoffs.cellHours))
      const sweptVerdicts = await db
        .delete(sensorVerdicts)
        .where(lt(sensorVerdicts.createdAt, cutoffs.readings))
      return {
        readings: sweptReadings.count,
        cellHours: sweptHours.count,
        verdicts: sweptVerdicts.count,
      }
    },
  }
}
