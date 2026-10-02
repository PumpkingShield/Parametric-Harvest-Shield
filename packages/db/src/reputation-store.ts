import type { OutlierCounts } from '@pumpking/shared'
import { and, asc, count, gte, lte, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sensorVerdicts } from './schema.ts'

/**
 * A sensor's reputation, read back — `FR-011`, `FR-012`.
 *
 * The aggregator's view, counted from `sensor_verdicts`. Not
 * `sensors.accepted`/`sensors.outliers`: those columns are the chain's, the
 * registry mirror rewrites them from the `Sensor` account every few minutes,
 * and what the chain holds is what the program will judge (`T035`). The two
 * agree once the counts reach the chain; until then this is the one that knows.
 */

export type SensorOutlierCounts = OutlierCounts & { sensorPubkey: string }

export interface ReputationStore {
  /**
   * Judged and outlier intervals of every sensor judged in `[fromDay, toDay]`,
   * both ends inclusive, by pool day. A sensor never judged in the window is
   * absent rather than zero: it has no record, which is not a clean one.
   */
  counts(fromDay: number, toDay: number): Promise<SensorOutlierCounts[]>
}

export function pgReputationStore(db: PostgresJsDatabase<Record<string, never>>): ReputationStore {
  return {
    async counts(fromDay, toDay) {
      if (toDay < fromDay) return []
      const rows = await db
        .select({
          sensorPubkey: sensorVerdicts.sensorPubkey,
          judged: count(),
          outliers: sql<number>`count(*) filter (where ${sensorVerdicts.outlier})`.mapWith(Number),
        })
        .from(sensorVerdicts)
        .where(and(gte(sensorVerdicts.dayIndex, fromDay), lte(sensorVerdicts.dayIndex, toDay)))
        .groupBy(sensorVerdicts.sensorPubkey)
        .orderBy(asc(sensorVerdicts.sensorPubkey))
      return rows
    },
  }
}
