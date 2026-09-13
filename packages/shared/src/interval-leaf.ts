import { decodeBase58 } from './base58.ts'
import { MERKLE_HASH_BYTES } from './merkle.ts'
import { ReadingKind, type ReadingKindName } from './reading.ts'

/**
 * The leaf of the day's Merkle tree: one closed interval of one cell —
 * `FR-008`, `FR-037`.
 *
 * The chain gets one root per cell per day (`readings_root` in
 * `DayRecordParams`), and the material behind that root is two levels deep:
 *
 * ```
 * day root ── leaf per interval (these bytes)
 *                 └── readingsRoot ── leaf per signed reading
 *                                     (canonicalReadingBytes)
 * ```
 *
 * So a proof that a reading decided a payout is two proofs: the reading in its
 * interval, and the interval in its day. Nesting them rather than flattening
 * every reading into one tree is what lets an interval be *named* — its
 * median, its vote count and its position in the day are committed to, so the
 * trace can show that hour 14 had no value without having to enumerate the
 * readings it did not get.
 *
 * The layout follows `canonicalReadingBytes`: a domain tag, then fixed-width
 * big-endian fields at constant offsets, no separators and no lengths. Nothing
 * here is variable length, so there is exactly one byte string per interval and
 * exactly one interval per byte string. Unlike a reading, nobody signs these —
 * they are hashed — but the reason for a canonical form is the same: a third
 * party redoing the arithmetic (`SC-010`) has to arrive at our bytes, not at
 * bytes that happen to mean the same thing.
 */

/**
 * Domain separation, and a version. Changing the layout means changing the
 * tag: a root computed under the old one then verifies only under the old one,
 * rather than a stored day quietly reinterpreting itself into a different root
 * than the transaction that carries it.
 */
const DOMAIN_TAG = 'pumpking/interval/v1'
const DOMAIN_TAG_BYTES = new TextEncoder().encode(DOMAIN_TAG)

const READING_KIND_TAG: Record<ReadingKindName, number> = {
  [ReadingKind.PrecipitationMm]: 0,
}

const OFFSET_CELL_ID = DOMAIN_TAG_BYTES.length // 20
const OFFSET_KIND = OFFSET_CELL_ID + 8 // 28
const OFFSET_DAY_INDEX = OFFSET_KIND + 1 // 29
const OFFSET_INTERVAL_INDEX = OFFSET_DAY_INDEX + 4 // 33
const OFFSET_HAS_VALUE = OFFSET_INTERVAL_INDEX + 2 // 35
const OFFSET_MEDIAN = OFFSET_HAS_VALUE + 1 // 36
const OFFSET_VOTE_COUNT = OFFSET_MEDIAN + 4 // 40
const OFFSET_READINGS_ROOT = OFFSET_VOTE_COUNT + 2 // 42

/** Every interval serialises to exactly this many bytes. */
export const CANONICAL_INTERVAL_BYTES = OFFSET_READINGS_ROOT + MERKLE_HASH_BYTES // 74

const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647
const UINT16_MAX = 65_535
const UINT32_MAX = 4_294_967_295
const UINT64_MAX = 0xffff_ffff_ffff_ffffn

/**
 * What one closed interval commits to.
 *
 * `medianX100` is `null` when the interval fell short of the minimum number of
 * independent votes (`FR-010`), and the presence byte in the encoding keeps
 * that distinct from a measured zero. Zero is a real, dry reading of the sky;
 * silence is not, and a format that wrote both as four zero bytes would make
 * the two indistinguishable inside the very structure meant to prove which one
 * happened.
 */
export type IntervalCommitment = {
  cellId: bigint
  kind: ReadingKindName
  /** Day index on the pool's clock — `FR-049`, never a date. */
  dayIndex: number
  /** Position of the interval inside its day, `0 .. intervalsPerDay - 1`. */
  intervalIndex: number
  medianX100: number | null
  /** Independent operators behind the median, not sensors — `FR-009`. */
  voteCount: number
  /**
   * Root over the signed readings the interval accepted, base58 as it is
   * stored, or `null` when it accepted none.
   *
   * A null root and a zero `voteCount` always travel together: every accepted
   * reading produces a vote, so an interval with no root is an interval no
   * operator was heard in. The encoding writes 32 zero bytes for the null,
   * which `voteCount` is what disambiguates.
   */
  readingsRoot: string | null
}

/**
 * The bytes of one interval, as the day's tree hashes them.
 *
 * Throws on a value that does not fit its field or a root that is not 32
 * base58 bytes. Every such value is a programmer error: these come from our
 * own aggregation, not from a request, and a leaf built out of a wrong-width
 * field would produce a root nobody can reproduce and no error anyone can read.
 */
export function canonicalIntervalBytes(interval: IntervalCommitment): Uint8Array {
  if (interval.cellId < 0n || interval.cellId > UINT64_MAX) {
    throw new RangeError(`cellId does not fit u64: ${interval.cellId}`)
  }
  if (!Number.isInteger(interval.dayIndex) || interval.dayIndex < 0) {
    throw new RangeError(`dayIndex is not a non-negative integer: ${interval.dayIndex}`)
  }
  if (interval.dayIndex > UINT32_MAX) {
    throw new RangeError(`dayIndex does not fit u32: ${interval.dayIndex}`)
  }
  if (!Number.isInteger(interval.intervalIndex) || interval.intervalIndex < 0) {
    throw new RangeError(`intervalIndex is not a non-negative integer: ${interval.intervalIndex}`)
  }
  if (interval.intervalIndex > UINT16_MAX) {
    throw new RangeError(`intervalIndex does not fit u16: ${interval.intervalIndex}`)
  }
  if (!Number.isInteger(interval.voteCount) || interval.voteCount < 0) {
    throw new RangeError(`voteCount is not a non-negative integer: ${interval.voteCount}`)
  }
  if (interval.voteCount > UINT16_MAX) {
    throw new RangeError(`voteCount does not fit u16: ${interval.voteCount}`)
  }

  const median = interval.medianX100
  if (median !== null) {
    if (!Number.isInteger(median)) {
      throw new RangeError(`medianX100 is not an integer: ${median}`)
    }
    if (median < INT32_MIN || median > INT32_MAX) {
      throw new RangeError(`medianX100 does not fit i32: ${median}`)
    }
  }

  let root: Uint8Array | null = null
  if (interval.readingsRoot !== null) {
    root = decodeBase58(interval.readingsRoot, MERKLE_HASH_BYTES)
    if (root === null) {
      throw new Error(
        `readingsRoot is not a base58 ${MERKLE_HASH_BYTES}-byte hash: ${interval.readingsRoot}`,
      )
    }
  }

  const bytes = new Uint8Array(CANONICAL_INTERVAL_BYTES)
  bytes.set(DOMAIN_TAG_BYTES, 0)

  const view = new DataView(bytes.buffer)
  view.setBigUint64(OFFSET_CELL_ID, interval.cellId, false)
  view.setUint8(OFFSET_KIND, READING_KIND_TAG[interval.kind])
  view.setUint32(OFFSET_DAY_INDEX, interval.dayIndex, false)
  view.setUint16(OFFSET_INTERVAL_INDEX, interval.intervalIndex, false)
  view.setUint8(OFFSET_HAS_VALUE, median === null ? 0 : 1)
  view.setInt32(OFFSET_MEDIAN, median ?? 0, false)
  view.setUint16(OFFSET_VOTE_COUNT, interval.voteCount, false)
  if (root !== null) bytes.set(root, OFFSET_READINGS_ROOT)

  return bytes
}
