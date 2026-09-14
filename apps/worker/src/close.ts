import { closePolicyInstruction, type PublicKey } from '@pumpking/anchor-client'
import type { DayRow, IntervalStore } from '@pumpking/db'
import type { DayOutcome, DaySubmitter } from './interval.ts'
import { type PolicySource, spellInWindow } from './settle.ts'

/**
 * Calling `close_policy` on the policies whose window ended without the event
 * — `FR-028`.
 *
 * **Nothing here moves money.** The premium became capital the day the policy
 * was sold (`FR-034`), so closing hands nobody anything; what it releases is
 * the **reservation**, which is capacity. Until it runs, a payout that will
 * never happen still counts against `free_liquidity` and against the cell's
 * exposure limit (`FR-019`, `FR-020`), and the pool sells less cover than it
 * has. The instruction takes no vault, no mint and no token program, and
 * neither does this module: that absence is the fact, not a simplification.
 *
 * **It decides nothing, like its twin in `settle.ts`.** `check_closure` reads
 * the cell's own day log, insists the window is finished and refuses if the
 * spell reached the threshold — so a wrong guess here costs a rejected
 * transaction, never a policy closed out from under an owner who was owed
 * money. That is what lets this read the aggregator's own `cell_days` rows
 * instead of the chain's ring buffer.
 *
 * **Why it has to run, and not merely ought to.** The cell's day log is a ring
 * of 128 days. Once the newest recorded day passes `window_start + 127`, the
 * window's first day falls out of the log, `spell_in_window` can no longer
 * call the window finished, and the policy becomes both unpayable and
 * **unclosable** — its capacity is reserved for good. The gap between the
 * longest window a policy may buy (90 days) and the ring is the grace period,
 * and it is only a grace period. Closing on the day the window finishes,
 * which is what `closeAfterDays` does, never approaches it.
 */

/* -------------------------------------------------------------------------- */
/* Deciding which windows are finished                                        */
/* -------------------------------------------------------------------------- */

/**
 * Whether the chain can answer for every day of the window.
 *
 * A row is not enough: `txSignature` is null until `submit_day_record` lands,
 * and a day that never reached the chain is a day the ring reads as `None` —
 * exactly the state `check_closure` refuses. Requiring the signature keeps the
 * module from asking, every cycle, for a closure the program is bound to
 * refuse.
 *
 * The direction of the error is the safe one either way. Declining to close
 * leaves capacity reserved a while longer; it can never close a window that is
 * still running, and there is no third thing closing can get wrong.
 */
export function windowIsFinished(
  rows: readonly DayRow[],
  windowStartDay: number,
  windowEndDay: number,
): boolean {
  const recorded = new Set<number>()
  for (const row of rows) {
    if (row.txSignature !== null) recorded.add(row.dayIndex)
  }
  for (let day = windowStartDay; day <= windowEndDay; day += 1) {
    if (!recorded.has(day)) return false
  }
  return true
}

export type CloseDeps = {
  store: Pick<IntervalStore, 'dayRecords'>
  policies: PolicySource
  submitter: DaySubmitter
  /**
   * Whoever pays for the transaction. `FR-028` closes capacity rather than
   * money, and the program checks this key against nothing: a payer, not an
   * authority.
   */
  caller: PublicKey
  programId?: PublicKey
}

export type CloseOutcome =
  | { policy: string; status: 'closed'; spell: number; txSignature: string }
  /** The window has not finished on chain yet. Nothing to close. */
  | { policy: string; status: 'running'; spell: number }
  /** The run reached the threshold: this policy owes money, and settling it is
   * `settle.ts`'s business. Closing here would be the payout-denying role
   * `FR-030` exists to make impossible. */
  | { policy: string; status: 'event'; spell: number }
  | { policy: string; status: 'failed'; spell: number; error: Error }

/**
 * Closes every policy on a cell whose window finished without the event —
 * `FR-028`.
 *
 * Both conditions are checked before the call rather than left to the program,
 * because both are cheap here and each avoided transaction is a fee: the
 * window has to be finished, and the run has to have fallen short. The program
 * checks them again regardless, and its answer is the one that counts.
 */
export async function closeFinishedWindows(
  deps: CloseDeps,
  cellId: bigint,
): Promise<CloseOutcome[]> {
  const outcomes: CloseOutcome[] = []

  for (const { address, account } of await deps.policies.openPolicies(cellId)) {
    const policy = address.toBase58()
    const rows = await deps.store.dayRecords(cellId, account.windowStartDay, account.windowEndDay)
    const spell = spellInWindow(rows, account.windowStartDay, account.windowEndDay)

    if (!windowIsFinished(rows, account.windowStartDay, account.windowEndDay)) {
      outcomes.push({ policy, status: 'running', spell })
      continue
    }
    if (spell >= account.spellDaysThreshold) {
      outcomes.push({ policy, status: 'event', spell })
      continue
    }

    const instruction = closePolicyInstruction({
      caller: deps.caller,
      owner: account.owner,
      nonce: BigInt(account.nonce.toString()),
      cellId,
      ...(deps.programId === undefined ? {} : { programId: deps.programId }),
    })

    try {
      const txSignature = await deps.submitter.submit(instruction)
      outcomes.push({ policy, status: 'closed', spell, txSignature })
    } catch (cause) {
      // A rejected closure is not a reason to skip the next policy: each one
      // holds its own slice of the cell's exposure limit, and the pool is
      // short of capacity for as long as any of them stays open.
      const error = cause instanceof Error ? cause : new Error(String(cause))
      outcomes.push({ policy, status: 'failed', spell, error })
    }
  }

  return outcomes
}

/**
 * Closes what the day that has just reached the chain finished — the other
 * half of the cycle `settleAfterDays` starts.
 *
 * Called for the cells that actually got a new day, and for the same reason:
 * a day record is the only thing that can finish a window. Because every cell
 * gets a day written every day — silence has to be written down to count as
 * silence — every open policy is looked at the day after its window ends, and
 * a backlog left by a worker that was down clears on its next cycle rather
 * than aging towards the ring's horizon.
 *
 * Runs after settlement, not before. A window that finished on the same day
 * its run reached the threshold is owed money, and the money is the deadline
 * that has sixty seconds on it (`SC-001`); capacity can wait a cycle.
 */
export async function closeAfterDays(
  deps: CloseDeps,
  outcomes: readonly DayOutcome[],
): Promise<CloseOutcome[]> {
  const cells = new Set<bigint>()
  for (const outcome of outcomes) {
    if (outcome.status === 'submitted') cells.add(outcome.cellId)
  }

  const closed: CloseOutcome[] = []
  for (const cellId of cells) {
    closed.push(...(await closeFinishedWindows(deps, cellId)))
  }
  return closed
}
