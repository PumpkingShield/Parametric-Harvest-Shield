import type { StripCell } from '../data/rainfall.ts'
import { formatMillimetres } from './value.ts'

/**
 * The operator screen's reads of the API — `T040`, `FR-036`, `FR-050`.
 *
 * `GET /v1/sensors/:pubkey/activity` and `GET /v1/cells/:cellId/sensors`: what
 * the aggregator made of this phone's readings, what it paid for each day, and
 * who else measures the cell. Parsed by hand like `publish.ts` — the shape is
 * refused at the boundary, without a schema library in the chunk.
 *
 * Money as it stands now is not read here. Stake and what waits to be claimed
 * are the chain's (`earnings.ts`), read beside the button that claims it.
 */

/** `ReadingVerdict` as `apps/api/src/routes/activity.ts` sends it. */
export type ReadingVerdict =
  | 'counted'
  | 'outlier'
  | 'not-counted'
  | 'no-median'
  | 'pending'
  | 'late'

const VERDICTS: readonly string[] = [
  'counted',
  'outlier',
  'not-counted',
  'no-median',
  'pending',
  'late',
]

export type ActivityReading = {
  measuredAt: string
  cellId: string
  valueX100: number
  verdict: ReadingVerdict
  medianX100: number | null
}

export type EarnedDay = {
  cellId: string
  dayIndex: number
  startsAt: string | null
  /** Base units, decimal. */
  amount: string
}

export type Activity = {
  since: string
  until: string
  readings: ActivityReading[]
  earned: { total: string; days: EarnedDay[] }
}

export type CellSensor = {
  pubkey: string
  operator: string
  slot: number
  stake: string
  voting: boolean
  problem: 'excluded' | 'understaked' | 'no-pool' | null
  judged: number
  outliers: number
}

