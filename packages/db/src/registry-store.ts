import { cellResolution, ReadingKind } from '@pumpking/shared'
import { and, asc, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { cells, operators, sensors } from './schema.ts'

/**
 * The sensor registry, as the rest of the service reads it — `FR-001`,
 * `FR-050`.
 *
 * Registration is on chain (`register_sensor`, `T031`), and nothing in this
 * service writes it: the mirror below (`T076`) copies the program's accounts
 * in, and everything else only asks. Until `T077` the show and the `SC-008`
 * feeder had a door of their own, `ensureCell`, that put their keys into these
 * tables directly. It is gone. A row that exists here and not on chain carries
 * no vote, so a door that makes such rows is a way to run a network that is
 * published, stored and shown — and silently counts for nothing.
 *
 * A run that means to publish (the show, the feeder) asks instead whether its
 * sensors vote, and refuses to start when they do not: `votingProblems`.
 */

export interface RegistryStore {
  /** The rows of these sensors, mirrored or not. A key with no row is absent. */
  rowsOf(pubkeys: readonly string[]): Promise<RegistryRow[]>
}

/** A sensor a run means to publish from, and the cell it means to publish into. */
export type ExpectedSensor = { pubkey: string; cellId: bigint }

/**
 * Why a sensor cannot vote where a run expects it to — the same three
 * conditions as `votingSensor`, and a fourth only a run can state.
 */
export type SensorProblem =
  /** No row, or a row the mirror has never found on chain. */
  | 'unregistered'
  /** On chain, in a different cell. The chain fixed the cell at registration. */
  | 'wrong-cell'
  /** Excluded for systematic outliers — `FR-012`. */
  | 'excluded'
  /** Below `pool.min_stake` — `FR-050`. */
  | 'understaked'

export type SensorIssue = { pubkey: string; problem: SensorProblem }

/**
 * The sensors among `expected` that would publish without a vote, and why —
 * empty when every one of them counts.
 *
 * Reads the mirror, not the chain: the median is taken over the mirror, so a
 * sensor staked a minute ago that the mirror has not caught up with is, for
 * the day being closed, not staked yet. Saying so before a run starts is
 * cheaper than finding a day without coverage after.
 */
export function votingProblems(
  expected: readonly ExpectedSensor[],
  rows: readonly RegistryRow[],
  minStake: bigint,
): SensorIssue[] {
  const byKey = new Map(rows.map((row) => [row.pubkey, row]))
  const issues: SensorIssue[] = []
  for (const sensor of expected) {
    const row = byKey.get(sensor.pubkey)
    const problem: SensorProblem | null =
      row === undefined || !row.mirrored
        ? 'unregistered'
        : row.cellId !== sensor.cellId
          ? 'wrong-cell'
          : !row.active
            ? 'excluded'
            : row.stake < minStake
              ? 'understaked'
              : null
    if (problem !== null) issues.push({ pubkey: sensor.pubkey, problem })
  }
  return issues
}

/** Every column the registry is compared on, with the operator's wallet. */
async function selectRows(
  db: PostgresJsDatabase<Record<string, never>>,
  where?: SQL,
): Promise<RegistryRow[]> {
  const query = db
    .select({
      pubkey: sensors.pubkey,
      operatorWallet: operators.wallet,
      cellId: sensors.cellId,
      slotInCell: sensors.slotInCell,
      stake: sensors.stake,
      accepted: sensors.accepted,
      outliers: sensors.outliers,
      active: sensors.active,
      mirroredAt: sensors.mirroredAt,
    })
    .from(sensors)
    .innerJoin(operators, eq(operators.id, sensors.operatorId))
  const rows = await (where === undefined ? query : query.where(where))
  return rows.map(({ mirroredAt, ...row }) => ({ ...row, mirrored: mirroredAt !== null }))
}

/** A mirrored sensor of a cell, by the slot the chain gave it. */
export type CellSlot = { pubkey: string; slotInCell: number }

/**
 * The slots of a cell, as the mirror last read them — what turns a slot of
 * the cell's reputation ring back into the sensor it belongs to (`T035`).
 */
export interface CellSlotStore {
  slotsOf(cellId: bigint): Promise<CellSlot[]>
}

export function pgCellSlotStore(db: PostgresJsDatabase<Record<string, never>>): CellSlotStore {
  return {
    async slotsOf(cellId) {
      // Mirrored rows only: the slot is the chain's, and a row the chain has
      // never confirmed holds an old fixture's claim on a bit, not a bit.
      return await db
        .select({ pubkey: sensors.pubkey, slotInCell: sensors.slotInCell })
        .from(sensors)
        .where(and(eq(sensors.cellId, cellId), isNotNull(sensors.mirroredAt)))
        .orderBy(asc(sensors.slotInCell))
    },
  }
}

/** The `RegistryStore` backed by the real tables. */
export function pgRegistryStore(db: PostgresJsDatabase<Record<string, never>>): RegistryStore {
  return {
    async rowsOf(pubkeys) {
      if (pubkeys.length === 0) return []
      return await selectRows(db, inArray(sensors.pubkey, [...pubkeys]))
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The mirror of the on-chain registry                                        */
/* -------------------------------------------------------------------------- */

/**
 * A `Sensor` account as the chain holds it — what the registry mirror copies
 * in (`T076`, `FR-001`, `FR-050`).
 *
 * The only door into these tables. It updates: the chain is the source of
 * truth, and a row that disagrees with it is repaired by the next read of the
 * chain rather than defended (`schema.ts`).
 */
export type ChainSensor = {
  /** Base58 `sensor_key`. */
  pubkey: string
  /** Base58 `operator`. */
  operatorWallet: string
  cellId: bigint
  /** The bit the program handed out — `Sensor.slot_in_cell`. */
  slotInCell: number
  stake: bigint
  accepted: number
  outliers: number
  active: boolean
}

/** A sensor row as the mirror compares it with the chain. */
export type RegistryRow = ChainSensor & {
  /** Whether the mirror has ever found this sensor on chain. */
  mirrored: boolean
}

export interface RegistryMirrorStore {
  /** Every sensor row, with its operator's wallet. */
  sensorRows(): Promise<RegistryRow[]>
  /**
   * Writes these sensors the way the chain has them, stamping `mirrored_at`,
   * and makes their cells and operators exist. One transaction: a cell
   * without its sensors, or a sensor half-moved, is not a state anyone should
   * read.
   *
   * Every field is overwritten, including the cell, slot and operator of a
   * row written before `T077` by the scenario door — whatever the fixture
   * said, the program's answer is the one the `contributors` mask is indexed
   * by.
   */
  mirrorSensors(rows: readonly ChainSensor[], at: Date): Promise<void>
}

/** `excluded.<column>` — the row Postgres was about to insert. */
function excluded(column: string) {
  return sql.raw(`excluded.${column}`)
}

/** The `RegistryMirrorStore` backed by the real tables. */
export function pgRegistryMirrorStore(
  db: PostgresJsDatabase<Record<string, never>>,
): RegistryMirrorStore {
  return {
    async sensorRows() {
      return await selectRows(db)
    },

    async mirrorSensors(rows, at) {
      if (rows.length === 0) return

      await db.transaction(async (tx) => {
        const cellIds = [...new Set(rows.map((row) => row.cellId))]
        await tx
          .insert(cells)
          // The program admits only cells at `GRID_RESOLUTION`, but the level
          // is read out of the id rather than assumed — `FR-060`.
          .values(cellIds.map((id) => ({ id, resolution: cellResolution(id) })))
          .onConflictDoNothing({ target: cells.id })

        const wallets = [...new Set(rows.map((row) => row.operatorWallet))]
        await tx
          .insert(operators)
          .values(wallets.map((wallet) => ({ wallet })))
          .onConflictDoNothing({ target: operators.wallet })
        const owners = await tx
          .select({ id: operators.id, wallet: operators.wallet })
          .from(operators)
          .where(inArray(operators.wallet, wallets))
        const idByWallet = new Map(owners.map((owner) => [owner.wallet, owner.id]))

        const values = rows.map((row) => {
          const operatorId = idByWallet.get(row.operatorWallet)
          if (operatorId === undefined) {
            throw new Error(`no operator row for wallet ${row.operatorWallet}`)
          }
          return {
            pubkey: row.pubkey,
            operatorId,
            cellId: row.cellId,
            // The chain does not say what a sensor measures, and the network
            // measures one thing (`FR-046`). A second kind will need a field
            // on `Sensor` before it needs one here.
            kind: ReadingKind.PrecipitationMm,
            slotInCell: row.slotInCell,
            stake: row.stake,
            accepted: row.accepted,
            outliers: row.outliers,
            active: row.active,
            mirroredAt: at,
          }
        })

        await tx
          .insert(sensors)
          .values(values)
          .onConflictDoUpdate({
            target: sensors.pubkey,
            set: {
              operatorId: excluded('operator_id'),
              cellId: excluded('cell_id'),
              slotInCell: excluded('slot_in_cell'),
              stake: excluded('stake'),
              accepted: excluded('accepted'),
              outliers: excluded('outliers'),
              active: excluded('active'),
              mirroredAt: excluded('mirrored_at'),
            },
          })
      })
    },
  }
}
