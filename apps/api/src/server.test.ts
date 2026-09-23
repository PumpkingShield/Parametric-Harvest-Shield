import type {
  CellSetup,
  CounterStore,
  DayRow,
  IntervalStore,
  ReadingRow,
  SaveOutcome,
  SensorRegistration,
} from '@pumpking/db'
import { cellIdFromH3Index } from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PolicyLookup } from './routes/policies.ts'
import { type ApiDeps, createApiApp } from './server.ts'

/**
 * The wiring, and only the wiring.
 *
 * Each route has its own tests over its own rules; what cannot be tested there
 * is whether it was mounted, and mounted where. A route hung at the wrong
 * prefix is a 404 in production and a green suite everywhere else — which is
 * the same shape as every other hole this project has found: the code exists
 * and nothing calls it.
 */

const H3 = '871e701b3ffffff'
const CELL_ID = cellIdFromH3Index(H3)
const POLICY = 'BPFLoaderUpgradeab1e11111111111111111111111'

class Readings {
  saved: ReadingRow[] = []
  sensorFor(_pubkey: string): Promise<SensorRegistration | null> {
    return Promise.resolve(null)
  }
  save(row: ReadingRow): Promise<SaveOutcome> {
    this.saved.push(row)
    return Promise.resolve({ stored: true, status: row.status })
  }
}

class Registry {
  cells: CellSetup[] = []
  ensureCell(setup: CellSetup): Promise<void> {
    this.cells.push(setup)
    return Promise.resolve()
  }
}

const noPolicies: PolicyLookup = { policyAt: () => Promise.resolve(null) }

/** `T067`: nothing has published here yet, so every sensor starts at one. */
const noCounters: CounterStore = { lastCounters: () => Promise.resolve(new Map()) }

function days(rows: DayRow[]): Pick<IntervalStore, 'dayRecords'> {
  return { dayRecords: () => Promise.resolve(rows) }
}

function app(overrides: Partial<ApiDeps> = {}) {
  const deps: ApiDeps = {
    readings: new Readings(),
    intervals: days([]),
    policies: noPolicies,
    registry: new Registry(),
    counters: noCounters,
    scenarioMode: false,
    ...overrides,
  }
  return createApiApp(deps)
}

describe('GET /health', () => {
  it('answers without touching the database or the chain', async () => {
    // The stores here throw on every call; a liveness probe that needs them
    // would make a platform restart a container over an outage a restart
    // cannot fix.
    const exploding: ApiDeps['intervals'] = {
      dayRecords: () => Promise.reject(new Error('postgres is unreachable')),
    }
    const response = await app({ intervals: exploding }).request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', scenarioMode: false })
  })

  it('says whether this deployment can invent weather', async () => {
    const response = await app({ scenarioMode: true }).request('/health')
    expect(await response.json()).toMatchObject({ scenarioMode: true })
  })

  it('says nothing about a worker when the loop is not in this process', async () => {
    // The two-process deployment: the worker answers for itself on its own
    // port, and an empty `worker` here would read as a loop that exists and
    // has never turned.
    const body = (await (await app({}).request('/health')).json()) as Record<string, unknown>
    expect('worker' in body).toBe(false)
  })

  it('carries the loop when the loop turns here', async () => {
    // `T056`: on the free plan there is one port, so this is the only place the
    // aggregator is visible from outside at all.
    const response = await app({
      worker: () => ({
        status: 'ok',
        uptimeSeconds: 12,
        cycles: 3,
        lastCycleAgoSeconds: 1,
        lastCycle: { submitted: 2, settled: 1, closed: 0, failed: 0 },
        lastSkipped: null,
        lastError: null,
      }),
    }).request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ok',
      worker: { status: 'ok', cycles: 3, lastCycle: { settled: 1 } },
    })
  })

  it('stays 200 while the loop is stalled', async () => {
    // A failing probe would have the platform restart the API, taking down the
    // routes that still work and the only voice able to say what went wrong.
    // The state is in the body for whoever is reading it.
    const response = await app({
      worker: () => ({
        status: 'stalled',
        uptimeSeconds: 600,
        cycles: 4,
        lastCycleAgoSeconds: 300,
        lastCycle: null,
        lastSkipped: 'no-pool',
        lastError: 'the pooler went away',
      }),
    }).request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ worker: { status: 'stalled' } })
  })

  it('counts uptime from the moment it was built', async () => {
    let now = new Date('2026-08-30T10:00:00Z')
    const server = app({ now: () => now })
    now = new Date('2026-08-30T10:01:30Z')

    expect(await (await server.request('/health')).json()).toMatchObject({ uptimeSeconds: 90 })
  })
})