export type CellSensors = {
  cellId: string
  minStake: string | null
  windowDays: number
  sensors: CellSensor[]
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const isDecimal = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+$/.test(value)

function asReading(value: unknown): ActivityReading | null {
  const v = record(value)
  if (
    v === null ||
    typeof v.measuredAt !== 'string' ||
    typeof v.cellId !== 'string' ||
    typeof v.valueX100 !== 'number' ||
    typeof v.verdict !== 'string' ||
    !VERDICTS.includes(v.verdict) ||
    !(v.medianX100 === null || typeof v.medianX100 === 'number')
  ) {
    return null
  }
  return {
    measuredAt: v.measuredAt,
    cellId: v.cellId,
    valueX100: v.valueX100,
    verdict: v.verdict as ReadingVerdict,
    medianX100: v.medianX100,
  }
}

function asEarnedDay(value: unknown): EarnedDay | null {
  const v = record(value)
  if (
    v === null ||
    typeof v.cellId !== 'string' ||
    typeof v.dayIndex !== 'number' ||
    !(v.startsAt === null || typeof v.startsAt === 'string') ||
    !isDecimal(v.amount)
  ) {
    return null
  }
  return { cellId: v.cellId, dayIndex: v.dayIndex, startsAt: v.startsAt, amount: v.amount }
}

/** Every element, or null if any one is not the shape. */
function all<T>(value: unknown, one: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const out: T[] = []
  for (const item of value) {
    const parsed = one(item)
    if (parsed === null) return null
    out.push(parsed)
  }
  return out
}

export function asActivity(value: unknown): Activity | null {
  const v = record(value)
  const earned = record(v?.earned)
  if (v === null || earned === null) return null
  if (typeof v.since !== 'string' || typeof v.until !== 'string' || !isDecimal(earned.total)) {
    return null
  }
  const readings = all(v.readings, asReading)
  const days = all(earned.days, asEarnedDay)
  if (readings === null || days === null) return null
  return { since: v.since, until: v.until, readings, earned: { total: earned.total, days } }
}

const PROBLEMS: readonly string[] = ['excluded', 'understaked', 'no-pool']

function asCellSensor(value: unknown): CellSensor | null {
  const v = record(value)
  if (
    v === null ||
    typeof v.pubkey !== 'string' ||
    typeof v.operator !== 'string' ||
    typeof v.slot !== 'number' ||
    !isDecimal(v.stake) ||
    typeof v.voting !== 'boolean' ||
    !(v.problem === null || (typeof v.problem === 'string' && PROBLEMS.includes(v.problem))) ||
    typeof v.judged !== 'number' ||
    typeof v.outliers !== 'number'
  ) {
    return null
  }
  return {
    pubkey: v.pubkey,
    operator: v.operator,
    slot: v.slot,
    stake: v.stake,
    voting: v.voting,
    problem: v.problem as CellSensor['problem'],
    judged: v.judged,
    outliers: v.outliers,
  }
}

export function asCellSensors(value: unknown): CellSensors | null {
  const v = record(value)
  if (
    v === null ||
    typeof v.cellId !== 'string' ||
    !(v.minStake === null || isDecimal(v.minStake)) ||
    typeof v.windowDays !== 'number'
  ) {
    return null
  }
  const sensors = all(v.sensors, asCellSensor)
  if (sensors === null) return null
  return { cellId: v.cellId, minStake: v.minStake, windowDays: v.windowDays, sensors }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type Read<T> = { kind: 'read'; value: T } | { kind: 'failed'; message: string }

async function read<T>(
  url: string,
  fetchFn: Fetch,
  parse: (value: unknown) => T | null,
): Promise<Read<T>> {
  let response: Response
  try {
    response = await fetchFn(url)
  } catch {
    return { kind: 'failed', message: 'The service did not answer. Check the connection.' }
  }
  const value = response.ok ? parse(await response.json().catch(() => null)) : null
  return value === null
    ? { kind: 'failed', message: `The service answered ${response.status}.` }
    : { kind: 'read', value }
}

export function fetchActivity(
  apiUrl: string,
  pubkey: string,
  fetchFn: Fetch,
): Promise<Read<Activity>> {
  return read(`${apiUrl}/v1/sensors/${pubkey}/activity`, fetchFn, asActivity)
}

export function fetchCellSensors(
  apiUrl: string,
  cellId: string,
  fetchFn: Fetch,
): Promise<Read<CellSensors>> {
  return read(`${apiUrl}/v1/cells/${cellId}/sensors`, fetchFn, asCellSensors)
}

/* -------------------------------------------------------------------------- */
/* What the screen says                                                       */
/* -------------------------------------------------------------------------- */

/** How many of the readings came to each verdict. */
export function verdictCounts(
  readings: readonly ActivityReading[],
): Record<ReadingVerdict, number> {
  const counts: Record<ReadingVerdict, number> = {
    counted: 0,
    outlier: 0,
    'not-counted': 0,
    'no-median': 0,
    pending: 0,
    late: 0,
  }
  for (const reading of readings) counts[reading.verdict] += 1
  return counts
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** What happened to a reading, in one line. */
export function verdictText(reading: ActivityReading): string {
  const median =
    reading.medianX100 === null ? '' : `, cell median ${formatMillimetres(reading.medianX100)} mm`
  switch (reading.verdict) {
    case 'counted':
      return `counted in the median${median}`
    case 'outlier':
      return `judged an outlier${median} — repeated outliers cost the stake`
    case 'not-counted':
      return `stored, not counted: this sensor had no vote in that interval${median}`
    case 'no-median':
      return 'stored: too few sensors voted in that interval for a median'
    case 'pending':
      return 'waiting for the day to close'
    case 'late':
      return 'stored as late, not counted'
  }
}

/**
 * The readings as squares, oldest first: counted is filled, an outlier is the
 * dashed square of a value nobody can stand behind, the rest are quiet.
 */
export function readingSquares(readings: readonly ActivityReading[]): StripCell[] {
  return [...readings]
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt))
    .map((reading) => ({
      state:
        reading.verdict === 'counted'
          ? 'filled'
          : reading.verdict === 'outlier'
            ? 'none'
            : 'future',
      detail: `${clock(reading.measuredAt)} — ${formatMillimetres(reading.valueX100)} mm — ${verdictText(reading)}`,
    }))
}

/** A peer's standing in one line. */
export function peerStatus(sensor: CellSensor): string {
  if (sensor.voting) return 'voting'
  switch (sensor.problem) {
    case 'understaked':
      return 'no stake — readings stored, not counted'
    case 'excluded':
      return 'excluded for repeated outliers — readings stored, not counted'
    case 'no-pool':
      return 'no pool on this network yet'
    case null:
      return 'not voting'
  }
}

/** A key as the list prints it: first four, last four. */
export function shortKey(key: string): string {
  return key.length <= 10 ? key : `${key.slice(0, 4)}…${key.slice(-4)}`
}
