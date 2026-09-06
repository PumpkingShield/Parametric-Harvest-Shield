import { z } from 'zod'
import { decodeBase58 } from './base58.ts'
import { cellIdFromH3Index, H3_CELL_PATTERN, h3IndexFromCellId } from './cell.ts'

/**
 * A signed sensor reading — `FR-003` — and the exact bytes its signature covers.
 *
 * Two representations, on purpose:
 *
 * - the **wire** form is the JSON body of `POST /v1/readings`: strings for the
 *   things JSON cannot hold (a 64-bit cell id, a public key), an ISO timestamp;
 * - the **domain** form is what the rest of the system computes on: `bigint`
 *   for the id and the counter, `Date` for the instant, matching the column
 *   types in `packages/db` and the field widths in the program.
 *
 * The signature is over neither of them. It is over `canonicalReadingBytes()` —
 * a fixed 80-byte layout with no separators, no lengths and no ordering choice
 * to get wrong. JSON would have been the obvious alternative and is the wrong
 * one: key order, unicode escapes and number formatting all vary between
 * encoders, and a sensor whose JSON writer disagrees with ours by one space
 * produces a signature that verifies nowhere.
 */

/** Kinds of measurement. The discriminant is part of the signed bytes. */
export const ReadingKind = {
  PrecipitationMm: 'precipitation_mm',
} as const

export type ReadingKindName = (typeof ReadingKind)[keyof typeof ReadingKind]

const READING_KIND_TAG: Record<ReadingKindName, number> = {
  [ReadingKind.PrecipitationMm]: 0,
}

/** Raw ed25519 public key of the sensor. */
export const SENSOR_KEY_BYTES = 32
/** Raw ed25519 signature over the canonical bytes. */
export const READING_SIGNATURE_BYTES = 64

const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647
const UINT64_MAX = 0xffff_ffff_ffff_ffffn

/**
 * Domain form. `cellId` comes from the registration of the sensor and never
 * from the reading itself (`FR-058`) — the wire field carries it only so that
 * the signature commits to which cell the vote was cast in.
 */
export type Reading = {
  /** Base58 ed25519 public key; also the seed of the on-chain `Sensor` PDA. */
  sensor: string
  cellId: bigint
  kind: ReadingKindName
  /** Hundredths of a unit as an integer. No floating point in the consensus. */
  valueX100: number
  measuredAt: Date
  /** Monotonic per sensor. A repeat is not counted twice — `FR-003`. */
  counter: bigint
}

export type SignedReading = Reading & {
  /** Base58 ed25519 signature over `canonicalReadingBytes()`. */
  signature: string
}

/* -------------------------------------------------------------------------- */
/* Canonical serialisation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Domain separation. A sensor key signs nothing but readings, but the prefix
 * costs 19 bytes and makes that a property of the format rather than of our
 * discipline: no signature produced here can be replayed as any other message.
 *
 * The `v1` is load-bearing. Changing the layout means changing this tag, and
 * signatures made under the old one then verify only under the old one —
 * silently reinterpreting stored bytes is how a trace stops matching its payout.
 */
const DOMAIN_TAG = 'pumpking/reading/v1'
const DOMAIN_TAG_BYTES = new TextEncoder().encode(DOMAIN_TAG)

const OFFSET_SENSOR = DOMAIN_TAG_BYTES.length // 19
const OFFSET_CELL_ID = OFFSET_SENSOR + SENSOR_KEY_BYTES // 51
const OFFSET_KIND = OFFSET_CELL_ID + 8 // 59
const OFFSET_VALUE = OFFSET_KIND + 1 // 60
const OFFSET_MEASURED_AT = OFFSET_VALUE + 4 // 64
const OFFSET_COUNTER = OFFSET_MEASURED_AT + 8 // 72

/** Every reading serialises to exactly this many bytes. */
export const CANONICAL_READING_BYTES = OFFSET_COUNTER + 8 // 80

/**
 * The bytes a sensor signs and the aggregator verifies.
 *
 * Fixed width, big-endian, every field at a constant offset. Nothing here is
 * length-prefixed because nothing here is variable length, which is what makes
 * the encoding unambiguous: there is exactly one byte string per reading and
 * exactly one reading per byte string.
 *
 * `measuredAt` is epoch **milliseconds** as a signed 64-bit integer. A reading
 * timestamped below millisecond precision is truncated here, so a client that
 * signs one has to derive its bytes the same way — which is why this function,
 * and not a description of it, is what the browser sensor imports.
 *
 * Throws on a value that does not fit its field. Every such value is a
 * programmer error rather than bad input: input arrives through
 * `readingSchema`, which rejects it first.
 */
