import { describe, expect, it } from 'vitest'
import {
  type CollusionCell,
  type CollusionParams,
  collusionCost,
  collusionFloor,
  collusionHolds,
  collusionRatio,
} from './collusion.ts'
import { medianX100 } from './median.ts'

const TOKEN = 1_000_000n
const params: CollusionParams = { minStake: TOKEN, minVotes: 3 }
const cell = (voteStakes: bigint[], freeSlots = 29): CollusionCell => ({ voteStakes, freeSlots })

/**
 * Every way there is, not the cheapest-first one the formula takes: each
 * subset of votes bought, then as many added as the subset still needs. If the
 * formula's shortcut is wrong, some subset here beats it.
 */
function bruteForce(c: CollusionCell, p: CollusionParams): bigint | null {
  const v = c.voteStakes.length
  let best: bigint | null = null
  for (let mask = 0; mask < 1 << v; mask += 1) {
    let bought = 0
    let cost = 0n
    for (let i = 0; i < v; i += 1) {
      if (mask & (1 << i)) {
        bought += 1
        cost += c.voteStakes[i] ?? 0n
      }
    }
    for (let added = 0; added <= c.freeSlots; added += 1) {
      const mine = bought + added
      const total = v + added
      if (mine === 0 || 2 * mine < total || total < p.minVotes) continue
      const price = cost + BigInt(added) * p.minStake
      if (best === null || price < best) best = price
      break
    }
  }
  return best
}

describe('collusionCost', () => {
  it('buys half of a three-vote cell at the minimum: two tokens', () => {
    expect(collusionCost(cell([TOKEN, TOKEN, TOKEN]), params)).toEqual({
      bought: 1,
      added: 1,
      cost: 2n * TOKEN,
    })
  })

  it('buys the cheapest votes first', () => {
    const path = collusionCost(cell([50n * TOKEN, TOKEN, 9n * TOKEN, 40n * TOKEN], 0), params)
    expect(path).toEqual({ bought: 2, added: 0, cost: 10n * TOKEN })
  })

  it('adds votes rather than buying dear ones', () => {
    // Two votes at 100: buying one (100) loses to adding two at the minimum.
    const path = collusionCost(cell([100n * TOKEN, 100n * TOKEN]), params)
    expect(path).toEqual({ bought: 0, added: 2, cost: 2n * TOKEN })
  })

  it('can only buy in a cell with no free slot', () => {
    const path = collusionCost(cell([100n * TOKEN, 100n * TOKEN, 100n * TOKEN], 0), params)
    expect(path).toEqual({ bought: 2, added: 0, cost: 200n * TOKEN })
  })

  it('has to bring the quorum itself to an empty cell', () => {
    expect(collusionCost(cell([]), params)).toEqual({ bought: 0, added: 3, cost: 3n * TOKEN })
  })

  it('has no path where the quorum cannot be reached', () => {
    expect(collusionCost(cell([TOKEN], 1), params)).toBeNull()
  })

  it('needs at least one vote of its own even without a quorum to meet', () => {
    expect(collusionCost(cell([]), { minStake: TOKEN, minVotes: 0 })).toEqual({
      bought: 0,
      added: 1,
      cost: TOKEN,
    })
  })

  it('does not depend on the order the votes come in', () => {
    const stakes = [7n, 3n, 11n, 5n, 2n].map((x) => x * TOKEN)
    expect(collusionCost(cell(stakes, 2), params)).toEqual(
      collusionCost(cell([...stakes].reverse(), 2), params),
    )
  })

  it('agrees with trying every subset', () => {
    const stakes = [1n, 2n, 3n, 5n, 8n, 13n, 21n].map((x) => x * TOKEN)
    let checked = 0
    for (let v = 0; v <= stakes.length; v += 1) {
      for (let free = 0; free <= 8; free += 1) {
        for (const minVotes of [1, 2, 3, 4, 5]) {
          const p = { minStake: 2n * TOKEN, minVotes }
          const c = cell(stakes.slice(0, v), free)
          expect(collusionCost(c, p)?.cost ?? null, `v=${v} free=${free} m=${minVotes}`).toBe(
            bruteForce(c, p),
          )
          checked += 1
        }
      }
    }
    expect(checked).toBe(8 * 9 * 5)
  })

  it('is never below the floor', () => {
    // The control: the floor would be zero, and the test vacuous, if it were
    // computed from nothing.
    expect(collusionFloor(params)).toBe(2n * TOKEN)
    let feasible = 0
    for (let v = 0; v <= 8; v += 1) {
      for (let free = 0; free <= 6; free += 1) {
        for (const minVotes of [1, 2, 3, 4, 5]) {
          const p = { minStake: TOKEN, minVotes }
          const path = collusionCost(
            cell(
              Array.from({ length: v }, () => TOKEN),
              free,
            ),
            p,
          )
          if (path === null) continue
          feasible += 1
          expect(path.cost).toBeGreaterThanOrEqual(collusionFloor(p))
        }
      }
    }
    expect(feasible).toBeGreaterThan(200)
  })

  it('refuses parameters no pool can have', () => {
    expect(() => collusionCost(cell([], -1), params)).toThrow(RangeError)
    expect(() => collusionCost(cell([]), { minStake: -1n, minVotes: 3 })).toThrow(RangeError)
  })
})

describe('what half the votes does to the median', () => {
  it('moves an even count by half, which is why half is control', () => {
    // Four honest votes at 4.00 mm; two of them bought and sent as zero.
    expect(medianX100([400, 400, 400, 400])).toBe(400)
    expect(medianX100([0, 0, 400, 400])).toBe(200)
    // One short of half moves nothing.
    expect(medianX100([0, 400, 400, 400, 400])).toBe(400)
  })
})

describe('collusionFloor', () => {
  it('is half the quorum, rounded up, at the minimum stake', () => {
    expect(collusionFloor({ minStake: TOKEN, minVotes: 3 })).toBe(2n * TOKEN)
    expect(collusionFloor({ minStake: TOKEN, minVotes: 4 })).toBe(2n * TOKEN)
    expect(collusionFloor({ minStake: TOKEN, minVotes: 5 })).toBe(3n * TOKEN)
  })

  it('is the price of the cheapest cell: at its quorum, every vote at the minimum', () => {
    for (const minVotes of [1, 2, 3, 4, 5, 6]) {
      const p = { minStake: TOKEN, minVotes }
      const quorum = cell(Array.from({ length: minVotes }, () => TOKEN))
      expect(collusionCost(quorum, p)?.cost).toBe(collusionFloor(p))
    }
  })
})

describe('collusionHolds', () => {
  it('asks for twice the limit, exactly', () => {
    expect(collusionHolds(200n, 100n)).toBe(true)
    expect(collusionHolds(199n, 100n)).toBe(false)
  })

  it('holds against a limit of nothing', () => {
    expect(collusionHolds(0n, 0n)).toBe(true)
  })

  it('fails on the demo pool by four orders of magnitude', () => {
    // devnet-init.mjs: one token, quorum 3, 10% of half a million tokens.
    const limit = (500_000n * TOKEN * 1_000n) / 10_000n
    const floor = collusionFloor(params)
    expect(collusionHolds(floor, limit)).toBe(false)
    expect(collusionRatio(floor, limit)).toBeCloseTo(4e-5, 10)
  })
})

describe('collusionRatio', () => {
  it('has no ratio against a limit of nothing', () => {
    expect(collusionRatio(5n, 0n)).toBeNull()
  })
})
