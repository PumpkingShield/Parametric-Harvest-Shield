import type { ReadingRow, ReadingStore, SaveOutcome, SensorRegistration } from '@pumpking/db'
import {
  cellIdFromH3Index,
  type Reading,
  ReadingKind,
  sensorPublicKey,
  signReading,
  toSignedReadingWire,
} from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { classifyArrival, createReadingsRoute, DEFAULT_MAX_AGE_MS } from './readings.ts'

const H3 = '871e701b3ffffff'
const CELL_ID = cellIdFromH3Index(H3)
const MEASURED_AT = new Date('2026-08-29T12:00:00.000Z')

/** A sensor with a known secret, so a test can sign the way a device does. */
const SEED = new Uint8Array(32).fill(9)

/** The rows a fake store holds, keyed the way the unique index is. */
class FakeStore implements ReadingStore {
  registrations = new Map<string, SensorRegistration>()
  rows = new Map<string, ReadingRow>()

  sensorFor(pubkey: string): Promise<SensorRegistration | null> {
    return Promise.resolve(this.registrations.get(pubkey) ?? null)
  }

  save(row: ReadingRow): Promise<SaveOutcome> {
    const key = `${row.sensorPubkey}/${row.counter}`
    const existing = this.rows.get(key)
    if (existing !== undefined) {
      return Promise.resolve({
        stored: false,
        existingSignature: existing.signature,
        status: existing.status,
      })
    }
    this.rows.set(key, row)
    return Promise.resolve({ stored: true, status: row.status })
  }
}

let store: FakeStore
let sensor: string

beforeEach(async () => {
  store = new FakeStore()
  sensor = await sensorPublicKey(SEED)
  store.registrations.set(sensor, {
    pubkey: sensor,
    cellId: CELL_ID,
    kind: ReadingKind.PrecipitationMm,
    active: true,
  })
})

function reading(overrides: Partial<Reading> = {}): Reading {
  return {
    sensor,
    cellId: CELL_ID,
    kind: ReadingKind.PrecipitationMm,
    valueX100: 250,
    measuredAt: MEASURED_AT,
    counter: 1n,
    ...overrides,
  }
}

/** The request body a device sends: signed, then rendered to wire JSON. */
async function body(overrides: Partial<Reading> = {}): Promise<Record<string, unknown>> {
  const value = reading(overrides)
  const signature = await signReading(value, SEED)
  return toSignedReadingWire({ ...value, signature }) as unknown as Record<string, unknown>
}

