import {
  type Connection,
  decodePolicy,
  POLICY_DISCRIMINATOR,
  type PolicyAccount,
  PROGRAM_ID,
  PublicKey,
} from '@pumpking/anchor-client'
import { type IntervalStore, spellInWindow } from '@pumpking/db'
import { decodeBase58, h3IndexFromCellId } from '@pumpking/shared'
import { Hono } from 'hono'
import { apiError } from '../errors.ts'

/**
 * `GET /v1/policies/:pubkey` — the policy, and how long its dry run is right
 * now (`FR-018`, `FR-047`).
 *
 * **Two sources, and the split is deliberate.** The policy itself comes from
 * the chain: it is one account read by address, it never expires, and the
 * chain is the source of truth for what somebody bought. The **run** comes
 * from Postgres, because the program keeps only 128 days of a cell's journal
 * and a settled policy has to stay explainable after its window has rolled out
 * of that ring.
 *
 * **It answers with the run, not with the days.** Drawing the window is
 * `GET /v1/cells/:cellId/days?from&to`, which this response hands the caller
 * the arguments for — `cellId`, `windowStartDay`, `windowEndDay`. Two calls
 * rather than one, because the strip is redrawn as days close while the policy
 * itself does not change, and because the whole trace (readings → medians →
 * days → index → transaction) is `GET /v1/policies/:pubkey/trace` and not this.
 *
 * **Nothing here decides anything.** `spell` is the same number
 * `settle_policy` would count, computed by the same `spellInWindow` the worker
 * uses, but the program counts it again over its own log and its answer is the
 * one that pays. A disagreement here shows an owner a run that is one day
 * short or one day long; it cannot make or withhold a payout, which is what
 * `FR-030` is for.
 */

/* -------------------------------------------------------------------------- */
/* Finding the policy                                                         */
/* -------------------------------------------------------------------------- */

export interface PolicyLookup {
  /** The policy at an address, or null when no policy lives there. */
  policyAt(address: string): Promise<PolicyAccount | null>
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false
  return prefix.every((byte, at) => data[at] === byte)
}

/**
 * The `PolicyLookup` backed by a cluster — one `getAccountInfo`, not a scan.
 *
 * Three ways of not being a policy are all the same answer, and all of them
 * are the caller's mistake rather than ours: nothing at the address, something
 * owned by another program, or one of our own accounts of a different type.
 * The discriminator is checked here rather than left to the coder because
 * `decodePolicy` throws on a `Pool`, and a pool address pasted into this route
 * is a wrong address, not a broken server.
 */
export function rpcPolicyLookup(connection: Connection, programId?: PublicKey): PolicyLookup {
  const program = programId ?? PROGRAM_ID
  return {
    async policyAt(address) {
      const info = await connection.getAccountInfo(new PublicKey(address))
      if (info === null || !info.owner.equals(program)) return null
      const data = Uint8Array.from(info.data)
      if (!startsWith(data, POLICY_DISCRIMINATOR)) return null
      return decodePolicy(data)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The answer                                                                 */
/* -------------------------------------------------------------------------- */

/** Base58 ed25519 public key, 32 bytes — the width of a Solana address. */
const ADDRESS_BYTES = 32

/**
 * The four names `PolicyState` has on chain, and the only four this route
 * sends.
 *
 * Written down as a type rather than left as `string`, because `string` is
 * what let the screen read `paidOut` as "closed without paying" for a policy
 * the chain had already paid: a reader comparing against a name that does not
 * exist is a comparison that never matches, and nothing — not the compiler,
 * not a test written in the same wrong vocabulary — can see it. Every layer
 * downstream narrows to this, so an invented name is now a build error.
 */
export type PolicyStateName = 'active' | 'paidOut' | 'closedNoEvent' | 'unclaimed'

const POLICY_STATES: readonly string[] = ['active', 'paidOut', 'closedNoEvent', 'unclaimed']

/**
 * Anchor encodes a fieldless enum as an object with one key, so the state is a
 * name. Unreachable through `decodePolicy`, which refuses bytes that are not a
 * `Policy` — but a name this route does not know is a program that has grown a
 * state nobody told the screen about, and saying so beats sending it on.
 */
function policyStateName(state: PolicyAccount['state']): PolicyStateName {
  const [name] = Object.keys(state)
  if (name === undefined || !POLICY_STATES.includes(name)) {
    throw new Error(`the program answered with a policy state this API does not know: ${name}`)
  }
  return name as PolicyStateName
}

/** A policy as the wire carries it. */
export type PolicyWire = {
  /** The address it was asked for by. */
  policy: string
  /** `FR-066`: fixed at issue. There is no field to redirect a payout with. */
  owner: string
  /** Decimal strings: `u64` does not survive a JSON number. */
  nonce: string
  /** H3 index in hex — the form `/v1/cells/:cellId/days` takes. */
  cellId: string
  spellDaysThreshold: number
  payout: string
  premium: string
  /** Day indices, both ends inclusive — `FR-069` counts them on this grid. */
  windowStartDay: number
  windowEndDay: number
  windowDays: number
  state: PolicyStateName
  /** Longest run of dry days inside the window, as `cell_days` sees it. */
  spell: number
  /**
   * Days of the window the aggregator has a row for.
   *
   * Carried because `spell` alone is ambiguous at zero: a window with no rows
   * has no run *and* no answer, and a screen that shows the first as the
   * second tells a farmer the rain fell.
   */
  recordedDays: number
}

export type PoliciesRouteOptions = {
  policies: PolicyLookup
  store: Pick<IntervalStore, 'dayRecords'>
}

export function createPoliciesRoute(options: PoliciesRouteOptions): Hono {
  const { policies, store } = options

  return new Hono().get('/:pubkey', async (context) => {
    const address = context.req.param('pubkey')
    if (decodeBase58(address, ADDRESS_BYTES) === null) {
      return apiError(context, 400, 'invalid policy address', {
        fields: [
          { field: 'pubkey', message: `must be a base58-encoded ${ADDRESS_BYTES}-byte address` },
        ],
      })
    }

    const policy = await policies.policyAt(address)
    if (policy === null) {
      return apiError(context, 404, 'no policy at that address')
    }

    const cellId = BigInt(policy.cellId.toString())
    const rows = await store.dayRecords(cellId, policy.windowStartDay, policy.windowEndDay)

    const wire: PolicyWire = {
      policy: address,
      owner: policy.owner.toBase58(),
      nonce: policy.nonce.toString(),
      cellId: h3IndexFromCellId(cellId),
      spellDaysThreshold: policy.spellDaysThreshold,
      payout: policy.payout.toString(),
      premium: policy.premium.toString(),
      windowStartDay: policy.windowStartDay,
      windowEndDay: policy.windowEndDay,
      windowDays: policy.windowEndDay - policy.windowStartDay + 1,
      state: policyStateName(policy.state),
      spell: spellInWindow(rows, policy.windowStartDay, policy.windowEndDay),
      recordedDays: rows.length,
    }
    return context.json(wire, 200)
  })
}
