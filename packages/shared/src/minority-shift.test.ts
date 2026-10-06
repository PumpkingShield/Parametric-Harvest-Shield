import { describe, expect, it } from 'vitest'
import { cellMedian, medianX100, type SensorReading } from './median.ts'
import { largestMinority, minorityFlipsDay, minorityReach } from './minority-shift.ts'

const COLUMN_MIN = -2_147_483_648
const COLUMN_MAX = 2_147_483_647

/** mulberry32: a fixed seed, so a failure names the case that failed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const integer = (next: () => number, low: number, high: number) =>
  low + Math.floor(next() * (high - low + 1))

/** Anything a colluder could send: ordinary rain, or the edge of the column. */
function anyValue(next: () => number): number {
  const roll = next()
  if (roll < 0.1) return COLUMN_MIN
  if (roll < 0.2) return COLUMN_MAX
  return integer(next, 0, 20_000)
}

describe('largestMinority', () => {
  it('is the largest group strictly below half', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(largestMinority)).toEqual([0, 0, 0, 1, 1, 2, 2, 3])
  })
})

describe('minorityReach', () => {
  it('drags the value to an honest neighbour, not past it', () => {
    // Five votes, two turned. Down: 100, 200, 300 stay → 100. Up: 300, 400, 500 → 500.
    expect(minorityReach([300, 100, 500, 200, 400], 2)).toEqual({
      honestX100: 300,
      downX100: 100,
      upX100: 500,
    })
  })

  it('cannot move a cell whose honest gauges agree', () => {
    const reach = minorityReach([0, 0, 0, 0, 0, 0, 0], 3)
    expect(reach).toEqual({ honestX100: 0, downX100: 0, upX100: 0 })
  })

  it('refuses a group of half or more — that is control, not a shift', () => {
    expect(() => minorityReach([100, 200, 300, 400], 2)).toThrow(RangeError)
    expect(() => minorityReach([100, 200, 300], 2)).toThrow(RangeError)
  })

  it('has nothing to move in an interval without votes', () => {
    expect(minorityReach([], 0)).toBeNull()
  })

  // The claim the real-gauge measurement stands on: the two turned-to-the-edge
  // cases are the worst any minority can do, whichever votes it holds and
  // whatever it reports. If this fails, the fixture measures a weaker attacker
  // than the spec names.
  it('bounds every minority attack, whatever votes it takes and whatever it reports', () => {
    const next = random(0x5c003)
    let attacks = 0
    let reachedAnEdge = 0
    for (let run = 0; run < 5_000; run += 1) {
      const count = integer(next, 1, 15)
      const honest = Array.from({ length: count }, () => integer(next, 0, 20_000))
      const colluders = integer(next, 0, largestMinority(count))
      const reach = minorityReach(honest, colluders)
      if (reach === null) throw new Error('a non-empty vote set has a value')

      // The group takes any `colluders` of the votes and reports anything.
      const taken = new Set<number>()
      while (taken.size < colluders) taken.add(integer(next, 0, count - 1))
      const attacked = honest.map((value, i) => (taken.has(i) ? anyValue(next) : value))
      const value = medianX100(attacked)
      if (value === null) throw new Error('a non-empty vote set has a value')

      attacks += 1
      expect(value).toBeGreaterThanOrEqual(reach.downX100)
      expect(value).toBeLessThanOrEqual(reach.upX100)
      // The worst case is an honest value, never the colluders' own.
      expect(Math.min(...honest)).toBeLessThanOrEqual(reach.downX100)
      expect(reach.upX100).toBeLessThanOrEqual(Math.max(...honest))
      if (value === reach.downX100 || value === reach.upX100) reachedAnEdge += 1
    }
    expect(attacks).toBe(5_000)
    // Witness that the bound is tight, not merely true: random attacks do
    // land on it.
    expect(reachedAnEdge).toBeGreaterThan(500)
  })

  // Control: one more colluder than a minority, and the same attack escapes
  // the honest votes. Without this the test above could hold for a median
  // that ignores the colluders altogether.
  it('escapes the honest votes once the group reaches half', () => {
    const honest = [100, 200, 300, 400]
    const attacked = [COLUMN_MAX, COLUMN_MAX, 300, 400]
    const value = medianX100(attacked)
    expect(value).not.toBeNull()
    expect(value ?? 0).toBeGreaterThan(Math.max(...honest))
  })

  it('counts an operator once however many sensors it turns — FR-009', () => {
    // Five honest operators; one colluding operator brings thirty sensors.
    const reading = (sensor: string, operator: string, valueX100: number): SensorReading => ({
      sensor,
      operator,
      valueX100,
    })
    const honest = [100, 120, 140, 160, 180].map((v, i) => reading(`h${i}`, `op${i}`, v))
    const flood = Array.from({ length: 30 }, (_, i) => reading(`m${i}`, 'mallory', COLUMN_MAX))
    const result = cellMedian([...honest, ...flood], { minimumVotes: 3 })
    const reach = minorityReach([100, 120, 140, 160, 180], 1)
    expect(result.voteCount).toBe(6)
    // Six votes, one of them Mallory's: an added vote is weaker than a turned one.
    expect(result.medianX100).toBeLessThanOrEqual(reach?.upX100 ?? Number.NaN)
  })
})

describe('minorityFlipsDay', () => {
  const threshold = 200

  it('flips nothing while every reachable value stays on one side', () => {
    expect(minorityFlipsDay({ honestX100: 0, downX100: 0, upX100: 150 }, threshold)).toBe(false)
    expect(minorityFlipsDay({ honestX100: 900, downX100: 300, upX100: 2000 }, threshold)).toBe(
      false,
    )
  })

  it('flips a dry day the group can push over the threshold', () => {
    expect(minorityFlipsDay({ honestX100: 100, downX100: 0, upX100: 201 }, threshold)).toBe(true)
  })

  it('flips a wet day the group can pull under it', () => {
    expect(minorityFlipsDay({ honestX100: 300, downX100: 199, upX100: 400 }, threshold)).toBe(true)
  })

  it('counts exactly the threshold as dry, as classifyDay does — FR-047', () => {
    expect(minorityFlipsDay({ honestX100: 100, downX100: 0, upX100: 200 }, threshold)).toBe(false)
    expect(minorityFlipsDay({ honestX100: 201, downX100: 200, upX100: 300 }, threshold)).toBe(true)
  })
})
