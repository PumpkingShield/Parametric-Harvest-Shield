import { describe, expect, it } from 'vitest'
import { formatExact } from './money.ts'

describe('formatExact', () => {
  it('keeps a fraction of a cent, which is what a day of rewards is', () => {
    expect(formatExact(41_666n, 6)).toBe('0.041666')
  })

  it('writes whole sums with hundredths, and drops zeros past them', () => {
    expect(formatExact('25000000', 6)).toBe('25.00')
    expect(formatExact(1_500_000n, 6)).toBe('1.50')
  })

  it('does not lose the last digits of a u64', () => {
    expect(formatExact(2n ** 64n - 1n, 6)).toBe('18446744073709.551615')
  })

  it('handles an asset without decimals', () => {
    expect(formatExact(7n, 0)).toBe('7')
  })
})
