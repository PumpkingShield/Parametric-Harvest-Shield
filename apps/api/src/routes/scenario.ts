import {
  type CounterStore,
  type RegistryStore,
  type SensorProblem,
  votingProblems,
} from '@pumpking/db'
import {
  cellIdFromH3Index,
  type Reading,
  type SignedReading,
  toSignedReadingWire,
} from '@pumpking/shared'
import {
  compression,
  estimateSigningMs,
  playScenario,
  readScenario,
  type Scenario,
  type ScenarioSensor,
  scenarioDuration,
  scenarioReadings,
  scenarioSensors,
  scenarioStart,
  signScenarioReadings,
} from '@pumpking/worker/scenario'
import { Hono } from 'hono'
import { z } from 'zod'
import { apiError, fieldErrors } from '../errors.ts'

/**
 * `POST /v1/scenario/run` — the button the M1 demo is driven from, and it only
 * exists when `SCENARIO_MODE=on` (`FR-042`, `FR-049`).
 *
 * **It starts a run; it is not a second way into the system.** Everything it
 * produces is a signed reading that goes through `POST /v1/readings` like any
 * device's. The aggregator takes the same median, the program checks the same
 * threshold, the money moves the same way. What a scenario changes is the
 * *step of the clock* and nothing else — `FR-049` — which is why `compression`
 * travels in every answer this route gives: a demo that does not say a day
 * lasted two seconds is claiming a drought payout arrives ninety seconds after
 * the drought, and the product makes no such claim.
 *
 * **`synthetic` is in the answer for the same reason** (`FR-039`, `FR-056`).
 * The scenario file cannot load without declaring itself invented; the flag is
 * carried out to the screen so the badge has something behind it that a
 * forgotten prop cannot switch off.
 *
 * **Off means gone, not forbidden.** With `enabled: false` every path here
 * answers 404. A `403` would tell an anonymous caller that a button which
 * invents the weather exists on this deployment, and in production it must
 * not exist at all. The factory refuses on its own rather than trusting the
 * wiring to leave it unmounted.
 *
 * **The run's network is registered on chain, and the run checks it** —
 * `FR-001`, `FR-050`, `T077`. On M1 this route wrote the fixture's sensors
 * into the registry itself; since `T076` such rows carry no vote, so the show
 * goes the way a real network does instead. Its operators register and stake
 * the sensors with `register_sensor` and `stake_sensor`
 * (`scripts/devnet-register.mjs`, once per deployment), the worker's mirror
 * copies them in, and this route refuses to start — 409, naming each sensor
 * and why — until every one of them votes in the scenario's cell. Starting
 * anyway would publish a drought the median never sees, and the show would
 * end in days without coverage rather than in a payout.
 */

/* -------------------------------------------------------------------------- */
/* Publishing what the run produces                                           */
/* -------------------------------------------------------------------------- */

/** What `POST /v1/readings` answered for one reading. */
export type PublishResult = { ok: boolean; status: number }

export interface ReadingPublisher {
  /** Publishes one signed reading the way a device does — through the door. */
  publish(reading: SignedReading): Promise<PublishResult>
}

/**
 * The publisher that goes through a mounted readings route, in process.
 *
 * In process rather than over a socket because the run and the intake are the
 * same server: a loopback request would add a listener, a port and a timeout
 * to a path whose whole point is that it is the ordinary one. The reading is
 * still rendered to wire JSON and still parsed, signature-checked and
 * counter-checked by the route, so nothing about the check is skipped.
 */
export function routeReadingPublisher(readings: Hono): ReadingPublisher {
  return {
    async publish(reading) {
      const response = await readings.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toSignedReadingWire(reading)),
      })
      return { ok: response.ok, status: response.status }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

export type RunStatus = 'running' | 'done' | 'failed'

/** A run as the wire carries it — everything the demo screen has to show. */
export type RunWire = {
  run: string
  scenario: string
  /** `FR-039`: always true, and always sent. A run cannot be anything else. */
  synthetic: true
  note: string
  /** `FR-049`: how much faster than the sky this run moves. 43200 at 2s a day. */
  compression: number
  /** Wall-clock seconds the run takes end to end. `SC-011` allows 90. */
  durationSeconds: number
  days: number
  /** What the fixture says the longest dry run in it is. */
  expectedSpell: number
  /** H3 index in hex — the argument `/v1/cells/:cellId/days` takes. */
  cellId: string
  genesisTs: string
  /**
   * The day boundary the run is anchored to — the instant its first reading is
   * due, which is at or after the request (`T067`).
   */
  startedAt: string
  /**
   * The pool day this run's day zero landed on — `T067`.
   *
   * Zero for the first run against a pool. A later run continues where the
   * network left off, and the number is how a demo says which chapter it is
   * playing: the policy bought during the first run has its window inside the
   * second, and the days on the screen are these.
   */
  firstDay: number
  finishedAt: string | null
  status: RunStatus
  /** Readings the scenario produced in total. */
  total: number
  /** Readings the intake accepted. */
  published: number
  /**
   * Readings the intake refused.
   *
   * Not folded into a failure: a refusal is the door working, and a run that
   * hits one has something to say about the network rather than about itself.
   * A demo where this is not zero is a demo to stop and look at.
   */
  refused: number
  error: string | null
}

