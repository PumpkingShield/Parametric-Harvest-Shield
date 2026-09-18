import { createDb, pgIntervalStore } from '@pumpking/db'
import { pino } from 'pino'
import { ConfigError, readWorkerConfig } from './config.ts'
import { createHealthServer } from './health.ts'
import { rpcCycle, startWorker } from './run.ts'

/**
 * The worker as its own process — `T057`, thinned out by `T056`.
 *
 * The loop itself lives in `run.ts`, because on the free deployment it turns
 * inside the API instead (`RUN_WORKER=on`). What is left here is what only a
 * process has: the environment, the database handle, its own health port, and
 * the signals.
 *
 * **Its own port is why this file still exists.** A worker has no requests, so
 * a loop that quietly stopped looks exactly like a loop with nothing to do; run
 * as a service of its own, it answers that question itself. Inside the API the
 * same state goes out on the API's `/health`, because one service has one port.
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

const worker = startWorker({
  config,
  log,
  cycle: rpcCycle(config, pgIntervalStore(database.db)),
})

const health = createHealthServer({
  state: () => worker.state,
  stalledMs: worker.stalledMs,
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

/* -------------------------------------------------------------------------- */
/* Shutting down                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Stop the loop, stop answering, close the pool, leave.
 *
 * The deadline is the platform's `SIGKILL` arriving first, which is worse than
 * an unfinished cycle.
 */
let stopping = false

async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    log.warn({ signal }, 'second signal, exiting now')
    process.exit(1)
  }
  stopping = true
  log.info({ signal }, 'shutting down')

  const deadline = setTimeout(() => {
    log.error({ timeoutMs: config.shutdownTimeoutMs }, 'shutdown deadline passed, exiting anyway')
    process.exit(1)
  }, config.shutdownTimeoutMs)
  deadline.unref()

  await worker.stop()

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
