import { describe, expect, it } from 'vitest'
import type { SensorVerdict } from './outlier.ts'
import { dayWeights, intervalWeights, REWARD_WEIGHT_UNIT } from './rewards.ts'

const UNIT = REWARD_WEIGHT_UNIT

function verdict(sensor: string, outlier = false): SensorVerdict {
  return { sensor, valueX100: 100, medianX100: 100, outlier }
}

/** Sensors `a1`, `a2` belong to operator `a`, `b1` to `b`, and so on. */
const operatorOf = (sensor: string): string | undefined => sensor.slice(0, 1)

describe('intervalWeights', () => {
  it('splits an interval equally between operators, not sensors', () => {
    // FR-009: two sensors of one operator are one vote.
    const weights = intervalWeights([verdict('a1'), verdict('a2'), verdict('b1')], operatorOf)
    expect(weights.get('b1')).toBe(UNIT / 2)
    expect(weights.get('a1')).toBe(UNIT / 4)
    expect(weights.get('a2')).toBe(UNIT / 4)
  })

  it('pays an outlier nothing and leaves its part to the others', () => {
    const weights = intervalWeights([verdict('a1'), verdict('b1', true)], operatorOf)
    expect(weights.get('a1')).toBe(UNIT)
    expect(weights.has('b1')).toBe(false)
  })

  it('an operator whose only sensor lied is not a vote', () => {
    const weights = intervalWeights([verdict('a1', true), verdict('b1'), verdict('c1')], operatorOf)
    expect(weights.get('b1')).toBe(UNIT / 2)
    expect(weights.get('c1')).toBe(UNIT / 2)
  })

  it('rounds down and never hands out more than the unit', () => {
    const weights = intervalWeights([verdict('a1'), verdict('b1'), verdict('c1')], operatorOf)
    const sum = [...weights.values()].reduce((a, b) => a + b, 0)
    expect(weights.get('a1')).toBe(Math.floor(UNIT / 3))
    expect(sum).toBeLessThanOrEqual(UNIT)
  })

  it('an interval without a value pays nobody', () => {
    expect(intervalWeights([], operatorOf).size).toBe(0)
  })

  it('refuses a judged sensor nobody operates', () => {
    expect(() => intervalWeights([verdict('a1')], () => undefined)).toThrow(RangeError)
  })
})

describe('dayWeights', () => {
  it('sums a sensor over the intervals it was accepted in', () => {
    const weights = dayWeights(
      [[verdict('a1'), verdict('b1')], [verdict('a1'), verdict('b1', true)], []],
      operatorOf,
    )
    expect(weights.get('a1')).toBe(UNIT / 2 + UNIT)
    expect(weights.get('b1')).toBe(UNIT / 2)
  })
})
