import {
  associatedTokenAddress,
  type Connection,
  decodePolicy,
  isPolicyActive,
  POLICY_DISCRIMINATOR,
  type PolicyAccount,
  PROGRAM_ID,
  type PublicKey,
  settlePolicyInstruction,
  TOKEN_PROGRAM_ID,
} from '@pumpking/anchor-client'
import { type IntervalStore, spellInWindow } from '@pumpking/db'
import { encodeBase58 } from '@pumpking/shared'
import type { DayOutcome, DaySubmitter } from './interval.ts'

/**
 * Calling `settle_policy` on the policies a recorded day has triggered —
 * `FR-026`, `FR-030`, `SC-001`.
 *
 * **Nothing here decides whether a policy pays.** The program reads the cell's
 * own day log, counts the run itself and compares it to the threshold the
 * policy was sold with; this module only decides which calls are worth making.
 * A wrong guess costs a rejected transaction, never a wrong transfer — which is
 * what lets it read the aggregator's own `cell_days` rows instead of the
 * chain's ring buffer, and be a cheap filter rather than a second authority.
 *
 * **It exists for `SC-001` and for nothing else.** `settle_policy` needs no
 * permission (`FR-030`): the owner can call it, a neighbour can, a bot watching
 * the program can. This is the worker doing it immediately so the sixty seconds
 * `SC-001` allows are spent on confirmation rather than on waiting for somebody
 * to notice. If this module stops running, every policy it would have settled
 * is still settleable by anyone — which is the property being protected, and
 * the reason a dispatcher is a convenience and not a role.
 *
 * That is also why `SC-002` holds: between buying cover and the money arriving,
 * the owner does nothing. Not because we promise to press the button, but
 * because the button is not theirs to press.
 */

/* -------------------------------------------------------------------------- */
/* Finding the policies                                                       */
/* -------------------------------------------------------------------------- */

/** A policy account and the address it lives at. */
export type OpenPolicy = {
  address: PublicKey
  account: PolicyAccount
}

export interface PolicySource {
  /** Policies on a cell that can still be triggered — `FR-027`. */
  openPolicies(cellId: bigint): Promise<OpenPolicy[]>
}

/**
 * The `PolicySource` backed by a cluster.
 *
 * Filtered on the account discriminator only, then narrowed in memory. The
 * cell id sits at a known offset and a `memcmp` on it would be a smaller
 * response, but it would also be this client's fourth copy of the account
 * layout — and a scan filtered on a wrong offset returns an empty list, which
 * is indistinguishable from a cell that genuinely has no policies. A quiet
 * "nothing to settle" is the one failure this module must not have.
 */
export function rpcPolicySource(connection: Connection, programId?: PublicKey): PolicySource {
  const program = programId ?? PROGRAM_ID
  return {
    async openPolicies(cellId) {
      const accounts = await connection.getProgramAccounts(program, {
        filters: [{ memcmp: { offset: 0, bytes: encodeBase58(POLICY_DISCRIMINATOR) } }],
      })
      const open: OpenPolicy[] = []
      for (const { pubkey, account } of accounts) {
        const policy = decodePolicy(account.data)
        if (BigInt(policy.cellId.toString()) !== cellId) continue
        if (!isPolicyActive(policy)) continue
        open.push({ address: pubkey, account: policy })
      }
      return open
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Deciding which are worth a call                                            */
/* -------------------------------------------------------------------------- */

export type SettleDeps = {
  store: Pick<IntervalStore, 'dayRecords'>
  policies: PolicySource
  submitter: DaySubmitter
  /**
   * Whoever pays for the transaction. `FR-030`: the program checks this key
   * against nothing, so it is a payer and not an authority.
   */
  caller: PublicKey
  /** Must equal `pool.asset_mint`; the program checks it. */
  assetMint: PublicKey
  tokenProgram?: PublicKey
  programId?: PublicKey
}

export type SettleOutcome =
  | { policy: string; status: 'settled'; spell: number; txSignature: string }
  /** The run has not reached the threshold yet. Nothing is owed. */
  | { policy: string; status: 'waiting'; spell: number }
  | { policy: string; status: 'failed'; spell: number; error: Error }

/**
 * Settles every policy on a cell whose window already holds the run it was
 * sold against — `FR-026`.
 *
 * The window does not have to be over. A run that has reached the threshold
 * cannot be un-reached by the days after it, so waiting for the window to
 * close would delay a payout that is already owed — `check_settlement` says
 * the same thing from the other side, and `SC-001` measures exactly that delay.
 *
 * The payout goes to the owner's associated token account, derived rather than
 * chosen: `FR-066` binds the destination to the owner, and the caller picks
 * which of the owner's accounts the money lands in, never whose.
 */
export async function settleTriggered(deps: SettleDeps, cellId: bigint): Promise<SettleOutcome[]> {
  const tokenProgram = deps.tokenProgram ?? TOKEN_PROGRAM_ID
  const outcomes: SettleOutcome[] = []

  for (const { address, account } of await deps.policies.openPolicies(cellId)) {
    const policy = address.toBase58()
    const rows = await deps.store.dayRecords(cellId, account.windowStartDay, account.windowEndDay)
    const spell = spellInWindow(rows, account.windowStartDay, account.windowEndDay)

    if (spell < account.spellDaysThreshold) {
      outcomes.push({ policy, status: 'waiting', spell })
      continue
    }

    const instruction = settlePolicyInstruction({
      caller: deps.caller,
      owner: account.owner,
      nonce: BigInt(account.nonce.toString()),
      cellId,
      assetMint: deps.assetMint,
      ownerTokens: associatedTokenAddress(account.owner, deps.assetMint, tokenProgram),
      tokenProgram,
      ...(deps.programId === undefined ? {} : { programId: deps.programId }),
    })

    try {
      const txSignature = await deps.submitter.submit(instruction)
      outcomes.push({ policy, status: 'settled', spell, txSignature })
    } catch (cause) {
      // A rejected settlement is not a reason to skip the next policy: the
      // cell's other owners are owed the same promptness, and the program has
      // already refused to move money it did not owe.
      const error = cause instanceof Error ? cause : new Error(String(cause))
      outcomes.push({ policy, status: 'failed', spell, error })
    }
  }

  return outcomes
}

/**
 * Settles the cells whose day has just reached the chain — the `SC-001` path.
 *
 * Called right after `closeDueDays`, and only for the cells that actually got
 * a new day: a day record is the only thing that can start a run, so a cell
 * whose record failed or was already on chain has nothing new to settle.
 * Each cell is visited once however many days it wrote, because settlement
 * reads the whole window rather than the last day of it.
 */
export async function settleAfterDays(
  deps: SettleDeps,
  outcomes: readonly DayOutcome[],
): Promise<SettleOutcome[]> {
  const cells = new Set<bigint>()
  for (const outcome of outcomes) {
    if (outcome.status === 'submitted') cells.add(outcome.cellId)
  }

  const settled: SettleOutcome[] = []
  for (const cellId of cells) {
    settled.push(...(await settleTriggered(deps, cellId)))
  }
  return settled
}
