import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CANONICAL_READING_BYTES,
  canonicalReadingBytes,
  readingWireSchema,
  type SignedReadingWire,
  signedReadingSchema,
  signedReadingWireSchema,
  toSignedReadingWire,
} from './reading.ts'

type CanonicalFixture = {
  cases: {
    name: string
    secretKeyHex: string
    reading: SignedReadingWire
    canonicalHex: string
  }[]
}

const fixtures = JSON.parse(
  readFileSync(new URL('../../../fixtures/reading-canonical.json', import.meta.url), 'utf8'),
) as CanonicalFixture

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

const [firstCase] = fixtures.cases
if (firstCase === undefined) throw new Error('fixtures/reading-canonical.json has no cases')

/** A valid wire body, fresh each time, for the rejection tests to spoil. */
const validWire = (): SignedReadingWire => structuredClone(firstCase.reading)

describe('canonicalReadingBytes', () => {
  for (const testCase of fixtures.cases) {
    it(`matches the golden vector: ${testCase.name}`, () => {
      const reading = signedReadingSchema.parse(testCase.reading)
      expect(hex(canonicalReadingBytes(reading))).toBe(testCase.canonicalHex)
    })

    it(`is exactly ${CANONICAL_READING_BYTES} bytes: ${testCase.name}`, () => {
      const reading = signedReadingSchema.parse(testCase.reading)
      expect(canonicalReadingBytes(reading)).toHaveLength(CANONICAL_READING_BYTES)
    })
  }

  it('opens with the domain tag so a signature cannot be replayed elsewhere', () => {
    const reading = signedReadingSchema.parse(validWire())
    const tag = Buffer.from(canonicalReadingBytes(reading).subarray(0, 19)).toString('ascii')
    expect(tag).toBe('pumpking/reading/v1')
  })

  it('changes when any signed field changes', () => {
    const base = signedReadingSchema.parse(validWire())
    const baseline = hex(canonicalReadingBytes(base))

    const variants = [
      { ...base, cellId: base.cellId + 1n },
      { ...base, valueX100: base.valueX100 + 1 },
      { ...base, measuredAt: new Date(base.measuredAt.getTime() + 1) },
      { ...base, counter: base.counter + 1n },
      { ...base, sensor: fixtures.cases[1]?.reading.sensor ?? base.sensor },
    ]

    for (const variant of variants) {
      expect(hex(canonicalReadingBytes(variant))).not.toBe(baseline)
    }
  })

  it('refuses a value that does not fit its field', () => {
    const base = signedReadingSchema.parse(validWire())
    expect(() => canonicalReadingBytes({ ...base, counter: -1n })).toThrow(RangeError)
    expect(() => canonicalReadingBytes({ ...base, counter: 2n ** 64n })).toThrow(RangeError)
    expect(() => canonicalReadingBytes({ ...base, valueX100: 2_147_483_648 })).toThrow(RangeError)
    expect(() => canonicalReadingBytes({ ...base, valueX100: 1.5 })).toThrow(RangeError)
    expect(() => canonicalReadingBytes({ ...base, measuredAt: new Date('nope') })).toThrow(
      RangeError,
    )
    expect(() => canonicalReadingBytes({ ...base, sensor: 'not-a-key' })).toThrow()
  })
})

describe('wire form', () => {
  for (const testCase of fixtures.cases) {
    it(`round-trips through the domain form: ${testCase.name}`, () => {
      const reading = signedReadingSchema.parse(testCase.reading)
      expect(toSignedReadingWire(reading)).toEqual(testCase.reading)
    })
  }

  it('parses the cell id into the 64-bit form the program and the database use', () => {
    const reading = signedReadingSchema.parse(validWire())
    expect(reading.cellId).toBe(BigInt(`0x${firstCase.reading.cellId}`))
    expect(typeof reading.counter).toBe('bigint')
    expect(reading.measuredAt.toISOString()).toBe(firstCase.reading.measuredAt)
  })

  it('accepts an offset timestamp as the same instant', () => {
    const utc = signedReadingSchema.parse({
      ...validWire(),
      measuredAt: '2026-08-29T11:00:00.000Z',
    })
    const offset = signedReadingSchema.parse({
      ...validWire(),
      measuredAt: '2026-08-29T13:00:00.000+02:00',
    })
    expect(offset.measuredAt.getTime()).toBe(utc.measuredAt.getTime())
    expect(hex(canonicalReadingBytes(offset))).toBe(hex(canonicalReadingBytes(utc)))
  })
})

describe('rejections', () => {
  const spoiled: [string, Record<string, unknown>][] = [
    ['a sensor key that is not base58', { sensor: 'not base58 0OIl' }],
    ['a sensor key of the wrong length', { sensor: '11111111' }],
    ['a cell id that is not an H3 cell', { cellId: '171e701b3ffffff' }],
    ['a cell id in uppercase', { cellId: '871E701B3FFFFFF' }],
    ['coordinates instead of a cell id — FR-058', { cellId: '49.55,25.6' }],
    ['an unknown measurement kind', { kind: 'temperature_c' }],
    ['a fractional value — no floating point in the consensus', { valueX100: 12.5 }],
    ['a value past the i32 column', { valueX100: 2_147_483_648 }],
    ['a negative counter', { counter: -1 }],
    ['a fractional counter', { counter: 1.5 }],
    ['a counter past the safe-integer range', { counter: Number.MAX_SAFE_INTEGER + 2 }],
    ['a timestamp that is not ISO 8601', { measuredAt: '29 Aug 2026' }],
    ['a signature of the wrong length', { signature: '11111111' }],
    ['a field the signature does not cover', { latitude: 49.55 }],
  ]

  for (const [name, patch] of spoiled) {
    it(`rejects ${name}`, () => {
      expect(signedReadingWireSchema.safeParse({ ...validWire(), ...patch }).success).toBe(false)
    })
  }

  it('rejects a body missing the signature', () => {
    const { signature: _signature, ...unsigned } = validWire()
    expect(signedReadingWireSchema.safeParse(unsigned).success).toBe(false)
    // The unsigned half is still a well-formed reading on its own.
    expect(readingWireSchema.safeParse(unsigned).success).toBe(true)
  })
})
