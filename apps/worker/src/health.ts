import { createServer, type Server } from 'node:http'
import type { CycleSummary } from './cycle.ts'

/**
 * Whether the loop is still turning, asked from outside — `T057`.
 *
 * A worker has no requests, so nothing about it is visible from the network by
 * default: a cycle that has quietly stopped looks exactly like a cycle that has
 * nothing to do. That is the same failure class this project has kept finding
 * on chain — the caller that does not exist — and the cheapest way to make it
 * visible is to let something ask.
 *
 * **What it reports is the age of the last finished cycle**, not whether the
 * database or the cluster answered. A cycle that ran and failed is a loop that
 * is turning, and the failure is in the log with its reason; a cycle that has
 * not finished in several periods is a process that will not recover on its own
 * and is worth restarting. Only the second returns 503, because 503 is what a
 * platform restarts on.
 *
 * `node:http` rather than Hono: one route, no body parsing, no routing, and the
 * worker has no HTTP dependency to justify otherwise.
 */

export type WorkerHealthState = {
  startedAt: Date
  /** When the last cycle finished, whatever it did. Null before the first. */
  lastCycleAt: Date | null
  lastCycle: CycleSummary | null
  /** Why the last cycle did nothing, when it did nothing. */
  lastSkipped: string | null
  /** The last cycle's error, if it threw. Cleared by the next one that does not. */
  lastError: string | null
  cycles: number
}

export type HealthStatus =
  /** No cycle has finished yet, and not enough time has passed to worry. */
  | 'starting'
  | 'ok'
  /** No cycle has finished in a while. The loop is not turning. */
  | 'stalled'

export type HealthWire = {
  status: HealthStatus
  uptimeSeconds: number
  cycles: number
  lastCycleAgoSeconds: number | null
  lastCycle: CycleSummary | null
  lastSkipped: string | null
  lastError: string | null
}

/**
 * How long without a finished cycle counts as stalled.
 *
 * Several periods rather than one: a cycle that closes a backlog of days takes
 * longer than the interval that scheduled it, and a probe that fires on the
 * first slow cycle would restart the process that is doing the most work.
 */
export const STALLED_PERIODS = 4
export const MINIMUM_STALLED_MS = 60_000

export function stalledAfterMs(cycleIntervalMs: number): number {
  return Math.max(cycleIntervalMs * STALLED_PERIODS, MINIMUM_STALLED_MS)
}

export function healthOf(
  state: WorkerHealthState,
  now: Date,
  stalledMs: number,
): { status: HealthStatus; wire: HealthWire } {
  const uptimeMs = now.getTime() - state.startedAt.getTime()
  const sinceMs = state.lastCycleAt === null ? null : now.getTime() - state.lastCycleAt.getTime()

  // Before the first cycle the grace is measured from startup: a worker whose
  // very first cycle is a long backlog is starting, not stalled.
  const idleMs = sinceMs ?? uptimeMs
  const status: HealthStatus =
    idleMs > stalledMs ? 'stalled' : state.lastCycleAt === null ? 'starting' : 'ok'

  return {
    status,
    wire: {
      status,
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      cycles: state.cycles,
      lastCycleAgoSeconds: sinceMs === null ? null : Math.floor(sinceMs / 1000),
      lastCycle: state.lastCycle,
      lastSkipped: state.lastSkipped,
      lastError: state.lastError,
    },
  }
}

export type HealthServerOptions = {
  state: () => WorkerHealthState
  stalledMs: number
  now?: () => Date
}

/** `GET /health`; anything else is a 404. */
export function createHealthServer(options: HealthServerOptions): Server {
  const now = options.now ?? (() => new Date())

  return createServer((request, response) => {
    if (request.method !== 'GET' || (request.url ?? '').split('?')[0] !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }

    const { status, wire } = healthOf(options.state(), now(), options.stalledMs)
    response.writeHead(status === 'stalled' ? 503 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(wire))
  })
}
