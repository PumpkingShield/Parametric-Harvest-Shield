import { type DayClassification, DayState, type ReferenceStateName } from '@pumpking/shared'
import { and, asc, eq, gte, isNotNull, lt, type SQL, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { cellDays, referenceHours } from './schema.ts'

/**
 * What the reference check needs of the database — `FR-013`, `T042`.
 *
 * Only days already on chain are compared. A day still waiting for its
 * transaction can be closed again with more readings, and a verdict on the
 * first version would be a verdict on a day that no longer exists; a day on
 * chain is final (`record_day` refuses to rewrite it), so its verdict is too.
 */

/** A day on chain the reference has not judged yet. */
export type PendingReferenceDay = {
  cellId: bigint
  dayIndex: number
  state: DayClassification
  rainfallX100: number | null
}

/** The public reference for one hour at a cell's centre. */
export type ReferenceHourRow = { cellId: bigint; hourStart: Date; valueX100: number }

/** A verdict on one day. */
export type ReferenceVerdictRow = {
  cellId: bigint
  dayIndex: number
  state: Exclude<ReferenceStateName, 'pending'>
  rainfallX100: number | null
}

export interface ReferenceStore {
  /** Pending days on chain from `fromDay` on, by cell then day. */
  pendingDays(fromDay: number): Promise<PendingReferenceDay[]>
  /**
   * The hours the source answered with, and the verdicts on the days they
   * completed — together, so a day is never judged against hours that were
   * not kept to show beside it.
   */
  saveReference(
    hours: readonly ReferenceHourRow[],
    verdicts: readonly ReferenceVerdictRow[],
  ): Promise<void>
  /**
   * Pending days before `beforeDay` — or every pending day, with null — marked
   * `unchecked`: the reference had its window and did not answer, or the
   * pool's clock does not count real days. `FR-044`: the day stands, without a
   * check. Returns how many were given up.
   */
  giveUp(beforeDay: number | null): Promise<number>
}

type Updates = Pick<PostgresJsDatabase<Record<string, never>>, 'update'>

/**
 * The write a verdict makes — `FR-043`. Beside the day, never into it: the two
 * `reference_*` columns and nothing else, so the class, the sensors' total, the
 * root and the transaction stay what the chain holds; and only over a day still
 * `pending`, so a verdict is made once.
 */
export function verdictUpdate(db: Updates, verdict: ReferenceVerdictRow) {
  return db
    .update(cellDays)
    .set({ referenceState: verdict.state, referenceRainfallX100: verdict.rainfallX100 })
    .where(
      and(
        eq(cellDays.cellId, verdict.cellId),
        eq(cellDays.dayIndex, verdict.dayIndex),
        eq(cellDays.referenceState, 'pending'),
      ),
    )
}

/** The write giving up makes — `FR-044`: the day stands, only its check is marked absent. */
export function giveUpUpdate(db: Updates, beforeDay: number | null) {
  const pending = eq(cellDays.referenceState, 'pending')
  return db
    .update(cellDays)
    .set({ referenceState: 'unchecked' })
    .where(beforeDay === null ? pending : and(pending, lt(cellDays.dayIndex, beforeDay)))
}

/** `excluded.<column>` — see `interval-store.ts`. */
function excluded(column: string): SQL {
  return sql.raw(`excluded.${column}`)
}

/** A cell's days that the cell called dry and the reference disputed — `FR-045`. */
export type DisputedDryDays = { cellId: bigint; days: number[] }

/** What the investigation step reads — `T044`. */
export interface InvestigationStore {
  /** Disputed dry days from `fromDay` on, grouped by cell, oldest first. */
  disputedDryDays(fromDay: number): Promise<DisputedDryDays[]>
}

type Selects = Pick<PostgresJsDatabase<Record<string, never>>, 'select'>

/**
 * The read behind the rule: one-sided, so a day the cell called wet and the
 * reference dry never counts — it is no claim of drought.
 */
export function disputedDryDaysQuery(db: Selects, fromDay: number) {
  return db
    .select({ cellId: cellDays.cellId, dayIndex: cellDays.dayIndex })
    .from(cellDays)
    .where(
      and(
        gte(cellDays.dayIndex, fromDay),
        eq(cellDays.state, DayState.Dry),
        eq(cellDays.referenceState, 'disputed'),
      ),
    )
    .orderBy(asc(cellDays.cellId), asc(cellDays.dayIndex))
}

/** Both reads of `cell_days` the reference drives — the check and the investigation. */
export function pgReferenceStore(
  db: PostgresJsDatabase<Record<string, never>>,
): ReferenceStore & InvestigationStore {
  return {
    async disputedDryDays(fromDay) {
      const byCell = new Map<bigint, number[]>()
      for (const row of await disputedDryDaysQuery(db, fromDay)) {
        const days = byCell.get(row.cellId) ?? []
        days.push(row.dayIndex)
        byCell.set(row.cellId, days)
      }
      return [...byCell].map(([cellId, days]) => ({ cellId, days }))
    },

    async pendingDays(fromDay) {
      return await db
        .select({
          cellId: cellDays.cellId,
          dayIndex: cellDays.dayIndex,
          state: cellDays.state,
          rainfallX100: cellDays.rainfallX100,
        })
        .from(cellDays)
        .where(
          and(
            gte(cellDays.dayIndex, fromDay),
            isNotNull(cellDays.txSignature),
            eq(cellDays.referenceState, 'pending'),
          ),
        )
        .orderBy(asc(cellDays.cellId), asc(cellDays.dayIndex))
    },

    async saveReference(hours, verdicts) {
      await db.transaction(async (tx) => {
        if (hours.length > 0) {
          // A later answer for the same hour replaces the earlier one: a
          // forecast archive settles as its runs come in, and the hour kept is
          // the one the verdict below was made on.
          await tx
            .insert(referenceHours)
            .values([...hours])
            .onConflictDoUpdate({
              target: [referenceHours.cellId, referenceHours.hourStart],
              set: { valueX100: excluded('value_x100') },
            })
        }
        for (const verdict of verdicts) await verdictUpdate(tx, verdict)
      })
    },

    async giveUp(beforeDay) {
      const result = await giveUpUpdate(db, beforeDay)
      return result.count
    },
  }
}
