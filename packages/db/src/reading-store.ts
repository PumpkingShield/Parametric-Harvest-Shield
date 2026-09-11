import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { readings, sensors } from './schema.ts'

/**
 * What intake needs of the database, and nothing else — `FR-002`, `FR-003`.
 *
 * The interface is here rather than in `apps/api` because it is a statement
 * about the tables: `sensorFor` is the registry lookup that turns a signature
 * into a vote, and `save` is the one that makes a counter used. The route owns
 * the rules; this owns the two questions the rules ask of storage, which is
 * what lets the route be tested without a Postgres.
 */

/** The registry row a reading is checked against — `FR-001`. */
export type SensorRegistration = {
  pubkey: string
  /** Fixed at registration (`FR-058`); a reading may name it but not choose it. */
  cellId: bigint
  kind: 'precipitation_mm'
  /** `FR-012`: a deactivated sensor still publishes, it just stops counting. */
  active: boolean
}

/** A reading on its way into the table. */
export type ReadingRow = {
  sensorPubkey: string
  cellId: bigint
  kind: 'precipitation_mm'
  measuredAt: Date
  valueX100: number
  counter: bigint
  signature: string
  /** `FR-004`: late readings are stored and left out of the index. */
  status: 'accepted' | 'late'
}

/**
 * The outcome of a write against `readings_sensor_counter_uq`.
 *
 * A counter that has been used before is not simply refused: a sensor on a bad
 * link retries, and the retry carries the same signature over the same bytes.
 * Telling the two apart is the difference between a client that cannot get an
 * answer and a client replaying somebody's reading, so the existing row comes
 * back and the route decides.
 */
export type SaveOutcome =
  | { stored: true; status: ReadingRow['status'] }
  | { stored: false; existingSignature: string; status: ReadingRow['status'] }

export interface ReadingStore {
  sensorFor(pubkey: string): Promise<SensorRegistration | null>
  save(row: ReadingRow): Promise<SaveOutcome>
}

/** The `ReadingStore` backed by the real tables. */
export function pgReadingStore(db: PostgresJsDatabase<Record<string, never>>): ReadingStore {
  return {
    async sensorFor(pubkey) {
      const [row] = await db
        .select({
          pubkey: sensors.pubkey,
          cellId: sensors.cellId,
          kind: sensors.kind,
          active: sensors.active,
        })
        .from(sensors)
        .where(eq(sensors.pubkey, pubkey))
        .limit(1)
      return row ?? null
    },

    async save(row) {
      // `onConflictDoNothing` and then a read, rather than a read and then an
      // insert: two sensors — or one sensor twice — racing on the same counter
      // would both pass a prior read and one would then fail the constraint.
      // The unique index is the arbiter, and this is it being asked.
      const inserted = await db
        .insert(readings)
        .values(row)
        .onConflictDoNothing({ target: [readings.sensorPubkey, readings.counter] })
        .returning({ status: readings.status })

      const first = inserted[0]
      if (first !== undefined) {
        return { stored: true, status: first.status as ReadingRow['status'] }
      }

      const [existing] = await db
        .select({ signature: readings.signature, status: readings.status })
        .from(readings)
        .where(
          and(eq(readings.sensorPubkey, row.sensorPubkey), eq(readings.counter, row.counter)),
        )
        .limit(1)
      if (existing === undefined) {
        // The conflicting row disappeared between the two statements, which
        // takes a retention sweep landing in the microsecond in between.
        // Saying so beats reporting a replay that did not happen.
        throw new Error(`the reading conflicting on counter ${row.counter} is gone`)
      }
      return {
        stored: false,
        existingSignature: existing.signature,
        status: existing.status as ReadingRow['status'],
      }
    },
  }
}
