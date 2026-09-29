import type { PoolAccount, PublicKey } from '@pumpking/anchor-client'
import type { IntervalStore } from '@pumpking/db'
import { ReadingKind } from '@pumpking/shared'
import type { PoolSource } from './chain.ts'
import { type CloseDeps, type CloseOutcome, closeAfterDays } from './close.ts'
import {
  type AggregationParams,
  backlogHorizon,
  closeDueDays,
  type DayOutcome,
  type DaySubmitter,
  DEFAULT_BACKLOG_DAYS,
  type PoolClock,
} from './interval.ts'
import type { MirrorOutcome, RegistryMirror } from './registry.ts'
import type { RetentionSweeper, SweepOutcome } from './retention.ts'
import {
  type PolicySource,
  type SettleDeps,
  type SettleOutcome,
  settleAfterDays,
} from './settle.ts'

/**
 * One turn of the worker — `T057`.
 *
 * The dispatchers exist and none of them starts itself. That is the hole this
 * project has now found three times: `close_policy` had a builder and no
 * caller, `settle_policy` had a dispatcher nothing ran, and the sensor registry
 * had a schema nobody wrote to. So the order is written down here, once, and it
 * is the whole of what a cycle does:
 *
 * 0. **`syncIfDue`** — the on-chain sensor registry into the database
 *    (`T076`), every few minutes. First, because every median the next step
 *    takes counts only the sensors this says are staked (`FR-050`); and until
 *    it has read the chain once in this process, no day is closed at all.
 * 1. **`closeDueDays`** — every day that is over and not yet on chain, for
 *    every cell. This is the only step that can produce a new day, and a new
 *    day is the only thing that can start or finish a policy's run.
 * 2. **`settleAfterDays`** — the cells that just got a day, paid if their run
 *    reached the threshold. First, because `SC-001` puts sixty seconds on this
 *    path and nothing else here has a deadline.
 * 3. **`closeAfterDays`** — the windows that just finished without the event.
 *    After settlement, because it releases capacity rather than money, and a
 *    window that finished on the same day it triggered is owed a payout, not a
 *    closure.
 * 4. **`sweepIfDue`** — readings and hourly medians past their retention
 *    (`T055`), once an hour. Last, because it has no deadline, and never newer
 *    than the oldest day step 1 could still close.
 *
 * **Nothing here decides anything.** Each dispatcher is a filter over calls
 * worth making; the program re-derives the run from its own day log and its
 * answer is the one that pays. A cycle that is wrong costs a rejected
 * transaction — never a wrong transfer, and never a withheld one (`FR-030`).
 *
 * **The clock comes from the pool, every cycle.** `genesis_ts`,
 * `seconds_per_day`, the dry threshold and the minimum number of votes are
 * fields of the on-chain `Pool`, so the worker cannot disagree with the program
 * about which day it is. A compressed run (`FR-049`) is a pool with
 * `seconds_per_day = 2` and needs no worker configuration at all.
 */

export type CycleDeps = {
  store: IntervalStore
  submitter: DaySubmitter
  policies: PolicySource
  pool: PoolSource
  /**
   * `FR-015`: must be `pool.aggregator`, and it signs the day record. Also the
   * payer for settlement and closure, which need no authority at all — one key
   * because there is one process, not because the roles are the same.
   */
  aggregator: PublicKey
  /** Not on chain: the program is handed a day, not the buckets it was cut in. */
  intervalsPerDay: number
  /** `FR-048`: hundredths of a day's intervals that must carry a value. */
  minimumCoverageX100: number
  backlogDays?: number
  programId?: PublicKey
  /** Absent in tests that are not about retention. */
  retention?: RetentionSweeper
  /**
   * Absent in tests that are not about the registry. Present in every real
   * cycle (`rpcCycle`): without it the registry is whatever the database last
   * held, and on a fresh one nothing votes.
   */
  registry?: RegistryMirror
}

/** Why a cycle did nothing, when it did nothing. */
export type CycleSkip =
  /** `initialize_pool` has not been called on this cluster yet. */
  | 'no-pool'
  /** The clock the pool publishes is not one a day can be counted on. */
  | 'unusable-clock'
  /**
   * The registry mirror has not read the chain in this process yet. A day
   * closed now would be a median over a registry of unknown age, written to
   * the chain for good (`registry.ts`).
   */
  | 'registry-unread'

