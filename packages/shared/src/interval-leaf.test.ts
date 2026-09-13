import { describe, expect, it } from 'vitest'
import { encodeBase58 } from './base58.ts'
import { cellIdFromH3Index } from './cell.ts'
import {
  CANONICAL_INTERVAL_BYTES,
  canonicalIntervalBytes,
  type IntervalCommitment,
} from './interval-leaf.ts'
import { merkleRoot } from './merkle.ts'
import { ReadingKind } from './reading.ts'

const CELL_ID = cellIdFromH3Index('871e701b3ffffff')
const ROOT = encodeBase58(new Uint8Array(32).fill(7))

function interval(overrides: Partial<IntervalCommitment> = {}): IntervalCommitment {
  return {
    cellId: CELL_ID,
    kind: ReadingKind.PrecipitationMm,
    dayIndex: 3,
    intervalIndex: 14,
    medianX100: 250,
    voteCount: 5,
    readingsRoot: ROOT,
    ...overrides,
  }
}

describe('canonicalIntervalBytes', () => {
  it('is a fixed width whatever the interval holds', () => {
    expect(canonicalIntervalBytes(interval())).toHaveLength(CANONICAL_INTERVAL_BYTES)
    expect(
      canonicalIntervalBytes(interval({ medianX100: null, voteCount: 0, readingsRoot: null })),
    ).toHaveLength(CANONICAL_INTERVAL_BYTES)
  })

  it('starts with the domain tag, so a leaf is never another message', () => {
    const bytes = canonicalIntervalBytes(interval())
    expect(new TextDecoder().decode(bytes.subarray(0, 20))).toBe('pumpking/interval/v1')
  })

  it('writes the fields big-endian at fixed offsets', () => {
    const bytes = canonicalIntervalBytes(interval())
    const view = new DataView(bytes.buffer)
    expect(view.getBigUint64(20, false)).toBe(CELL_ID)
    expect(view.getUint8(28)).toBe(0)
    expect(view.getUint32(29, false)).toBe(3)
    expect(view.getUint16(33, false)).toBe(14)
    expect(view.getUint8(35)).toBe(1)
    expect(view.getInt32(36, false)).toBe(250)
    expect(view.getUint16(40, false)).toBe(5)
    expect([...bytes.subarray(42)]).toEqual(Array.from<number>({ length: 32 }).fill(7))
  })

  /**
   * The whole reason for a presence byte. Without it an interval nobody
   * measured and an interval that measured no rain would hash identically, and
   * the tree meant to prove which of the two happened could not tell them
   * apart.
   */
  it('separates an interval without a value from one that measured zero', () => {
    const silent = canonicalIntervalBytes(interval({ medianX100: null }))
    const dry = canonicalIntervalBytes(interval({ medianX100: 0 }))
    expect(silent).not.toEqual(dry)
    expect(new DataView(silent.buffer).getUint8(35)).toBe(0)
    expect(new DataView(dry.buffer).getUint8(35)).toBe(1)
  })

  it('separates intervals that differ only in position', () => {
    const roots = [
      merkleRoot([canonicalIntervalBytes(interval({ intervalIndex: 0 }))]),
      merkleRoot([canonicalIntervalBytes(interval({ intervalIndex: 1 }))]),
      merkleRoot([canonicalIntervalBytes(interval({ dayIndex: 4 }))]),
    ]
    expect(new Set(roots.map((root) => root?.toString())).size).toBe(3)
  })

  it('writes a null root as thirty-two zeroes', () => {
    const bytes = canonicalIntervalBytes(
      interval({ medianX100: null, voteCount: 0, readingsRoot: null }),
    )
    expect([...bytes.subarray(42)]).toEqual(Array.from<number>({ length: 32 }).fill(0))
  })

  it('is deterministic', () => {
    expect(canonicalIntervalBytes(interval())).toEqual(canonicalIntervalBytes(interval()))
  })

  it('refuses a value that does not fit its field', () => {
    expect(() => canonicalIntervalBytes(interval({ dayIndex: -1 }))).toThrow(RangeError)
    expect(() => canonicalIntervalBytes(interval({ dayIndex: 4_294_967_296 }))).toThrow(RangeError)
    expect(() => canonicalIntervalBytes(interval({ intervalIndex: 65_536 }))).toThrow(RangeError)
    expect(() => canonicalIntervalBytes(interval({ voteCount: 65_536 }))).toThrow(RangeError)
    expect(() => canonicalIntervalBytes(interval({ medianX100: 2_147_483_648 }))).toThrow(
      RangeError,
    )
    expect(() => canonicalIntervalBytes(interval({ medianX100: 1.5 }))).toThrow(RangeError)
    expect(() => canonicalIntervalBytes(interval({ cellId: -1n }))).toThrow(RangeError)
  })

  it('refuses a root that is not a base58 32-byte hash', () => {
    expect(() => canonicalIntervalBytes(interval({ readingsRoot: 'not-base58' }))).toThrow(/base58/)
    expect(() =>
      canonicalIntervalBytes(interval({ readingsRoot: encodeBase58(new Uint8Array(31)) })),
    ).toThrow(/base58/)
  })
})
