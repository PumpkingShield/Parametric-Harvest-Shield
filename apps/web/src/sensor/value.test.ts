import { describe, expect, it } from 'vitest'
import { formatMillimetres, parseMillimetres } from './value.ts'

describe('parseMillimetres', () => {
  it('reads whole and decimal millimetres into hundredths without a float', () => {
    expect(parseMillimetres('0')).toEqual({ ok: true, valueX100: 0 })
    expect(parseMillimetres('12')).toEqual({ ok: true, valueX100: 1200 })
    expect(parseMillimetres('2.5')).toEqual({ ok: true, valueX100: 250 })
    expect(parseMillimetres(' 0.07 ')).toEqual({ ok: true, valueX100: 7 })
    // The case a float gets wrong: 0.29 * 100 is 28.999999999999996.
    expect(parseMillimetres('0.29')).toEqual({ ok: true, valueX100: 29 })
  })

  it('takes a decimal comma, which is what a Ukrainian keyboard types', () => {
    expect(parseMillimetres('3,75')).toEqual({ ok: true, valueX100: 375 })
  })

  it('refuses a third decimal instead of rounding it into a claim', () => {
    const parsed = parseMillimetres('1.234')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain('Two decimals')
  })

  it('refuses what is not a reading', () => {
    for (const text of ['', '   ', '-1', 'abc', '1e3', '1.', '.5', '12345678']) {
      expect(parseMillimetres(text).ok, text).toBe(false)
    }
  })

  it('stays inside the i32 the signed bytes hold', () => {
    const parsed = parseMillimetres('9999999.99')
    expect(parsed).toEqual({ ok: true, valueX100: 999_999_999 })
    if (parsed.ok) expect(parsed.valueX100).toBeLessThan(2 ** 31)
  })
})

describe('formatMillimetres', () => {
  it('gives back what was typed', () => {
    for (const text of ['0', '12', '2.50', '0.07', '3.75']) {
      const parsed = parseMillimetres(text)
      if (!parsed.ok) throw new Error(text)
      expect(formatMillimetres(parsed.valueX100)).toBe(text)
    }
  })
})
