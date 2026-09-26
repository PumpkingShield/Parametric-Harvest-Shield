import type { Logger } from 'pino'

/**
 * What a process does with a failure nobody is waiting for — `T068`.
 *
 * **The failure that made this necessary is not ours.** `sendAndConfirmTransaction`
 * in `@solana/web3.js` 1.98 confirms through `confirmTransaction`, which starts
 * an `async` function it never awaits and never catches: once the signature
 * subscription is up, it asks `getSignatureStatus` once, early. When the RPC
 * answers that call with `429`, the rejection has no owner, and Node's default
 * for an unhandled rejection is to end the process. On 2026-09-21 that took the
 * API down in the middle of a scenario run, and the run — which lives in the
 * process's memory — went with it; a platform restart does not bring it back.
 *
 * The promise that rejected had no awaiter, so nothing that is waiting for an
 * answer is left without one: the confirmation it belonged to still finishes
 * through the subscription or the block height. Logging it and carrying on is
 * the correct response, not a tolerated one.
 *
 * **An uncaught exception is different, and still ends the process.** A throw
 * that reached the top of the stack left whatever it was in the middle of
 * half-done, and Node documents that resuming after it is unsafe. The guard
 * says why the process is going before it goes, which the default does not do
 * in a form a log search finds.
 */
export type GuardedProcess = {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown
  exit(code: number): void
}

export function guardProcess(target: GuardedProcess, log: Logger): void {
  target.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'a promise nobody awaited was rejected; carrying on')
  })
  target.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'uncaught exception; exiting')
    target.exit(1)
  })
}
