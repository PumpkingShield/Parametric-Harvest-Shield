import { describe, expect, it } from 'vitest'
import {
  type ActivityReading,
  asActivity,
  asCellSensors,
  fetchActivity,
  peerStatus,
  readingSquares,
  shortKey,
  verdictCounts,
  verdictText,
} from './activity.ts'

/** The operator screen's reads of the API, refused when not the shape — `T040`. */

const WIRE = {
  pubkey: 'k',
  since: '2026-10-05T12:00:00.000Z',
  until: '2026-10-06T12:00:00.000Z',
  readings: [
    {
      measuredAt: '2026-10-06T10:20:00.000Z',
      cellId: '871e701b3ffffff',
      valueX100: 120,
      verdict: 'counted',
      medianX100: 100,
    },
  ],
  earned: {
    total: '18446744073709551615',
    days: [{ cellId: '871e701b3ffffff', dayIndex: 4, startsAt: null, amount: '41666' }],
  },
}

const reading = (verdict: ActivityReading['verdict'], at: string): ActivityReading => ({
  measuredAt: at,
  cellId: '871e701b3ffffff',
  valueX100: 1120,
  verdict,
  medianX100: verdict === 'pending' ? null : 0,
})

describe('asActivity', () => {
  it('reads the wire, keeping a u64 total as the decimal string it came as', () => {
    expect(asActivity(WIRE)?.earned.total).toBe('18446744073709551615')
  })

  it('refuses a verdict it does not know, and an amount that is not a whole number', () => {
    const [first] = WIRE.readings
    expect(asActivity({ ...WIRE, readings: [{ ...first, verdict: 'maybe' }] })).toBeNull()
    expect(
      asActivity({
        ...WIRE,
        earned: { ...WIRE.earned, days: [{ ...WIRE.earned.days[0], amount: '0.5' }] },
      }),
    ).toBeNull()
  })
})

describe('fetchActivity', () => {
  it('says the service did not answer, rather than showing an empty day', async () => {
    const read = await fetchActivity('http://api', 'k', () => Promise.reject(new Error('offline')))
    expect(read.kind).toBe('failed')
  })

  it('asks the activity route of the key', async () => {
    let asked = ''
    const read = await fetchActivity('http://api', 'k', async (url) => {
      asked = url
      return new Response(JSON.stringify(WIRE), { status: 200 })
    })
    expect(asked).toBe('http://api/v1/sensors/k/activity')
    expect(read.kind).toBe('read')
  })
})

describe('asCellSensors', () => {
  it('reads the cell’s sensors and refuses a problem it does not know', () => {
    const sensor = {
      pubkey: 'p',
      operator: 'o',
      slot: 0,
      stake: '0',
      voting: false,
      problem: 'understaked',
      judged: 0,
      outliers: 0,
    }
    const wire = { cellId: 'c', minStake: '1000000', windowDays: 14, sensors: [sensor] }
    expect(asCellSensors(wire)?.sensors).toHaveLength(1)
    expect(asCellSensors({ ...wire, sensors: [{ ...sensor, problem: 'lazy' }] })).toBeNull()
  })
})

describe('what the screen says', () => {
  it('counts each verdict', () => {
    const counts = verdictCounts([
      reading('counted', '2026-10-06T01:00:00Z'),
      reading('counted', '2026-10-06T02:00:00Z'),
      reading('outlier', '2026-10-06T03:00:00Z'),
    ])
    expect(counts).toMatchObject({ counted: 2, outlier: 1, pending: 0 })
  })

  it('draws the readings oldest first: counted filled, outlier dashed, the rest quiet', () => {
    const squares = readingSquares([
      reading('pending', '2026-10-06T05:00:00Z'),
      reading('outlier', '2026-10-06T03:00:00Z'),
      reading('counted', '2026-10-06T01:00:00Z'),
    ])
    expect(squares.map((square) => square.state)).toEqual(['filled', 'none', 'future'])
    expect(squares[1]?.detail).toContain('11.20 mm')
    expect(squares[1]?.detail).toContain('outlier')
  })

  it('names what a reading did not count for, and why', () => {
    expect(verdictText(reading('not-counted', 'x'))).toContain('no vote')
    expect(verdictText(reading('no-median', 'x'))).toContain('too few sensors')
    expect(verdictText(reading('pending', 'x'))).toContain('day to close')
  })

  it('says why a peer does not vote — FR-050', () => {
    const peer = {
      pubkey: 'p',
      operator: 'o',
      slot: 0,
      stake: '0',
      voting: false,
      problem: 'understaked' as const,
      judged: 0,
      outliers: 0,
    }
    expect(peerStatus(peer)).toBe('no stake — readings stored, not counted')
    expect(peerStatus({ ...peer, voting: true, problem: null })).toBe('voting')
  })

  it('shortens a key to its ends', () => {
    expect(shortKey('8kQvAAAAAAAAAAAAAAAA3nRa')).toBe('8kQv…3nRa')
  })
})
