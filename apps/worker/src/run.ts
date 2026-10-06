import { Connection } from '@pumpking/anchor-client'
import type {
  CellSlotStore,
  IntervalStore,
  RegistryMirrorStore,
  RewardMirrorStore,
  RetentionStore,
} from '@pumpking/db'
import type { Logger } from 'pino'
import { rpcDaySubmitter, rpcPoolSource } from './chain.ts'
import { rpcExclusionSource } from './exclude.ts'
import type { WorkerConfig } from './config.ts'
import { type CycleDeps, type CycleReport, runCycle, summarise } from './cycle.ts'
import { stalledAfterMs, type WorkerHealthState } from './health.ts'
import { registryMirror, rpcRegistrySource } from './registry.ts'
import { retentionSweeper } from './retention.ts'
import { rewardMirror, rpcDayRewardSource } from './rewards.ts'
import { rpcPolicySource } from './settle.ts'

/**
 * The loop, without the process — `T056`.
 *
 * This used to be `index.ts`, and it moved for one reason: Render's free plan
 * has no background worker, so on the deployment that M1 is shown from the loop
 * has to turn inside the API process. What starts it is now a function, and
 * both entry points call it — `apps/worker/src/index.ts` for the two-process
 * local run, `apps/api/src/index.ts` when `RUN_WORKER=on`.
 *
 * **The database is not owned here.** `stop()` stops scheduling and waits for
 * the cycle in flight; closing the pool is the caller's, because inside the API
 * the pool is the API's and closing it would cut the requests still finishing.
 *
 * **Cycles do not overlap.** The next one is scheduled after the current one
 * finishes rather than on a fixed interval: a cycle that closes a backlog of
 * days can outlast its own period, and two at once would race to write the same
 * day, each seeing a row the other had not signed yet.
 *
 * **A cycle that throws is logged and the loop continues.** The dispatchers
 * already keep one cell's failure from costing another its day; what reaches
 * here is the layer below them — the database, the cluster — and the answer to
 * that is to try again in a few seconds, not to exit and let a platform decide
 * how long to wait before restarting. What a long run of failures looks like
 * from outside is `/health`.
 */

/** One turn of the loop. Injected so the loop is testable without a cluster. */
export type CycleRunner = (now: Date) => Promise<CycleReport>

export type StartWorkerOptions = {
  config: WorkerConfig
  log: Logger
  cycle: CycleRunner
  now?: () => Date
  /** Injected so the keep-alive ping is testable without a server. */
  fetch?: typeof fetch
}

export type WorkerRuntime = {
  /** Live, and read by whoever answers `/health` for this process. */
  readonly state: WorkerHealthState
  /** How long without a finished cycle counts as stalled. */
  readonly stalledMs: number
  /** Stop scheduling, wait for the cycle in flight. Leaves the database open. */
  stop(): Promise<void>
}

/**
 * The real cycle: RPC connection, on-chain sources, the interval store.
 *
 * Built here rather than in each entry point so the two processes cannot drift
 * into disagreeing about what the worker does — they differ in where they get a
 * database handle, and in nothing else.
 */
export function rpcCycle(
  config: WorkerConfig,
  store: IntervalStore,
  retention: RetentionStore,
  registry: RegistryMirrorStore,
  slots: CellSlotStore,
  rewards: RewardMirrorStore,
): CycleRunner {
  const connection = new Connection(config.rpcUrl, 'confirmed')

  const deps: CycleDeps = {
    store,
    submitter: rpcDaySubmitter({ connection, aggregator: config.aggregator }),
    policies: rpcPolicySource(connection, config.programId),
    pool: rpcPoolSource(connection, config.programId),
    aggregator: config.aggregator.publicKey,
    intervalsPerDay: config.intervalsPerDay,
    minimumCoverageX100: config.minimumCoverageX100,
    backlogDays: config.backlogDays,
    programId: config.programId,
    retention: retentionSweeper(retention),
    registry: registryMirror(
      rpcRegistrySource(connection, config.programId),
      registry,
      config.registrySyncMs,
    ),
    exclusion: { slots, chain: rpcExclusionSource(connection, config.programId) },
    rewards: rewardMirror({
      store: rewards,
      source: rpcDayRewardSource(connection, config.programId),
      slots,
    }),
  }

  return (now) => runCycle(deps, now)
}

