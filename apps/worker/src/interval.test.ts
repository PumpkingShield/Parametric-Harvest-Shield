import { PublicKey, type TransactionInstruction } from '@pumpking/anchor-client'
import type { AcceptedReading, DayRow, IntervalRow, IntervalStore } from '@pumpking/db'
import {
  canonicalReadingBytes,
  cellIdFromH3Index,
  DayState,
  encodeBase58,
  merkleRoot,
  ReadingKind,
} from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type AggregationParams,
  type AggregatorDeps,
  type ClosedInterval,
  closeCellDay,
  closeDay,
  closeDueDays,
  closeInterval,
  type DaySubmitter,
  dayIndexAt,
  dayStart,
  intervalStart,
  type PoolClock,
} from './interval.ts'

const CELL_ID = cellIdFromH3Index('871e701b3ffffff')
const OTHER_CELL = cellIdFromH3Index('871e701b7ffffff')
const GENESIS = new Date('2026-08-01T00:00:00.000Z')

/** Production: a day is a day and an interval is an hour. */
const CLOCK: PoolClock = { genesisTs: GENESIS, secondsPerDay: 86_400, intervalsPerDay: 24 }

const PARAMS: AggregationParams = {
  kind: ReadingKind.PrecipitationMm,
  minimumVotes: 3,
  dryThresholdX100: 100,
  minimumCoverageX100: 75,
}

/** A base58 key of the right width, so canonical bytes can be built from it. */
const sensorKey = (seed: number): string => encodeBase58(new Uint8Array(32).fill(seed))

let counter = 0n

function reading(overrides: Partial<AcceptedReading> = {}): AcceptedReading {
  counter += 1n
  return {
    sensorPubkey: sensorKey(1),
    operator: 'operator-1',
    slotInCell: 0,
    valueX100: 100,
    measuredAt: new Date(GENESIS.getTime() + 1000),
    counter,
    signature: 'signature',
    ...overrides,
  }
}

/** Three operators, one sensor each — the minimum an interval needs. */
function quorum(valuesX100: readonly number[], measuredAt: Date): AcceptedReading[] {
  return valuesX100.map((valueX100, index) =>
    reading({
      sensorPubkey: sensorKey(index + 1),
      operator: `operator-${index + 1}`,
      slotInCell: index,
      valueX100,
      measuredAt,
    }),
  )
}

class FakeStore implements IntervalStore {
  cells: bigint[] = [CELL_ID]
  readings: AcceptedReading[] = []
  intervals: IntervalRow[] = []
  days = new Map<string, DayRow>()
  /** What the store was asked for, in order — the sequence matters. */
  calls: string[] = []

  cellIds(): Promise<bigint[]> {
    return Promise.resolve([...this.cells])
  }

  acceptedReadings(
    cellId: bigint,
    _kind: string,
    from: Date,
    to: Date,
  ): Promise<AcceptedReading[]> {
    this.calls.push('acceptedReadings')
    return Promise.resolve(
      this.readings.filter(
        (row) =>
          cellId === CELL_ID &&
          row.measuredAt.getTime() >= from.getTime() &&
          row.measuredAt.getTime() < to.getTime(),
      ),
    )
  }

  dayRecord(cellId: bigint, dayIndex: number): Promise<DayRow | null> {
    return Promise.resolve(this.days.get(`${cellId}/${dayIndex}`) ?? null)
  }

  saveIntervals(rows: readonly IntervalRow[]): Promise<void> {
    this.calls.push('saveIntervals')
    this.intervals.push(...rows)
    return Promise.resolve()
  }

  saveDay(row: DayRow): Promise<void> {
    this.calls.push('saveDay')
    this.days.set(`${row.cellId}/${row.dayIndex}`, row)
    return Promise.resolve()
  }