async function post(payload: unknown, at = MEASURED_AT): Promise<Response> {
  const route = createReadingsRoute({ store, now: () => at })
  return await route.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

describe('classifyArrival', () => {
  it('accepts a reading inside the window and marks a later one late', () => {
    const measured = new Date('2026-08-29T12:00:00Z')
    const inside = new Date(measured.getTime() + DEFAULT_MAX_AGE_MS)
    const outside = new Date(measured.getTime() + DEFAULT_MAX_AGE_MS + 1)
    expect(classifyArrival(measured, inside, DEFAULT_MAX_AGE_MS)).toBe('accepted')
    expect(classifyArrival(measured, outside, DEFAULT_MAX_AGE_MS)).toBe('late')
  })

  /**
   * `FR-004` is one-sided. A reading from the future has no closed hour to go
   * into, and a sensor whose clock runs fast must not be able to vote early in
   * an interval nobody else can see yet.
   */
  it('treats a reading from the future as late', () => {
    const measured = new Date('2026-08-29T12:00:00Z')
    const before = new Date(measured.getTime() - 1)
    expect(classifyArrival(measured, before, DEFAULT_MAX_AGE_MS)).toBe('late')
  })
})

describe('POST /v1/readings', () => {
  it('stores a signed reading from a registered sensor', async () => {
    const response = await post(await body())
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ status: 'accepted', counter: 1 })
    expect(store.rows.size).toBe(1)
  })

  /** `FR-004`: stored, and out of the index. */
  it('stores a late reading and says so', async () => {
    const late = new Date(MEASURED_AT.getTime() + DEFAULT_MAX_AGE_MS + 1)
    const response = await post(await body(), late)
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ status: 'late' })
    expect([...store.rows.values()][0]?.status).toBe('late')
  })

  /* ------------------------------------------------------------------ */
  /* FR-002: signed by a registered key, or it is not a measurement      */
  /* ------------------------------------------------------------------ */

  it('refuses a reading whose signature does not cover its values', async () => {
    // A value changed after signing — the commonest shape of a forgery, and
    // the one a naive "verify the fields we like" check would miss.
    const tampered = { ...(await body()), valueX100: 0 }
    const response = await post(tampered)
    expect(response.status).toBe(401)
    expect(store.rows.size).toBe(0)
  })

  it('refuses a reading from a key nobody registered', async () => {
    store.registrations.clear()
    const response = await post(await body())
    expect(response.status).toBe(401)
    expect(store.rows.size).toBe(0)
  })

  /**
   * An unknown key and a bad signature get the same answer on purpose. Which
   * keys are registered is not a list an unauthenticated caller gets to walk.
   */
  it('does not tell a stranger which keys exist', async () => {
    // A registered key with a signature that does not cover the values, and
    // an untouched signature from a key nobody registered.
    const forged = await post({ ...(await body()), valueX100: 0 })
    const genuine = await body()
    store.registrations.clear()
    const unknown = await post(genuine)

    expect(forged.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(await unknown.json()).toEqual(await forged.json())
  })

  /* ------------------------------------------------------------------ */
  /* FR-058: the cell comes from the registry, not from the reading      */
  /* ------------------------------------------------------------------ */

  it('refuses a reading that votes in a cell the sensor is not registered in', async () => {
    const elsewhere = await body({ cellId: cellIdFromH3Index('871e701b0ffffff') })
    const response = await post(elsewhere)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      fields: [{ field: 'cellId' }],
    })
    expect(store.rows.size).toBe(0)
  })

  it('stores the cell the registry names, never the one the body carries', async () => {
    await post(await body())
    expect([...store.rows.values()][0]?.cellId).toBe(CELL_ID)
  })

  /* ------------------------------------------------------------------ */
  /* FR-003: a counter is used once                                      */
  /* ------------------------------------------------------------------ */

  it('is idempotent for the same reading sent twice', async () => {
    // SC-009 puts this on a 3G link: a sensor that never saw the answer
    // retries with the same bytes, and an error there would have it retry
    // forever.
    const payload = await body()
    expect((await post(payload)).status).toBe(201)
    const retry = await post(payload)
    expect(retry.status).toBe(200)
    expect(store.rows.size).toBe(1)
  })

  it('refuses a different reading under a counter already used', async () => {
    await post(await body())
    const response = await post(await body({ valueX100: 9_999 }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ fields: [{ field: 'counter' }] })
    expect([...store.rows.values()][0]?.valueX100).toBe(250)
  })

  /* ------------------------------------------------------------------ */
  /* FR-041: an invalid request names the field                          */
  /* ------------------------------------------------------------------ */

  it('names the field that is wrong', async () => {
    const response = await post({ ...(await body()), valueX100: 'wet' })
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { fields: { field: string }[] }
    expect(payload.fields.map((one) => one.field)).toContain('valueX100')
  })

  it('names a field that is missing rather than filling it in', async () => {
    const { counter: _counter, ...without } = await body()
    const response = await post(without)
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { fields: { field: string }[] }
    expect(payload.fields.map((one) => one.field)).toContain('counter')
  })

  /**
   * `strictObject` in the schema: a key the signature does not cover has no
   * meaning, and accepting one quietly would invite a client to believe it
   * does.
   */
  it('refuses a body carrying a field the signature does not cover', async () => {
    const response = await post({ ...(await body()), priority: 'high' })
    expect(response.status).toBe(400)
    expect(store.rows.size).toBe(0)
  })

  it('refuses a body that is not JSON at all', async () => {
    const route = createReadingsRoute({ store })
    const response = await route.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(response.status).toBe(400)
  })
})
