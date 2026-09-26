import type { CounterStore, IntervalStore, ReadingStore, RegistryStore } from '@pumpking/db'
import type { HealthWire as WorkerHealthWire } from '@pumpking/worker/health'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { apiError } from './errors.ts'
import { createCellsRoute } from './routes/cells.ts'
import { createPoliciesRoute, type PolicyLookup } from './routes/policies.ts'
import { createReadingsRoute } from './routes/readings.ts'
import { createScenarioRoute, routeReadingPublisher } from './routes/scenario.ts'

/**
 * The four routes, mounted — `T057`.
 *
 * Every one of them was written as a factory taking its dependencies, and this
 * is the only place that hands them real ones. That split is why the routes
 * have 60 tests between them and no database: the rules live in the routes, the
 * wiring lives here, and neither has to pretend to be the other.
 *
 * **`createApiApp` builds; it does not listen.** `index.ts` is the process —
 * environment, connections, signals. Here there is nothing a test cannot do,
 * which is what lets the mounting itself be tested: a route mounted at the
 * wrong prefix is a 404 in production and nothing at all in a unit test of the
 * route.
 *
 * **The scenario route gets its publisher from the readings route it is mounted
 * beside**, not from a URL. `routeReadingPublisher` calls the same Hono
 * instance in process, so a scenario reading is parsed, signature-checked and
 * counter-checked by exactly the code a device's reading meets — the run is not
 * a second door, it is the ordinary one used quickly (`FR-049`).
 */

export type ApiDeps = {
  readings: ReadingStore
  /** The day journal, for `/v1/cells` and for a policy's current run. */
  intervals: Pick<IntervalStore, 'dayRecords'>
  policies: PolicyLookup
  /** `FR-001`: on M1 only the scenario run writes it, and only its own cell. */
  registry: RegistryStore
  /** `T067`: where each sensor's counter stopped, so a second run resumes it. */
  counters: CounterStore
  /** `SCENARIO_MODE=on`. False and every scenario path answers 404. */
  scenarioMode: boolean
  /** `*` or the origins the interface is served from. */
  webOrigin?: string | string[]
  /**
   * `T056`: the loop's own health, when the loop turns in this process.
   *
   * Absent on a deployment where the worker is its own service and answers for
   * itself. Present on the free one, where there is a single port and the
   * aggregator would otherwise be invisible — and a cycle that has quietly
   * stopped looking exactly like a cycle with nothing to do is the failure this
   * project has kept finding.
   */
  worker?: () => WorkerHealthWire
  now?: () => Date
}

/** What `/health` says, and the only shape a platform probe depends on. */
export type HealthWire = {
  status: 'ok'
  uptimeSeconds: number
  /** `FR-039`, `FR-056`: whether this deployment can invent weather. */
  scenarioMode: boolean
  /** `T056`: the loop, when it turns here. Absent when it does not. */
  worker?: WorkerHealthWire
}

export function createApiApp(deps: ApiDeps): Hono {
  const now = deps.now ?? (() => new Date())
  const startedAt = now()

  const readings = createReadingsRoute({ store: deps.readings })

  const app = new Hono()

  app.use(
    '/v1/*',
    cors({
      origin: deps.webOrigin ?? '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type'],
    }),
  )

  /**
   * Liveness, and deliberately nothing else.
   *
   * It does not touch Postgres or the cluster. A platform restarts the
   * container when this fails, and a restart does not fix an unreachable
   * database — it only removes the one process that could still answer, and
   * still say why. Whether a dependency is reachable is a question the route
   * that needs it answers, in the error it returns, to the caller who asked.
   */
  app.get('/health', (context) => {
    const worker = deps.worker?.()
    const wire: HealthWire = {
      status: 'ok',
      uptimeSeconds: Math.floor((now().getTime() - startedAt.getTime()) / 1000),
      scenarioMode: deps.scenarioMode,
      // The status code stays 200 even when the loop is stalled. A probe that
      // failed here would have the platform restart the API — which also takes
      // down the routes that still work and the only voice able to say what
      // went wrong. The number of cycles is in the body, where whoever is
      // reading it can act on it.
      ...(worker === undefined ? {} : { worker }),
    }
    return context.json(wire, 200)
  })

  app.route('/v1/readings', readings)
  app.route('/v1/cells', createCellsRoute({ store: deps.intervals }))
  app.route('/v1/policies', createPoliciesRoute({ policies: deps.policies, store: deps.intervals }))
  app.route(
    '/v1/scenario',
    createScenarioRoute({
      enabled: deps.scenarioMode,
      registry: deps.registry,
      counters: deps.counters,
      publisher: routeReadingPublisher(readings),
      now,
    }),
  )

  // The same shape as every route's refusals (`errors.ts`, `T065`).
  app.notFound((context) => apiError(context, 404, 'not found'))

  /**
   * The last resort, and it says nothing.
   *
   * A route that throws has hit something it did not expect — a dropped
   * connection, a cluster timing out — and the message from inside is a query,
   * a host or a key. What the caller needs is that it was not their request;
   * what an operator needs is the log line, which the process writes.
   */
  app.onError((_error, context) => apiError(context, 500, 'internal error'))

  return app
}
