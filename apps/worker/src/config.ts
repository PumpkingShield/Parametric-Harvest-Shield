import { Keypair, PROGRAM_ID, PublicKey } from '@pumpking/anchor-client'
import { decodeBase58 } from '@pumpking/shared'
import { z } from 'zod'

/**
 * The environment the worker process is started with — read once, refused
 * loudly, and testable without a process.
 *
 * **Most of what aggregation needs is not here.** The clock (`genesis_ts`,
 * `seconds_per_day`), the dry threshold and the minimum number of votes are
 * fields of the on-chain `Pool`, and the worker reads them from it every cycle
 * rather than from an environment variable. A worker that believes a different
 * `genesis_ts` than the program computes a different day index, and a day
 * written under the wrong index is either a rejected transaction or a day
 * recorded in the wrong place — and it is compressed time (`FR-049`) that makes
 * this concrete rather than theoretical: a demo pool has `seconds_per_day = 2`,
 * and nobody is going to remember to set an env var to match.
 *
 * What is here is what the chain does not publish: how finely the worker cuts a
 * day into intervals, the coverage fraction a day needs (`FR-048`), how often
 * the loop turns and how far back it will reach.
 */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** 64 bytes: a keypair as `solana-keygen` writes it, secret then public. */
const KEYPAIR_BYTES = 64

/**
 * The aggregator's keypair, as an environment variable can carry it.
 *
 * Two forms because both exist in the wild and neither is guessable from the
 * other: the JSON array `solana-keygen` writes into `id.json`, and the base58
 * a secret manager holds on one line. Anything else is refused rather than
 * half-parsed — a key read wrong is a signature by nobody.
 */
export function parseKeypair(value: string): Keypair {
  const text = value.trim()

  if (text.startsWith('[')) {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed) || parsed.length !== KEYPAIR_BYTES) {
      throw new Error(
        `must be ${KEYPAIR_BYTES} bytes, got ${Array.isArray(parsed) ? parsed.length : 'not an array'}`,
      )
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]))
  }

  const bytes = decodeBase58(text, KEYPAIR_BYTES)
  if (bytes === null) {
    throw new Error(`must be a JSON array or base58 of ${KEYPAIR_BYTES} bytes`)
  }
  return Keypair.fromSecretKey(bytes)
}

// `object`, not `strictObject`: this is handed `process.env`, which carries the
// whole shell. Unknown keys are stripped rather than refused.
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'is required: readings and days live in Postgres'),
  SOLANA_RPC_URL: z.url('must be an RPC endpoint: the worker reads the pool and sends days'),
  PUMPKING_PROGRAM_ID: z.string().regex(BASE58, 'must be a base58 program address').optional(),
  /** `FR-015`: the only key the program takes a day record from. It signs. */
  AGGREGATOR_KEYPAIR: z.string().min(1, 'is required: a day record is signed by the aggregator'),
  LOG_LEVEL: z.string().default('info'),
  /** Its own port: the API's is a different service on a different one. */
  WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
  /**
   * How finely a day is cut. Not on chain — the program stores a day and gets
   * the count as `total_intervals` inside the record (`FR-048`). Twenty-four in
   * production; a compressed run divides its two seconds by the same number.
   */
  INTERVALS_PER_DAY: z.coerce.number().int().min(1).max(65_535).default(24),
  /** `FR-048`: hundredths of a day's intervals that must carry a value. */
  MINIMUM_COVERAGE_X100: z.coerce.number().int().min(0).max(100).default(75),
  /**
   * How often the loop turns.
   *
   * Well under a compressed day (two seconds) is not the requirement — a run
   * closes days in a batch — but `SC-001` gives sixty seconds from a closed
   * interval to money in the farmer's account, and those seconds should be
   * spent on confirmation rather than on waiting for the next tick.
   */
  CYCLE_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
  /** `DEFAULT_BACKLOG_DAYS`: how far back a run reaches for days it missed. */
  BACKLOG_DAYS: z.coerce.number().int().min(1).default(7),
  /**
   * A URL pinged once a cycle so a free tier does not idle the API to sleep.
   *
   * Empty by default, and it points at the *other* service on purpose: a
   * process pinging itself proves nothing about whether it is awake. The worker
   * is the one that has a reason to be running anyway.
   */
  KEEPALIVE_URL: z.string().default(''),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
})

export type WorkerConfig = {
  databaseUrl: string
  rpcUrl: string
  programId: PublicKey
  aggregator: Keypair
  logLevel: string
  port: number
  intervalsPerDay: number
  minimumCoverageX100: number
  cycleIntervalMs: number
  backlogDays: number
  keepAliveUrl: string | null
  shutdownTimeoutMs: number
}

/** What a caller sees when the environment is wrong: every problem, not the first. */
export class ConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`the environment is not usable:\n${problems.map((one) => `  - ${one}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

export function readWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`),
    )
  }
  const value = parsed.data

  let aggregator: Keypair
  try {
    aggregator = parseKeypair(value.AGGREGATOR_KEYPAIR)
  } catch (cause) {
    throw new ConfigError([
      `AGGREGATOR_KEYPAIR: ${cause instanceof Error ? cause.message : String(cause)}`,
    ])
  }

  return {
    databaseUrl: value.DATABASE_URL,
    rpcUrl: value.SOLANA_RPC_URL,
    programId:
      value.PUMPKING_PROGRAM_ID === undefined
        ? PROGRAM_ID
        : new PublicKey(value.PUMPKING_PROGRAM_ID),
    aggregator,
    logLevel: value.LOG_LEVEL,
    port: value.WORKER_PORT,
    intervalsPerDay: value.INTERVALS_PER_DAY,
    minimumCoverageX100: value.MINIMUM_COVERAGE_X100,
    cycleIntervalMs: value.CYCLE_INTERVAL_MS,
    backlogDays: value.BACKLOG_DAYS,
    keepAliveUrl: value.KEEPALIVE_URL.trim() === '' ? null : value.KEEPALIVE_URL.trim(),
    shutdownTimeoutMs: value.SHUTDOWN_TIMEOUT_MS,
  }
}
