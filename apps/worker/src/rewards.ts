import {
  type Connection,
  type DayRewardedEvent,
  dayRewardedFromLogs,
  PROGRAM_ID,
  type PublicKey,
} from '@pumpking/anchor-client'
import type { CellSlotStore, RewardMirrorStore, SlotRewardRow } from '@pumpking/db'

/**
 * What each slot earned on each day, read out of the day's own transaction —
 * `T040`, `FR-036`.
 *
 * `pay_day` divides the day's budget on chain and logs the result as
 * `DayRewarded`. The account keeps only the running unclaimed balance, so the
 * event is the one place the per-day figure exists, and this is the only
 * reader of it: the operator screen shows a history of what the program paid,
 * not a second implementation of how it divides.
 *
 * **Its own step, not a line in `closeCellDay`.** A day is finished once its
 * signature is stored (`interval.ts`), and a worker that died between that and
 * reading the logs would never come back to the day. Here the unread days are
 * a query — `cell_days.rewards_read_at is null` — so a crash, an RPC that has
 * not indexed the transaction yet, or a deploy in between costs a later read,
 * not a hole in the history.
 *
 * **Not every cycle, and never ahead of a day.** A quiet cycle costs one
 * statement already (`T073`). A cycle that submitted a day leaves the history
 * for the next quiet one, which reads it straight away: nothing waits on the
 * history, while the day is the road to a payout, and a worker catching up —
 * after downtime, or on a scenario pool whose day is two seconds — would
 * otherwise spend a `getTransaction` and a write per day it has not yet sent.
 * Measured on the demo (2026-10-06): about 0.46 s a day from a laptop, the
 * difference between keeping up with a two-second day and falling behind it.
 * A worker that is never quiet still reads once a retry period, so the
 * history lags behind a busy worker but is not starved by it.
 */

/** How often unread days are looked for, busy or not, when nothing is owed. */
export const REWARDS_RETRY_MS = 300_000

/**
 * Where a day transaction's `DayRewarded` comes from. `undefined` — the
 * cluster does not have the transaction (yet); `null` — it does, and the
 * program logged no such event (a day written before `T036`).
 */
export interface DayRewardSource {
  dayRewarded(signature: string): Promise<DayRewardedEvent | null | undefined>
}

export function rpcDayRewardSource(connection: Connection, programId?: PublicKey): DayRewardSource {
  const program = programId ?? PROGRAM_ID
  return {
    async dayRewarded(signature) {
      const tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      if (tx === null) return undefined
      return dayRewardedFromLogs(tx.meta?.logMessages ?? [], program)
    },
  }
}

export type RewardReadOutcome =
  | { cellId: bigint; dayIndex: number; status: 'read'; slots: number }
  /** The cluster has no such transaction yet; left unread for the next try. */
  | { cellId: bigint; dayIndex: number; status: 'missing' }
  | { cellId: bigint; dayIndex: number; status: 'failed'; error: Error }

export type RewardMirrorDeps = {
  store: RewardMirrorStore
  source: DayRewardSource
  /** Who holds a slot of a cell — the same lookup exclusion uses. */
  slots: CellSlotStore
}

/** The rows of an event: one per slot that earned, with its sensor if known. */
export function slotRewardRows(
  event: DayRewardedEvent,
  holders: ReadonlyMap<number, string>,
): SlotRewardRow[] {
  const rows: SlotRewardRow[] = []
  event.earned.forEach((earned, slot) => {
    if (earned > 0n) rows.push({ slot, sensorPubkey: holders.get(slot) ?? null, earned })
  })
  return rows
}

/** Reads every unread day from `fromDay` on into `slot_rewards`. */
export async function readDayRewards(
  deps: RewardMirrorDeps,
  fromDay: number,
): Promise<RewardReadOutcome[]> {
  const outcomes: RewardReadOutcome[] = []
  const holdersOf = new Map<bigint, Map<number, string>>()

  for (const { cellId, dayIndex, txSignature } of await deps.store.unreadDays(fromDay)) {
    try {
      const event = await deps.source.dayRewarded(txSignature)
      if (event === undefined) {
        outcomes.push({ cellId, dayIndex, status: 'missing' })
        continue
      }
      if (event !== null && (event.cellId !== cellId || event.dayIndex !== dayIndex)) {
        // The signature belongs to another day: a row that is wrong, and
        // writing its numbers under this day would make it wrong twice.
        throw new Error(
          `transaction ${txSignature} paid cell ${event.cellId} day ${event.dayIndex}, not cell ${cellId} day ${dayIndex}`,
        )
      }

      let holders = holdersOf.get(cellId)
      if (holders === undefined) {
        holders = new Map()
        for (const { pubkey, slots } of await deps.slots.slotsOf(cellId)) {
          for (const held of slots) if (held.cellId === cellId) holders.set(held.slotInCell, pubkey)
        }
        holdersOf.set(cellId, holders)
      }

      const rows = event === null ? [] : slotRewardRows(event, holders)
      await deps.store.saveDayRewards(cellId, dayIndex, rows)
      outcomes.push({ cellId, dayIndex, status: 'read', slots: rows.length })
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      outcomes.push({ cellId, dayIndex, status: 'failed', error })
    }
  }
  return outcomes
}

export interface RewardMirror {
  /**
   * Reads unread days in the first quiet cycle after one that submitted a
   * day, or once the retry period has passed, busy or not; null otherwise.
   */
  readIfDue(now: Date, submitted: boolean, fromDay: number): Promise<RewardReadOutcome[] | null>
}

export function rewardMirror(
  deps: RewardMirrorDeps,
  retryMs: number = REWARDS_RETRY_MS,
): RewardMirror {
  if (!Number.isInteger(retryMs) || retryMs < 1) {
    throw new RangeError(`retryMs must be a positive integer: ${retryMs}`)
  }
  let nextAt: number | null = null
  // A day went out since the last read: the next quiet cycle owes it one.
  let owed = false
  return {
    async readIfDue(now, submitted, fromDay) {
      const at = now.getTime()
      const due = nextAt === null || at >= nextAt
      if (submitted) owed = true
      if (!due && (submitted || !owed)) return null
      owed = false
      nextAt = at + retryMs
      return await readDayRewards(deps, fromDay)
    },
  }
}
