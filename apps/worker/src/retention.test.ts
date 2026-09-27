import type { RetentionCutoffs, RetentionStore, SweepResult } from '@pumpking/db'
import { describe, expect, it } from 'vitest'
import { retentionSweeper, SWEEP_EVERY_MS } from './retention.ts'

/**
 * When the sweep runs. What it deletes is `@pumpking/db`'s; how often it is
 * asked, and what happens when it refuses, is the worker's.
 */

class Store implements RetentionStore {
  asked: RetentionCutoffs[] = []
  failures = 0
  sweep(cutoffs: RetentionCutoffs): Promise<SweepResult> {
    this.asked.push(cutoffs)
    if (this.failures > 0) {
      this.failures -= 1
      return Promise.reject(new Error('connection reset'))
    }
    return Promise.resolve({ readings: 3, cellHours: 1 })
  }
}

const NOW = new Date('2026-09-27T10:00:00Z')
const at = (ms: number) => new Date(NOW.getTime() + ms)

describe('retentionSweeper', () => {
  it('sweeps on its first call — a fresh process does not wait an hour', async () => {
    const store = new Store()
    const outcome = await retentionSweeper(store).sweepIfDue(NOW, NOW)

    expect(outcome).toEqual({ status: 'swept', readings: 3, cellHours: 1 })
    expect(store.asked).toHaveLength(1)
  })

  it('sweeps once an hour, not once a cycle', async () => {
    const store = new Store()
    const sweeper = retentionSweeper(store)

    await sweeper.sweepIfDue(NOW, NOW)
    expect(await sweeper.sweepIfDue(at(5_000), NOW)).toBeNull()
    expect(await sweeper.sweepIfDue(at(SWEEP_EVERY_MS - 1), NOW)).toBeNull()
    expect(await sweeper.sweepIfDue(at(SWEEP_EVERY_MS), NOW)).not.toBeNull()

    expect(store.asked).toHaveLength(2)
  })

  it('a failure is an outcome, and it waits its hour like a success', async () => {
    const store = new Store()
    store.failures = 1
    const sweeper = retentionSweeper(store)

    const first = await sweeper.sweepIfDue(NOW, NOW)
    expect(first?.status).toBe('failed')
    expect(first?.status === 'failed' ? first.error.message : null).toBe('connection reset')

    // Asked again on the next turn, a struggling database would be asked
    // twelve hundred times an hour by the very job meant to relieve it.
    expect(await sweeper.sweepIfDue(at(5_000), NOW)).toBeNull()
    expect((await sweeper.sweepIfDue(at(SWEEP_EVERY_MS), NOW))?.status).toBe('swept')
  })

  it('cuts at retention when the horizon is newer', async () => {
    const store = new Store()
    // A compressed clock: its oldest backlog day began a minute ago.
    await retentionSweeper(store).sweepIfDue(NOW, at(-60_000))

    expect(store.asked).toEqual([
      {
        readings: new Date('2026-08-28T10:00:00Z'),
        cellHours: new Date('2025-09-27T10:00:00Z'),
      },
    ])
  })

  it('cuts at the horizon when it is older than retention', async () => {
    const store = new Store()
    const horizon = new Date('2026-08-20T00:00:00Z')
    await retentionSweeper(store).sweepIfDue(NOW, horizon)

    expect(store.asked[0]?.readings).toEqual(horizon)
    // Twelve months back is already older than any backlog.
    expect(store.asked[0]?.cellHours).toEqual(new Date('2025-09-27T10:00:00Z'))
  })

  it('refuses a period that is not a positive number of milliseconds', () => {
    expect(() => retentionSweeper(new Store(), 0)).toThrow(RangeError)
    expect(() => retentionSweeper(new Store(), 1.5)).toThrow(RangeError)
  })
})