type Run = RunWire

/* -------------------------------------------------------------------------- */
/* The request                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What each `SensorProblem` means to whoever runs the show, and what fixes it.
 * The mirror lags the chain by up to `REGISTRY_SYNC_MS`, and on the demo the
 * worker is off between shows — a sensor registered a minute ago reads as
 * unregistered here until the loop has turned once.
 */
const ISSUE_MESSAGES: Record<SensorProblem, string> = {
  unregistered:
    'not in the mirrored registry — run scripts/devnet-register.mjs, and let the worker turn once',
  'wrong-cell': 'registered on chain in a different cell than the scenario names',
  excluded: 'excluded on chain for systematic outliers (FR-012)',
  understaked: 'staked below pool.min_stake (FR-050) — run scripts/devnet-register.mjs',
}

/** A scenario name is a file name, so it is a name and not a path. */
const SCENARIO_NAME = /^[a-z][a-z0-9-]*$/

const runRequestSchema = z.strictObject({
  scenario: z.string().regex(SCENARIO_NAME, 'must be a scenario name, lowercase and dashes'),
  /**
   * Genesis of the pool the run is anchored to. Defaults to the instant the
   * run starts, which is what keeps every reading's arrival age near zero:
   * compressed time moves the measurement and the publication together, so
   * `FR-004`'s staleness window never fires on a run that is merely fast.
   */
  genesisTs: z.iso.datetime({ offset: true }).optional(),
})

export type ScenarioRouteOptions = {
  /** `SCENARIO_MODE=on`. False makes every path here answer 404. */
  enabled: boolean
  /** Read, never written: whether the scenario's sensors vote (`votingProblems`). */
  registry: RegistryStore
  /**
   * `pool.min_stake`, read from the chain when a run is asked for; null when
   * the pool does not exist yet. The same number the aggregator filters on.
   */
  minStake: () => Promise<bigint | null>
  publisher: ReadingPublisher
  /** `T067`: where each sensor's counter stopped, so a later run resumes it. */
  counters: CounterStore
  /** Injected so a test plays a two-day scenario instead of reading a fixture. */
  load?: (name: string) => Scenario
  now?: () => Date
  /** Injected so a test plays a 58-second run without waiting 58 seconds. */
  sleep?: (ms: number) => Promise<void>
  /**
   * What signing this run will cost, in milliseconds — injected so a test can
   * state a cost instead of racing the machine it runs on (`T069`).
   */
  signingCost?: (
    readings: readonly Reading[],
    sensors: readonly ScenarioSensor[],
  ) => Promise<number>
  /** Injected so a test can name the run instead of guessing its id. */
  newRunId?: () => string
}

/**
 * How many finished runs are remembered.
 *
 * A show is a handful of runs and the screen only ever asks about the one it
 * started, so this exists to stop a long-lived process from growing rather
 * than to serve history — the history of a run is the days it recorded, and
 * those are in `cell_days` forever.
 */
export const REMEMBERED_RUNS = 16

