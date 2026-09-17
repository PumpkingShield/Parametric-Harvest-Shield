import {
  type Commitment,
  type Connection,
  decodePool,
  type Keypair,
  type PoolAccount,
  PROGRAM_ID,
  type PublicKey,
  poolPda,
  sendAndConfirmTransaction,
  Transaction,
  type TransactionInstruction,
} from '@pumpking/anchor-client'
import type { DaySubmitter } from './interval.ts'

/**
 * The `DaySubmitter` that talks to a cluster — `FR-015`.
 *
 * One instruction per transaction, and no batching of cells into one. Two
 * reasons, and neither is about fees: a day record either lands or does not,
 * and a cell whose neighbour's record was malformed should not lose its own
 * day; and `cell_days.tx_signature` is the trace's link from a payout to the
 * transaction that caused it, which stops meaning anything when one signature
 * covers thirty cells.
 *
 * `confirmed` rather than `finalized`: `SC-001` gives the whole path from a
 * closed interval to money in the farmer's account sixty seconds, and
 * finalisation alone spends a good part of that. The day record is not a
 * payment — the payment is `settle_policy`, which reads the account this
 * transaction wrote — so a record that ends up rolled back costs a retry
 * rather than a wrong transfer.
 */
export type RpcSubmitterOptions = {
  connection: Connection
  /** `FR-015`: `pool.aggregator`, the only key the program takes a day from. */
  aggregator: Keypair
  commitment?: Commitment
}

export function rpcDaySubmitter(options: RpcSubmitterOptions): DaySubmitter {
  const commitment: Commitment = options.commitment ?? 'confirmed'
  return {
    async submit(instruction: TransactionInstruction): Promise<string> {
      const transaction = new Transaction().add(instruction)
      return await sendAndConfirmTransaction(
        options.connection,
        transaction,
        [options.aggregator],
        { commitment, preflightCommitment: commitment },
      )
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Reading the pool                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Where the cycle gets the clock and the thresholds it aggregates under.
 *
 * An interface for the same reason `DaySubmitter` is one: what a cycle does
 * with `seconds_per_day` is arithmetic, and arithmetic should be testable
 * without a cluster.
 */
export interface PoolSource {
  /** The pool, or null when it has not been initialised yet. */
  read(): Promise<PoolAccount | null>
}

/**
 * The `PoolSource` backed by a cluster — one `getAccountInfo` per cycle.
 *
 * Read every cycle rather than cached at startup. It costs one call, and it
 * buys two things worth more than that: a worker started before
 * `initialize_pool` waits for the pool instead of needing a restart, which on
 * an M1 show is the actual order of events; and a pool whose published
 * parameters change is followed rather than argued with.
 *
 * A missing pool is `null`, not an error. "The pool does not exist yet" is a
 * state the process has an answer for — do nothing this cycle — and turning it
 * into a throw would make it indistinguishable from an RPC that is down.
 */
export function rpcPoolSource(connection: Connection, programId?: PublicKey): PoolSource {
  const program = programId ?? PROGRAM_ID
  const address = poolPda(program).address
  return {
    async read() {
      const info = await connection.getAccountInfo(address)
      if (info === null || !info.owner.equals(program)) return null
      return decodePool(Uint8Array.from(info.data))
    },
  }
}