  markDaySubmitted(cellId: bigint, dayIndex: number, txSignature: string): Promise<void> {
    this.calls.push('markDaySubmitted')
    const key = `${cellId}/${dayIndex}`
    const row = this.days.get(key)
    if (row !== undefined) this.days.set(key, { ...row, txSignature })
    return Promise.resolve()
  }
}

class FakeSubmitter implements DaySubmitter {
  sent: TransactionInstruction[] = []
  failWith: Error | null = null

  submit(instruction: TransactionInstruction): Promise<string> {
    if (this.failWith !== null) return Promise.reject(this.failWith)
    this.sent.push(instruction)
    return Promise.resolve(`signature-${this.sent.length}`)
  }
}

let store: FakeStore
let submitter: FakeSubmitter
let deps: AggregatorDeps

beforeEach(() => {
  counter = 0n
  store = new FakeStore()
  submitter = new FakeSubmitter()
  deps = {
    store,
    submitter,
    aggregator: PublicKey.default,
    clock: CLOCK,
    params: PARAMS,
  }
})

/* -------------------------------------------------------------------------- */

describe('the clock', () => {
  it('floors to the day, the way Pool::day_index does', () => {
    expect(dayIndexAt(CLOCK, GENESIS)).toBe(0)
    expect(dayIndexAt(CLOCK, new Date(GENESIS.getTime() + 86_399_999))).toBe(0)
    expect(dayIndexAt(CLOCK, new Date(GENESIS.getTime() + 86_400_000))).toBe(1)
  })

  it('has no answer before genesis', () => {
    expect(dayIndexAt(CLOCK, new Date(GENESIS.getTime() - 1))).toBeNull()
  })

  it('puts interval zero exactly on the day boundary', () => {
    for (const day of [0, 1, 37, 100_000]) {
      expect(intervalStart(CLOCK, day, 0)).toEqual(dayStart(CLOCK, day))
      expect(dayStart(CLOCK, day).getTime()).toBe(GENESIS.getTime() + day * 86_400_000)
    }
  })

  /**
   * `FR-049`: compressing the clock changes the step and nothing else. Two
   * seconds do not divide into twenty-four whole milliseconds, so the buckets
   * differ in length — what must not happen is the day drifting away from the
   * boundary the program computes.
   */
  it('keeps days exact on a compressed clock that does not divide evenly', () => {
    const scenario: PoolClock = { genesisTs: GENESIS, secondsPerDay: 2, intervalsPerDay: 24 }
    for (const day of [0, 1, 45]) {
      expect(dayStart(scenario, day).getTime()).toBe(GENESIS.getTime() + day * 2000)
    }
    expect(intervalStart(scenario, 0, 23).getTime()).toBeLessThan(dayStart(scenario, 1).getTime())
    expect(dayIndexAt(scenario, new Date(GENESIS.getTime() + 2001))).toBe(1)
  })

  it('refuses a clock that cannot produce a boundary', () => {
    expect(() => dayStart({ ...CLOCK, secondsPerDay: 0 }, 1)).toThrow(RangeError)
    expect(() => dayStart({ ...CLOCK, intervalsPerDay: 0 }, 1)).toThrow(RangeError)
    expect(() => dayStart({ ...CLOCK, intervalsPerDay: 65_536 }, 1)).toThrow(RangeError)
  })
})

/* -------------------------------------------------------------------------- */

const POSITION = { cellId: CELL_ID, dayIndex: 0, intervalIndex: 0, start: GENESIS }

