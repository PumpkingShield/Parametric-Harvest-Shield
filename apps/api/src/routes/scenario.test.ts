import type {
  CellSetup,
  CounterStore,
  ReadingRow,
  ReadingStore,
  RegistryStore,
  SaveOutcome,
  SensorRegistration,
} from '@pumpking/db'
import {
  cellIdFromH3Index,
  ReadingKind,
  type SignedReading,
  sensorPublicKey,
  verifyReadingSignature,
} from '@pumpking/shared'
import { loadScenario, type Scenario } from '@pumpking/worker/scenario'
import { beforeEach, describe, expect, it } from 'vitest'
import { createReadingsRoute } from './readings.ts'
import {
  createScenarioRoute,
  type PublishResult,
  type ReadingPublisher,
  type RunWire,
  routeReadingPublisher,
} from './scenario.ts'

const H3 = '871e701b3ffffff'
const CELL_ID = cellIdFromH3Index(H3)
const WALLET_A = 'So11111111111111111111111111111111111111112'
const WALLET_B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const WALLET_C = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'

/**
 * A two-day scenario at one interval a day, so a run is four readings rather
 * than the fixture's two thousand. Everything the route does to it is what it
 * does to `drought.json`; only the arithmetic is small enough to assert.
 */
function scenario(overrides: Record<string, unknown> = {}): Scenario {
  return loadScenario({
    name: 'tiny',
    synthetic: true,
    note: 'Two days, two sensors, one interval each. Synthetic.',
    clock: { secondsPerDay: 2, intervalsPerDay: 1 },
    cell: H3,
    kind: ReadingKind.PrecipitationMm,
    params: { minimumVotes: 2, dryThresholdX100: 100, minimumCoverageX100: 75 },
    sensors: [
      { seed: 11, operator: 'operator-a', slotInCell: 0, offsetX100: 0 },
      { seed: 12, operator: 'operator-b', slotInCell: 1, offsetX100: 0 },
    ],
    programme: [{ days: 2, intervalX100: 0 }],
    expected: { days: 2, longestDrySpell: 2 },
    ...overrides,
  })
}

class FakeRegistry implements RegistryStore {
  setups: CellSetup[] = []
  fail: Error | null = null

  ensureCell(setup: CellSetup): Promise<void> {
    this.setups.push(setup)
    return this.fail === null ? Promise.resolve() : Promise.reject(this.fail)
  }
}

/**
 * The two questions `POST /v1/readings` asks of storage, and the one a
 * resuming run asks (`T067`) — because they are questions about one table, and
 * a fake that split them could answer them inconsistently.
 */
class FakeReadingStore implements ReadingStore, CounterStore {
  registrations = new Map<string, SensorRegistration>()
  rows: ReadingRow[] = []

  lastCounters(pubkeys: readonly string[]): Promise<Map<string, bigint>> {
    const wanted = new Set(pubkeys)
    const last = new Map<string, bigint>()
    for (const row of this.rows) {
      if (!wanted.has(row.sensorPubkey)) continue
      const seen = last.get(row.sensorPubkey)
      if (seen === undefined || row.counter > seen) last.set(row.sensorPubkey, row.counter)
    }
    return Promise.resolve(last)
  }

  sensorFor(pubkey: string): Promise<SensorRegistration | null> {
    return Promise.resolve(this.registrations.get(pubkey) ?? null)
  }

  save(row: ReadingRow): Promise<SaveOutcome> {
    const existing = this.rows.find(
      (one) => one.sensorPubkey === row.sensorPubkey && one.counter === row.counter,
    )
    if (existing !== undefined) {
      return Promise.resolve({
        stored: false,
        existingSignature: existing.signature,
        status: existing.status,
      })
    }
    this.rows.push(row)
    return Promise.resolve({ stored: true, status: row.status })
  }
}

class FakePublisher implements ReadingPublisher {
  sent: SignedReading[] = []
  refuse = new Set<number>()