export function canonicalReadingBytes(reading: Reading): Uint8Array {
  const sensorKey = decodeBase58(reading.sensor, SENSOR_KEY_BYTES)
  if (sensorKey === null) {
    throw new Error(`sensor is not a base58 ${SENSOR_KEY_BYTES}-byte key: ${reading.sensor}`)
  }
  if (reading.cellId < 0n || reading.cellId > UINT64_MAX) {
    throw new RangeError(`cellId does not fit u64: ${reading.cellId}`)
  }
  if (reading.counter < 0n || reading.counter > UINT64_MAX) {
    throw new RangeError(`counter does not fit u64: ${reading.counter}`)
  }
  if (!Number.isInteger(reading.valueX100)) {
    throw new RangeError(`valueX100 is not an integer: ${reading.valueX100}`)
  }
  if (reading.valueX100 < INT32_MIN || reading.valueX100 > INT32_MAX) {
    throw new RangeError(`valueX100 does not fit i32: ${reading.valueX100}`)
  }
  const measuredAtMs = reading.measuredAt.getTime()
  if (!Number.isFinite(measuredAtMs)) {
    throw new RangeError('measuredAt is not a valid date')
  }

  const bytes = new Uint8Array(CANONICAL_READING_BYTES)
  bytes.set(DOMAIN_TAG_BYTES, 0)
  bytes.set(sensorKey, OFFSET_SENSOR)

  const view = new DataView(bytes.buffer)
  view.setBigUint64(OFFSET_CELL_ID, reading.cellId, false)
  view.setUint8(OFFSET_KIND, READING_KIND_TAG[reading.kind])
  view.setInt32(OFFSET_VALUE, reading.valueX100, false)
  view.setBigInt64(OFFSET_MEASURED_AT, BigInt(measuredAtMs), false)
  view.setBigUint64(OFFSET_COUNTER, reading.counter, false)

  return bytes
}

/* -------------------------------------------------------------------------- */
/* Wire schema                                                                */
/* -------------------------------------------------------------------------- */

const sensorKeySchema = z
  .string()
  .refine((value) => decodeBase58(value, SENSOR_KEY_BYTES) !== null, {
    message: `must be a base58-encoded ${SENSOR_KEY_BYTES}-byte ed25519 public key`,
  })

const signatureSchema = z
  .string()
  .refine((value) => decodeBase58(value, READING_SIGNATURE_BYTES) !== null, {
    message: `must be a base58-encoded ${READING_SIGNATURE_BYTES}-byte ed25519 signature`,
  })

/**
 * The JSON body of `POST /v1/readings`, and its mapping into the domain form.
 *
 * `strictObject`: an unknown key is rejected rather than dropped. A field the
 * signature does not cover has no meaning here, and accepting one quietly would
 * invite a client to believe it does.
 */
export const readingWireSchema = z.strictObject({
  sensor: sensorKeySchema,
  /** H3 index as hex — JSON has no 64-bit integer. */
  cellId: z.string().regex(H3_CELL_PATTERN, 'must be an H3 cell index in hex'),
  kind: z.enum([ReadingKind.PrecipitationMm]),
  valueX100: z.int().min(INT32_MIN).max(INT32_MAX),
  measuredAt: z.iso.datetime({ offset: true }),
  /**
   * A JSON number, capped at the safe-integer range rather than at `u64`. The
   * column is a `bigint` and the signed field is eight bytes, so the ceiling
   * can be raised without touching either; a counter that reached 2^53 would
   * mean a sensor reporting every second for 285 million years.
   */
  counter: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
})

export type ReadingWire = z.infer<typeof readingWireSchema>

export const signedReadingWireSchema = readingWireSchema.extend({
  signature: signatureSchema,
})

export type SignedReadingWire = z.infer<typeof signedReadingWireSchema>

const toReading = (wire: ReadingWire): Reading => ({
  sensor: wire.sensor,
  cellId: cellIdFromH3Index(wire.cellId),
  kind: wire.kind,
  valueX100: wire.valueX100,
  measuredAt: new Date(wire.measuredAt),
  counter: BigInt(wire.counter),
})

/** Wire JSON to domain reading. */
export const readingSchema = readingWireSchema.transform(toReading)

/** Wire JSON to domain reading with its signature. `FR-002` verifies it. */
export const signedReadingSchema = signedReadingWireSchema.transform(
  (wire): SignedReading => ({ ...toReading(wire), signature: wire.signature }),
)

/**
 * Domain reading back to wire JSON. The inverse of `readingSchema`, and the
 * reason a round trip can be tested: the browser sensor (`FR-005`) builds its
 * request body with this, having signed the bytes from `canonicalReadingBytes`.
 */
export function toReadingWire(reading: Reading): ReadingWire {
  return {
    sensor: reading.sensor,
    cellId: h3IndexFromCellId(reading.cellId),
    kind: reading.kind,
    valueX100: reading.valueX100,
    measuredAt: reading.measuredAt.toISOString(),
    counter: Number(reading.counter),
  }
}

export function toSignedReadingWire(reading: SignedReading): SignedReadingWire {
  return { ...toReadingWire(reading), signature: reading.signature }
}