describe('closeInterval', () => {
  it('takes the median of the operators, not of the sensors', () => {
    const closed = closeInterval(
      [
        // One operator with three sensors, and it is still one vote — FR-009.
        reading({ sensorPubkey: sensorKey(1), operator: 'a', slotInCell: 0, valueX100: 900 }),
        reading({ sensorPubkey: sensorKey(2), operator: 'a', slotInCell: 1, valueX100: 900 }),
        reading({ sensorPubkey: sensorKey(3), operator: 'a', slotInCell: 2, valueX100: 900 }),
        reading({ sensorPubkey: sensorKey(4), operator: 'b', slotInCell: 3, valueX100: 100 }),
        reading({ sensorPubkey: sensorKey(5), operator: 'c', slotInCell: 4, valueX100: 200 }),
      ],
      POSITION,
      PARAMS,
    )
    expect(closed.voteCount).toBe(3)
    expect(closed.medianX100).toBe(200)
  })

  it('has no value below the minimum votes, and still has a root', () => {
    const closed = closeInterval(quorum([10, 20], GENESIS), POSITION, PARAMS)
    expect(closed.medianX100).toBeNull()
    expect(closed.voteCount).toBe(2)
    // FR-010 costs the interval its value, not the operators their proof.
    expect(closed.readingsRoot).not.toBeNull()
    expect(closed.contributors).toBe(0b11)
  })

  it('has neither value nor root when nothing was published', () => {
    const closed = closeInterval([], POSITION, PARAMS)
    expect(closed.medianX100).toBeNull()
    expect(closed.voteCount).toBe(0)
    expect(closed.readingsRoot).toBeNull()
    expect(closed.contributors).toBe(0)
  })

  it('marks the slot of every sensor it accepted', () => {
    const closed = closeInterval(
      [
        reading({ sensorPubkey: sensorKey(1), operator: 'a', slotInCell: 0 }),
        reading({ sensorPubkey: sensorKey(2), operator: 'b', slotInCell: 5 }),
        reading({ sensorPubkey: sensorKey(3), operator: 'c', slotInCell: 31 }),
      ],
      POSITION,
      PARAMS,
    )
    expect(closed.contributors).toBe(1 | (1 << 5) | (1 << 31))
  })

  it('refuses a slot the on-chain mask cannot address', () => {
    expect(() => closeInterval([reading({ slotInCell: 32 })], POSITION, PARAMS)).toThrow(RangeError)
    expect(() => closeInterval([reading({ slotInCell: -1 })], POSITION, PARAMS)).toThrow(RangeError)
  })

  it('roots the readings in an order the readings themselves fix', () => {
    const readings = quorum([10, 20, 30], GENESIS)
    const forwards = closeInterval(readings, POSITION, PARAMS)
    const backwards = closeInterval([...readings].reverse(), POSITION, PARAMS)
    expect(backwards.readingsRoot).toBe(forwards.readingsRoot)
  })

  it('roots exactly the bytes the sensors signed', () => {
    const readings = quorum([10, 20, 30], GENESIS)
    const closed = closeInterval(readings, POSITION, PARAMS)
    const expected = merkleRoot(
      readings.map((row) =>
        canonicalReadingBytes({
          sensor: row.sensorPubkey,
          cellId: CELL_ID,
          kind: ReadingKind.PrecipitationMm,
          valueX100: row.valueX100,
          measuredAt: row.measuredAt,
          counter: row.counter,
        }),
      ),
    )
    expect(closed.readingsRoot).toBe(encodeBase58(expected ?? new Uint8Array()))
  })
})

/* -------------------------------------------------------------------------- */

function intervals(valuesX100: readonly (number | null)[]): ClosedInterval[] {
  return valuesX100.map((value, index) => ({
    cellId: CELL_ID,
    kind: ReadingKind.PrecipitationMm,
    dayIndex: 0,
    intervalIndex: index,
    start: intervalStart(CLOCK, 0, index),
    medianX100: value,
    voteCount: value === null ? 0 : 3,
    votes: [],
    readingsRoot: value === null ? null : encodeBase58(new Uint8Array(32).fill(index + 1)),
    contributors: value === null ? 0 : 0b111,
  }))
}

const full = (value: number): (number | null)[] => Array.from({ length: 24 }, () => value)

