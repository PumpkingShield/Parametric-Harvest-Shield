import { cellToChildren, cellToParent, latLngToCell } from 'h3-js'
import { describe, expect, it } from 'vitest'
import {
  cellFromLatLng,
  cellIdFromH3Index,
  cellResolution,
  cellSize,
  DEFAULT_RESOLUTION,
  H3_CELL_PATTERN,
  h3IndexFromCellId,
  isCellId,
} from './cell.ts'

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

describe('resolution', () => {
  it('reads the level back out of the id — FR-069', () => {
    expect(cellResolution(cellIdFromH3Index('871e701b3ffffff'))).toBe(7)
    expect(cellResolution(cellIdFromH3Index('88754e6499fffff'))).toBe(8)
    expect(cellResolution(cellIdFromH3Index('80f1fffffffffff'))).toBe(0)
    expect(cellResolution(cellIdFromH3Index('8f0326352285762'))).toBe(15)
  })

  it('rejects an id shaped like a cell that H3 does not have', () => {
    // Matches H3_CELL_PATTERN — mode 1, right length — but the digits name no
    // cell. Resolution read out of it would be a number that means nothing.
    const shaped = cellIdFromH3Index('8ffffffffffffff')
    expect(isCellId(shaped)).toBe(false)
    expect(() => cellResolution(shaped)).toThrow(RangeError)
  })

  it('accepts every real index as a cell id', () => {
    for (const index of indexes) {
      expect(isCellId(cellIdFromH3Index(index))).toBe(true)
    }
  })

  it('res 8 is an expansion, not a migration — FR-069', () => {
    // Each res 7 cell holds exactly seven res 8 children, so the two levels
    // coexist and a policy issued at res 7 keeps being settled at res 7.
    const parent = h3IndexFromCellId(cellFromLatLng(49.5535, 25.5948))
    const children = cellToChildren(parent, 8)
    expect(children).toHaveLength(7)
    for (const child of children) {
      expect(cellToParent(child, 7)).toBe(parent)
      expect(cellResolution(cellIdFromH3Index(child))).toBe(8)
    }
  })
})

describe('cell from coordinates', () => {
  /** Ternopil oblast, the pilot region. */
  const lat = 49.5535
  const lng = 25.5948

  it('defaults to res 7 — FR-060', () => {
    const cellId = cellFromLatLng(lat, lng)
    expect(cellResolution(cellId)).toBe(DEFAULT_RESOLUTION)
    expect(DEFAULT_RESOLUTION).toBe(7)
  })

  it('takes the level as a parameter, not a constant — FR-060', () => {
    for (const resolution of [0, 5, 7, 8, 15]) {
      expect(cellResolution(cellFromLatLng(lat, lng, resolution))).toBe(resolution)
    }
  })

  it('agrees with h3-js and round-trips through the id', () => {
    const cellId = cellFromLatLng(lat, lng)
    expect(h3IndexFromCellId(cellId)).toBe(latLngToCell(lat, lng, 7))
  })

  it('puts two points of the same village in one cell — FR-060', () => {
    // ~700 m apart: a cell is ~2.8 km across, so neighbouring fields share it.
    expect(cellFromLatLng(lat, lng)).toBe(cellFromLatLng(lat + 0.004, lng + 0.004))
  })

  it('puts points 30 km apart in different cells', () => {
    expect(cellFromLatLng(lat, lng)).not.toBe(cellFromLatLng(lat + 0.27, lng))
  })

  it('rejects a latitude outside the sphere instead of wrapping it — FR-058', () => {
    // H3 itself answers 100°N with a valid cell somewhere over the pole. A
    // sensor registered from that typo would vote in a cell it is not in.
    expect(latLngToCell(100, lng, 7)).not.toBe(latLngToCell(80, lng, 7))
    expect(() => cellFromLatLng(100, lng)).toThrow(RangeError)
    expect(() => cellFromLatLng(-90.0001, lng)).toThrow(RangeError)
  })

  it('rejects a longitude outside the sphere', () => {
    expect(() => cellFromLatLng(lat, 400)).toThrow(RangeError)
    expect(() => cellFromLatLng(lat, -180.0001)).toThrow(RangeError)
  })

  it('accepts the poles and the antimeridian', () => {
    expect(isCellId(cellFromLatLng(90, 180))).toBe(true)
    expect(isCellId(cellFromLatLng(-90, -180))).toBe(true)
  })

  it('rejects a missing or unusable coordinate', () => {
    expect(() => cellFromLatLng(Number.NaN, lng)).toThrow(RangeError)
    expect(() => cellFromLatLng(lat, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('rejects a level outside 0..15', () => {
    expect(() => cellFromLatLng(lat, lng, 16)).toThrow(RangeError)
    expect(() => cellFromLatLng(lat, lng, -1)).toThrow(RangeError)
    expect(() => cellFromLatLng(lat, lng, 7.5)).toThrow(RangeError)
  })
})

describe('published cell size — FR-060', () => {
  it('matches the figures the methodology page states for res 7', () => {
    const size = cellSize()
    expect(size.resolution).toBe(7)
    // FR-060: ≈5.2 km², side ≈1.41 km, ≈2.8 km across.
    expect(size.areaKm2).toBeCloseTo(5.2, 1)
    expect(size.edgeKm).toBeCloseTo(1.41, 2)
    expect(size.acrossKm).toBeCloseTo(2.8, 1)
  })

  it('is twice the side across, and shrinks with the level', () => {
    const seven = cellSize(7)
    const eight = cellSize(8)
    expect(seven.acrossKm).toBe(seven.edgeKm * 2)
    expect(eight.areaKm2).toBeLessThan(seven.areaKm2)
    // Seven children to a parent, so a level down is a seventh of the area.
    expect(seven.areaKm2 / eight.areaKm2).toBeCloseTo(7, 2)
  })

  it('rejects a level outside 0..15', () => {
    expect(() => cellSize(16)).toThrow(RangeError)
    expect(() => cellSize(-1)).toThrow(RangeError)
  })
})
