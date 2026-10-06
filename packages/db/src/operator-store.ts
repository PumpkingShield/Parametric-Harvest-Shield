import type { ReadingKindName } from '@pumpking/shared'
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql, sum } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  cellDays,
  cellHours,
  operators,
  readings,
  sensors,
  sensorVerdicts,
  slotRewards,
} from './schema.ts'

/**
 * What an operator screen reads, and the one table only it needs — `T040`,
 * `FR-036`, `FR-050`.
 *
 * Everything here is the aggregator's word: which readings were stored, how
 * the intervals they fell in were judged, what the program paid for each day.
 * Money as it stands now — stake, what is waiting to be claimed — is not here
 * at all. The screen reads that from the chain, because a claim changes it the
 * moment it lands and a mirror would show the old sum for minutes.
 */

/* -------------------------------------------------------------------------- */
/* The reward mirror — written by the worker                                  */
/* -------------------------------------------------------------------------- */

/** A day on chain whose `DayRewarded` has not been read into `slot_rewards`. */
export type UnreadRewardDay = { cellId: bigint; dayIndex: number; txSignature: string }

/** What one slot earned on one day. */
export type SlotRewardRow = {
  slot: number
  /** The sensor holding the slot when the day was read; null if unknown. */
  sensorPubkey: string | null
  earned: bigint
}

export interface RewardMirrorStore {
  /**
   * Days from `fromDay` on that carry a signature and were never read, oldest
   * first. Bounded below so a transaction the cluster no longer serves is
   * given up on rather than asked about for ever.
   */
  unreadDays(fromDay: number): Promise<UnreadRewardDay[]>
  /**
   * The day's earnings, replacing any earlier read of it, and the day marked
   * read — together, so a crash between the two cannot leave a day marked
   * with nothing under it.
   */
  saveDayRewards(cellId: bigint, dayIndex: number, rows: readonly SlotRewardRow[]): Promise<void>
}

