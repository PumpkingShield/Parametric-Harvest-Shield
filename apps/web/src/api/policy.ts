/**
 * The two reads the policy screen is built from — `GET /v1/policies/:pubkey`
 * and `GET /v1/cells/:cellId/days?from&to`.
 *
 * Parsed by hand rather than with Zod. The page is read on a cheap phone
 * outdoors and `SC-013` budgets two seconds on 3G for it; the project has
 * already dropped a CSS framework and rerouted an import to keep the first
 * screen at 202 kB, and two response shapes do not justify putting a schema
 * library back into that number. What the rule asks for — refuse an answer
 * that is not the shape, at the boundary, without a cast — is what these
 * functions do.
 */

/** `PolicyWire` as `apps/api/src/routes/policies.ts` sends it. */
export interface Policy {
  policy: string
  owner: string
  /** Decimal strings: `u64` does not survive a JSON number. */
  nonce: string
  /** H3 index in hex — the argument the day journal is asked for by. */
  cellId: string
  spellDaysThreshold: number
  payout: string
  premium: string
  windowStartDay: number
  windowEndDay: number
  windowDays: number
  state: string
  /** The run the aggregator's own rows see, counted by `spellInWindow`. */
  spell: number
  /** Days of the window the aggregator has a row for. */
  recordedDays: number
}

/** `DayWire` as `apps/api/src/routes/cells.ts` sends it. */
export interface Day {
  dayIndex: number
  /** 0 no coverage, 1 dry, 2 wet — the same byte the program stores. */
  state: number
  /** Null and not zero: zero is a measured dry sky, null is silence. */
  rainfallX100: number | null
  coveredHours: number
  merkleRoot: string | null
  txSignature: string | null
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): value is string {
  return typeof value === 'string'
}

function int(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

export function parsePolicy(value: unknown): Policy {
  const row = record(value)
  if (
    row === null ||
    !str(row.policy) ||
    !str(row.owner) ||
    !str(row.nonce) ||
    !str(row.cellId) ||
    !int(row.spellDaysThreshold) ||
    !str(row.payout) ||
    !str(row.premium) ||
    !int(row.windowStartDay) ||
    !int(row.windowEndDay) ||
    !int(row.windowDays) ||
    !str(row.state) ||
    !int(row.spell) ||
    !int(row.recordedDays)
  ) {
    throw new Error('the API answered with something that is not a policy')
  }

  return {
    policy: row.policy,
    owner: row.owner,
    nonce: row.nonce,
    cellId: row.cellId,
    spellDaysThreshold: row.spellDaysThreshold,
    payout: row.payout,
    premium: row.premium,
    windowStartDay: row.windowStartDay,
    windowEndDay: row.windowEndDay,
    windowDays: row.windowDays,
    state: row.state,
    spell: row.spell,
    recordedDays: row.recordedDays,
  }
}

function parseDay(value: unknown): Day {
  const row = record(value)
  if (
    row === null ||
    !int(row.dayIndex) ||
    !int(row.state) ||
    !(row.rainfallX100 === null || int(row.rainfallX100)) ||
    !int(row.coveredHours) ||
    !(row.merkleRoot === null || str(row.merkleRoot)) ||
    !(row.txSignature === null || str(row.txSignature))
  ) {
    throw new Error('the API answered with something that is not a day journal')
  }

  return {
    dayIndex: row.dayIndex,
    state: row.state,
    rainfallX100: row.rainfallX100 === null ? null : (row.rainfallX100 as number),
    coveredHours: row.coveredHours,
    merkleRoot: row.merkleRoot === null ? null : (row.merkleRoot as string),
    txSignature: row.txSignature === null ? null : (row.txSignature as string),
  }
}

export function parseDays(value: unknown): Day[] {
  const envelope = record(value)
  if (envelope === null || !Array.isArray(envelope.days)) {
    throw new Error('the API answered with something that is not a day journal')
  }
  return envelope.days.map(parseDay)
}

export interface RequestOptions {
  /** Injected so the client is tested without a server. */
  fetch?: typeof fetch
  signal?: AbortSignal
}

async function read(url: string, options: RequestOptions): Promise<unknown> {
  const call = options.fetch ?? fetch
  const response = await call(url, options.signal ? { signal: options.signal } : {})

  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A proxy in front of a sleeping service answers HTML, and a parse error
    // from deep inside would send the reader looking in the wrong place.
    throw new ApiError(`the API answered ${response.status} and not JSON`, response.status)
  }

  if (!response.ok) {
    const named = record(body)?.error
    throw new ApiError(str(named) ? named : `the API answered ${response.status}`, response.status)
  }
  return body
}

function origin(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '')
}

export async function fetchPolicy(
  apiUrl: string,
  address: string,
  options: RequestOptions = {},
): Promise<Policy> {
  return parsePolicy(
    await read(`${origin(apiUrl)}/v1/policies/${encodeURIComponent(address)}`, options),
  )
}

export async function fetchDays(
  apiUrl: string,
  cellId: string,
  from: number,
  to: number,
  options: RequestOptions = {},
): Promise<Day[]> {
  return parseDays(
    await read(
      `${origin(apiUrl)}/v1/cells/${encodeURIComponent(cellId)}/days?from=${from}&to=${to}`,
      options,
    ),
  )
}
