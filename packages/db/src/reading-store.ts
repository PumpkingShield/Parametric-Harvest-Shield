import { and, eq, inArray, max } from 'drizzle-orm'
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

/* -------------------------------------------------------------------------- */
/* Where a sensor left off                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The highest counter each of these sensors has already used — `FR-003`.
 *
 * Separate from `ReadingStore` because intake never asks it. Publishing a
 * reading is a question about one counter (`save` and the unique index answer
 * it); this is a question about all of them, and the only caller is a scenario
 * run deciding where to pick up (`T067`). Folding it into the intake interface
 * would oblige every fake of the door to answer a question the door never asks.
 *
 * **A real device asks itself the same thing after a power cut.** `FR-003`
 * requires counters to ascend, not to begin at one, and a sensor that comes
 * back up resumes from where its log ended rather than replaying it. A run
 * that resumes is therefore doing what the hardware does — which is what makes
 * a second run of the same fixture a continuation of the network's life
 * instead of a collision with it.
 */
export interface CounterStore {
  lastCounters(pubkeys: readonly string[]): Promise<Map<string, bigint>>
}

/** The `CounterStore` backed by the readings table. */
export function pgCounterStore(db: PostgresJsDatabase<Record<string, never>>): CounterStore {
  return {
    async lastCounters(pubkeys) {
      // An empty `IN ()` is not SQL, and asking about no sensors has one
      // answer that needs no round trip.
      if (pubkeys.length === 0) return new Map()

      const rows = await db
        .select({ sensorPubkey: readings.sensorPubkey, last: max(readings.counter) })
        .from(readings)
        // Every row, `late` ones included: `readings_sensor_counter_uq` does
        // not care why a counter was used, only that it was. Resuming past an
        // accepted reading and onto a late one would collide on the next run.
        .where(inArray(readings.sensorPubkey, [...pubkeys]))
        .groupBy(readings.sensorPubkey)

      const counters = new Map<string, bigint>()
      for (const row of rows) {
        // A sensor with no rows is simply absent from the result; `max` over a
        // group is null only if the column is, and the column is `notNull`.
        if (row.last === null) continue
        counters.set(row.sensorPubkey, BigInt(row.last))
      }
      return counters
    },
  }
}
