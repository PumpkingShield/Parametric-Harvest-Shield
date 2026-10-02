import {
  type CellReputationAccount,
  type Connection,
  decodeCellReputation,
  decodeSensor,
  excludeSensorInstruction,
  PROGRAM_ID,
  PublicKey,
  reputationPda,
  reputationWindow,
  type SensorAccount,
  sensorPda,
} from '@pumpking/anchor-client'
import type { CellSlotStore } from '@pumpking/db'
import { breachesOutlierShare, OUTLIER_WINDOW_DAYS } from '@pumpking/shared'
import { type DayOutcome, type DaySubmitter, dayIndexAt, type PoolClock } from './interval.ts'

/**
 * Calling `exclude_sensor` on the sensors whose record breaches the outlier
 * share — `FR-012`, `FR-052`, `T035`.
 *
 * The same kind of dispatcher as `settle.ts`, and for the same reason it may
 * stop running without anything breaking: `exclude_sensor` needs no
 * permission, the program sums the window itself and applies the published
 * rule, and anybody watching the chain can call it. This is the worker doing
 * it promptly, so a lying sensor stops voting the day its record crosses the
 * line rather than the day somebody notices.
 *
 * **It reads the chain's ring, not `sensor_verdicts`.** The table is the
 * aggregator's own record and agrees with the ring until an operator
 * reinstates a sensor — the ring forgets the slot's history then, the table
 * does not — and a filter that disagrees with the program is a stream of
 * rejected transactions. Each candidate's `Sensor` is read from the chain too
 * before the call, because the mirror catches up with an exclusion only every
 * few minutes, and a compressed pool closes a day every two seconds.
 */

export interface ExclusionSource {
  /** The cell's `CellReputation`, or null before its first day of verdicts. */
  reputation(cellId: bigint): Promise<CellReputationAccount | null>
  /** The `Sensor` account as the chain holds it now, or null. */
  sensor(sensorKey: PublicKey): Promise<SensorAccount | null>
}

export function rpcExclusionSource(connection: Connection, programId?: PublicKey): ExclusionSource {
  const program = programId ?? PROGRAM_ID
  return {
    async reputation(cellId) {
      const info = await connection.getAccountInfo(reputationPda(cellId, program).address)
      return info === null ? null : decodeCellReputation(info.data)
    },
    async sensor(sensorKey) {
      const info = await connection.getAccountInfo(sensorPda(sensorKey, program).address)
      return info === null ? null : decodeSensor(info.data)
    },
  }
}

export type ExcludeDeps = {
  slots: CellSlotStore
  chain: ExclusionSource
  submitter: DaySubmitter
  /** Pays the fee. `exclude_sensor` checks this key against nothing. */
  caller: PublicKey
  /** Must equal `pool.asset_mint`; the program checks it. */
  assetMint: PublicKey
  clock: PoolClock
  programId?: PublicKey
}

export type ExcludeOutcome =
  | { sensor: string; status: 'excluded'; judged: number; outliers: number; txSignature: string }
  /** Over the line on the ring, already excluded on chain. Nothing to send. */
  | { sensor: string; status: 'already-excluded'; judged: number; outliers: number }
  | { sensor: string; status: 'failed'; judged: number; outliers: number; error: Error }

/**
 * The days an exclusion on `today` counts — `[today − OUTLIER_WINDOW_DAYS,
 * today − 1]`, the closed days before it, as `outlier_window` in the program
 * has them. Null on day zero, which has no closed day before it.
 */
export function outlierWindow(today: number): { from: number; to: number } | null {
  if (today < 1) return null
  return { from: Math.max(0, today - OUTLIER_WINDOW_DAYS), to: today - 1 }
}

/** Excludes every sensor of a cell whose record over the window breaches. */
export async function excludeBreaching(
  deps: ExcludeDeps,
  cellId: bigint,
  now: Date,
): Promise<ExcludeOutcome[]> {
  const today = dayIndexAt(deps.clock, now)
  const window = today === null ? null : outlierWindow(today)
  if (window === null) return []

  const reputation = await deps.chain.reputation(cellId)
  if (reputation === null) return []

  const outcomes: ExcludeOutcome[] = []
  for (const { pubkey, slotInCell } of await deps.slots.slotsOf(cellId)) {
    const counts = reputationWindow(reputation, slotInCell, window.from, window.to)
    if (!breachesOutlierShare(counts)) continue

    const sensorKey = new PublicKey(pubkey)
    const sensor = await deps.chain.sensor(sensorKey)
    if (sensor === null || !sensor.active) {
      outcomes.push({ sensor: pubkey, status: 'already-excluded', ...counts })
      continue
    }

    try {
      const txSignature = await deps.submitter.submit(
        excludeSensorInstruction({
          caller: deps.caller,
          sensorKey,
          cellId,
          assetMint: deps.assetMint,
          ...(deps.programId === undefined ? {} : { programId: deps.programId }),
        }),
      )
      outcomes.push({ sensor: pubkey, status: 'excluded', ...counts, txSignature })
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      outcomes.push({ sensor: pubkey, status: 'failed', ...counts, error })
    }
  }
  return outcomes
}

/**
 * Checks the cells whose day has just reached the chain. A new day is the only
 * thing that adds to a record, so it is the only moment one can newly cross
 * the line.
 */
export async function excludeAfterDays(
  deps: ExcludeDeps,
  outcomes: readonly DayOutcome[],
  now: Date,
): Promise<ExcludeOutcome[]> {
  const cells = new Set<bigint>()
  for (const outcome of outcomes) {
    if (outcome.status === 'submitted') cells.add(outcome.cellId)
  }
  const excluded: ExcludeOutcome[] = []
  for (const cellId of cells) {
    excluded.push(...(await excludeBreaching(deps, cellId, now)))
  }
  return excluded
}