  publish(reading: SignedReading): Promise<PublishResult> {
    this.sent.push(reading)
    const refused = this.refuse.has(this.sent.length)
    return Promise.resolve({ ok: !refused, status: refused ? 401 : 201 })
  }
}

const STARTED_AT = new Date('2026-09-01T00:00:00.000Z')

let registry: FakeRegistry
let publisher: FakePublisher
let store: FakeReadingStore
let ids: number

beforeEach(() => {
  registry = new FakeRegistry()
  publisher = new FakePublisher()
  store = new FakeReadingStore()
  ids = 0
})

type RouteOverrides = {
  enabled?: boolean
  load?: (name: string) => Scenario
  /** Milliseconds the run is told signing will take — `T069`. */
  signingMs?: number
}

function route(overrides: RouteOverrides = {}) {
  return createScenarioRoute({
    enabled: overrides.enabled ?? true,
    registry,
    counters: store,
    publisher,
    load: overrides.load ?? (() => scenario()),
    signingCost: () => Promise.resolve(overrides.signingMs ?? 0),
    now: () => STARTED_AT,
    // The compressed clock is still a clock; the run is only asked not to
    // spend two real seconds proving it.
    sleep: () => Promise.resolve(),
    newRunId: () => {
      ids += 1
      return `run-${ids}`
    },
  })
}

const BODY = { scenario: 'tiny', operators: { 'operator-a': WALLET_A, 'operator-b': WALLET_B } }