export function createScenarioRoute(options: ScenarioRouteOptions): Hono {
  const load = options.load ?? readScenario
  const signingCost = options.signingCost ?? estimateSigningMs
  const now = options.now ?? (() => new Date())
  const newRunId = options.newRunId ?? (() => crypto.randomUUID())

  const runs = new Map<string, Run>()
  let active: string | null = null

  const app = new Hono()

  if (!options.enabled) {
    // Every path, including the status one: with the mode off there is nothing
    // here to have an opinion about.
    return app.all('/*', (context) => apiError(context, 404, 'not found'))
  }

  function remember(run: Run): void {
    runs.set(run.run, run)
    while (runs.size > REMEMBERED_RUNS) {
      const [oldest] = runs.keys()
      if (oldest === undefined) break
      runs.delete(oldest)
    }
  }

  /** Plays the run to its end, in the background, and records what happened. */
  async function play(
    run: Run,
    readings: readonly SignedReading[],
    genesisTs: Date,
    startedAt: Date,
  ): Promise<void> {
    try {
      await playScenario(
        readings,
        {
          publish: async (reading) => {
            const result = await options.publisher.publish(reading)
            if (result.ok) run.published += 1
            else run.refused += 1
          },
        },
        { genesisTs, startedAt, now, ...(options.sleep ? { sleep: options.sleep } : {}) },
      )
      run.status = 'done'
    } catch (cause) {
      run.status = 'failed'
      run.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      run.finishedAt = now().toISOString()
      if (active === run.run) active = null
    }
  }

  return app
    .post('/run', async (context) => {
      let body: unknown
      try {
        body = await context.req.json()
      } catch {
        return apiError(context, 400, 'body must be JSON')
      }

      const parsed = runRequestSchema.safeParse(body)
      if (!parsed.success) {
        return apiError(context, 400, 'invalid run', {
          fields: fieldErrors(parsed.error, '(body)'),
        })
      }
      const request = parsed.data

      // One run at a time. A run reads the sensors' counters and the clock
      // once, at the start, and everything it will publish follows from that
      // reading (`T067`). A second run beginning before the first has finished
      // would read the same two numbers and produce the same counters over the
      // same days — the collision resuming was meant to end, back again and
      // harder to see. A demo that half works is worse than one that says it
      // is busy.
      if (active !== null) {
        return apiError(context, 409, 'a scenario run is already in flight', { run: active })
      }

      let scenario: Scenario
      try {
        scenario = load(request.scenario)
      } catch (cause) {
        return apiError(context, 404, 'no such scenario', {
          fields: [
            { field: 'scenario', message: cause instanceof Error ? cause.message : String(cause) },
          ],
        })
      }

      const requestedAt = now()
      const genesisTs = request.genesisTs === undefined ? requestedAt : new Date(request.genesisTs)
      const cellId = cellIdFromH3Index(scenario.cell)
      const sensors: ScenarioSensor[] = await scenarioSensors(scenario)

      const minStake = await options.minStake()
      if (minStake === null) {
        return apiError(context, 409, 'there is no pool on this cluster yet', {
          fields: [{ field: 'scenario', message: 'initialize_pool has not been called' }],
        })
      }
      const issues = votingProblems(
        sensors.map((sensor) => ({ pubkey: sensor.pubkey, cellId })),
        await options.registry.rowsOf(sensors.map((sensor) => sensor.pubkey)),
        minStake,
      )
      if (issues.length > 0) {
        return apiError(context, 409, 'not every sensor of the scenario votes', {
          fields: issues.map((issue) => ({
            field: `sensors.${issue.pubkey}`,
            message: ISSUE_MESSAGES[issue.problem],
          })),
        })
      }

      // Read before anything is published, because from here on this run is
      // the only writer.
      const counters = await options.counters.lastCounters(sensors.map((sensor) => sensor.pubkey))

      // Where in the pool's life this run goes. On the first run the genesis is
      // now and this is day zero; on a later one it is the next boundary, so no
      // day is written twice and none is skipped.
      //
      // Chosen for the moment the run will be **ready**, not for the moment
      // the request arrived (`T069`). Signing the readings is the work between
      // the two, it cannot happen before the offset is known — a signature
      // commits to the instant it was taken at — and on the deployment it took
      // nine seconds, which at two seconds a day is four and a half days of a
      // schedule that had already started running. The days go by whether or
      // not their readings have been signed yet, and the aggregator closes
      // them either way.
      const readyAt = new Date(
        now().getTime() +
          (await signingCost(
            scenarioReadings(scenario, genesisTs, sensors, { dayOffset: 0, counters }),
            sensors,
          )),
      )
      const { dayOffset, startsAt } = scenarioStart(scenario, genesisTs, requestedAt, readyAt)
      const signed = await signScenarioReadings(
        scenarioReadings(scenario, genesisTs, sensors, { dayOffset, counters }),
        sensors,
      )

      const run: Run = {
        run: newRunId(),
        scenario: scenario.name,
        synthetic: true,
        note: scenario.note,
        compression: compression(scenario),
        durationSeconds: scenarioDuration(scenario),
        days: scenario.expected.days,
        expectedSpell: scenario.expected.longestDrySpell,
        cellId: scenario.cell,
        genesisTs: genesisTs.toISOString(),
        startedAt: startsAt.toISOString(),
        firstDay: dayOffset,
        finishedAt: null,
        status: 'running',
        total: signed.length,
        published: 0,
        refused: 0,
        error: null,
      }
      active = run.run
      remember(run)

      // Deliberately not awaited: the run lasts as long as the compressed
      // clock says, and a request held open for a minute is a demo button that
      // looks broken. `GET /v1/scenario/run/:id` is how it is watched.
      //
      // The anchor is the genesis, not `startsAt`, and the difference is a bug
      // this cost a devnet run to find. `playScenario` publishes a reading at
      // `anchor + (measuredAt - genesisTs)`; `dayOffset` is already inside
      // `measuredAt`, so anchoring at `startsAt` would add it a second time and
      // the chapter would wait a whole offset past its own boundary — 64
      // seconds at 32 days and two seconds a day, by which point the aggregator
      // has closed those days empty. Anchoring at the genesis makes the due
      // instant the measured instant, which is what a run on the pool's own
      // clock means.
      void play(run, signed, genesisTs, genesisTs)

      return context.json(run, 202)
    })
    .get('/run/:id', (context) => {
      const run = runs.get(context.req.param('id'))
      if (run === undefined) {
        return apiError(context, 404, 'no such run')
      }
      return context.json(run, 200)
    })
}
