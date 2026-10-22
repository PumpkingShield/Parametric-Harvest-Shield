import {
  type Connection,
  cellPda,
  decodeCellState,
  openInvestigationInstruction,
  PROGRAM_ID,
  type PublicKey,
} from '@pumpking/anchor-client'
import type { InvestigationStore } from '@pumpking/db'
import { INVESTIGATION_WINDOW_DAYS, investigationDays } from '@pumpking/shared'
import { type DaySubmitter, dayIndexAt, type PoolClock } from './interval.ts'

/**
 * Putting a cell under investigation when its disagreement with the reference
 * is systematic — `FR-045`, `T044`.
 *
 * The rule is `investigationDays`: enough days the cell called dry and the
 * reference disputed, inside one coverage window. The program checks its own
 * half again — the days are named, in the window, and dry in the cell's log —
 * so a wrong call here is a rejected transaction, never a cell closed on
 * evidence the chain does not hold.
 *
 * **Every cell with disputes is looked at on every attempt**, not only the ones
 * that got a new verdict. A send that failed is then simply tried again on the
 * next attempt, and nothing has to remember that it failed.
 *
 * **The flag is read from the chain before the call.** Only the authority
 * lowers it, so a cell already under investigation is the normal state of a
 * cell that fired once, and the read is what keeps that from being a stream of
 * rejected transactions.
 */

export interface InvestigationSource {
  /** Whether the cell is under investigation now, or null when it has no account. */
  underInvestigation(cellId: bigint): Promise<boolean | null>
}

export function rpcInvestigationSource(
  connection: Connection,
  programId?: PublicKey,
): InvestigationSource {
  const program = programId ?? PROGRAM_ID
  return {
    async underInvestigation(cellId) {
      const info = await connection.getAccountInfo(cellPda(cellId, program).address)
      return info === null ? null : decodeCellState(info.data).underInvestigation
    },
  }
}

export type InvestigateDeps = {
  store: InvestigationStore
  chain: InvestigationSource
  submitter: DaySubmitter
  /** `pool.aggregator`; the program checks the key. */
  aggregator: PublicKey
  clock: PoolClock
  programId?: PublicKey
}

export type InvestigateOutcome =
  | { cellId: bigint; status: 'opened'; days: number[]; txSignature: string }
  /** The rule holds and the flag is already up. Nothing to send. */
  | { cellId: bigint; status: 'already-open'; days: number[] }
  | { cellId: bigint; status: 'failed'; days: number[]; error: Error }

export async function investigateDisputes(
  deps: InvestigateDeps,
  now: Date,
): Promise<InvestigateOutcome[]> {
  const today = dayIndexAt(deps.clock, now)
  if (today === null) return []

  const outcomes: InvestigateOutcome[] = []
  const candidates = await deps.store.disputedDryDays(
    Math.max(0, today - INVESTIGATION_WINDOW_DAYS),
  )
  for (const { cellId, days: disputed } of candidates) {
    const days = investigationDays(disputed, today)
    if (days === null) continue
    try {
      const flagged = await deps.chain.underInvestigation(cellId)
      if (flagged === true) {
        outcomes.push({ cellId, status: 'already-open', days })
        continue
      }
      const txSignature = await deps.submitter.submit(
        openInvestigationInstruction({
          aggregator: deps.aggregator,
          cellId,
          disputedDays: days,
          ...(deps.programId === undefined ? {} : { programId: deps.programId }),
        }),
      )
      outcomes.push({ cellId, status: 'opened', days, txSignature })
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      outcomes.push({ cellId, status: 'failed', days, error })
    }
  }
  return outcomes
}
