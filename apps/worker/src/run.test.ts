import { Keypair, PROGRAM_ID } from '@pumpking/anchor-client'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerConfig } from './config.ts'
import type { CycleReport } from './cycle.ts'
import { startWorker } from './run.ts'

/**
 * The loop, without a cluster under it.
 *
 * What is tested here is what neither the dispatchers nor `runCycle` can be
 * asked about: that something turns them, that it does not turn two at once,
 * that a failure does not end the loop, and that `stop()` waits. It matters
 * more since `T056` than it did before — the same function now runs inside the
 * API process, where a loop that never stops would hold a deploy open.
 */

const log = pino({ level: 'silent' })

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: 'postgresql://localhost:5432/test',
    rpcUrl: 'http://localhost:8899',
    programId: PROGRAM_ID,
    aggregator: Keypair.generate(),
    logLevel: 'silent',
    port: 8081,
    intervalsPerDay: 24,
    minimumCoverageX100: 75,
    cycleIntervalMs: 1_000,
    backlogDays: 7,
    keepAliveUrl: null,
    shutdownTimeoutMs: 15_000,
    ...overrides,
  }
}

function report(overrides: Partial<CycleReport> = {}): CycleReport {
  return { skipped: null, aggregatorMatches: true, days: [], settled: [], closed: [], ...overrides }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startWorker', () => {
  it('turns the first cycle immediately, not after a period', async () => {
    // A deploy that has just replaced the process should not leave a day
    // unwritten for the length of a tick.
    let turns = 0
    const worker = startWorker({
      config: config(),
      log,
      cycle: async () => {
        turns += 1
        return report()
      },
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(turns).toBe(1)

    await worker.stop()
  })

  it('keeps turning, one period apart', async () => {
    let turns = 0
    const worker = startWorker({
      config: config({ cycleIntervalMs: 1_000 }),
      log,
      cycle: async () => {
        turns += 1
        return report()
      },
    })

    await vi.advanceTimersByTimeAsync(3_000)
    expect(turns).toBe(4)
    expect(worker.state.cycles).toBe(4)

    await worker.stop()
  })

  it('never runs two cycles at once', async () => {
    // Two at once would race to write the same day, each seeing a row the other
    // had not signed yet. The next one is scheduled after the current finishes,
    // so a cycle that outlasts its own period simply delays the next.
    let inFlight = 0
    let overlaps = 0
    let turns = 0

    const worker = startWorker({
      config: config({ cycleIntervalMs: 100 }),
      log,
      cycle: async () => {
        inFlight += 1
        if (inFlight > 1) overlaps += 1
        turns += 1
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        inFlight -= 1
        return report()
      },
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(overlaps).toBe(0)
    // Five seconds of 1s cycles with a 100ms gap: nowhere near fifty.
    expect(turns).toBeLessThan(6)

    // Stopped with the timers still frozen: the wait for the cycle in flight
    // only ends when something moves the clock.
    const stopped = worker.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    await stopped
  })

  it('logs a cycle that throws and turns again', async () => {
    // What reaches here is the layer below the dispatchers — the database, the
    // cluster — and the answer to that is to try again, not to exit.
    let turns = 0
    const worker = startWorker({
      config: config(),
      log,
      cycle: async () => {
        turns += 1
        if (turns === 1) throw new Error('the pooler went away')
        return report()
      },
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(worker.state.lastError).toBe('the pooler went away')
    expect(worker.state.cycles).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(turns).toBe(2)
    // Cleared by the next cycle that does not throw: an old error left standing
    // would read as a worker that is still failing.
    expect(worker.state.lastError).toBeNull()

    await worker.stop()
  })

  it('records why a cycle did nothing', async () => {
    const worker = startWorker({
      config: config(),
      log,
      cycle: async () => report({ skipped: 'no-pool', aggregatorMatches: false }),
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(worker.state.lastSkipped).toBe('no-pool')
    expect(worker.state.lastCycle).toBeNull()

    await worker.stop()
  })

  it('summarises a cycle that did something', async () => {
    const worker = startWorker({
      config: config(),
      log,
      cycle: async () =>
        report({
          days: [{ cellId: 1n, dayIndex: 4, status: 'submitted', txSignature: 'sig' }],
        }),
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(worker.state.lastCycle).toEqual({ submitted: 1, settled: 0, closed: 0, failed: 0 })
    expect(worker.state.lastSkipped).toBeNull()

    await worker.stop()
  })

  it('stops scheduling and waits for the cycle in flight', async () => {
    // `closeCellDay` writes the row, sends the transaction, then stores the
    // signature. Cut between the second and the third, the day is on chain with
    // no local record of it — recoverable, but by hand.
    let finished = false
    let turns = 0

    const worker = startWorker({
      config: config({ cycleIntervalMs: 100 }),
      log,
      cycle: async () => {
        turns += 1
        await new Promise((resolve) => setTimeout(resolve, 500))
        finished = true
        return report()
      },
    })

    await vi.advanceTimersByTimeAsync(10)
    const stopped = worker.stop()
    await vi.advanceTimersByTimeAsync(500)
    await stopped

    expect(finished).toBe(true)

    const after = turns
    await vi.advanceTimersByTimeAsync(5_000)
    expect(turns).toBe(after)
  })

  it('can be stopped twice', async () => {
    // Two signals in a row are an operator, not a bug.
    const worker = startWorker({ config: config(), log, cycle: async () => report() })

    await vi.advanceTimersByTimeAsync(0)
    await worker.stop()
    await expect(worker.stop()).resolves.toBeUndefined()
  })

  it('pings the keep-alive URL after a cycle, and a failed ping does not stop the loop', async () => {
    const seen: string[] = []
    const worker = startWorker({
      config: config({ keepAliveUrl: 'https://api.example/health' }),
      log,
      cycle: async () => report(),
      fetch: async (input) => {
        seen.push(String(input))
        throw new Error('asleep')
      },
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen).toEqual(['https://api.example/health', 'https://api.example/health'])
    expect(worker.state.cycles).toBe(2)

    await worker.stop()
  })

  it('does not ping when no URL is configured', async () => {
    // The single-service deployment is this case: a process pinging itself
    // proves nothing, and the pinger there is a scheduled GitHub Action.
    const call = vi.fn()
    const worker = startWorker({
      config: config({ keepAliveUrl: null }),
      log,
      cycle: async () => report(),
      fetch: call as unknown as typeof fetch,
    })

    await vi.advanceTimersByTimeAsync(2_000)
    expect(call).not.toHaveBeenCalled()

    await worker.stop()
  })
})
