import { decodeInstruction, PublicKey, type TransactionInstruction } from '@pumpking/anchor-client'
import type {
  AcceptedReading,
  DayRow,
  IntervalRow,
  IntervalStore,
  OpenDay,
  VerdictRow,
} from '@pumpking/db'
import {
  canonicalReadingBytes,
  cellIdFromH3Index,
  DayState,
  encodeBase58,
  merkleRoot,
  REWARD_WEIGHT_UNIT,
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
  dayReputation,
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
  /** `sensor_verdicts`, keyed by cell and day the way a replace addresses them. */
  verdicts = new Map<string, VerdictRow[]>()
  days = new Map<string, DayRow>()
  /** What the store was asked for, in order — the sequence matters. */
  calls: string[] = []
  /** The minimum stake each read of readings asked for. */
  minStakes: bigint[] = []

  openDays(fromDay: number, toDay: number): Promise<OpenDay[]> {
    this.calls.push('openDays')
    const open: OpenDay[] = []
    for (const cellId of [...this.cells].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      for (let dayIndex = fromDay; dayIndex <= toDay; dayIndex += 1) {
        if (this.days.get(`${cellId}/${dayIndex}`)?.txSignature == null) {
          open.push({ cellId, dayIndex })
        }
      }
    }
    return Promise.resolve(open)
  }

  acceptedReadings(
    cellId: bigint,
    _kind: string,
    from: Date,
    to: Date,
    minStake: bigint,
  ): Promise<AcceptedReading[]> {
    this.calls.push('acceptedReadings')
    this.minStakes.push(minStake)
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

  dayRecords(cellId: bigint, fromDay: number, toDay: number): Promise<DayRow[]> {
    const rows: DayRow[] = []
    for (let day = fromDay; day <= toDay; day += 1) {
      const row = this.days.get(`${cellId}/${day}`)
      if (row !== undefined) rows.push(row)
    }
    return Promise.resolve(rows)
  }

  saveIntervals(rows: readonly IntervalRow[]): Promise<void> {
    this.calls.push('saveIntervals')
    this.intervals.push(...rows)
    return Promise.resolve()
  }

  replaceDayVerdicts(
    cellId: bigint,
    _kind: string,
    dayIndex: number,
    rows: readonly VerdictRow[],
  ): Promise<void> {
    this.calls.push('replaceDayVerdicts')
    this.verdicts.set(`${cellId}/${dayIndex}`, [...rows])
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
  /** Every transaction, as the instructions it carried. */
  transactions: TransactionInstruction[][] = []
  failWith: Error | null = null

  submit(instruction: TransactionInstruction, ...rest: TransactionInstruction[]): Promise<string> {
    if (this.failWith !== null) return Promise.reject(this.failWith)
    this.sent.push(instruction)
    this.transactions.push([instruction, ...rest])
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
    minStake: 1_000_000n,
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

  it('judges every sensor against the median its readings made — FR-011', () => {
    const closed = closeInterval(
      [
        ...quorum([300, 310, 0], GENESIS),
        // A second reading of the liar's: still one sensor in one interval.
        reading({ sensorPubkey: sensorKey(3), operator: 'operator-3', slotInCell: 2, valueX100: 0 }),
      ],
      POSITION,
      PARAMS,
    )
    expect(closed.medianX100).toBe(300)
    expect(closed.verdicts.map((one) => [one.sensor, one.valueX100, one.outlier])).toEqual(
      [
        [sensorKey(1), 300, false],
        [sensorKey(2), 310, false],
        [sensorKey(3), 0, true],
      ].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    )
    // Reputation is a second pass: the liar is still in the median, the mask
    // and the root of the interval it was judged in.
    expect(closed.contributors).toBe(0b111)
  })

  it('judges nobody in an interval without a value', () => {
    expect(closeInterval(quorum([10, 900], GENESIS), POSITION, PARAMS).verdicts).toEqual([])
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
    verdicts: [],
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
  it('stores the verdicts of the day, by interval and pool day', async () => {
    const second = new Date(GENESIS.getTime() + 3_600_000 + 60_000)
    store.readings = [
      ...quorum([300, 300, 0], new Date(GENESIS.getTime() + 60_000)),
      ...quorum([300, 300, 290], second),
    ]
    await closeCellDay(deps, CELL_ID, 0)

    const rows = store.verdicts.get(`${CELL_ID}/0`) ?? []
    expect(rows).toHaveLength(6)
    expect(rows.every((row) => row.dayIndex === 0 && row.cellId === CELL_ID)).toBe(true)
    expect(rows.filter((row) => row.outlier).map((row) => [row.sensorPubkey, row.intervalStart]))
      .toEqual([[sensorKey(3), intervalStart(CLOCK, 0, 0)]])
  })

  it('sends the day and its verdicts in one transaction, the day first — T035', async () => {
    // A covered day — a day below the coverage floor pays nobody (T036) — whose
    // first hour has a liar and whose second has an honest spread.
    const hour = (index: number) => new Date(GENESIS.getTime() + index * 3_600_000 + 60_000)
    store.readings = [
      ...quorum([300, 300, 0], hour(0)),
      ...quorum([300, 300, 290], hour(1)),
      ...Array.from({ length: 22 }, (_, index) => quorum([300, 300, 300], hour(index + 2))).flat(),
    ]
    await closeCellDay(deps, CELL_ID, 0)

    expect(submitter.transactions).toHaveLength(1)
    const [day, reputation] = submitter.transactions[0] ?? []
    expect(day).toBeDefined()
    expect(reputation).toBeDefined()
    expect(decodeInstruction(day?.data ?? new Uint8Array())?.name).toBe('submitDayRecord')
    const decoded = decodeInstruction(reputation?.data ?? new Uint8Array())
    expect(decoded?.name).toBe('submitDayReputation')
    const data = decoded?.data as
      | { params: { judged: number[]; outliers: number[]; weights: number[] } }
      | undefined
    const params = data?.params ?? { judged: [], outliers: [], weights: [] }
    expect(params.judged.slice(0, 4)).toEqual([24, 24, 24, 0])
    expect(params.outliers.slice(0, 4)).toEqual([0, 0, 1, 0])
    // T036: the weights travel too. Each sensor is its own operator here, so
    // every accepted interval is split three ways, or two where one lied.
    const third = Math.floor(REWARD_WEIGHT_UNIT / 3)
    expect(params.weights.slice(0, 4)).toEqual([
      REWARD_WEIGHT_UNIT / 2 + 23 * third,
      REWARD_WEIGHT_UNIT / 2 + 23 * third,
      23 * third,
      0,
    ])
  })

  it('sends the rewards half even when nobody was judged — T036', async () => {
    // The day's budget has to be returned on the day, and only this
    // instruction returns it.
    await closeCellDay(deps, CELL_ID, 0)
    expect(submitter.transactions.map((tx) => tx.length)).toEqual([2])
    const decoded = decodeInstruction(submitter.transactions[0]?.[1]?.data ?? new Uint8Array())
    expect(decoded?.name).toBe('submitDayReputation')
    const data = decoded?.data as { params: { weights: number[] } } | undefined
    expect(data?.params.weights.every((weight) => weight === 0)).toBe(true)
  })

  it('counts a sensor that moved in the cell it left up to the move, and not in its interval — FR-059', async () => {
    const hour = (index: number) => new Date(GENESIS.getTime() + index * 3_600_000 + 60_000)
    const movedAt = new Date(GENESIS.getTime() + 2.5 * 3_600_000)
    // Sensor 3 left at 02:30 and, until the mirror caught up, kept naming
    // this cell: its readings are stored, and stop counting at the move.
    store.readings = [0, 1, 2, 3].flatMap((index) =>
      quorum([10, 10, 10], hour(index)).map((one) =>
        one.slotInCell === 2 ? { ...one, votesUntil: movedAt } : one,
      ),
    )
    await closeCellDay(deps, CELL_ID, 0)

    expect(store.intervals.slice(0, 4).map((row) => row.voteCount)).toEqual([3, 3, 2, 2])
    // Two votes are short of the minimum: the interval of the move has no value.
    expect(store.intervals[2]?.medianX100).toBeNull()
  })

  it('counts a sensor that moved in from the first whole interval after the move — FR-059', async () => {
    const hour = (index: number) => new Date(GENESIS.getTime() + index * 3_600_000 + 60_000)
    const movedAt = new Date(GENESIS.getTime() + 2.5 * 3_600_000)
    store.readings = [2, 3].flatMap((index) =>
      quorum([10, 10, 10], hour(index)).map((one) =>
        one.slotInCell === 2 ? { ...one, votesFrom: movedAt } : one,
      ),
    )
    await closeCellDay(deps, CELL_ID, 0)

    expect(store.intervals.slice(2, 4).map((row) => row.voteCount)).toEqual([2, 3])
  })

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

  it('asks only for readings of sensors holding the minimum stake — FR-050', async () => {
    await closeCellDay({ ...deps, minStake: 5_000_000n }, CELL_ID, 0)
    // The filter is the store's (`votingSensor`); what is checked here is that
    // the day is never taken over a set the minimum was not applied to.
    expect(store.minStakes).toEqual([5_000_000n])
  })

  it('stores the day before it sends it, and the signature after', async () => {
    const outcome = await closeCellDay(deps, CELL_ID, 0)
    expect(outcome.status).toBe('submitted')
    expect(store.calls).toEqual([
      'acceptedReadings',
      'saveIntervals',
      'replaceDayVerdicts',
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
    // Days on chain are not visited at all — not even to be reported.
    expect(again.map((outcome) => `${outcome.dayIndex}:${outcome.status}`)).toEqual(['2:submitted'])
    expect(submitter.sent).toHaveLength(3)
  })

  it('asks the store one question on a quiet cycle, however long the backlog', async () => {
    // `T073`: thirty days of backlog used to be thirty reads per cell per
    // cycle, and at the `SC-008` load that alone spent both free traffic
    // allowances within a week.
    await closeDueDays(deps, now(30), 30)
    store.calls = []

    const quiet = await closeDueDays(deps, now(30), 30)
    expect(quiet).toEqual([])
    expect(store.calls).toEqual(['openDays'])
  })

  it('retries a day whose row exists but whose transaction never landed', async () => {
    // Row written, worker died before the signature was stored: the day is
    // unfinished, and the question must still find it.
    store.days.set(`${CELL_ID}/0`, {
      cellId: CELL_ID,
      dayIndex: 0,
      state: DayState.NoCoverage,
      rainfallX100: null,
      coveredHours: 0,
      merkleRoot: null,
      txSignature: null,
    })

    const outcomes = await closeDueDays(deps, now(1))
    expect(outcomes.map((outcome) => `${outcome.dayIndex}:${outcome.status}`)).toEqual([
      '0:submitted',
    ])
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

describe('dayReputation', () => {
  /** `quorum` gives sensor n slot n − 1 and an operator of its own. */
  const sensors = new Map(
    [1, 2, 3].map((seed, slot) => [sensorKey(seed), { slot, operator: `operator-${seed}` }]),
  )
  const position = (intervalIndex: number) => ({
    cellId: CELL_ID,
    dayIndex: 3,
    intervalIndex,
    start: intervalStart(CLOCK, 3, intervalIndex),
  })

  it('counts each slot’s judgements and outliers over the day', () => {
    const intervals = [
      closeInterval(quorum([300, 300, 0], GENESIS), position(0), PARAMS),
      closeInterval(quorum([300, 300, 0], GENESIS), position(1), PARAMS),
      // No value: nobody judged.
      closeInterval(quorum([300, 0], GENESIS), position(2), PARAMS),
    ]
    const reputation = dayReputation(intervals, sensors, 0b111)
    expect(reputation.dayIndex).toBe(3)
    expect(reputation.judged.slice(0, 4)).toEqual([2, 2, 2, 0])
    expect(reputation.outliers.slice(0, 4)).toEqual([0, 0, 2, 0])
    expect(reputation.judged).toHaveLength(32)
    // The liar earned nothing; the two others split each interval.
    expect(reputation.weights.slice(0, 4)).toEqual([REWARD_WEIGHT_UNIT, REWARD_WEIGHT_UNIT, 0, 0])
    expect(reputation.weights).toHaveLength(32)
  })

  it('splits by operator before sensor — FR-009', () => {
    const shared = new Map([
      [sensorKey(1), { slot: 0, operator: 'roof' }],
      [sensorKey(2), { slot: 1, operator: 'roof' }],
      [sensorKey(3), { slot: 2, operator: 'field' }],
    ])
    const intervals = [closeInterval(quorum([300, 300, 300], GENESIS), position(0), PARAMS)]
    const reputation = dayReputation(intervals, shared, 0b111)
    expect(reputation.weights.slice(0, 3)).toEqual([
      REWARD_WEIGHT_UNIT / 4,
      REWARD_WEIGHT_UNIT / 4,
      REWARD_WEIGHT_UNIT / 2,
    ])
  })

  it('pays nobody on a day whose mask is empty, and still counts the verdicts', () => {
    const intervals = [closeInterval(quorum([300, 300, 0], GENESIS), position(0), PARAMS)]
    const reputation = dayReputation(intervals, sensors, 0)
    expect(reputation.judged.slice(0, 3)).toEqual([1, 1, 1])
    expect(reputation.weights.every((weight) => weight === 0)).toBe(true)
  })

  it('is all zeroes for a day nobody was judged in, and still a reputation', () => {
    const reputation = dayReputation([closeInterval([], position(0), PARAMS)], new Map(), 0)
    expect(reputation.judged.every((n) => n === 0)).toBe(true)
    expect(reputation.weights.every((n) => n === 0)).toBe(true)
  })

  it('refuses a verdict whose sensor it cannot place', () => {
    const intervals = [closeInterval(quorum([300, 300, 0], GENESIS), position(0), PARAMS)]
    expect(() => dayReputation(intervals, new Map(), 0b111)).toThrow(RangeError)
  })
})