describe('closeDay', () => {
  it('sums the covered intervals and calls the day dry at the threshold', () => {
    const record = closeDay(
      intervals(full(0)).map((i) => ({ ...i, medianX100: 4 })),
      PARAMS,
    )
    expect(record.rainfallX100).toBe(96)
    expect(record.state).toBe(DayState.Dry)
    expect(record.coveredIntervals).toBe(24)
    expect(record.totalIntervals).toBe(24)
  })

  it('calls the day wet one hundredth past the threshold', () => {
    const values = full(0)
    values[0] = 101
    const record = closeDay(intervals(values), PARAMS)
    expect(record.rainfallX100).toBe(101)
    expect(record.state).toBe(DayState.Wet)
  })

  it('measures a day from the intervals it has, above the coverage floor', () => {
    const values = full(0)
    for (let i = 0; i < 6; i += 1) values[i] = null
    const record = closeDay(intervals(values), PARAMS)
    expect(record.coveredIntervals).toBe(18)
    expect(record.state).toBe(DayState.Dry)
  })

  /** `FR-048`: below the floor the day is not measured, not "not dry". */
  it('has no coverage below the minimum share of intervals', () => {
    const values = full(0)
    for (let i = 0; i < 7; i += 1) values[i] = null
    const record = closeDay(intervals(values), PARAMS)
    expect(record.state).toBe(DayState.NoCoverage)
    expect(record.rainfallX100).toBeNull()
  })

  /**
   * The mask records who was paid for, not who was switched on: `claim_reward`
   * pays against it, and a day that bought nobody cover owes nobody a reward.
   * The program refuses any other pairing.
   */
  it('credits nobody for a day without coverage', () => {
    const values = full(0)
    for (let i = 0; i < 7; i += 1) values[i] = null
    expect(closeDay(intervals(values), PARAMS).contributors).toBe(0)
  })

  it('credits only the intervals that carried a value', () => {
    const withGap = intervals(full(0))
    const gap = withGap[3]
    if (gap === undefined) throw new Error('fixture')
    withGap[3] = { ...gap, medianX100: null, contributors: 0b1000, voteCount: 1 }
    expect(closeDay(withGap, PARAMS).contributors).toBe(0b111)
  })

  it('roots every interval of the day, gaps included', () => {
    const dry = closeDay(intervals(full(0)), PARAMS)
    const values = full(0)
    values[23] = null
    const gapped = closeDay(intervals(values), PARAMS)
    expect(dry.readingsRoot).toHaveLength(32)
    // The day commits to its own gaps — otherwise a missing interval and a
    // measured zero would produce the same root.
    expect(gapped.readingsRoot).not.toEqual(dry.readingsRoot)
  })

  it('refuses intervals that are not one day of one cell', () => {
    expect(() => closeDay([], PARAMS)).toThrow(RangeError)
    const mixed = intervals(full(0))
    const second = mixed[1]
    if (second === undefined) throw new Error('fixture')
    mixed[1] = { ...second, cellId: OTHER_CELL }
    expect(() => closeDay(mixed, PARAMS)).toThrow(RangeError)
  })
})

/* -------------------------------------------------------------------------- */

