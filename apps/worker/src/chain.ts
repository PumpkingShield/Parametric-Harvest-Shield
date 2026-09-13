import {
  type Commitment,
  type Connection,
  type Keypair,
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
