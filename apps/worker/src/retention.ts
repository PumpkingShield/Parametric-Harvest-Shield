import {
  cutoffsBefore,
  type RetentionStore,
  retentionCutoffs,
  type SweepResult,
} from '@pumpking/db'

/**
 * The retention sweep, turned by the worker — `T055`.
 *
 * The fourth dispatcher, and it follows the lesson of the other three: a sweep
 * that exists as a function and not as a step of the loop is a sweep that does
 * not happen. It is the last step of a cycle, after every day, settlement and
 * closure, because it is the only one with no deadline.
 *
 * **Once an hour, not once a cycle.** The cycle turns every few seconds; the
 * rows it removes age by the day. Deleting twelve hundred times an hour what
 * could be deleted once would be twelve hundred statements for the same rows.
 *
 * **A failed sweep does not fail the cycle.** Its days are already on chain by
 * the time it runs, and a database that refused a delete is reported, then
 * asked again an hour later rather than on the next turn — a sweep that fails
 * because the database is struggling should not be what keeps it struggling.
 */

export const SWEEP_EVERY_MS = 3_600_000

export type SweepOutcome = ({ status: 'swept' } & SweepResult) | { status: 'failed'; error: Error }

export interface RetentionSweeper {
  /**
   * Sweeps if an hour has passed since the last attempt, and returns null
   * otherwise. `horizon` is the earliest instant a cycle may still read from;
   * nothing newer is swept, whatever retention says.
   */
  sweepIfDue(now: Date, horizon: Date): Promise<SweepOutcome | null>
}

export function retentionSweeper(
  store: RetentionStore,
  everyMs: number = SWEEP_EVERY_MS,
): RetentionSweeper {
  if (!Number.isInteger(everyMs) || everyMs < 1) {
    throw new RangeError(`everyMs must be a positive integer: ${everyMs}`)
  }
  let lastAttemptAt: number | null = null

  return {
    async sweepIfDue(now, horizon) {
      const at = now.getTime()
      if (lastAttemptAt !== null && at - lastAttemptAt < everyMs) return null
      // Recorded before the attempt, so a failure waits its hour too.
      lastAttemptAt = at
      try {
        const swept = await store.sweep(cutoffsBefore(retentionCutoffs(now), horizon))
        return { status: 'swept', ...swept }
      } catch (cause) {
        return {
          status: 'failed',
          error: cause instanceof Error ? cause : new Error(String(cause)),
        }
      }
    },
  }
}