export function startWorker(options: StartWorkerOptions): WorkerRuntime {
  const { config, log } = options
  const now = options.now ?? (() => new Date())
  const call = options.fetch ?? fetch

  const state: WorkerHealthState = {
    startedAt: now(),
    lastCycleAt: null,
    lastCycle: null,
    lastSkipped: null,
    lastError: null,
    cycles: 0,
  }

  let stopping = false
  let running: Promise<void> | null = null
  let timer: NodeJS.Timeout | null = null

  /**
   * A ping at the API's `/health`, so a free tier does not idle it to sleep.
   *
   * Failures are logged at debug and nothing else: the worker's own work does
   * not depend on the API being up, and a keep-alive that can stop a cycle
   * would be worse than no keep-alive. Empty unless somebody names a URL — and
   * on the single-service deployment nobody does, because a process pinging
   * itself proves nothing about whether it is awake. There the pinger is a
   * scheduled GitHub Action, outside both.
   */
  async function keepAlive(url: string): Promise<void> {
    try {
      const response = await call(url, { method: 'GET' })
      log.debug({ url, status: response.status }, 'keep-alive')
    } catch (cause) {
      log.debug({ url, err: cause }, 'keep-alive failed')
    }
  }

  async function turn(): Promise<void> {
    try {
      const report = await options.cycle(now())

      if (report.registry?.status === 'failed') {
        log.warn({ err: report.registry.error }, 'the registry read failed, trying again shortly')
      } else if (report.registry?.status === 'mirrored') {
        const { onChain, written, missing } = report.registry
        if (missing.length > 0) {
          // The program closes no `Sensor` account, so a mirrored sensor the
          // scan did not return is a short answer or a changed program. Left
          // voting; said loudly.
          log.warn({ onChain, written, missing }, 'mirrored sensors missing from the chain')
        } else if (written > 0) log.info({ onChain, written }, 'registry mirrored')
        else log.debug({ onChain, written }, 'registry mirrored')
      }

      if (report.skipped !== null) {
        // Once, and again when the reason changes. A worker started before
        // `initialize_pool` would otherwise write the same line every few
        // seconds until somebody deploys the pool, and a log nobody can read is
        // a log nobody reads.
        if (report.skipped === state.lastSkipped)
          log.debug({ skipped: report.skipped }, 'nothing to do')
        else log.info({ skipped: report.skipped }, 'nothing to do')
      } else {
        const summary = summarise(report)
        const line = { ...summary, aggregatorMatches: report.aggregatorMatches }
        if (summary.failed > 0) log.warn(line, 'cycle finished with failures')
        else if (summary.submitted + summary.settled + summary.closed + summary.excluded > 0) log.info(line, 'cycle')
        else log.debug(line, 'cycle')

        for (const read of report.rewards ?? []) {
          // Nothing waits on the history, and an unread day is read again
          // later; a failure is worth a line, a missing transaction a debug one.
          const at = { cellId: read.cellId.toString(), dayIndex: read.dayIndex }
          if (read.status === 'failed') {
            log.warn({ ...at, err: read.error }, 'reading the day’s rewards failed')
          } else if (read.status === 'missing') {
            log.debug(at, 'the day’s transaction is not on the cluster yet')
          } else log.debug({ ...at, slots: read.slots }, 'day rewards read')
        }

        if (report.swept?.status === 'failed') {
          log.warn({ err: report.swept.error }, 'the retention sweep failed, next try in an hour')
        } else if (report.swept?.status === 'swept') {
          const { readings, cellHours, verdicts } = report.swept
          const line = { readings, cellHours, verdicts }
          if (readings + cellHours + verdicts > 0) log.info(line, 'retention sweep')
          else log.debug(line, 'retention sweep')
        }

        if (!report.aggregatorMatches) {
          // Every `submit_day_record` this worker sends will be rejected, and
          // the network will look like it is running while recording nothing.
          log.error(
            { aggregator: config.aggregator.publicKey.toBase58() },
            'this key is not pool.aggregator — no day record will be accepted',
          )
        }
      }

      state.lastCycle = report.skipped === null ? summarise(report) : null
      state.lastSkipped = report.skipped
      state.lastError = null
    } catch (cause) {
      state.lastError = cause instanceof Error ? cause.message : String(cause)
      log.error({ err: cause }, 'the cycle failed')
    } finally {
      state.lastCycleAt = now()
      state.cycles += 1
    }

    if (config.keepAliveUrl !== null) await keepAlive(config.keepAliveUrl)
  }

  function schedule(): void {
    if (stopping) return
    timer = setTimeout(() => {
      running = turn().finally(() => {
        running = null
        schedule()
      })
    }, config.cycleIntervalMs)
  }

  // The first cycle runs now rather than after a period: a deploy that has just
  // replaced the process should not leave a day unwritten for the length of a
  // tick.
  running = turn().finally(() => {
    running = null
    schedule()
  })

  return {
    state,
    stalledMs: stalledAfterMs(config.cycleIntervalMs),
    async stop(): Promise<void> {
      if (stopping) return
      stopping = true
      if (timer !== null) clearTimeout(timer)

      // Waited for rather than cut off because of where a cycle can be
      // interrupted: `closeCellDay` writes the `cell_days` row, sends the
      // transaction, then stores the signature. Killed between the second and
      // the third, the day is on chain with no local record of the signature —
      // the row is there and unsigned, the next run tries to submit it again,
      // and the program refuses a day it already has. Recoverable, but by hand.
      if (running !== null) {
        log.info('waiting for the cycle in flight')
        await running
      }
    },
  }
}
