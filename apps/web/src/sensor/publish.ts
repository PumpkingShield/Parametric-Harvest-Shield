import { cellIdFromH3Index } from '@pumpking/shared/cell-id'
import {
  ReadingKind,
  type SignedReadingWire,
  toSignedReadingWire,
} from '@pumpking/shared/reading-bytes'
import { sensorPublicKey, signReading } from '@pumpking/shared/signature'
import type { SensorRecord } from './vault.ts'

/**
 * Signing a reading and sending it — `FR-002`, `FR-003`, `FR-005`.
 *
 * The bytes signed are `canonicalReadingBytes`, imported, never re-described:
 * a phone whose layout differs from the server's by one byte signs readings
 * that verify nowhere. The imports are subpaths for the same reason the policy
 * screen's are (`CLAUDE.md`): the barrel would pull `h3-js` and Zod into a
 * page that needs neither.
 *
 * The two reads of the API are parsed by hand, like `api/policy.ts`: refuse a
 * shape that is not the one expected, at the boundary, without a schema
 * library in the bundle.
 */

/** `SensorWire` as `apps/api/src/routes/sensors.ts` sends it. */
export type Registration = {
  pubkey: string
  cellId: string
  stake: string
  minStake: string | null
  voting: boolean
  problem: 'unregistered' | 'excluded' | 'understaked' | 'no-pool' | null
}

export type LookUp =
  | { kind: 'registered'; registration: Registration }
  | { kind: 'unknown' }
  | { kind: 'unreachable'; message: string }

const PROBLEMS: readonly string[] = ['unregistered', 'excluded', 'understaked', 'no-pool']

function isProblem(value: unknown): value is Registration['problem'] {
  return value === null || (typeof value === 'string' && PROBLEMS.includes(value))
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asRegistration(value: unknown): Registration | null {
  const v = record(value)
  if (
    v === null ||
    typeof v.pubkey !== 'string' ||
    typeof v.cellId !== 'string' ||
    typeof v.stake !== 'string' ||
    !(v.minStake === null || typeof v.minStake === 'string') ||
    typeof v.voting !== 'boolean' ||
    !isProblem(v.problem)
  ) {
    return null
  }
  return {
    pubkey: v.pubkey,
    cellId: v.cellId,
    stake: v.stake,
    minStake: v.minStake,
    voting: v.voting,
    problem: v.problem,
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Where the key is registered — the cell every reading has to name (`FR-058`). */
export async function lookUpSensor(
  apiUrl: string,
  pubkey: string,
  fetchFn: Fetch,
): Promise<LookUp> {
  let response: Response
  try {
    response = await fetchFn(`${apiUrl}/v1/sensors/${pubkey}`)
  } catch {
    return { kind: 'unreachable', message: 'The service did not answer. Check the connection.' }
  }
  if (response.status === 404) return { kind: 'unknown' }
  const registration = response.ok ? asRegistration(await response.json()) : null
  if (registration === null) {
    return { kind: 'unreachable', message: `The service answered ${response.status}.` }
  }
  return { kind: 'registered', registration }
}

/**
 * The next reading, signed, and the record that has to be saved before it is
 * sent: the counter moves here, and only here.
 */
export async function signNext(
  record: SensorRecord,
  cellHex: string,
  valueX100: number,
  measuredAt: Date,
): Promise<{ body: SignedReadingWire; record: SensorRecord }> {
  const counter = record.lastCounter + 1n
  // Milliseconds are what the canonical bytes hold; the wire's ISO string says
  // the same instant, so the server rebuilds exactly the bytes signed here.
  const reading = {
    sensor: await sensorPublicKey(record.secretKey),
    cellId: cellIdFromH3Index(cellHex),
    kind: ReadingKind.PrecipitationMm,
    valueX100,
    measuredAt,
    counter,
  }
  const signature = await signReading(reading, record.secretKey)
  const body = toSignedReadingWire({ ...reading, signature })
  return { body, record: { ...record, lastCounter: counter, pending: body } }
}

/** What happened to a reading, as the person holding the phone needs to know it. */
export type Sent =
  /** Stored. `accepted` counts, `late` does not (`FR-004`). */
  | { kind: 'stored'; status: 'accepted' | 'late' }
  /** Refused for good: sending the same body again gets the same answer. */
  | { kind: 'refused'; message: string }
  /** No answer, or one that says to try again: the body is kept for a retry. */
  | { kind: 'retry'; message: string }

/** The API's refusal (`errors.ts`): its message, and the first field's. */
function refusalMessage(value: unknown, status: number): string {
  const error = record(record(value)?.error)
  if (error === null || typeof error.message !== 'string') {
    return `The service answered ${status}.`
  }
  const fields = record(error.details)?.fields
  const first = Array.isArray(fields) ? record(fields[0]) : null
  return typeof first?.message === 'string' ? `${error.message}: ${first.message}` : error.message
}

export async function sendReading(
  apiUrl: string,
  body: SignedReadingWire,
  fetchFn: Fetch,
): Promise<Sent> {
  let response: Response
  try {
    response = await fetchFn(`${apiUrl}/v1/readings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { kind: 'retry', message: 'No answer from the service. The reading is kept.' }
  }

  const json: unknown = await response.json().catch(() => null)
  // 201 the first time, 200 when this exact body arrived before and its answer
  // was lost on the way back — the same reading either way (`readings.ts`).
  if (response.status === 200 || response.status === 201) {
    const status = record(json)?.status
    if (status === 'accepted' || status === 'late') return { kind: 'stored', status }
    return { kind: 'retry', message: 'The service answered in a shape this page does not know.' }
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: 'retry', message: refusalMessage(json, response.status) }
  }
  return { kind: 'refused', message: refusalMessage(json, response.status) }
}
