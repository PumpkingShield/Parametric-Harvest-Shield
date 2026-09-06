import { describe, expect, it } from 'vitest'
import { cellIdFromH3Index, H3_CELL_PATTERN, h3IndexFromCellId } from './cell.ts'

/** Real h3-js output: res 7 (the pilot level), res 8 and res 0 and res 15. */
const indexes = [
  '871e701b3ffffff',
  '87be0e341ffffff',
  '88754e6499fffff',
  '8f0326352285762',
  '80f1fffffffffff',
]

describe('cell id', () => {
  for (const index of indexes) {
    it(`round-trips ${index}`, () => {
      expect(h3IndexFromCellId(cellIdFromH3Index(index))).toBe(index)
    })

    it(`${index} fits the 64-bit id the program and the database use`, () => {
      const cellId = cellIdFromH3Index(index)
      // Bit 63 is reserved and zero, so the id also fits a signed bigint column.
      expect(cellId).toBeLessThan(2n ** 63n)
      expect(cellId).toBeGreaterThan(0n)
    })
  }

  it('rejects an index that is not a cell', () => {
    // Mode 2 is an edge, not a cell: it would name a boundary, not an area.
    expect(H3_CELL_PATTERN.test('171e701b3ffffff')).toBe(false)
    expect(() => cellIdFromH3Index('171e701b3ffffff')).toThrow()
  })

  it('rejects uppercase, short and non-hex forms', () => {
    expect(() => cellIdFromH3Index('871E701B3FFFFFF')).toThrow()
    expect(() => cellIdFromH3Index('871e701b3fffff')).toThrow()
    expect(() => cellIdFromH3Index('871e701b3ffffffg')).toThrow()
    expect(() => cellIdFromH3Index('')).toThrow()
  })

  it('rejects an id outside the cell range', () => {
    expect(() => h3IndexFromCellId(0n)).toThrow(RangeError)
    expect(() => h3IndexFromCellId(-1n)).toThrow(RangeError)
    expect(() => h3IndexFromCellId(2n ** 60n)).toThrow(RangeError)
  })
})
