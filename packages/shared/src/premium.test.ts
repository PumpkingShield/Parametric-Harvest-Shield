import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BPS_DENOMINATOR,
  dryDayFrequencyBps,
  MIN_HISTORY_DAYS,
  premiumFor,
  premiumRateBps,
} from './premium.ts'

const fixtures = JSON.parse(
  readFileSync(new URL('../../../fixtures/premium-cases.json', import.meta.url), 'utf8'),
) as {
  frequency: { name: string; days: number[]; frequencyBps: number | null }[]
  premium: {
    name: string
    payout: string
    frequencyBps: number
    riskLoadingBps: number
    minRateBps: number
    rateBps: number
    premium: string
  }[]
}

/**
 * The Rust twin in `programs/pumpking/src/premium.rs` runs this exact file. A
 * case that passes on one side and fails on the other is the divergence the
 * fixture exists to catch.
 */
describe('dryDayFrequencyBps — shared cases', () => {
  for (const testCase of fixtures.frequency) {
    it(testCase.name, () => {
      expect(dryDayFrequencyBps(testCase.days)).toBe(testCase.frequencyBps)
    })
  }
})

describe('premium — shared cases', () => {
  for (const testCase of fixtures.premium) {
    it(testCase.name, () => {
      const rate = premiumRateBps(
        testCase.frequencyBps,
        testCase.riskLoadingBps,
        testCase.minRateBps,
      )
      expect(rate).toBe(testCase.rateBps)
      expect(premiumFor(BigInt(testCase.payout), rate)).toBe(BigInt(testCase.premium))
    })
  }
})

describe('dryDayFrequencyBps', () => {
  it('refuses to quote one day below the minimum record', () => {
    const short = Array.from({ length: MIN_HISTORY_DAYS - 1 }, () => 1)
    expect(dryDayFrequencyBps(short)).toBeNull()

    short.push(1)
    expect(dryDayFrequencyBps(short)).toBe(BPS_DENOMINATOR)
  })

  it('counts coverage, not length', () => {
    // A hundred days of silence around fourteen recorded ones is still a
    // fourteen-day record — `FR-047` again: silence is not a wet day.
    const sparse = [...Array.from({ length: 50 }, () => 0), ...Array.from({ length: 14 }, () => 2)]
    expect(dryDayFrequencyBps(sparse)).toBe(0)
  })
})

describe('premiumRateBps', () => {
  it('is monotone in the frequency', () => {
    const rates = [0, 1_000, 2_000, 5_000].map((bps) => premiumRateBps(bps, 2_500, 100))
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1] ?? 0)
    }
  })

  it('never quotes below the published floor', () => {
    expect(premiumRateBps(0, 0, 250)).toBe(250)
    expect(premiumRateBps(1, 0, 250)).toBe(250)
    expect(premiumRateBps(300, 0, 250)).toBe(300)
  })
})

describe('premiumFor', () => {
  it('charges at least one unit for any rate above nothing', () => {
    expect(premiumFor(1n, 1)).toBe(1n)
    expect(premiumFor(1n, BPS_DENOMINATOR)).toBe(1n)
  })

  it('is exact when the arithmetic divides', () => {
    expect(premiumFor(10_000n, 250)).toBe(250n)
  })

  it('costs nothing only when the rate is nothing', () => {
    expect(premiumFor(1_000_000n, 0)).toBe(0n)
  })
})