describe('closeCellDay', () => {
  it('buckets readings by the interval they were measured in', async () => {
    store.readings = [
      ...quorum([10, 10, 10], new Date(GENESIS.getTime() + 60_000)),
      ...quorum([20, 20, 20], new Date(GENESIS.getTime() + 3_600_000 + 60_000)),
    ]
    await closeCellDay(deps, CELL_ID, 0)

    expect(store.intervals).toHaveLength(24)
    expect(store.intervals[0]?.medianX100).toBe(10)
    expect(store.intervals[1]?.medianX100).toBe(20)
    expect(store.intervals[2]?.medianX100).toBeNull()
  })

  it('stores the day before it sends it, and the signature after', async () => {
    const outcome = await closeCellDay(deps, CELL_ID, 0)
    expect(outcome.status).toBe('submitted')
    expect(store.calls).toEqual([
      'acceptedReadings',
      'saveIntervals',
      'saveDay',
      'markDaySubmitted',
    ])
    expect(store.days.get(`${CELL_ID}/0`)?.txSignature).toBe('signature-1')
    expect(submitter.sent).toHaveLength(1)
  })

  it('writes a day nobody measured rather than skipping it', async () => {
    const outcome = await closeCellDay(deps, CELL_ID, 0)
    expect(outcome.status).toBe('submitted')
    const day = store.days.get(`${CELL_ID}/0`)
    expect(day?.state).toBe(DayState.NoCoverage)
    expect(day?.rainfallX100).toBeNull()
    expect(day?.coveredHours).toBe(0)
  })

  it('leaves a day that already reached the chain alone', async () => {
    await closeCellDay(deps, CELL_ID, 0)
    store.calls = []
    const again = await closeCellDay(deps, CELL_ID, 0)
    expect(again).toEqual({
      cellId: CELL_ID,
      dayIndex: 0,
      status: 'recorded',
      txSignature: 'signature-1',
    })
    expect(store.calls).toEqual([])
    expect(submitter.sent).toHaveLength(1)
  })

  it('retries a day whose row was written but never sent', async () => {
    store.days.set(`${CELL_ID}/0`, {
      cellId: CELL_ID,
      dayIndex: 0,
      state: DayState.NoCoverage,
      rainfallX100: null,
      coveredHours: 0,
      merkleRoot: null,
      txSignature: null,
    })
    const outcome = await closeCellDay(deps, CELL_ID, 0)
    expect(outcome.status).toBe('submitted')
    expect(submitter.sent).toHaveLength(1)
  })

  it('does not mark a day submitted when the transaction failed', async () => {
    submitter.failWith = new Error('blockhash not found')
    await expect(closeCellDay(deps, CELL_ID, 0)).rejects.toThrow('blockhash not found')
    expect(store.days.get(`${CELL_ID}/0`)?.txSignature).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */

describe('closeDueDays', () => {
  const now = (day: number): Date => new Date(GENESIS.getTime() + day * 86_400_000)

  it('closes nothing before the first day is over', async () => {
    expect(await closeDueDays(deps, GENESIS)).toEqual([])
    expect(await closeDueDays(deps, new Date(GENESIS.getTime() - 1))).toEqual([])
    expect(submitter.sent).toHaveLength(0)
  })

  /**
   * The on-chain log only grows forwards: a day written after a newer one is a
   * day that can never be written, and an unwritten day reads as no coverage —
   * a gap in a run the network did not actually have.
   */
  it('closes the backlog oldest first', async () => {
    const outcomes = await closeDueDays(deps, now(4))
    expect(outcomes.map((outcome) => outcome.dayIndex)).toEqual([0, 1, 2, 3])
  })

  it('reaches back no further than the backlog allows', async () => {
    const outcomes = await closeDueDays(deps, now(10), 3)
    expect(outcomes.map((outcome) => outcome.dayIndex)).toEqual([7, 8, 9])
  })

  it('passes over the days it has already sent', async () => {
    await closeDueDays(deps, now(2))
    const again = await closeDueDays(deps, now(3))
    expect(again.map((outcome) => outcome.status)).toEqual(['recorded', 'recorded', 'submitted'])
    expect(submitter.sent).toHaveLength(3)
  })

  it('stops a cell at its first failure and carries on with the others', async () => {
    store.cells = [CELL_ID, OTHER_CELL]
    let sends = 0
    deps.submitter = {
      submit(_instruction) {
        sends += 1
        // The first cell fails on its first day; the second cell is fine.
        if (sends === 1) return Promise.reject(new Error('rpc down'))
        return Promise.resolve(`signature-${sends}`)
      },
    }

    const outcomes = await closeDueDays(deps, now(3))
    expect(outcomes.map((outcome) => `${outcome.cellId}:${outcome.status}`)).toEqual([
      `${CELL_ID}:failed`,
      `${OTHER_CELL}:submitted`,
      `${OTHER_CELL}:submitted`,
      `${OTHER_CELL}:submitted`,
    ])
  })
})
