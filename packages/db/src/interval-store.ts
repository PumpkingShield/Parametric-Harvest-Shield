import type { DayClassification, ReadingKindName } from '@pumpking/shared'
import { and, asc, eq, gte, lt, lte, type SQL, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { cellDays, cellHours, cells, operators, readings, sensors } from './schema.ts'

/**
 * What aggregation needs of the database, and nothing else — `FR-008`,
 * `FR-015`, `FR-047`.
 *
 * The same split as `ReadingStore`: this owns the questions storage is asked,
 * the worker owns the arithmetic that asks them. Aggregation is the one place
 * where a mistake is invisible — a median taken over the wrong set still
 * produces a plausible number — so the part worth testing is the arithmetic,
 * and it is testable here without a Postgres because the four queries it needs
 * are named rather than inlined.
 *
 * Readings arrive with the operator and the sensor slot already attached.
 * That is not denormalisation for speed: `FR-009` makes the operator the unit
 * of the vote and the on-chain `contributors` mask is indexed by slot, so a
 * reading without both is not usable material, and fetching it separately
 * would let the two drift apart between the query and the median.
 */

/** A reading that counts towards a cell value, with what makes it count. */
export type AcceptedReading = {
  sensorPubkey: string
  /** Wallet of the operator. Many sensors of one are one vote — `FR-009`. */
  operator: string
  /** Position in the on-chain `contributors` bitmask, 0..31. */
  slotInCell: number
  valueX100: number
  measuredAt: Date
  counter: bigint
  /** Base58 ed25519 signature — part of the leaf the interval commits to. */
  signature: string
}

/** A closed interval, as `cell_hours` holds it — `FR-008`. */
export type IntervalRow = {
  cellId: bigint
  /** Start of the interval. On a compressed clock (`FR-049`) this is not an hour. */
  hourStart: Date
  kind: ReadingKindName
  /** Null when the interval fell short of the minimum votes — `FR-010`. */
  medianX100: number | null
  voteCount: number
  /** Base58 root over the signed readings of the interval, null when it had none. */
  merkleRoot: string | null
  disputed: boolean
}

/** A classified day, as `cell_days` holds it — `FR-047`, `FR-048`. */
export type DayRow = {
  cellId: bigint
  dayIndex: number
  state: DayClassification
  rainfallX100: number | null
  coveredHours: number
  /** Base58 root over the intervals of the day — the one the chain carries. */
  merkleRoot: string | null
  /**
   * Signature of the `submit_day_record` transaction, null until it lands.
   * The row is written before the transaction is sent, so a worker that dies
   * between the two restarts into a day it can see is unfinished rather than
   * one it has no record of.
   */
  txSignature: string | null
}

export interface IntervalStore {
  /**
   * Every cell the network knows about — `FR-006`.
   *
   * Not "cells with readings in the window": a day nobody measured still has
   * to reach the chain, because the ring buffer answers `None` for anything
   * past the last recorded day, and a policy whose window ends in an unwritten
   * day cannot be closed at all. Silence has to be written down to count as
   * silence.
   */
  cellIds(): Promise<bigint[]>
  /** Accepted readings of one cell and kind in `[from, to)`, oldest first. */
  acceptedReadings(
    cellId: bigint,
    kind: ReadingKindName,
    from: Date,
    to: Date,
  ): Promise<AcceptedReading[]>
  /** The stored day, or null when it has not been closed yet. */
  dayRecord(cellId: bigint, dayIndex: number): Promise<DayRow | null>
  /**
   * The stored days of a cell in `[fromDay, toDay]`, both ends inclusive and
   * ascending — a policy's coverage window, in one query.
   *
   * Days the cell has no row for are simply absent rather than filled in. The
   * caller decides what a missing day means, and for settlement it means the
   * same thing the on-chain ring means by `None`: not an answer, and a break
   * in the run.
   */
  dayRecords(cellId: bigint, fromDay: number, toDay: number): Promise<DayRow[]>
  saveIntervals(rows: readonly IntervalRow[]): Promise<void>
  saveDay(row: DayRow): Promise<void>
  markDaySubmitted(cellId: bigint, dayIndex: number, txSignature: string): Promise<void>
}

/**
 * `excluded.<column>` — the row Postgres was about to insert.
 *
 * Spelled out rather than taken from the values object because these upserts
 * carry many rows at once, and a literal would write the first row's number
 * into every conflicting one.
 */
function excluded(column: string): SQL {
  return sql.raw(`excluded.${column}`)
}

/** The `IntervalStore` backed by the real tables. */
export function pgIntervalStore(db: PostgresJsDatabase<Record<string, never>>): IntervalStore {
  return {
    async cellIds() {
      const rows = await db.select({ id: cells.id }).from(cells).orderBy(asc(cells.id))
      return rows.map((row) => row.id)
    },

    async acceptedReadings(cellId, kind, from, to) {
      const rows = await db
        .select({
          sensorPubkey: readings.sensorPubkey,
          operator: operators.wallet,
          slotInCell: sensors.slotInCell,
          valueX100: readings.valueX100,
          measuredAt: readings.measuredAt,
          counter: readings.counter,
          signature: readings.signature,
        })
        .from(readings)
        .innerJoin(sensors, eq(sensors.pubkey, readings.sensorPubkey))
        .innerJoin(operators, eq(operators.id, sensors.operatorId))
        .where(
          and(
            eq(readings.cellId, cellId),
            eq(readings.kind, kind),
            gte(readings.measuredAt, from),
            lt(readings.measuredAt, to),
            // `late` and `rejected` never counted; `outlier` stopped counting
            // when the sensor's reputation said so — FR-004, FR-011.
            eq(readings.status, 'accepted'),
            // FR-012: an excluded sensor keeps publishing and stops voting.
            eq(sensors.active, true),
          ),
        )
        .orderBy(asc(readings.sensorPubkey), asc(readings.counter))
      return rows
    },

    async dayRecord(cellId, dayIndex) {
      const [row] = await db
        .select({
          cellId: cellDays.cellId,
          dayIndex: cellDays.dayIndex,
          state: cellDays.state,
          rainfallX100: cellDays.rainfallX100,
          coveredHours: cellDays.coveredHours,
          merkleRoot: cellDays.merkleRoot,
          txSignature: cellDays.txSignature,
        })
        .from(cellDays)
        .where(and(eq(cellDays.cellId, cellId), eq(cellDays.dayIndex, dayIndex)))
        .limit(1)
      return row ?? null
    },

    async dayRecords(cellId, fromDay, toDay) {
      return await db
        .select({
          cellId: cellDays.cellId,
          dayIndex: cellDays.dayIndex,
          state: cellDays.state,
          rainfallX100: cellDays.rainfallX100,
          coveredHours: cellDays.coveredHours,
          merkleRoot: cellDays.merkleRoot,
          txSignature: cellDays.txSignature,
        })
        .from(cellDays)
        .where(
          and(
            eq(cellDays.cellId, cellId),
            gte(cellDays.dayIndex, fromDay),
            lte(cellDays.dayIndex, toDay),
          ),
        )
        .orderBy(asc(cellDays.dayIndex))
    },

    async saveIntervals(rows) {
      if (rows.length === 0) return
      // Re-closing an interval overwrites it: the readings behind a median can
      // only grow while the window is open (`FR-004`), so a second pass either
      // computes the same number or a better-covered one. What it must never
      // do is leave the first attempt's median next to the second attempt's
      // day, which is what a `DoNothing` here would produce.
      await db
        .insert(cellHours)
        .values([...rows])
        .onConflictDoUpdate({
          target: [cellHours.cellId, cellHours.hourStart, cellHours.kind],
          set: {
            medianX100: excluded('median_x100'),
            voteCount: excluded('vote_count'),
            merkleRoot: excluded('merkle_root'),
            disputed: excluded('disputed'),
          },
        })
    },

    async saveDay(row) {
      // `txSignature` is deliberately not in the update set. A day already
      // submitted keeps the signature of the transaction that submitted it —
      // the chain's log is append-only (`record_day` refuses a day that is not
      // newer), so a recomputed day that disagrees with the one on chain is a
      // bug to be found, not a row to be overwritten into agreement.
      await db
        .insert(cellDays)
        .values(row)
        .onConflictDoUpdate({
          target: [cellDays.cellId, cellDays.dayIndex],
          set: {
            state: excluded('state'),
            rainfallX100: excluded('rainfall_x100'),
            coveredHours: excluded('covered_hours'),
            merkleRoot: excluded('merkle_root'),
          },
        })
    },

    async markDaySubmitted(cellId, dayIndex, txSignature) {
      await db
        .update(cellDays)
        .set({ txSignature })
        .where(and(eq(cellDays.cellId, cellId), eq(cellDays.dayIndex, dayIndex)))
    },
  }
}
