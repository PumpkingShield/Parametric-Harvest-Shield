import { signedReadingSchema, verifyReadingSignature } from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import { lookUpSensor, sendReading, signNext } from './publish.ts'
import { newRecord, type SensorRecord } from './vault.ts'

const CELL = '871e701b3ffffff'
const API = 'https://api.test'
const AT = new Date('2026-10-03T12:34:56.789Z')

type Call = { url: string; init: RequestInit | undefined }

function answering(status: number, body: unknown, calls: Call[] = []) {
  return (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
}

const offline = () => Promise.reject(new TypeError('Failed to fetch'))

describe('signNext', () => {
  it('signs a body the server parses and verifies as the reading typed', async () => {
    // The server's own two checks, run on what the phone produced: a phone
    // whose bytes differed by one would pass here only if the server's did too.
    const { body } = await signNext(newRecord(), CELL, 250, AT)

    const parsed = signedReadingSchema.safeParse(body)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(await verifyReadingSignature(parsed.data)).toBe(true)
    expect(parsed.data.valueX100).toBe(250)
    expect(parsed.data.measuredAt.getTime()).toBe(AT.getTime())
    expect(body.cellId).toBe(CELL)
  })

  it('a changed value no longer verifies — the control for the check above', async () => {
    const { body } = await signNext(newRecord(), CELL, 250, AT)
    const parsed = signedReadingSchema.parse({ ...body, valueX100: 251 })
    expect(await verifyReadingSignature(parsed)).toBe(false)
  })

  it('spends the next counter and keeps the body as pending, without touching the old record', async () => {
    const start: SensorRecord = newRecord()
    const first = await signNext(start, CELL, 0, AT)
    const second = await signNext(first.record, CELL, 0, AT)

    expect(first.body.counter).toBe(1)
    expect(second.body.counter).toBe(2)
    expect(second.record.lastCounter).toBe(2n)
    expect(second.record.pending).toEqual(second.body)
    expect(start.lastCounter).toBe(0n)
    expect(start.pending).toBeNull()
  })
})

describe('sendReading', () => {
  it('posts the body as JSON to /v1/readings', async () => {
    const calls: Call[] = []
    const { body } = await signNext(newRecord(), CELL, 250, AT)
    await sendReading(API, body, answering(201, { status: 'accepted', counter: 1 }, calls))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${API}/v1/readings`)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body)
  })

  it('treats the first answer and the repeat of a lost one alike', async () => {
    const { body } = await signNext(newRecord(), CELL, 250, AT)
    expect(
      await sendReading(API, body, answering(201, { status: 'accepted', counter: 1 })),
    ).toEqual({ kind: 'stored', status: 'accepted' })
    expect(await sendReading(API, body, answering(200, { status: 'late', counter: 1 }))).toEqual({
      kind: 'stored',
      status: 'late',
    })
  })

  it('names the refusal, field and all', async () => {
    const { body } = await signNext(newRecord(), CELL, 250, AT)
    const refusal = {
      error: {
        code: 'INVALID_INPUT',
        message: 'reading names a cell the sensor is not registered in',
        details: { fields: [{ field: 'cellId', message: 'must be 871e701b2ffffff' }] },
      },
    }
    expect(await sendReading(API, body, answering(400, refusal))).toEqual({
      kind: 'refused',
      message: 'reading names a cell the sensor is not registered in: must be 871e701b2ffffff',
    })
    const unknown = {
      error: { code: 'UNAUTHORIZED', message: 'unknown sensor or invalid signature', details: {} },
    }
    expect(await sendReading(API, body, answering(401, unknown))).toEqual({
      kind: 'refused',
      message: 'unknown sensor or invalid signature',
    })
  })

  it('keeps the reading for another try when nothing, or a server failure, answered', async () => {
    const { body } = await signNext(newRecord(), CELL, 250, AT)
    expect((await sendReading(API, body, offline)).kind).toBe('retry')
    expect((await sendReading(API, body, answering(503, {}))).kind).toBe('retry')
    expect((await sendReading(API, body, answering(429, {}))).kind).toBe('retry')
    expect((await sendReading(API, body, answering(201, { surprise: true }))).kind).toBe('retry')
  })
})

describe('lookUpSensor', () => {
  const registration = {
    pubkey: 'key',
    cellId: CELL,
    previousCellId: null,
    movedAt: null,
    stake: '1000000',
    minStake: '1000000',
    voting: true,
    problem: null,
  }

  it('reads the registration', async () => {
    const calls: Call[] = []
    expect(await lookUpSensor(API, 'key', answering(200, registration, calls))).toEqual({
      kind: 'registered',
      registration,
    })
    expect(calls[0]?.url).toBe(`${API}/v1/sensors/key`)
  })

  it('reads a move, and an answer from an API that does not know about moves yet — FR-059', async () => {
    const moved = { ...registration, previousCellId: '871e701b2ffffff', movedAt: '2026-10-05T12:30:00.000Z' }
    expect(await lookUpSensor(API, 'key', answering(200, moved))).toEqual({
      kind: 'registered',
      registration: moved,
    })
    const { previousCellId: _p, movedAt: _m, ...older } = registration
    expect(await lookUpSensor(API, 'key', answering(200, older))).toEqual({
      kind: 'registered',
      registration,
    })
    expect(
      (await lookUpSensor(API, 'key', answering(200, { ...registration, movedAt: 7 }))).kind,
    ).toBe('unreachable')
  })

  it('tells an unregistered key from a service that did not answer', async () => {
    expect(await lookUpSensor(API, 'key', answering(404, {}))).toEqual({ kind: 'unknown' })
    expect((await lookUpSensor(API, 'key', offline)).kind).toBe('unreachable')
    expect((await lookUpSensor(API, 'key', answering(500, {}))).kind).toBe('unreachable')
  })

  it('refuses an answer that is not a registration, and a problem it has no words for', async () => {
    const { voting: _, ...noVoting } = registration
    expect((await lookUpSensor(API, 'key', answering(200, noVoting))).kind).toBe('unreachable')
    expect(
      (await lookUpSensor(API, 'key', answering(200, { ...registration, problem: 'banned' }))).kind,
    ).toBe('unreachable')
  })
})
