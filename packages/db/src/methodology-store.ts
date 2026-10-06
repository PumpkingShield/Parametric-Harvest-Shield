import type { ReadingKindName } from '@pumpking/shared'
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { operators, sensors } from './schema.ts'

/**
 * What the methodology page reads from the mirror — `T041`, `FR-054`.
 *
 * Only who votes where and on how much stake. The rule that turns a row into a
 * vote (`active`, stake at least `min_stake`, one vote per operator) is the
 * route's, applied to every row the way the median applies it, rather than a
 * `where` here that could drift from it.
 */

/** A mirrored sensor in its own cell. */
export type StakeRow = {
  cellId: bigint
  operatorWallet: string
  stake: bigint
  active: boolean
}

export interface MethodologyStore {
  /**
   * Every mirrored sensor of this kind, in the cell it votes in now — one that
   * moved votes in the new cell only (`FR-059`).
   */
  stakes(kind: ReadingKindName): Promise<StakeRow[]>
}

export function pgMethodologyStore(
  db: PostgresJsDatabase<Record<string, never>>,
): MethodologyStore {
  return {
    async stakes(kind) {
      return await db
        .select({
          cellId: sensors.cellId,
          operatorWallet: operators.wallet,
          stake: sensors.stake,
          active: sensors.active,
        })
        .from(sensors)
        .innerJoin(operators, eq(operators.id, sensors.operatorId))
        .where(and(eq(sensors.kind, kind), isNotNull(sensors.mirroredAt)))
        .orderBy(asc(sensors.cellId), asc(sensors.slotInCell))
    },
  }
}
