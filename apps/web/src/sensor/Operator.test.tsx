import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Activity, CellSensors } from './activity.ts'
import { PeersView, ReadingsView, readingRows } from './Operator.tsx'

/** The operator screen's aggregator half — `T040`, `FR-050`. */

const activity = (verdicts: Activity['readings'][number]['verdict'][]): Activity => ({
  since: '2026-10-05T12:00:00.000Z',
  until: '2026-10-06T12:00:00.000Z',
  readings: verdicts.map((verdict, index) => ({
    measuredAt: `2026-10-06T0${index}:00:00.000Z`,
    cellId: '871e701b3ffffff',
    valueX100: 0,
    verdict,
    medianX100: null,
  })),
  earned: { total: '0', days: [] },
})

describe('readingRows', () => {
  it('counts what was sent and what of it counted, and lists only the other outcomes that happened', () => {
    expect(readingRows(activity(['counted', 'counted', 'outlier', 'pending']))).toEqual([
      ['Sent', '4'],
      ['Counted in the median', '2'],
      ['Judged an outlier', '1'],
      ['Waiting for the day to close', '1'],
    ])
    expect(readingRows(activity(['not-counted', 'no-median', 'late']))).toContainEqual([
      'Stored, not counted',
      '2',
    ])
  })
})

describe('ReadingsView', () => {
  it('says so when the phone sent nothing, instead of drawing an empty strip', () => {
    const html = renderToStaticMarkup(<ReadingsView activity={activity([])} />)
    expect(html).toContain('No readings from this phone in the last 24 hours')
  })
})

describe('PeersView', () => {
  it('lists the cell’s sensors, marks this phone, and says who has no vote', () => {
    const cell: CellSensors = {
      cellId: '871e701b3ffffff',
      minStake: '1000000',
      windowDays: 14,
      sensors: [
        {
          pubkey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          operator: 'o',
          slot: 0,
          stake: '1000000',
          voting: true,
          problem: null,
          judged: 24,
          outliers: 1,
        },
        {
          pubkey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          operator: 'o2',
          slot: 1,
          stake: '0',
          voting: false,
          problem: 'understaked',
          judged: 0,
          outliers: 0,
        },
      ],
    }
    const html = renderToStaticMarkup(
      <PeersView cell={cell} pubkey="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" />,
    )
    expect(html).toContain('23/24')
    expect(html).toContain('← this phone')
    expect(html).toContain('no stake — readings stored, not counted')
  })
})
