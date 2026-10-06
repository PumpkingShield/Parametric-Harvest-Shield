import { BorshCoder, EventParser, type Idl } from '@coral-xyz/anchor'
import { PUMPKING_IDL } from './idl/idl.ts'
import { PROGRAM_ID } from './program.ts'
import type { PublicKey } from './web3.ts'

/**
 * The program's events, read back out of a transaction's logs — `T040`.
 *
 * An event is the only place some numbers exist at all. `DayRewarded` says
 * what each slot earned on a day; `CellRewards.accrued` only holds what is
 * still unclaimed, so once the operator claims, the day it was earned on is
 * gone from every account. The aggregator sends that transaction itself and
 * reads the event out of it, so the history the operator screen shows is the
 * program's own arithmetic and not a second copy of `pay_day` in TypeScript.
 *
 * `EventParser` and not a scan for `Program data:` lines: it follows the
 * invocation stack and only takes lines this program wrote, so another
 * program in the same transaction cannot be read as ours.
 */

const coder = new BorshCoder(PUMPKING_IDL as Idl)

/** `DayRewarded`, with the `u64`s as `bigint`. */
export type DayRewardedEvent = {
  cellId: bigint
  dayIndex: number
  /** Per slot, what the day added to the slot's unclaimed balance. */
  earned: bigint[]
  /** What went back to capital with the day. */
  returned: bigint
}

/** A `BN` — or anything else with a decimal `toString` — as a `bigint`. */
function big(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'object' && value !== null) return BigInt(String(value))
  throw new TypeError(`not an integer: ${String(value)}`)
}

/** Every event the program logged, in order, by its IDL name. */
export function programEvents(
  logs: readonly string[],
  programId: PublicKey = PROGRAM_ID,
): { name: string; data: Record<string, unknown> }[] {
  const parser = new EventParser(programId, coder)
  return [...parser.parseLogs([...logs])].map((event) => ({
    name: event.name,
    data: event.data as Record<string, unknown>,
  }))
}

/**
 * The `DayRewarded` of a transaction's logs, or null when it has none.
 *
 * Every day transaction carries exactly one (`T036`): the reputation half
 * always runs, and it always pays or returns the day.
 */
export function dayRewardedFromLogs(
  logs: readonly string[],
  programId: PublicKey = PROGRAM_ID,
): DayRewardedEvent | null {
  const event = programEvents(logs, programId).find((one) => one.name === 'dayRewarded')
  if (event === undefined) return null
  const { data } = event
  const earned = data.earned
  if (!Array.isArray(earned)) throw new TypeError('DayRewarded.earned is not an array')
  return {
    cellId: big(data.cellId),
    dayIndex: Number(data.dayIndex),
    earned: earned.map(big),
    returned: big(data.returned),
  }
}
