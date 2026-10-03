import {
  type RegistryRow,
  type RegistryStore,
  type SensorProblem,
  votingProblems,
} from '@pumpking/db'
import { decodeBase58, h3IndexFromCellId, SENSOR_KEY_BYTES } from '@pumpking/shared'
import { Hono } from 'hono'
import { apiError } from '../errors.ts'

/**
 * `GET /v1/sensors/:pubkey` — where a key is registered, and whether its
 * readings count. `FR-001`, `FR-005`, `FR-050`, `FR-058`.
 *
 * The browser sensor (`T038`) asks this before it signs anything: a reading
 * names its cell, and the cell is the registration's (`FR-058`), not the
 * page's to choose. It asks the **mirror** — the same rows `POST /v1/readings`
 * and the aggregator judge a reading by — and not the chain. Ask the chain,
 * and a sensor registered a minute ago reads as registered while the API
 * still refuses it, because the mirror has not caught up.
 *
 * The answer is public on purpose. The registry is on chain (`FR-007`): every
 * sensor is an account at an address derived from its key, readable by anyone
 * with an RPC endpoint. `POST /v1/readings` still gives one answer for an
 * unknown key and a bad signature, but that is about not telling a forger
 * which half of a forgery failed, not about hiding who is registered.
 */

/** Why a registered key does not vote — the registry's reasons, and the pool's. */
export type SensorStatusProblem = Exclude<SensorProblem, 'wrong-cell'> | 'no-pool'

/** `SensorWire` as the browser sensor reads it. */
export type SensorWire = {
  pubkey: string
  /** H3 index in hex — the cell every reading of this key has to name. */
  cellId: string
  /** Decimal strings: `u64` does not survive a JSON number. */
  stake: string
  /** Null before `initialize_pool`. */
  minStake: string | null
  /** True when a reading of this key, arriving in time, enters the median. */
  voting: boolean
  problem: SensorStatusProblem | null
}

/**
 * The reason a registered key does not vote, or null when it does. The row's
 * own cell is the one expected: a key cannot sit in the wrong cell when only
 * its registration names one, so `wrong-cell` never comes back from here.
 */
export function statusProblem(
  row: RegistryRow,
  minStake: bigint | null,
): SensorStatusProblem | null {
  if (minStake === null) return 'no-pool'
  for (const issue of votingProblems(
    [{ pubkey: row.pubkey, cellId: row.cellId }],
    [row],
    minStake,
  )) {
    if (issue.problem !== 'wrong-cell') return issue.problem
  }
  return null
}

export type SensorsRouteOptions = {
  registry: RegistryStore
  minStake: () => Promise<bigint | null>
}

export function createSensorsRoute(options: SensorsRouteOptions): Hono {
  const { registry } = options

  return new Hono().get('/:pubkey', async (context) => {
    const pubkey = context.req.param('pubkey')
    if (decodeBase58(pubkey, SENSOR_KEY_BYTES) === null) {
      return apiError(context, 400, 'invalid sensor key', {
        fields: [
          {
            field: 'pubkey',
            message: `must be a base58-encoded ${SENSOR_KEY_BYTES}-byte ed25519 public key`,
          },
        ],
      })
    }

    const [row] = await registry.rowsOf([pubkey])
    if (row === undefined) {
      return apiError(context, 404, 'no sensor with that key in the registry')
    }

    const minStake = await options.minStake()
    const problem = statusProblem(row, minStake)

    const wire: SensorWire = {
      pubkey,
      cellId: h3IndexFromCellId(row.cellId),
      stake: row.stake.toString(),
      minStake: minStake === null ? null : minStake.toString(),
      voting: problem === null,
      problem,
    }
    return context.json(wire, 200)
  })
}
