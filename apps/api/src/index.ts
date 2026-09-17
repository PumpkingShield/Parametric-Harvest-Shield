import { type ServerType, serve } from '@hono/node-server'
import { Connection } from '@pumpking/anchor-client'
import { createDb, pgIntervalStore, pgReadingStore, pgRegistryStore } from '@pumpking/db'
import { pino } from 'pino'
import { ConfigError, readApiConfig } from './config.ts'
import { rpcPolicyLookup } from './routes/policies.ts'
import { createApiApp } from './server.ts'

/**
 * The API process — `T057`.
 *
 * Everything above this file is a factory over injected dependencies, and this
 * is where the injecting happens: one environment, one database handle, one
 * cluster connection, one server. It contains no rules, and it should stay that
 * way — a decision made here is a decision no test can reach.
 *
 * **Started with `node --env-file-if-exists=../../.env src/index.ts`** (see
 * `package.json`). Node runs the TypeScript directly; there is no build step
 * between this file and the process.
 */

const config = (() => {
  try {
    return readApiConfig(process.env)
  } catch (cause) {
    // Before the logger, because the logger's level comes from the config that
    // just failed. A process that cannot read its environment has exactly one
    // useful thing to say, and it says it on stderr.
    process.stderr.write(`${cause instanceof ConfigError ? cause.message : String(cause)}\n`)
    process.exit(1)
  }
})()

const log = pino({ level: config.logLevel, name: 'api' })

const database = createDb(config.databaseUrl)
const connection = new Connection(config.rpcUrl, 'confirmed')

const app = createApiApp({
  readings: pgReadingStore(database.db),
  intervals: pgIntervalStore(database.db),
  policies: rpcPolicyLookup(connection, config.programId),
  registry: pgRegistryStore(database.db),
  scenarioMode: config.scenarioMode,
  webOrigin: config.webOrigin,
})

const server: ServerType = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info(
    {
      port: info.port,
      programId: config.programId.toBase58(),
      scenarioMode: config.scenarioMode,
    },
    // Said out loud at startup because a deployment that can invent weather and
    // does not know it is the one failure `FR-039` cannot be checked for later.
    config.scenarioMode ? 'listening — SCENARIO MODE IS ON' : 'listening',
  )
})

/* -------------------------------------------------------------------------- */
/* Shutting down                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Stop listening, let the requests that are already in flight finish, close
 * the pool, leave.
 *
 * The deadline is not a formality: a platform sends `SIGTERM` and then `SIGKILL`
 * a short while later, and a process that has not closed its Postgres pool by
 * then leaves connections the pooler holds until they time out — on a free tier
 * that is the next deploy failing to connect.
 *
 * **A scenario run in flight is not waited for.** Its readings are durable one
 * at a time (`POST /v1/readings` stores each before answering), so an
 * interrupted run is a cell whose journal stops where the run stopped, which is
 * exactly what it is. Holding a deploy open for the rest of a compressed month
 * to make a demo look tidy would be the wrong trade.
 */
let stopping = false

async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    // A second signal is an operator saying the first one is taking too long.
    log.warn({ signal }, 'second signal, exiting now')
    process.exit(1)
  }
  stopping = true
  log.info({ signal }, 'shutting down')

  const deadline = setTimeout(() => {
    log.error({ timeoutMs: config.shutdownTimeoutMs }, 'shutdown deadline passed, exiting anyway')
    process.exit(1)
  }, config.shutdownTimeoutMs)
  // Node keeps running while a timer is pending; this one must not be the
  // reason a process that is otherwise finished stays alive.
  deadline.unref()

  await new Promise<void>((resolve) => {
    server.close((error) => {
      if (error) log.error({ err: error }, 'the server did not close cleanly')
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
