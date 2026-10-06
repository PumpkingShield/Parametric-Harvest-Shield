import type { OperatorStore, RegistryRow, SensorReadingRow } from '@pumpking/db'
import { cellIdFromH3Index, sensorPublicKey } from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type ActivityWire,
  createActivityRoute,
  dayIndexOf,
  type PoolClock,
  readingVerdicts,
} from './activity.ts'

/**
 * What became of a sensor's readings, told from what the aggregator wrote —
 * `T040`. A day is 24 one-hour intervals here; the route is never told so, and
 * learns the boundaries from `cell_hours`.
 */

const H3 = '871e701b3ffffff'
const LEFT = '871e701b2ffffff'
const CELL = cellIdFromH3Index(H3)
const OLD = cellIdFromH3Index(LEFT)
const CLOCK: PoolClock = { genesisTs: new Date('2026-10-01T00:00:00Z'), secondsPerDay: 86_400 }
/** Day 5 of the pool. */
const at = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00Z`)

const reading = (time: string, overrides: Partial<SensorReadingRow> = {}): SensorReadingRow => ({
  cellId: CELL,
  measuredAt: at(time),
  valueX100: 120,
  status: 'accepted',
  ...overrides,
})

/** Day 5's intervals of a cell, each hour with the given median. */
const hours = (cellId: bigint, median: (hour: number) => number | null) =>
  Array.from({ length: 24 }, (_unused, hour) => ({
    cellId,
    start: new Date(at('00:00').getTime() + hour * 3_600_000),
    medianX100: median(hour),
  }))

describe('readingVerdicts', () => {
  const closedDays = [{ cellId: CELL, dayIndex: 5 }]

  it('counts a reading whose interval judged it with the median, and gives the median', () => {
    const [wire] = readingVerdicts({
      readings: [reading('10:20')],
      intervals: hours(CELL, () => 100),
      closedDays,
      verdicts: [
        {
          cellId: CELL,
          intervalStart: at('10:00'),
          valueX100: 120,
          medianX100: 100,
          outlier: false,
        },
      ],
      clock: CLOCK,
    })
    expect(wire).toMatchObject({ cellId: H3, verdict: 'counted', medianX100: 100 })
  })

  it('names an outlier — FR-011', () => {
    const [wire] = readingVerdicts({
      readings: [reading('14:59')],
      intervals: hours(CELL, () => 0),
      closedDays,
      verdicts: [
        { cellId: CELL, intervalStart: at('14:00'), valueX100: 1120, medianX100: 0, outlier: true },
      ],
      clock: CLOCK,
    })
    expect(wire?.verdict).toBe('outlier')
  })

  it('tells an interval without a median from one this sensor had no vote in', () => {
    const wires = readingVerdicts({
      readings: [reading('03:10'), reading('04:10')],
      intervals: hours(CELL, (hour) => (hour === 3 ? null : 50)),
      closedDays,
      verdicts: [],
      clock: CLOCK,
    })
    expect(wires.map((wire) => wire.verdict)).toEqual(['no-median', 'not-counted'])
    // The median it was not counted towards is still shown.
    expect(wires[1]?.medianX100).toBe(50)
  })

  it('waits for a day not closed yet instead of guessing — and says late for late', () => {
    const wires = readingVerdicts({
      readings: [reading('10:20'), reading('11:00', { status: 'late' })],
      intervals: [],
      closedDays: [],
      verdicts: [],
      clock: CLOCK,
    })
    expect(wires.map((wire) => wire.verdict)).toEqual(['pending', 'late'])
  })

  it('looks in the cell the reading was stored under, not the sensor’s current one — FR-059', () => {
    // Moved from OLD at 09:30. The 09:10 reading went to OLD and was judged
    // there; the same hour in CELL has a median and no verdict of it.
    const [wire] = readingVerdicts({
      readings: [reading('09:10', { cellId: OLD })],
      intervals: [...hours(CELL, () => 70), ...hours(OLD, () => 0)],
      closedDays: [...closedDays, { cellId: OLD, dayIndex: 5 }],
      verdicts: [
        { cellId: OLD, intervalStart: at('09:00'), valueX100: 0, medianX100: 0, outlier: false },
      ],
      clock: CLOCK,
    })
    expect(wire).toMatchObject({ cellId: LEFT, verdict: 'counted', medianX100: 0 })
  })

  it('keeps a reading of a day not closed pending, whatever intervals are written', () => {
    // Day 4 is closed and day 5 is not. Day 5's intervals are there all the
    // same: the worker writes them before the day row, and one that stopped
    // between the two leaves exactly this. Without the day, nothing is judged.
    const dayFour = hours(CELL, () => 0).map((one) => ({
      ...one,
      start: new Date(one.start.getTime() - 86_400_000),
    }))
    const [wire] = readingVerdicts({
      readings: [reading('00:10')],
      intervals: [...dayFour, ...hours(CELL, () => 50)],
      closedDays: [{ cellId: CELL, dayIndex: 4 }],
      verdicts: [],
      clock: CLOCK,
    })
    expect(wire?.verdict).toBe('pending')
  })

  it('never takes an interval of the day before for a reading of a closed day', () => {
    // Day 5 is closed and its intervals are not in the answer — swept, or a
    // query cut short. The last interval of day 4 starts before 00:10 too,
    // and is still not where the reading was judged.
    const dayFour = hours(CELL, () => 0).map((one) => ({
      ...one,
      start: new Date(one.start.getTime() - 86_400_000),
    }))
    const [wire] = readingVerdicts({
      readings: [reading('00:10')],
      intervals: dayFour,
      closedDays: [
        { cellId: CELL, dayIndex: 4 },
        { cellId: CELL, dayIndex: 5 },
      ],
      verdicts: [],
      clock: CLOCK,
    })
    expect(wire?.verdict).toBe('pending')
  })

  it('is pending everywhere before there is a pool', () => {
    const [wire] = readingVerdicts({
      readings: [reading('10:20')],
      intervals: hours(CELL, () => 0),
      closedDays,
      verdicts: [],
      clock: null,
    })
    expect(wire?.verdict).toBe('pending')
  })
})

describe('dayIndexOf', () => {
  it('counts pool days from genesis, and has none before it', () => {
    expect(dayIndexOf(CLOCK, at('10:00'))).toBe(5)
    expect(dayIndexOf(CLOCK, new Date('2026-09-30T23:59:59Z'))).toBeNull()
  })
})

describe('GET /v1/sensors/:pubkey/activity', () => {
  let pubkey: string
  let rows: RegistryRow[]
  const asked: { earnedFrom?: number; cells?: bigint[] } = {}

  const store: OperatorStore = {
    sensorReadings: async () => [reading('10:20')],
    closedDays: async () => [],
    cellIntervals: async (cells) => {
      asked.cells = [...cells]
      return []
    },
    sensorVerdicts: async () => [],
    earnedDays: async (_pubkey, fromDay) => {
      asked.earnedFrom = fromDay
      return [{ cellId: CELL, dayIndex: 4, earned: 41_666n }]
    },
    earnedTotal: async () => 2n ** 64n - 1n,
    cellSensors: async () => [],
  }

  beforeEach(async () => {
    pubkey = await sensorPublicKey(new Uint8Array(32).fill(4))
    rows = [
      {
        pubkey,
        operatorWallet: 'operator',
        cellId: CELL,
        slotInCell: 2,
        previousCellId: OLD,
        previousSlot: 0,
        movedAt: at('09:30'),
        stake: 1n,
        accepted: 0,
        outliers: 0,
        active: true,
        mirrored: true,
      },
    ]
  })

  function route() {
    return createActivityRoute({
      registry: { rowsOf: async (keys) => rows.filter((row) => keys.includes(row.pubkey)) },
      store,
      clock: async () => CLOCK,
      now: () => at('12:00'),
    })
  }

  it('answers with the day’s readings and the earnings by day, amounts as decimal strings', async () => {
    const response = await route().request(`/${pubkey}/activity`)
    expect(response.status).toBe(200)
    const wire = (await response.json()) as ActivityWire
    expect(wire.since).toBe('2026-10-05T12:00:00.000Z')
    expect(wire.readings).toHaveLength(1)
    expect(wire.earned).toEqual({
      total: '18446744073709551615',
      days: [{ cellId: H3, dayIndex: 4, startsAt: '2026-10-05T00:00:00.000Z', amount: '41666' }],
    })
    // Thirty days back from today (day 5), and both cells a moved sensor
    // stored readings under.
    expect(asked.earnedFrom).toBe(0)
    expect(asked.cells).toEqual([CELL, OLD])
  })

  it('is a 404 for a key the registry does not have, and a 400 for one that is not a key', async () => {
    rows = []
    expect((await route().request(`/${pubkey}/activity`)).status).toBe(404)
    expect((await route().request('/not-a-key/activity')).status).toBe(400)
  })
})
