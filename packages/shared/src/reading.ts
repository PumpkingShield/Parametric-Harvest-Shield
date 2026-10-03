import { z } from 'zod'
import { decodeBase58 } from './base58.ts'
import { cellIdFromH3Index, H3_CELL_PATTERN } from './cell-id.ts'
import {
  INT32_MAX,
  INT32_MIN,
  READING_SIGNATURE_BYTES,
  type Reading,
  ReadingKind,
  type ReadingWire,
  SENSOR_KEY_BYTES,
  type SignedReading,
  type SignedReadingWire,
} from './reading-bytes.ts'

export type {
  Reading,
  ReadingKindName,
  ReadingWire,
  SignedReading,
  SignedReadingWire,
} from './reading-bytes.ts'
export {
  CANONICAL_READING_BYTES,
  canonicalReadingBytes,
  READING_SIGNATURE_BYTES,
  ReadingKind,
  SENSOR_KEY_BYTES,
  toReadingWire,
  toSignedReadingWire,
} from './reading-bytes.ts'

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
 *
 * The types, the bytes and the wire mapping live in `reading-bytes.ts`, which
 * the browser sensor imports on its own; this module adds the validator.
 */

type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

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

// The schema and the hand-written type are one definition: a field added to
// either without the other fails the build here, not a signature in the field.
const wireMatches: SameType<z.infer<typeof readingWireSchema>, ReadingWire> = true
void wireMatches

export const signedReadingWireSchema = readingWireSchema.extend({
  signature: signatureSchema,
})

const signedWireMatches: SameType<z.infer<typeof signedReadingWireSchema>, SignedReadingWire> = true
void signedWireMatches

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
