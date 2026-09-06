import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeBase58 } from './base58.ts'
import { type SignedReadingWire, signedReadingSchema } from './reading.ts'
import { sensorPublicKey, signReading, verifyReadingSignature } from './signature.ts'

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

const secretKeyOf = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))

const [firstCase, secondCase] = fixtures.cases
if (firstCase === undefined || secondCase === undefined) {
  throw new Error('fixtures/reading-canonical.json needs at least two cases')
}

const validWire = (): SignedReadingWire => structuredClone(firstCase.reading)

describe('verifyReadingSignature', () => {
  for (const testCase of fixtures.cases) {
    it(`accepts the golden vector: ${testCase.name}`, async () => {
      const reading = signedReadingSchema.parse(testCase.reading)
      await expect(verifyReadingSignature(reading)).resolves.toBe(true)
    })
  }

  it('rejects a reading whose value was edited after signing', async () => {
    const reading = signedReadingSchema.parse(validWire())
    const tampered = { ...reading, valueX100: reading.valueX100 + 1 }
    await expect(verifyReadingSignature(tampered)).resolves.toBe(false)
  })

  it('rejects a vote moved into another cell — FR-058', async () => {
    const reading = signedReadingSchema.parse(validWire())
    await expect(verifyReadingSignature({ ...reading, cellId: reading.cellId + 1n })).resolves.toBe(
      false,
    )
  })

  it('rejects a reading re-dated after signing', async () => {
    const reading = signedReadingSchema.parse(validWire())
    const shifted = { ...reading, measuredAt: new Date(reading.measuredAt.getTime() + 1) }
    await expect(verifyReadingSignature(shifted)).resolves.toBe(false)
  })

  it('rejects a replayed counter carrying its old signature — FR-003', async () => {
    const reading = signedReadingSchema.parse(validWire())
    await expect(
      verifyReadingSignature({ ...reading, counter: reading.counter + 1n }),
    ).resolves.toBe(false)
  })

  it('rejects a signature lifted from another reading', async () => {
    const reading = signedReadingSchema.parse(validWire())
    const other = signedReadingSchema.parse(secondCase.reading)
    await expect(verifyReadingSignature({ ...reading, signature: other.signature })).resolves.toBe(
      false,
    )
  })

  it('rejects a reading claimed under someone else key', async () => {
    const reading = signedReadingSchema.parse(validWire())
    const other = signedReadingSchema.parse(secondCase.reading)
    await expect(verifyReadingSignature({ ...reading, sensor: other.sensor })).resolves.toBe(false)
  })

  it('returns false rather than throwing on malformed input', async () => {
    const reading = signedReadingSchema.parse(validWire())
    await expect(verifyReadingSignature({ ...reading, sensor: 'not-a-key' })).resolves.toBe(false)
    await expect(
      verifyReadingSignature({ ...reading, signature: 'not-a-signature' }),
    ).resolves.toBe(false)
    await expect(verifyReadingSignature({ ...reading, signature: '11111111' })).resolves.toBe(false)
    // A well-formed 64-byte signature that decodes to a point off the curve.
    const garbage = encodeBase58(new Uint8Array(64).fill(0xff))
    await expect(verifyReadingSignature({ ...reading, signature: garbage })).resolves.toBe(false)
    // A field out of range makes the canonical bytes unbuildable, not an exception.
    await expect(verifyReadingSignature({ ...reading, counter: -1n })).resolves.toBe(false)
  })
})

describe('signReading', () => {
  for (const testCase of fixtures.cases) {
    it(`reproduces the golden signature: ${testCase.name}`, async () => {
      const reading = signedReadingSchema.parse(testCase.reading)
      const secretKey = secretKeyOf(testCase.secretKeyHex)
      // Ed25519 is deterministic: the same key over the same bytes is the same
      // signature, so a drift in the canonical layout shows up here too.
      await expect(signReading(reading, secretKey)).resolves.toBe(testCase.reading.signature)
    })

    it(`derives the sensor identity from the seed: ${testCase.name}`, async () => {
      const secretKey = secretKeyOf(testCase.secretKeyHex)
      await expect(sensorPublicKey(secretKey)).resolves.toBe(testCase.reading.sensor)
    })
  }

  it('signs and verifies a reading that is not in the fixtures', async () => {
    const secretKey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)
    const reading = {
      ...signedReadingSchema.parse(validWire()),
      sensor: await sensorPublicKey(secretKey),
      valueX100: 0,
      counter: 99n,
    }
    const signature = await signReading(reading, secretKey)
    await expect(verifyReadingSignature({ ...reading, signature })).resolves.toBe(true)
  })
})
