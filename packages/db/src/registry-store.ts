import type { ReadingKindName } from '@pumpking/shared'
import { inArray } from 'drizzle-orm'
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
 * meant after the fact. A row that exists and disagrees is therefore an error,
 * not something to correct — which is what the unique index on
 * `(cell_id, slot_in_cell)` is left to say out loud.
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
   * Throws when a row exists and disagrees — a second sensor claiming a taken
   * slot is a fixture that contradicts the database, and the run has to stop
   * rather than publish votes credited to the wrong key.
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

      // Conflicting on the key alone, on purpose. A sensor already registered
      // is left exactly as it is; a *different* sensor claiming a taken slot
      // hits `sensors_cell_slot_uq` and raises, because the alternative is two
      // keys sharing one bit of the contributors mask.
      await db.insert(sensors).values(values).onConflictDoNothing({ target: sensors.pubkey })
    },
  }
}
