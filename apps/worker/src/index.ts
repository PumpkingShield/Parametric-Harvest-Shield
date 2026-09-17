import { Connection } from '@pumpking/anchor-client'
import { createDb, pgIntervalStore } from '@pumpking/db'
import { pino } from 'pino'
import { rpcDaySubmitter, rpcPoolSource } from './chain.ts'
import { ConfigError, readWorkerConfig } from './config.ts'
import { type CycleDeps, runCycle, summarise } from './cycle.ts'
import { createHealthServer, stalledAfterMs, type WorkerHealthState } from './health.ts'
import { rpcPolicySource } from './settle.ts'

/**
 * The worker process — `T057`.
 *
 * One loop, three dispatchers, in the order `cycle.ts` writes down. Everything
 * this file adds to that is the part a test cannot have: the environment, the
 * connections, the timer, the signals.
 *
 * **Cycles do not overlap.** The next one is scheduled after the current one
 * finishes rather than on a fixed interval, because a cycle that closes a
 * backlog of days can outlast its own period — and two of them at once would
 * race to write the same day, each seeing a row the other had not signed yet.
 *
 * **A cycle that throws is logged and the loop continues.** The dispatchers
 * already keep one cell's failure from costing another its day; what reaches
 * here is the layer below them — the database, the cluster — and the answer to
 * that is to try again in a few seconds, not to exit and let a platform decide
 * how long to wait before restarting. What a long run of failures looks like
 * from outside is `/health`.
 */

const config = (() => {
  try {
    return readWorkerConfig(process.env)
  } catch (cause) {
    process.stderr.write(`${cause instanceof ConfigError ? cause.message : String(cause)}\n`)
    process.exit(1)
  }
})()

const log = pino({ level: config.logLevel, name: 'worker' })

const database = createDb(config.databaseUrl)
const connection = new Connection(config.rpcUrl, 'confirmed')

const deps: CycleDeps = {
  store: pgIntervalStore(database.db),
  submitter: rpcDaySubmitter({ connection, aggregator: config.aggregator }),
  policies: rpcPolicySource(connection, config.programId),
  pool: rpcPoolSource(connection, config.programId),
  aggregator: config.aggregator.publicKey,
  intervalsPerDay: config.intervalsPerDay,
  minimumCoverageX100: config.minimumCoverageX100,
  backlogDays: config.backlogDays,
  programId: config.programId,
}

const state: WorkerHealthState = {
  startedAt: new Date(),
  lastCycleAt: null,
  lastCycle: null,
  lastSkipped: null,
  lastError: null,
  cycles: 0,
}

/* -------------------------------------------------------------------------- */
/* Keeping the API awake                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A ping at the API's `/health`, so a free tier does not idle it to sleep.
 *
 * Failures are logged at debug and nothing else: the worker's own work does not
 * depend on the API being up, and a keep-alive that can stop a cycle would be
 * worse than no keep-alive. It points at the other service on purpose — a
 * process pinging itself proves nothing about whether it is awake.
 */
async function keepAlive(url: string): Promise<void> {
  try {
    const response = await fetch(url, { method: 'GET' })
    log.debug({ url, status: response.status }, 'keep-alive')
  } catch (cause) {
    log.debug({ url, err: cause }, 'keep-alive failed')
  }
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

let stopping = false
let running: Promise<void> | null = null
let timer: NodeJS.Timeout | null = null

async function cycle(): Promise<void> {
  try {
    const report = await runCycle(deps, new Date())

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
      else if (summary.submitted + summary.settled + summary.closed > 0) log.info(line, 'cycle')
      else log.debug(line, 'cycle')

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
    state.lastCycleAt = new Date()
    state.cycles += 1
  }

  if (config.keepAliveUrl !== null) await keepAlive(config.keepAliveUrl)
}

function schedule(): void {
  if (stopping) return
  timer = setTimeout(() => {
    running = cycle().finally(() => {
      running = null
      schedule()
    })
  }, config.cycleIntervalMs)
}

const health = createHealthServer({
  state: () => state,
  stalledMs: stalledAfterMs(config.cycleIntervalMs),
})

health.listen(config.port, () => {
  log.info(
    {
      port: config.port,
      cycleIntervalMs: config.cycleIntervalMs,
      intervalsPerDay: config.intervalsPerDay,
      minimumCoverageX100: config.minimumCoverageX100,
      backlogDays: config.backlogDays,
      aggregator: config.aggregator.publicKey.toBase58(),
      programId: config.programId.toBase58(),
    },
    'worker started',
  )
})

// The first cycle runs now rather than after a period: a deploy that has just
// replaced a worker should not leave a day unwritten for the length of a tick.
running = cycle().finally(() => {
  running = null
  schedule()
})

/* -------------------------------------------------------------------------- */
/* Shutting down                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Stop scheduling, let the cycle in flight finish, close the pool, leave.
 *
 * The cycle is waited for rather than cut off because of where it can be
 * interrupted: `closeCellDay` writes the `cell_days` row, sends the
 * transaction, then stores the signature. Killed between the second and the
 * third, the day is on chain with no local record of the signature — the row is
 * there and unsigned, so the next run tries to submit it again and the program
 * refuses a day it already has. Recoverable, but by hand.
 *
 * The deadline is the platform's `SIGKILL` arriving first, which is worse.
 */
async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    log.warn({ signal }, 'second signal, exiting now')
    process.exit(1)
  }
  stopping = true
  log.info({ signal }, 'shutting down')

  if (timer !== null) clearTimeout(timer)

  const deadline = setTimeout(() => {
    log.error({ timeoutMs: config.shutdownTimeoutMs }, 'shutdown deadline passed, exiting anyway')
    process.exit(1)
  }, config.shutdownTimeoutMs)
  deadline.unref()

  if (running !== null) {
    log.info('waiting for the cycle in flight')
    await running
  }

  await new Promise<void>((resolve) => {
    health.close(() => {
      resolve()
    })
  })

  try {
    await database.close()
  } catch (cause) {
    log.error({ err: cause }, 'the database pool did not close cleanly')
  }

  clearTimeout(deadline)
  log.info('stopped')
  process.exit(0)
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
  })
}
