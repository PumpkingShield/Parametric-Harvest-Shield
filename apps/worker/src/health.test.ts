import { describe, expect, it } from 'vitest'
import {
  createHealthServer,
  healthOf,
  MINIMUM_STALLED_MS,
  stalledAfterMs,
  type WorkerHealthState,
} from './health.ts'

const START = new Date('2026-08-30T10:00:00Z')
const at = (seconds: number): Date => new Date(START.getTime() + seconds * 1000)

function state(overrides: Partial<WorkerHealthState> = {}): WorkerHealthState {
  return {
    startedAt: START,
    lastCycleAt: null,
    lastCycle: null,
    lastSkipped: null,
    lastError: null,
    cycles: 0,
    ...overrides,
  }
}

const MINUTE = 60_000

describe('healthOf', () => {
  it('is starting before the first cycle finishes', () => {
    // A worker whose first cycle is a long backlog is starting, not broken.
    expect(healthOf(state(), at(5), MINUTE).status).toBe('starting')
  })

  it('is ok once the loop is turning', () => {
    const { status, wire } = healthOf(
      state({
        lastCycleAt: at(20),
        cycles: 4,
        lastCycle: { submitted: 1, settled: 0, closed: 0, failed: 0 },
      }),
      at(25),
      MINUTE,
    )

    expect(status).toBe('ok')
    expect(wire.lastCycleAgoSeconds).toBe(5)
    expect(wire.cycles).toBe(4)
    expect(wire.uptimeSeconds).toBe(25)
  })

  it('is stalled when no cycle has finished in a while', () => {
    // The failure this exists for: a loop that has quietly stopped looks
    // exactly like a loop with nothing to do, and nothing else can tell them
    // apart from outside.
    expect(healthOf(state({ lastCycleAt: at(10) }), at(100), MINUTE).status).toBe('stalled')
  })

  it('is stalled when the first cycle never finishes either', () => {
    expect(healthOf(state(), at(100), MINUTE).status).toBe('stalled')
  })

  it('a cycle that failed is still a loop that is turning', () => {
    // The error is in the log with its reason; a restart does not fix an
    // unreachable database, it only removes the process that could say so.
    const { status, wire } = healthOf(
      state({ lastCycleAt: at(5), cycles: 1, lastError: 'connection refused' }),
      at(6),
      MINUTE,
    )

    expect(status).toBe('ok')
    expect(wire.lastError).toBe('connection refused')
  })

  it('carries why a cycle did nothing', () => {
    const { wire } = healthOf(state({ lastCycleAt: at(5), lastSkipped: 'no-pool' }), at(6), MINUTE)
    expect(wire.lastSkipped).toBe('no-pool')
  })
})

describe('stalledAfterMs', () => {
  it('is several periods, never less than a minute', () => {
    // A probe that fires on the first slow cycle would restart the process
    // doing the most work.
    expect(stalledAfterMs(5_000)).toBe(MINIMUM_STALLED_MS)
    expect(stalledAfterMs(60_000)).toBe(240_000)
  })
})

describe('the health server', () => {
  async function ask(
    server: ReturnType<typeof createHealthServer>,
    path: string,
  ): Promise<{ status: number; body: unknown }> {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`)
      return { status: response.status, body: await response.json() }
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  }

  it('answers 200 while the loop is turning', async () => {
    const server = createHealthServer({
      state: () => state({ lastCycleAt: at(5), cycles: 2 }),
      stalledMs: MINUTE,
      now: () => at(6),
    })

    expect(await ask(server, '/health')).toEqual({
      status: 200,
      body: {
        status: 'ok',
        uptimeSeconds: 6,
        cycles: 2,
        lastCycleAgoSeconds: 1,
        lastCycle: null,
        lastSkipped: null,
        lastError: null,
      },
    })
  })

  it('answers 503 when it has stalled, because 503 is what a platform restarts on', async () => {
    const server = createHealthServer({
      state: () => state({ lastCycleAt: at(5) }),
      stalledMs: MINUTE,
      now: () => at(300),
    })

    const { status, body } = await ask(server, '/health')
    expect(status).toBe(503)
    expect(body).toMatchObject({ status: 'stalled' })
  })

  it('has one path and nothing else', async () => {
    const server = createHealthServer({
      state: () => state({ lastCycleAt: at(5) }),
      stalledMs: MINUTE,
      now: () => at(6),
    })

    expect(await ask(server, '/')).toEqual({ status: 404, body: { error: 'not found' } })
  })

  it('ignores a query string on the probe', async () => {
    const server = createHealthServer({
      state: () => state({ lastCycleAt: at(5) }),
      stalledMs: MINUTE,
      now: () => at(6),
    })

    expect((await ask(server, '/health?from=railway')).status).toBe(200)
  })
})
