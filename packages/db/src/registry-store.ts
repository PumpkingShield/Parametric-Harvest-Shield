import { cellResolution, ReadingKind, type ReadingKindName } from '@pumpking/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { cells, operators, sensors } from './schema.ts'

/**
 * Putting a cell, its operators and its sensors into the registry — `FR-001`,
 * `FR-006`, `FR-009`.
 *
 * `POST /v1/readings` refuses a key it does not know (`FR-002`), so until
 * somebody writes these three tables the network cannot publish anything at
 * all. On M1 the sensors are our own keys and the weather is a scenario
 * (`fixtures/scenarios/`), and the run is the only thing that knows which
 * sensors it is about to use — so the run is what registers them. Open
 * registration is `register_sensor` on chain, which is `T031` and M2; this is
 * the M1 door and it is deliberately narrow: it can only make rows exist.
 *
 * **Every method is idempotent and none of them updates.** A second run over
 * the same fixture must be a no-op rather than a rewrite: the slot a sensor
 * occupies, the cell it votes in and the operator its vote counts for are
 * facts the median and the on-chain `contributors` mask are computed from, and
 * quietly moving one under a running policy would change what a recorded day
 * meant after the fact. A row that exists and disagrees is left as it is.
 *
 * **Since `T076` the rows this door writes do not vote.** `FR-050` counts only
 * a sensor the registry mirror found on chain, so a sensor that exists only
 * here publishes and is stored, and carries no vote and no bit of the mask.
 * Its slot is a fixture's claim and nothing more, which is why the slot index
 * binds mirrored rows only (`schema.ts`). `T077` moves the show to on-chain
 * registration; until then this door keeps intake open for scenario keys.
 */

/** A sensor as the registry needs it — `FR-001`. */
export type SensorSetup = {
  /** Base58 ed25519 public key; also the seed of the on-chain `Sensor` PDA. */
  pubkey: string
  kind: ReadingKindName
  /** Position in the on-chain `contributors` bitmask, 0..31. */
  slotInCell: number
  /**
   * Base58 wallet of the operator this sensor's vote counts for — `FR-009`
   * makes the operator the unit of the vote, so a sensor without one is not a
   * vote, and rewards and burnt stake settle against this key.
   */
  operatorWallet: string
}

/** A cell and the network that publishes into it. */
export type CellSetup = {
  cellId: bigint
  /** `FR-060` makes the grid level a parameter, so it is stored, not assumed. */
  resolution: number
  sensors: readonly SensorSetup[]
}

export interface RegistryStore {
  /**
   * Makes the cell, its operators and its sensors exist. Idempotent.
   *
   * A row that already exists is left exactly as it is, including one the
   * mirror has since written from the chain.
   */
  ensureCell(setup: CellSetup): Promise<void>
}

/** The `RegistryStore` backed by the real tables. */
export function pgRegistryStore(db: PostgresJsDatabase<Record<string, never>>): RegistryStore {
  return {
    async ensureCell(setup) {
      await db
        .insert(cells)
        .values({ id: setup.cellId, resolution: setup.resolution })
        .onConflictDoNothing({ target: cells.id })

      const wallets = [...new Set(setup.sensors.map((sensor) => sensor.operatorWallet))]
      if (wallets.length === 0) return

      await db
        .insert(operators)
        .values(wallets.map((wallet) => ({ wallet })))
        .onConflictDoNothing({ target: operators.wallet })

      // Read back rather than `returning()`: the rows that already existed are
      // not returned by an insert that did nothing about them, and those are
      // exactly the ones a second run needs.
      const rows = await db
        .select({ id: operators.id, wallet: operators.wallet })
        .from(operators)
        .where(inArray(operators.wallet, wallets))
      const idByWallet = new Map(rows.map((row) => [row.wallet, row.id]))

      const values = setup.sensors.map((sensor) => {
        const operatorId = idByWallet.get(sensor.operatorWallet)
        if (operatorId === undefined) {
          // The insert above put every wallet there; reaching this means the
          // row vanished between the two statements.
          throw new Error(`no operator row for wallet ${sensor.operatorWallet}`)
        }
        return {
          pubkey: sensor.pubkey,
          operatorId,
          cellId: setup.cellId,
          kind: sensor.kind,
          slotInCell: sensor.slotInCell,
        }
      })

      // Conflicting on the key alone, on purpose: a sensor already registered
      // — by this door or by the chain — is left exactly as it is.
      await db.insert(sensors).values(values).onConflictDoNothing({ target: sensors.pubkey })
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
 * Open registration is `register_sensor` on chain (`T031`), so after M2 the
 * three tables above are a cache of the program's registry, and this is the
 * door that fills them. Unlike `ensureCell` it **does** update: the chain is
 * the source of truth, and a row that disagrees with it is repaired by the
 * next read of the chain rather than defended (`schema.ts`).
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
   * row the scenario door wrote first — whatever the fixture said, the
   * program's answer is the one the `contributors` mask is indexed by.
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
      const rows = await db
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
      return rows.map(({ mirroredAt, ...row }) => ({ ...row, mirrored: mirroredAt !== null }))
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