describe('the four routes are mounted where the contract says', () => {
  let readings: Readings

  beforeEach(() => {
    readings = new Readings()
  })

  it('POST /v1/readings reaches the intake', async () => {
    const response = await app({ readings }).request('/v1/readings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonsense: true }),
    })

    // 400 from the route, not 404 from the router: the door is there and it is
    // the one that refuses a body that is not a reading (`FR-041`).
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid reading' })
  })

  it('GET /v1/cells/:cellId/days reaches the journal', async () => {
    const row: DayRow = {
      cellId: CELL_ID,
      dayIndex: 4,
      state: 1,
      rainfallX100: 40,
      coveredHours: 24,
      merkleRoot: 'root',
      txSignature: 'tx',
    }
    const response = await app({ intervals: days([row]) }).request(
      `/v1/cells/${H3}/days?from=0&to=9`,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ cellId: H3, days: [{ dayIndex: 4 }] })
  })

  it('GET /v1/policies/:pubkey reaches the lookup', async () => {
    const response = await app().request(`/v1/policies/${POLICY}`)

    // The lookup finds nothing, which is the route's own 404 and proves the
    // request got that far — the router's 404 has no such body.
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'no policy at that address' })
  })

  it('POST /v1/scenario/run reaches the run when the mode is on', async () => {
    const response = await app({ scenarioMode: true }).request('/v1/scenario/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'no-such-scenario', operators: {} }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'no such scenario' })
  })

  it('the scenario route is gone, not forbidden, when the mode is off', async () => {
    const started = await app({ scenarioMode: false }).request('/v1/scenario/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'drought', operators: {} }),
    })
    const status = await app({ scenarioMode: false }).request('/v1/scenario/run/any-id')

    // A 403 would tell an anonymous caller that a button which invents the
    // weather exists on this deployment.
    expect(started.status).toBe(404)
    expect(status.status).toBe(404)
  })
})

describe('the scenario run publishes through the mounted intake', () => {
  it('a run reaches the same door a device does', async () => {
    // The publisher is built from the readings route this app mounted, so a
    // reading the run produces is parsed, signature-checked and counter-checked
    // by exactly the code a sensor's reading meets. The proof that it is wired
    // to *this* app is that the run's readings land in *this* store.
    const readings = new Readings()
    const registry = new Registry()
    const server = app({ readings, registry, scenarioMode: true })

    const response = await server.request('/v1/scenario/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'drought', operators: {} }),
    })

    // Every operator the fixture names needs a wallet, and none was given: the
    // run refuses before it registers anything or publishes anything.
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: 'the run has no wallet for every operator the scenario names',
    })
    expect(registry.cells).toEqual([])
    expect(readings.saved).toEqual([])
  })
})

describe('what falls through', () => {
  it('an unknown path is a 404 in the shape the routes use', async () => {
    const response = await app().request('/v1/pool')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not found' })
  })

  it('a route that throws is a 500 that says nothing about why', async () => {
    const exploding: ApiDeps['intervals'] = {
      dayRecords: () => Promise.reject(new Error('password authentication failed for user "app"')),
    }
    const response = await app({ intervals: exploding }).request(`/v1/cells/${H3}/days?from=0&to=1`)

    expect(response.status).toBe(500)
    // The message from inside names a user, a host or a query. The caller gets
    // that it was not their request; the operator gets the log line.
    expect(await response.json()).toEqual({ error: 'internal error' })
  })
})

describe('CORS', () => {
  it('lets the interface call from its own origin', async () => {
    const response = await app({ webOrigin: ['https://pumpking.app'] }).request(
      `/v1/cells/${H3}/days?from=0&to=1`,
      { headers: { origin: 'https://pumpking.app' } },
    )

    expect(response.headers.get('access-control-allow-origin')).toBe('https://pumpking.app')
  })

  it('does not answer for an origin that was not named', async () => {
    const response = await app({ webOrigin: ['https://pumpking.app'] }).request(
      `/v1/cells/${H3}/days?from=0&to=1`,
      { headers: { origin: 'https://elsewhere.example' } },
    )

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('leaves the health check alone', async () => {
    // It is a platform probe, not a browser call; the middleware is on `/v1/*`.
    const response = await app().request('/health', { headers: { origin: 'https://any.example' } })
    expect(response.status).toBe(200)
  })
})
