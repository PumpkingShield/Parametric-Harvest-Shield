import type { DayClassification, ReferenceStateName } from '@pumpking/shared'
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

/** `excluded.<column>` — see `interval-store.ts`. */
function excluded(column: string): SQL {
  return sql.raw(`excluded.${column}`)
}

export function pgReferenceStore(db: PostgresJsDatabase<Record<string, never>>): ReferenceStore {
  return {
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
        for (const verdict of verdicts) {
          await tx
            .update(cellDays)
            .set({ referenceState: verdict.state, referenceRainfallX100: verdict.rainfallX100 })
            .where(
              and(
                eq(cellDays.cellId, verdict.cellId),
                eq(cellDays.dayIndex, verdict.dayIndex),
                // Never over a verdict already made.
                eq(cellDays.referenceState, 'pending'),
              ),
            )
        }
      })
    },

    async giveUp(beforeDay) {
      const pending = eq(cellDays.referenceState, 'pending')
      const result = await db
        .update(cellDays)
        .set({ referenceState: 'unchecked' })
        .where(beforeDay === null ? pending : and(pending, lt(cellDays.dayIndex, beforeDay)))
      return result.count
    },
  }
}
