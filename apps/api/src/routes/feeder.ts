import { createHash, timingSafeEqual } from 'node:crypto'
import type { CounterStore, RegistryStore } from '@pumpking/db'
import {
  dueHours,
  type FeederSensor,
  feederCellSetups,
  feederReadings,
  feederSensors,
  HOUR_MS,
  lastFullHour,
} from '@pumpking/worker/feeder'
import { Hono } from 'hono'
import { apiError } from '../errors.ts'
import { DEFAULT_MAX_AGE_MS } from './readings.ts'
import type { ReadingPublisher } from './scenario.ts'

/**
 * `POST /v1/feeder/tick` — the hundred sensors of the `SC-008` run, woken from
 * outside (`T058`).
 *
 * An external scheduler (cron-job.org) calls this every few minutes; each call
 * publishes the hours the network has not reached yet, through the same
 * readings route a device uses, and returns. The call is also what keeps a
 * free Render service awake, the way a real network's traffic would. How the
 * readings are made, and why a tick needs no memory, is in
 * `apps/worker/src/feeder.ts`.
 *
 * **Absent unless configured.** Without `FEEDER_TOKEN` every path answers 404,
 * like the scenario route with `SCENARIO_MODE=off`: a deployment that is not
 * running the load test does not admit it has a button for one. With it, the
 * caller must present the token — this door writes readings, and an anonymous
 * caller has no business deciding when a hundred sensors speak. It is its own
 * switch and not `SCENARIO_MODE`, which would also open the route that invents
 * a drought.
 *
 * **One tick at a time.** A tick that outlasts the scheduler's timeout is still
 * running when the next one arrives; the second answers 409 at once instead of
 * racing the first over the same counters. Racing would not corrupt anything —
 * intake is the arbiter and a duplicate is a retry — but it would double the
 * traffic this run exists to measure.
 */

export type FeederTickWire = {
  /** `FR-039`: the weather these sensors report is invented. */
  synthetic: true
  hours: number[]
  sent: number
  /** 201: stored now. */
  stored: number
  /** 200: intake already had it — a tick that ran twice, or a restart. */
  repeated: number
  /** Anything else intake answered. */
  refused: number
}

export type FeederRouteOptions = {
  /** `FEEDER_TOKEN`. Null and the route is not there. */
  token: string | null
  /** `FR-009`: three wallets, one per operator. */
  operatorWallets: readonly string[]
  registry: RegistryStore
  counters: CounterStore
  publisher: ReadingPublisher
  maxAgeMs?: number
  now?: () => Date
  concurrency?: number
}

/** Equal-time comparison over digests, so neither length nor prefix leaks. */
function sameToken(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(presented), digest(expected))
}

async function inBatches<T>(
  items: readonly T[],
  size: number,
  each: (item: T) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(each))
  }
}

export function createFeederRoute(options: FeederRouteOptions): Hono {
  const route = new Hono()
  const now = options.now ?? (() => new Date())
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const token = options.token

  if (token === null) {
    route.all('*', (context) => apiError(context, 404, 'not found'))
    return route
  }

  let sensors: Promise<FeederSensor[]> | null = null
  // Once per process: `ensureCell` is idempotent, but asking it every tick
  // would add four cells' worth of inserts to the traffic being measured.
  let registered: Promise<void> | null = null
  let busy = false

  route.post('/tick', async (context) => {
    const header = context.req.header('authorization') ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!sameToken(presented, token)) {
      return apiError(context, 401, 'a feeder tick needs the feeder token')
    }
    if (busy) return apiError(context, 409, 'a tick is already running')
    busy = true

    try {
      sensors ??= feederSensors()
      const network = await sensors
      registered ??= (async () => {
        for (const setup of feederCellSetups(network, options.operatorWallets)) {
          await options.registry.ensureCell(setup)
        }
      })().catch((cause: unknown) => {
        // Not remembered as done: the next tick tries again.
        registered = null
        throw cause
      })
      await registered

      const at = now()
      const counters = await options.counters.lastCounters(network.map((sensor) => sensor.pubkey))
      const hours = dueHours(at, lastFullHour(network, counters), Math.ceil(maxAgeMs / HOUR_MS))
      const readings = await feederReadings(network, hours, at, maxAgeMs)

      const tally: FeederTickWire = {
        synthetic: true,
        hours,
        sent: readings.length,
        stored: 0,
        repeated: 0,
        refused: 0,
      }
      await inBatches(readings, options.concurrency ?? 8, async (reading) => {
        const result = await options.publisher.publish(reading)
        if (result.status === 201) tally.stored += 1
        else if (result.status === 200) tally.repeated += 1
        else tally.refused += 1
      })
      return context.json(tally, 200)
    } finally {
      busy = false
    }
  })

  return route
}
