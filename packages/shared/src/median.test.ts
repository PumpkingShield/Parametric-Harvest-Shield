import { describe, expect, it } from 'vitest'
import { cellMedian, medianX100, type SensorReading } from './median.ts'

const reading = (sensor: string, operator: string, valueX100: number): SensorReading => ({
  sensor,
  operator,
  valueX100,
})

describe('medianX100', () => {
  it('is the middle value of an odd count', () => {
    expect(medianX100([300, 100, 200])).toBe(200)
  })

  it('averages the two middle values of an even count', () => {
    expect(medianX100([100, 200, 300, 400])).toBe(250)
  })

  it('rounds an odd average down, not toward zero', () => {
    expect(medianX100([100, 101])).toBe(100)
    expect(medianX100([-101, -100])).toBe(-101)
  })

  it('does not overflow on values at the edge of the column', () => {
    expect(medianX100([2_147_483_647, 2_147_483_646])).toBe(2_147_483_646)
    expect(medianX100([-2_147_483_648, -2_147_483_647])).toBe(-2_147_483_648)
  })

  it('does not depend on the order the readings arrived in', () => {
    const values = [512, 7, 1900, 44, 44, 3, 88]
    const shuffled = [88, 44, 3, 1900, 7, 44, 512]
    expect(medianX100(shuffled)).toBe(medianX100(values))
  })

  it('has no median for nothing', () => {
    expect(medianX100([])).toBeNull()
  })

  it('is the value itself for a single reading', () => {
    expect(medianX100([1250])).toBe(1250)
  })
})

describe('cellMedian', () => {
  const params = { minimumVotes: 3 }

  it('takes the median of one vote per operator', () => {
    const result = cellMedian(
      [reading('s1', 'alice', 100), reading('s2', 'bob', 200), reading('s3', 'carol', 900)],
      params,
    )
    expect(result.medianX100).toBe(200)
    expect(result.voteCount).toBe(3)
  })

  it('collapses the sensors of one operator into a single vote — FR-009', () => {
    // Bob runs thirty sensors all reporting a drought. Alice and Carol have one
    // each. Bob carries one vote, not thirty, or influence over a cell would
    // cost the price of hardware.
    const bobs = Array.from({ length: 30 }, (_, i) => reading(`b${i}`, 'bob', 0))
    const result = cellMedian(
      [reading('s1', 'alice', 500), ...bobs, reading('s3', 'carol', 600)],
      params,
    )
    expect(result.voteCount).toBe(3)
    expect(result.medianX100).toBe(500)
  })

  it('collapses an operator by the median of its own sensors', () => {
    const result = cellMedian(
      [
        reading('a1', 'alice', 100),
        reading('a2', 'alice', 300),
        reading('a3', 'alice', 200),
        reading('s2', 'bob', 1000),
        reading('s3', 'carol', 1100),
      ],
      params,
    )
    const alice = result.votes.find((vote) => vote.operator === 'alice')
    expect(alice?.valueX100).toBe(200)
    expect(alice?.sensors).toEqual(['a1', 'a2', 'a3'])
  })

  it('has no value below the minimum number of independent votes — FR-010', () => {
    const result = cellMedian([reading('s1', 'alice', 100), reading('s2', 'bob', 200)], params)
    expect(result.medianX100).toBeNull()
    expect(result.voteCount).toBe(2)
  })

  it('keeps the votes visible even when the interval has no value', () => {
    // The operator has to be able to see the reading arrived, and the trace has
    // to be able to show how far short the interval fell.
    const result = cellMedian([reading('s1', 'alice', 100)], params)
    expect(result.medianX100).toBeNull()
    expect(result.votes).toHaveLength(1)
    expect(result.votes[0]?.sensors).toEqual(['s1'])
  })

  it('has no value and no votes for an interval nobody reported in', () => {
    const result = cellMedian([], params)
    expect(result.medianX100).toBeNull()
    expect(result.voteCount).toBe(0)
    expect(result.votes).toEqual([])
  })

  it('gives the same result whatever order the readings arrived in', () => {
    const readings = [
      reading('s1', 'alice', 700),
      reading('s2', 'bob', 100),
      reading('a2', 'alice', 500),
      reading('s3', 'carol', 400),
      reading('s4', 'dave', 400),
    ]
    const forwards = cellMedian(readings, params)
    const backwards = cellMedian([...readings].reverse(), params)
    expect(backwards).toEqual(forwards)
  })

  it('sorts the votes by value and breaks ties by operator', () => {
    const result = cellMedian(
      [reading('s1', 'carol', 400), reading('s2', 'alice', 400), reading('s3', 'bob', 100)],
      params,
    )
    expect(result.votes.map((vote) => vote.operator)).toEqual(['bob', 'alice', 'carol'])
  })

  it('counts a sensor once even if it reported twice in the interval', () => {
    const result = cellMedian(
      [
        reading('s1', 'alice', 100),
        reading('s1', 'alice', 300),
        reading('s2', 'bob', 200),
        reading('s3', 'carol', 200),
      ],
      params,
    )
    expect(result.votes.find((vote) => vote.operator === 'alice')?.sensors).toEqual(['s1'])
  })

  it('refuses a minimum that would let an empty interval have a value', () => {
    expect(() => cellMedian([], { minimumVotes: 0 })).toThrow(RangeError)
    expect(() => cellMedian([], { minimumVotes: -1 })).toThrow(RangeError)
    expect(() => cellMedian([], { minimumVotes: 1.5 })).toThrow(RangeError)
  })
})