export type CycleReport = {
  skipped: CycleSkip | null
  /**
   * Whether `pool.aggregator` is the key this worker signs with.
   *
   * False means every `submit_day_record` will be rejected, and the network
   * records nothing while looking like it is working. Cheap to check, and the
   * alternative is reading it out of a stream of failed transactions.
   */
  aggregatorMatches: boolean
  days: DayOutcome[]
  settled: SettleOutcome[]
  closed: CloseOutcome[]
  /** Null when no sweep was due this cycle. */
  swept: SweepOutcome | null
  /** Null when no read of the registry was due this cycle. */
  registry: MirrorOutcome | null
}

/** A fresh set of empty lists — never a shared one a caller could append to. */
function nothing(): Omit<CycleReport, 'skipped' | 'aggregatorMatches'> {
  return { days: [], settled: [], closed: [], swept: null, registry: null }
}

/** The pool's own clock, plus how finely this worker cuts a day. */
export function clockOf(pool: PoolAccount, intervalsPerDay: number): PoolClock {
  return {
    // `genesis_ts` is unix seconds in an `i64`; a `Date` is milliseconds.
    genesisTs: new Date(Number(pool.genesisTs.toString()) * 1000),
    secondsPerDay: pool.secondsPerDay,
    intervalsPerDay,
  }
}

/** The parameters aggregation reads, three of four of them published on chain. */
export function paramsOf(pool: PoolAccount, minimumCoverageX100: number): AggregationParams {
  return {
    kind: ReadingKind.PrecipitationMm,
    // `FR-010`: independent votes an interval needs to get a value at all.
    minimumVotes: pool.minSensorsPerCell,
    // `FR-047`: a day is dry when its hourly total does not exceed this.
    dryThresholdX100: pool.dryDayThresholdMmX100,
    minimumCoverageX100,
  }
}

export async function runCycle(deps: CycleDeps, now: Date): Promise<CycleReport> {
  const pool = await deps.pool.read()
  if (pool === null) {
    return { skipped: 'no-pool', aggregatorMatches: false, ...nothing() }
  }

  const aggregatorMatches = pool.aggregator.equals(deps.aggregator)
  const clock = clockOf(pool, deps.intervalsPerDay)
  if (pool.secondsPerDay < 1 || !Number.isFinite(clock.genesisTs.getTime())) {
    // Nothing to do about it here, and guessing would write days under an index
    // the program does not share.
    return { skipped: 'unusable-clock', aggregatorMatches, ...nothing() }
  }

  const registry = deps.registry === undefined ? null : await deps.registry.syncIfDue(now)
  if (deps.registry !== undefined && !deps.registry.synced) {
    return { skipped: 'registry-unread', aggregatorMatches, ...nothing(), registry }
  }

  const params = paramsOf(pool, deps.minimumCoverageX100)

  const days = await closeDueDays(
    {
      store: deps.store,
      submitter: deps.submitter,
      aggregator: deps.aggregator,
      clock,
      params,
      // `FR-050`: the pool publishes the minimum, like every other threshold.
      minStake: BigInt(pool.minStake.toString()),
      ...(deps.programId === undefined ? {} : { programId: deps.programId }),
    },
    now,
    deps.backlogDays,
  )

  const settle: SettleDeps = {
    store: deps.store,
    policies: deps.policies,
    submitter: deps.submitter,
    caller: deps.aggregator,
    assetMint: pool.assetMint,
    ...(deps.programId === undefined ? {} : { programId: deps.programId }),
  }
  const settled = await settleAfterDays(settle, days)

  const close: CloseDeps = {
    store: deps.store,
    policies: deps.policies,
    submitter: deps.submitter,
    caller: deps.aggregator,
    ...(deps.programId === undefined ? {} : { programId: deps.programId }),
  }
  const closed = await closeAfterDays(close, days)

  const swept =
    deps.retention === undefined
      ? null
      : await deps.retention.sweepIfDue(
          now,
          backlogHorizon(clock, now, deps.backlogDays ?? DEFAULT_BACKLOG_DAYS),
        )

  return { skipped: null, aggregatorMatches, days, settled, closed, swept, registry }
}

/** What a finished cycle is worth saying in one log line. */
export type CycleSummary = {
  submitted: number
  settled: number
  closed: number
  /** Days, settlements and closures the cluster refused. */
  failed: number
}

export function summarise(report: CycleReport): CycleSummary {
  return {
    submitted: report.days.filter((day) => day.status === 'submitted').length,
    settled: report.settled.filter((one) => one.status === 'settled').length,
    closed: report.closed.filter((one) => one.status === 'closed').length,
    failed:
      report.days.filter((day) => day.status === 'failed').length +
      report.settled.filter((one) => one.status === 'failed').length +
      report.closed.filter((one) => one.status === 'failed').length,
  }
}
