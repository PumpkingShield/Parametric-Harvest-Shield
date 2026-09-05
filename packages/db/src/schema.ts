import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import type { DayClassification } from '@pumpking/shared'

/**
 * Off-chain mirror and working set. The chain is the source of truth for
 * sensors, policies and payouts; these tables are a cache the interface reads
 * so it does not have to walk accounts. A divergence is repaired by re-reading
 * the chain, never by editing a row here.
 *
 * Readings, hourly medians and days are different: they are the raw material
 * the aggregator turns into the on-chain day log, and they live here first.
 */

/**
 * H3 cell ids are stored as signed 64-bit integers, the same width the program
 * uses (`CellState.cell_id: u64`). The top bit of an H3 index is reserved and
 * always zero, so every id fits a Postgres `bigint` without wrapping. The hex
 * form h3-js speaks is a presentation detail converted at the edge.
 */
const cellId = () => bigint({ mode: 'bigint' })

/**
 * Hundredths of a unit as integers. Floating point is not in the consensus.
 * Named explicitly because automatic snake_case turns `x100` into `x_100`.
 */
const valueX100 = (name: string) => integer(name)

export const readingStatus = pgEnum('reading_status', [
  /** Counted towards the cell median. */
  'accepted',
  /** Off the median by more than the threshold — FR-011, feeds reputation. */
  'outlier',
  /** Arrived past the window — FR-004, stored but out of the index. */
  'late',
  /** Bad signature, unknown key or replayed counter — FR-002, FR-003. */
  'rejected',
])

export const readingKind = pgEnum('reading_kind', ['precipitation_mm'])

export const operators = pgTable('operators', {
  id: uuid().primaryKey().defaultRandom(),
  /** Base58 Solana pubkey. Rewards and burnt stake settle against it. */
  wallet: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/**
 * Registry of cells the network actually covers — FR-006. A cell is the unit of
 * consensus, index, policy and exposure limit.
 */
export const cells = pgTable('cells', {
  id: cellId().primaryKey(),
  /**
   * Derivable from the id itself; kept as a column because FR-060 makes the
   * level a parameter rather than a constant, and FR-069 makes a move to res 8
   * an expansion — res 7 and res 8 rows coexist rather than migrate.
   */
  resolution: smallint().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/**
 * Mirror of the on-chain sensor registry plus metadata the chain has no room
 * for — FR-001.
 */
export const sensors = pgTable(
  'sensors',
  {
    /** Base58 ed25519 pubkey. Also the seed of the on-chain `Sensor` PDA. */
    pubkey: text().primaryKey(),
    operatorId: uuid()
      .notNull()
      .references(() => operators.id),
    /**
     * Fixed at registration from the sensor's coordinates and never carried in
     * a reading — FR-058. A reading that named its own cell would let a sensor
     * vote in someone else's, and would leak the field's position.
     */
    cellId: cellId()
      .notNull()
      .references(() => cells.id),
    kind: readingKind().notNull(),
    /** Position in the on-chain `contributors` bitmask, 0..31. */
    slotInCell: smallint().notNull(),
    /** `sql`0`` and not `0n`: drizzle-kit 0.31.10 cannot serialise a BigInt
     * literal into its snapshot and dies with "Do not know how to serialize
     * a BigInt" on generate. */
    stake: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    accepted: integer().notNull().default(0),
    outliers: integer().notNull().default(0),
    /** False once excluded for systematic outliers — FR-012. */
    active: boolean().notNull().default(true),
    registeredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sensors_cell_idx').on(t.cellId),
    index('sensors_operator_idx').on(t.operatorId),
    /**
     * MAX_SENSORS_PER_CELL = 32: one sensor per bitmask slot, or the day's
     * contributor set stops being readable.
     */
    unique('sensors_cell_slot_uq').on(t.cellId, t.slotInCell),
  ],
)

/**
 * Signed readings — FR-003. Retention is 30 days (SC-012); the sweep is a job,
 * not a constraint, because the row has to survive long enough to be shown in
 * the trace of a policy settled from it.
 */
export const readings = pgTable(
  'readings',
  {
    id: uuid().primaryKey().defaultRandom(),
    sensorPubkey: text()
      .notNull()
      .references(() => sensors.pubkey),
    /** Denormalised from the sensor so the median query never joins. */
    cellId: cellId()
      .notNull()
      .references(() => cells.id),
    kind: readingKind().notNull(),
    measuredAt: timestamp({ withTimezone: true }).notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    valueX100: valueX100('value_x100').notNull(),
    /** Monotonic per sensor. A repeat is not counted twice — FR-003. */
    counter: bigint({ mode: 'bigint' }).notNull(),
    /** Base58 ed25519 signature over the canonical serialisation. */
    signature: text().notNull(),
    status: readingStatus().notNull(),
  },
  (t) => [
    unique('readings_sensor_counter_uq').on(t.sensorPubkey, t.counter),
    index('readings_cell_measured_idx').on(t.cellId, t.kind, t.measuredAt),
    index('readings_received_idx').on(t.receivedAt),
  ],
)

/**
 * Hourly cell median — FR-008. `voteCount` counts operators, not sensors: many
 * sensors of one operator carry one vote between them (FR-009), so a cell can
 * hold thirty sensors and still fall short of coverage.
 */
export const cellHours = pgTable(
  'cell_hours',
  {
    cellId: cellId()
      .notNull()
      .references(() => cells.id),
    /** Start of the interval, truncated to the hour. */
    hourStart: timestamp({ withTimezone: true }).notNull(),
    kind: readingKind().notNull(),
    /** Null when the hour fell short of the minimum votes — FR-010. */
    medianX100: valueX100('median_x100'),
    voteCount: smallint().notNull(),
    /** Root over the accepted readings of the hour, for the inclusion proof. */
    merkleRoot: text(),
    /**
     * Set when the median diverged from the public reference — FR-013. The hour
     * still enters the index (FR-017); the flag is a supervision signal, not a
     * reason to drop the measurement from someone's policy after the fact.
     */
    disputed: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cellId, t.hourStart, t.kind] }),
    index('cell_hours_cell_start_idx').on(t.cellId, t.hourStart),
  ],
)

/**
 * Classified day — FR-047, FR-048. Kept forever: this is the row a payout is
 * explained from long after the readings behind it have been swept.
 */
export const cellDays = pgTable(
  'cell_days',
  {
    cellId: cellId()
      .notNull()
      .references(() => cells.id),
    /** `(measured_at - genesis_ts) / seconds_per_day`, matching the program. */
    dayIndex: integer().notNull(),
    /**
     * 0 no coverage, 1 dry, 2 wet — the byte the program stores in `day_log`.
     * The mapping has one definition, `DayState` in `@pumpking/shared`, because
     * a second one is how the two `dry_spell` twins start to disagree.
     */
    state: smallint().notNull().$type<DayClassification>(),
    /** Sum of the hourly medians. Null when the day had no coverage at all. */
    rainfallX100: valueX100('rainfall_x100'),
    /** Hours that got a median. Shown in the trace — FR-048. */
    coveredHours: smallint().notNull(),
    merkleRoot: text(),
    /** Signature of the `submit_day_record` transaction, once committed. */
    txSignature: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.cellId, t.dayIndex] })],
)

/** Readings past their retention window — the sweep SC-012 depends on. */
export const readingsOlderThan = (days: number) =>
  sql`${readings.receivedAt} < now() - make_interval(days => ${days})`