export function pgRewardMirrorStore(
  db: PostgresJsDatabase<Record<string, never>>,
): RewardMirrorStore {
  return {
    async unreadDays(fromDay) {
      const rows = await db
        .select({
          cellId: cellDays.cellId,
          dayIndex: cellDays.dayIndex,
          txSignature: cellDays.txSignature,
        })
        .from(cellDays)
        .where(
          and(
            gte(cellDays.dayIndex, fromDay),
            isNotNull(cellDays.txSignature),
            isNull(cellDays.rewardsReadAt),
          ),
        )
        .orderBy(asc(cellDays.cellId), asc(cellDays.dayIndex))
      return rows.flatMap((row) =>
        row.txSignature === null ? [] : [{ ...row, txSignature: row.txSignature }],
      )
    },

    async saveDayRewards(cellId, dayIndex, rows) {
      await db.transaction(async (tx) => {
        await tx
          .delete(slotRewards)
          .where(and(eq(slotRewards.cellId, cellId), eq(slotRewards.dayIndex, dayIndex)))
        const earning = rows.filter((row) => row.earned > 0n)
        if (earning.length > 0) {
          await tx.insert(slotRewards).values(earning.map((row) => ({ cellId, dayIndex, ...row })))
        }
        await tx
          .update(cellDays)
          .set({ rewardsReadAt: sql`now()` })
          .where(and(eq(cellDays.cellId, cellId), eq(cellDays.dayIndex, dayIndex)))
      })
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The operator screen — read by the API                                      */
/* -------------------------------------------------------------------------- */

/** A stored reading of one sensor, as it arrived. */
export type SensorReadingRow = {
  cellId: bigint
  measuredAt: Date
  valueX100: number
  status: 'accepted' | 'outlier' | 'late' | 'rejected'
}

/** An interval of a cell as the aggregator closed it. */
export type CellIntervalRow = { cellId: bigint; start: Date; medianX100: number | null }

/** A sensor's verdict in one interval. */
export type SensorVerdictRow = {
  cellId: bigint
  intervalStart: Date
  valueX100: number
  medianX100: number
  outlier: boolean
}

/** What a sensor earned on a day, in one cell. */
export type EarnedDayRow = { cellId: bigint; dayIndex: number; earned: bigint }

/** A sensor of a cell, with its record over a span of days. */
export type CellSensorRow = {
  pubkey: string
  operatorWallet: string
  slotInCell: number
  stake: bigint
  active: boolean
  judged: number
  outliers: number
}

export interface OperatorStore {
  /** The sensor's readings measured in `[from, to)`, newest first, at most `limit`. */
  sensorReadings(
    pubkey: string,
    kind: ReadingKindName,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<SensorReadingRow[]>
  /** Days of these cells in `[fromDay, toDay]` that the aggregator has closed. */
  closedDays(
    cellIds: readonly bigint[],
    fromDay: number,
    toDay: number,
  ): Promise<{ cellId: bigint; dayIndex: number }[]>
  /** Intervals of these cells starting in `[from, to)`. */
  cellIntervals(
    cellIds: readonly bigint[],
    kind: ReadingKindName,
    from: Date,
    to: Date,
  ): Promise<CellIntervalRow[]>
  /** The sensor's verdicts for intervals starting in `[from, to)`. */
  sensorVerdicts(
    pubkey: string,
    kind: ReadingKindName,
    from: Date,
    to: Date,
  ): Promise<SensorVerdictRow[]>
  /** What the sensor earned on each day from `fromDay` on, newest first. */
  earnedDays(pubkey: string, fromDay: number): Promise<EarnedDayRow[]>
  /** Everything the sensor ever earned, by the days the worker has read. */
  earnedTotal(pubkey: string): Promise<bigint>
  /**
   * The mirrored sensors whose own cell is this one — not those that left
   * it — with their verdicts over `[fromDay, toDay]` in any cell.
   */
  cellSensors(
    cellId: bigint,
    kind: ReadingKindName,
    fromDay: number,
    toDay: number,
  ): Promise<CellSensorRow[]>
}

export function pgOperatorStore(db: PostgresJsDatabase<Record<string, never>>): OperatorStore {
  return {
    async sensorReadings(pubkey, kind, from, to, limit) {
      return await db
        .select({
          cellId: readings.cellId,
          measuredAt: readings.measuredAt,
          valueX100: readings.valueX100,
          status: readings.status,
        })
        .from(readings)
        .where(
          and(
            eq(readings.sensorPubkey, pubkey),
            eq(readings.kind, kind),
            gte(readings.measuredAt, from),
            lt(readings.measuredAt, to),
          ),
        )
        .orderBy(desc(readings.measuredAt))
        .limit(limit)
    },

    async closedDays(cellIds, fromDay, toDay) {
      if (cellIds.length === 0 || toDay < fromDay) return []
      return await db
        .select({ cellId: cellDays.cellId, dayIndex: cellDays.dayIndex })
        .from(cellDays)
        .where(
          and(
            inArray(cellDays.cellId, [...cellIds]),
            gte(cellDays.dayIndex, fromDay),
            lte(cellDays.dayIndex, toDay),
          ),
        )
    },

    async cellIntervals(cellIds, kind, from, to) {
      if (cellIds.length === 0) return []
      return await db
        .select({
          cellId: cellHours.cellId,
          start: cellHours.hourStart,
          medianX100: cellHours.medianX100,
        })
        .from(cellHours)
        .where(
          and(
            inArray(cellHours.cellId, [...cellIds]),
            eq(cellHours.kind, kind),
            gte(cellHours.hourStart, from),
            lt(cellHours.hourStart, to),
          ),
        )
        .orderBy(asc(cellHours.hourStart))
    },

    async sensorVerdicts(pubkey, kind, from, to) {
      return await db
        .select({
          cellId: sensorVerdicts.cellId,
          intervalStart: sensorVerdicts.intervalStart,
          valueX100: sensorVerdicts.valueX100,
          medianX100: sensorVerdicts.medianX100,
          outlier: sensorVerdicts.outlier,
        })
        .from(sensorVerdicts)
        .where(
          and(
            eq(sensorVerdicts.sensorPubkey, pubkey),
            eq(sensorVerdicts.kind, kind),
            gte(sensorVerdicts.intervalStart, from),
            lt(sensorVerdicts.intervalStart, to),
          ),
        )
    },

    async earnedDays(pubkey, fromDay) {
      return await db
        .select({
          cellId: slotRewards.cellId,
          dayIndex: slotRewards.dayIndex,
          earned: slotRewards.earned,
        })
        .from(slotRewards)
        .where(and(eq(slotRewards.sensorPubkey, pubkey), gte(slotRewards.dayIndex, fromDay)))
        .orderBy(desc(slotRewards.dayIndex), asc(slotRewards.cellId))
    },

    async earnedTotal(pubkey) {
      const [row] = await db
        .select({ total: sum(slotRewards.earned) })
        .from(slotRewards)
        .where(eq(slotRewards.sensorPubkey, pubkey))
      // `sum` of a bigint is a numeric, and postgres-js hands it back as text.
      return BigInt(row?.total ?? '0')
    },

    async cellSensors(cellId, kind, fromDay, toDay) {
      // Correlated subqueries rather than a join and a group: a sensor nobody
      // has judged yet still belongs on the list. Raw, with an alias, because
      // drizzle 0.45 drops the table from a column inside a one-table select,
      // and `where "sensor_pubkey" = "pubkey"` would compare the wrong things.
      const record = (outlierOnly: boolean) => sql`(
        select count(*) from ${sensorVerdicts} v
        where v.sensor_pubkey = ${sensors}.pubkey
          and v.kind = ${kind}
          and v.day_index between ${fromDay}::integer and ${toDay}::integer
          ${outlierOnly ? sql`and v.outlier` : sql``})`
      const rows = await db
        .select({
          pubkey: sensors.pubkey,
          operatorWallet: operators.wallet,
          slotInCell: sensors.slotInCell,
          stake: sensors.stake,
          active: sensors.active,
          judged: sql<number>`${record(false)}`.mapWith(Number),
          outliers: sql<number>`${record(true)}`.mapWith(Number),
        })
        .from(sensors)
        .innerJoin(operators, eq(operators.id, sensors.operatorId))
        .where(and(eq(sensors.cellId, cellId), isNotNull(sensors.mirroredAt)))
        .orderBy(asc(sensors.slotInCell))
      return rows
    },
  }
}