async function post(body: unknown, overrides: RouteOverrides = {}): Promise<Response> {
  return await route(overrides).request('/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Polls the status route until the run stops running.
 *
 * The route deliberately does not await the run, and a signature check is a
 * handful of turns of the event loop per reading, so a single drain proves
 * nothing. This is what the demo screen does with a progress bar, minus the
 * bar.
 */
async function settled(app: ReturnType<typeof route>, id: string): Promise<RunWire> {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
    const run = (await (await app.request(`/run/${id}`)).json()) as RunWire
    if (run.status !== 'running') return run
  }
  throw new Error('the run never finished')
}

/** A run started and played to its end, with the app that played it. */
async function play(
  body: unknown = BODY,
): Promise<{ app: ReturnType<typeof route>; run: RunWire }> {
  const app = route()
  const response = await app.request('/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const started = (await response.json()) as RunWire
  return { app, run: await settled(app, started.run) }
}

describe('POST /v1/scenario/run', () => {
  it('answers 202 with the numbers the screen has to show', async () => {
    const response = await post(BODY)
    expect(response.status).toBe(202)
    const run = (await response.json()) as RunWire
    expect(run).toEqual(
      expect.objectContaining({
        run: 'run-1',
        scenario: 'tiny',
        // `FR-039`, `FR-056`: the badge has this behind it.
        synthetic: true,
        // `FR-049`: 86400 / 2. Without it the demo claims a payout arrives
        // four seconds after a two-day drought.
        compression: 43_200,
        durationSeconds: 4,
        days: 2,
        expectedSpell: 2,
        cellId: H3,
        status: 'running',
        total: 4,
        published: 0,
        refused: 0,
        error: null,
      }),
    )
  })

  it('registers the cell, the operators and the sensors before publishing', async () => {
    await post(BODY)
    expect(registry.setups).toHaveLength(1)
    const setup = registry.setups[0]
    expect(setup?.cellId).toBe(CELL_ID)
    expect(setup?.resolution).toBe(7)
    expect(setup?.sensors.map((one) => one.operatorWallet)).toEqual([WALLET_A, WALLET_B])
    expect(setup?.sensors.map((one) => one.slotInCell)).toEqual([0, 1])
  })

  it('publishes every reading the scenario produces, signed', async () => {
    const { run } = await play()
    expect(run.status).toBe('done')
    expect(run.published).toBe(4)
    expect(run.refused).toBe(0)
    expect(publisher.sent).toHaveLength(4)
    for (const reading of publisher.sent) {
      expect(await verifyReadingSignature(reading)).toBe(true)
    }
  })

  /**
   * The run has to be indistinguishable from hardware at the door: same cell,
   * same kind, counters ascending per sensor from one (`FR-003`).
   */
  it('publishes readings a device could have signed', async () => {
    await play()
    const first = publisher.sent[0]
    expect(first?.cellId).toBe(CELL_ID)
    expect(first?.kind).toBe(ReadingKind.PrecipitationMm)
    const bySensor = new Map<string, bigint[]>()
    for (const reading of publisher.sent) {
      bySensor.set(reading.sensor, [...(bySensor.get(reading.sensor) ?? []), reading.counter])
    }
    expect([...bySensor.values()]).toEqual([
      [1n, 2n],
      [1n, 2n],
    ])
  })

  /**
   * A refusal is the door working. It is counted and shown rather than folded
   * into a failed run — a demo where it is not zero is one to stop and look at.
   */
  it('counts a refused reading without failing the run', async () => {
    publisher.refuse.add(2)
    const { run } = await play()
    expect(run.status).toBe('done')
    expect(run.published).toBe(3)
    expect(run.refused).toBe(1)
  })

  it('anchors genesis at the start of the run when the body does not say', async () => {
    const response = await post(BODY)
    const run = (await response.json()) as RunWire
    expect(run.genesisTs).toBe(STARTED_AT.toISOString())
    expect(run.startedAt).toBe(STARTED_AT.toISOString())
  })

  /**
   * `T069`, and it cost a devnet run to learn. The schedule is chosen for the
   * moment the run can start publishing, not for the moment the request
   * arrived — a reading's signature commits to the instant it was measured, so
   * nothing can be signed until the day offset is fixed, and then thousands of
   * signatures happen while that offset's days go by. On the deployment that
   * was nine seconds against a two-second day: four and a half days elapsed
   * before the first reading, the aggregator closed them, and an eighteen-day
   * drought reached the chain as thirteen.
   */
  it('starts the run past the days that elapse while it is being signed', async () => {
    // Ten seconds of signing on two-second days: five days go by first.
    const response = await post(BODY, { signingMs: 10_000 })
    const run = (await response.json()) as RunWire
    expect(run.firstDay).toBe(5)
    expect(run.startedAt).toBe(new Date(STARTED_AT.getTime() + 10_000).toISOString())
  })

  /**
   * The same on a pool that is already alive, where the day the request lands
   * in may already hold the previous chapter's last reading — so the signing
   * time and the day of grace are both counted, and they are counted once each.
   */
  it('counts the signing time on top of the day a live pool is already in', async () => {
    const genesisTs = new Date(STARTED_AT.getTime() - 8_000).toISOString()
    const response = await post({ ...BODY, genesisTs }, { signingMs: 10_000 })
    const run = (await response.json()) as RunWire
    // Day 4 when the request arrives, day 9 when signing ends, day 10 is free.
    expect(run.firstDay).toBe(10)
  })

  it('takes the genesis the body names', async () => {
    const at = '2026-07-01T00:00:00.000Z'
    const response = await post({ ...BODY, genesisTs: at })
    const run = (await response.json()) as RunWire
    expect(run.genesisTs).toBe(at)
  })
})

describe('GET /v1/scenario/run/:id', () => {
  it('reports the run while it is in flight and after it ends', async () => {
    const { run } = await play()
    expect(run.status).toBe('done')
    expect(run.finishedAt).not.toBeNull()
  })

  it('answers 404 for a run it never started', async () => {
    const response = await route().request('/run/run-99')
    expect(response.status).toBe(404)
  })
})

describe('POST /v1/scenario/run — refusals', () => {
  /**
   * Off means gone. A 403 would announce that a button which invents the
   * weather exists on this deployment.
   */
  it('answers 404 to everything when the mode is off', async () => {
    const off = route({ enabled: false })
    expect((await post(BODY, { enabled: false })).status).toBe(404)
    expect((await off.request('/run/run-1')).status).toBe(404)
    expect(registry.setups).toEqual([])
  })

  it('refuses a body that is not JSON', async () => {
    const response = await route().request('/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(response.status).toBe(400)
  })

  it('refuses a scenario name that is a path', async () => {
    const response = await post({ ...BODY, scenario: '../secrets' })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { fields: { field: string }[] }
    expect(body.fields[0]?.field).toBe('scenario')
  })

  it('refuses an operator wallet that is not base58', async () => {
    const response = await post({ ...BODY, operators: { 'operator-a': 'not a wallet' } })
    expect(response.status).toBe(400)
  })

  /**
   * `FR-009` counts a vote per operator, so a missing wallet is a run that
   * silently falls short of coverage rather than one that fails loudly.
   */
  it('refuses when an operator the scenario names has no wallet', async () => {
    const response = await post({ scenario: 'tiny', operators: { 'operator-a': WALLET_A } })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { fields: { field: string }[] }
    expect(body.fields.map((one) => one.field)).toEqual(['operators.operator-b'])
    expect(registry.setups).toEqual([])
  })

  it('answers 404 for a scenario there is no file for', async () => {
    const response = await post(BODY, {
      load: () => {
        throw new RangeError('not a scenario name: nope')
      },
    })
    expect(response.status).toBe(404)
  })

  /**
   * A slot already held by a different key. Nothing has been published yet, so
   * stopping is the whole fix.
   */
  it('refuses when the registry disagrees with the scenario', async () => {
    registry.fail = new Error('duplicate key value violates sensors_cell_slot_uq')
    const response = await post(BODY)
    expect(response.status).toBe(409)
    expect(publisher.sent).toEqual([])
  })

  /**
   * Counters ascend from one per sensor, so two runs of one fixture would each
   * read the other's readings as replays.
   */
  it('refuses a second run while one is in flight', async () => {
    const app = route()
    const body = { method: 'POST', headers: { 'content-type': 'application/json' } }
    const first = await app.request('/run', { ...body, body: JSON.stringify(BODY) })
    expect(first.status).toBe(202)
    const second = await app.request('/run', { ...body, body: JSON.stringify(BODY) })
    expect(second.status).toBe(409)
    expect((await second.json()) as { run: string }).toEqual(
      expect.objectContaining({ run: 'run-1' }),
    )
  })

  it('allows a run once the one before it has finished', async () => {
    const { app } = await play()
    const again = await app.request('/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    })
    expect(again.status).toBe(202)
  })
})

describe('the fixture the demo is actually run on', () => {
  /**
   * `drought.json` is the run M1 is shown on, and it is read here through the
   * route the button calls rather than through a fixture loader a test wrote.
   * The budget is `SC-011`: 90 seconds of compressed time from the first
   * reading to the payout.
   */
  it('reports drought.json inside the budget SC-011 sets', async () => {
    const app = createScenarioRoute({
      enabled: true,
      registry,
      counters: store,
      publisher,
      now: () => STARTED_AT,
      sleep: () => Promise.resolve(),
      newRunId: () => 'run-drought',
    })
    const response = await app.request('/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scenario: 'drought',
        operators: {
          'operator-a': WALLET_A,
          'operator-b': WALLET_B,
          'operator-c': WALLET_C,
        },
      }),
    })

    expect(response.status).toBe(202)
    const run = (await response.json()) as RunWire
    expect(run.synthetic).toBe(true)
    expect(run.days).toBe(29)
    expect(run.expectedSpell).toBe(18)
    expect(run.compression).toBe(43_200)
    expect(run.durationSeconds).toBe(58)
    expect(run.durationSeconds).toBeLessThan(90)
    // 27 days that report, 24 intervals each, three sensors: two days of the
    // programme are silent for every interval they have.
    expect(run.total).toBe(27 * 24 * 3)
  })
})

describe('routeReadingPublisher', () => {
  /**
   * The claim the whole route rests on: a scenario reading is indistinguishable
   * from a device's at the door. Not asserted by inspection — the readings go
   * through the real `POST /v1/readings`, which checks the registration, the
   * cell, the signature and the counter, and only rows it accepted come out
   * the other side.
   */
  it('puts a run through the real readings route', async () => {
    for (const seed of [11, 12]) {
      const pubkey = await sensorPublicKey(new Uint8Array(32).fill(seed))
      store.registrations.set(pubkey, {
        pubkey,
        cellId: CELL_ID,
        kind: ReadingKind.PrecipitationMm,
        active: true,
      })
    }
    // Compressed time, modelled rather than waited out: the injected sleep
    // advances the clock instead of the process, and intake reads the same
    // clock the run is played on. Freezing it instead would make every day
    // after the first arrive from the future, which `FR-004` calls late — a
    // fact about a stopped clock, not about a run.
    let clock = STARTED_AT.getTime()
    const now = (): Date => new Date(clock)
    const readings = createReadingsRoute({ store, now })

    const app = createScenarioRoute({
      enabled: true,
      registry,
      counters: store,
      publisher: routeReadingPublisher(readings),
      load: () => scenario(),
      now,
      sleep: (ms) => {
        clock += ms
        return Promise.resolve()
      },
      newRunId: () => 'run-door',
    })
    const started = await app.request('/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    })
    expect(started.status).toBe(202)

    const run = await settled(app, 'run-door')
    expect(run.status).toBe('done')
    expect(run.published).toBe(4)
    expect(run.refused).toBe(0)
    expect(store.rows).toHaveLength(4)
    // `FR-004`: on a compressed clock the measurement and its publication move
    // together, so nothing a run publishes is ever stale.
    expect(store.rows.every((row) => row.status === 'accepted')).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */

/**
 * `T067` — the demo's second chapter.
 *
 * Both runs go through the real `POST /v1/readings`, so nothing here is
 * asserted by inspection: if the second run collided with the first on
 * `readings_sensor_counter_uq`, the door would refuse its readings and
 * `refused` would say so. That refusal is the failure this task exists to
 * remove, and it is what these tests would see.
 */
describe('a second run against the same pool — T067', () => {
  /**
   * Compressed time, modelled rather than waited out — the same clock the
   * publisher test uses, because intake reads the clock the run is played on.
   */
  function chapters(): { app: ReturnType<typeof createScenarioRoute>; at: () => Date } {
    let clock = STARTED_AT.getTime()
    const now = (): Date => new Date(clock)
    // The sleep below advances this clock instead of the process, so `at()`
    // reads the compressed time a chapter actually consumed.

    const readings = createReadingsRoute({ store, now })
    let id = 0
    const app = createScenarioRoute({
      enabled: true,
      registry,
      counters: store,
      publisher: routeReadingPublisher(readings),
      load: () => scenario(),
      now,
      sleep: (ms) => {
        clock += ms
        return Promise.resolve()
      },
      newRunId: () => {
        id += 1
        return `chapter-${id}`
      },
    })
    return { app, at: now }
  }

  async function register(): Promise<void> {
    for (const seed of [11, 12]) {
      const pubkey = await sensorPublicKey(new Uint8Array(32).fill(seed))
      store.registrations.set(pubkey, {
        pubkey,
        cellId: CELL_ID,
        kind: ReadingKind.PrecipitationMm,
        active: true,
      })
    }
  }

  /** Starts a chapter and plays it to its end. */
  async function chapter(
    app: ReturnType<typeof createScenarioRoute>,
    body: unknown,
  ): Promise<RunWire> {
    const response = await app.request('/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(202)
    const started = (await response.json()) as RunWire
    return await settled(app, started.run)
  }

  it('publishes both chapters in full, refusing nothing', async () => {
    await register()
    const { app } = chapters()

    const first = await chapter(app, BODY)
    expect(first.status).toBe('done')
    expect(first.firstDay).toBe(0)
    expect(first.published).toBe(4)
    expect(first.refused).toBe(0)

    // The same fixture, the same keys, the same pool. Before `T067` this was
    // four readings the door had already seen.
    const second = await chapter(app, { ...BODY, genesisTs: STARTED_AT.toISOString() })
    expect(second.status).toBe('done')
    expect(second.published).toBe(4)
    expect(second.refused).toBe(0)
    expect(store.rows).toHaveLength(8)
    expect(store.rows.every((row) => row.status === 'accepted')).toBe(true)
  })

  it('resumes each sensor from the counter the table already holds', async () => {
    await register()
    const { app } = chapters()
    await chapter(app, BODY)
    await chapter(app, { ...BODY, genesisTs: STARTED_AT.toISOString() })

    for (const pubkey of store.registrations.keys()) {
      const own = store.rows
        .filter((row) => row.sensorPubkey === pubkey)
        .map((row) => row.counter)
        .sort((a, b) => Number(a - b))
      expect(own).toEqual([1n, 2n, 3n, 4n])
    }
  })

  /**
   * The calendar half of the task. The second chapter's weather must land on
   * days the aggregator has not closed — otherwise its readings would be
   * counted into a day that was already published on chain.
   */
  it('starts the second chapter past every day the first one touched', async () => {
    await register()
    const { app } = chapters()
    const first = await chapter(app, BODY)
    const second = await chapter(app, { ...BODY, genesisTs: STARTED_AT.toISOString() })

    expect(second.firstDay).toBeGreaterThan(first.firstDay + first.days - 1)
    expect(new Date(second.startedAt).getTime()).toBe(STARTED_AT.getTime() + second.firstDay * 2000)

    const seam = STARTED_AT.getTime() + second.firstDay * 2000
    const before = store.rows.filter((row) => row.measuredAt.getTime() < seam)
    const after = store.rows.filter((row) => row.measuredAt.getTime() >= seam)
    expect(before).toHaveLength(4)
    expect(after).toHaveLength(4)
  })

  /**
   * When a chapter publishes, not only what — and this is the test that was
   * missing when a devnet run found the bug.
   *
   * `playScenario` publishes a reading at `anchor + (measuredAt - genesisTs)`,
   * and `dayOffset` is already inside `measuredAt`. Anchoring the run at its
   * own boundary instead of at the genesis adds the offset twice: the chapter
   * sits idle for a whole offset past the day it was supposed to start on, and
   * the aggregator closes those days empty while it waits. Nothing about the
   * readings is wrong when that happens — the counters resume, the days are
   * right, `published` reaches `total` — which is exactly why only the clock
   * catches it.
   */
  it('plays the second chapter at its boundary, not an offset past it', async () => {
    await register()
    const { app, at } = chapters()

    await chapter(app, BODY)
    const second = await chapter(app, { ...BODY, genesisTs: STARTED_AT.toISOString() })

    const boundary = STARTED_AT.getTime() + second.firstDay * 2000
    expect(new Date(second.startedAt).getTime()).toBe(boundary)

    // The fixture is two days of one interval, so the last reading is due at
    // the start of the chapter's final day — one day after its boundary.
    const lastDue = boundary + (second.days - 1) * 2000
    expect(at().getTime()).toBe(lastDue)
  })

  /**
   * A run reads the counters and the clock once, at the start. Two runs in
   * flight would read the same two numbers and rebuild the collision — so the
   * guard that says «busy» is part of `T067`, not only of the demo's manners.
   */
  it('refuses a second chapter while the first is still playing', async () => {
    await register()
    const { app } = chapters()
    const started = await app.request('/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    })
    expect(started.status).toBe(202)

    const overlapping = await app.request('/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    })
    expect(overlapping.status).toBe(409)
  })
})
