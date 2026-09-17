import { PROGRAM_ID, PublicKey } from '@pumpking/anchor-client'
import { z } from 'zod'

/**
 * The environment the API process is started with — read once, at the top,
 * and refused loudly.
 *
 * A pure function over a record rather than a read of `process.env`, for the
 * same reason every route here is a factory: a config that can only be tested
 * by starting a process is a config nobody tests. `index.ts` calls this with
 * `process.env` and does nothing else with the environment.
 *
 * **Everything the process cannot work without is required.** A missing
 * `DATABASE_URL` is not a default to invent; a wrong `SOLANA_RPC_URL` is worse
 * than an absent one. The three that do have defaults have them because there
 * is a right answer: the port a platform assigns, the program the IDL was
 * built for, and a scenario mode that is off unless somebody says otherwise.
 */

/** `FR-042`, `FR-049`: the demo button exists only where this says `on`. */
const SCENARIO_MODE = ['on', 'off'] as const

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

// `object`, not `strictObject`: this is handed `process.env`, which carries the
// whole shell. Unknown keys are stripped rather than refused.
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  DATABASE_URL: z.string().min(1, 'is required: the API reads days and the registry from Postgres'),
  SOLANA_RPC_URL: z.url('must be an RPC endpoint: a policy is read from the chain'),
  PUMPKING_PROGRAM_ID: z.string().regex(BASE58, 'must be a base58 program address').optional(),
  SCENARIO_MODE: z.enum(SCENARIO_MODE).default('off'),
  LOG_LEVEL: z.string().default('info'),
  /**
   * Origins the browser is allowed to call from — `apps/web` is on a different
   * host than the API, so without this the interface cannot make one request.
   *
   * `*` by default, and that is not a hole being left open: every route here is
   * either a public read or authenticated by the sensor's own signature over
   * the reading. There is no cookie, no session and no ambient authority for an
   * origin to borrow, so CORS is not what protects anything — naming an origin
   * is tidiness, and pretending otherwise would be the actual risk.
   */
  WEB_ORIGIN: z.string().default('*'),
  /** How long in-flight requests get to finish before the process is killed. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
})

export type ApiConfig = {
  port: number
  databaseUrl: string
  rpcUrl: string
  programId: PublicKey
  scenarioMode: boolean
  logLevel: string
  /** `*`, or the list `WEB_ORIGIN` named. */
  webOrigin: string | string[]
  shutdownTimeoutMs: number
}

/** What a caller sees when the environment is wrong: every problem, not the first. */
export class ConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`the environment is not usable:\n${problems.map((one) => `  - ${one}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

export function readApiConfig(env: Record<string, string | undefined>): ApiConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`),
    )
  }
  const value = parsed.data

  return {
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    rpcUrl: value.SOLANA_RPC_URL,
    // The IDL's address is the program `anchor build` stamped, so an override
    // is for a second deployment of the same code and nothing else.
    programId:
      value.PUMPKING_PROGRAM_ID === undefined
        ? PROGRAM_ID
        : new PublicKey(value.PUMPKING_PROGRAM_ID),
    scenarioMode: value.SCENARIO_MODE === 'on',
    logLevel: value.LOG_LEVEL,
    webOrigin:
      value.WEB_ORIGIN === '*' ? '*' : value.WEB_ORIGIN.split(',').map((one) => one.trim()),
    shutdownTimeoutMs: value.SHUTDOWN_TIMEOUT_MS,
  }
}
