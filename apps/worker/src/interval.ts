import {
  type DayRecord,
  type PublicKey,
  submitDayRecordInstruction,
  type TransactionInstruction,
} from '@pumpking/anchor-client'
import type { AcceptedReading, DayRow, IntervalRow, IntervalStore } from '@pumpking/db'
import {
  canonicalIntervalBytes,
  canonicalReadingBytes,
  cellMedian,
  classifyDay,
  DayState,
  encodeBase58,
  merkleRoot,
  type OperatorVote,
  type ReadingKindName,
} from '@pumpking/shared'

/**
 * Closing an interval, closing a day, and putting the day on chain — `FR-008`,
 * `FR-015`, `FR-047`, `FR-048`.
 *
 * This is the first place where the three packages meet in one process:
 * `@pumpking/shared` decides what the numbers are, `@pumpking/db` holds the
 * readings they are made of, and `@pumpking/anchor-client` turns the result
 * into the one transaction a cell sends per day. Nothing here re-implements
 * any of the three — the value of this file is entirely in the order it does
 * things and in what it refuses to do.
 *
 * **What it refuses to do** is decide anything. The median, the classification
 * and the Merkle tree are pure functions in `shared`, and the chain re-derives
 * dry from wet itself against the pool's published threshold. So the worst a
 * broken aggregator can do is publish a day nobody can reproduce from the
 * readings, and the root it publishes is what makes that visible: an operator
 * checks the same day, gets a different root, and has something to point at.
 * It cannot invent a reading — it holds no sensor's key — and the one thing it
 * can still do, staying silent about somebody's reading, is the open risk
 * written down in `docs/PLAN.md` rather than a problem this file solves.
 *
 * **The day is an index, not a date.** Every boundary here comes out of
 * `PoolClock`, which is the pool's own `genesis_ts` and `seconds_per_day`
 * (`FR-049`). A scenario run compresses the clock and changes nothing else:
 * the same buckets, the same medians, the same transaction.
 */

/* -------------------------------------------------------------------------- */
/* The clock                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The pool's clock, as the program publishes it, plus how finely a day is cut.
 *
 * `intervalsPerDay` is a worker parameter rather than a pool one, and
 * deliberately: the chain stores a day, never an interval, so the number of
 * buckets a day was measured in reaches it only as `total_intervals` inside
 * the record. Twenty-four in production. In a scenario run with
 * `secondsPerDay = 2` it is whatever divides two seconds usefully — the
 * coverage rule (`FR-048`) is a fraction, so it means the same thing at any
 * number of buckets.
 */
export type PoolClock = {
  /** `pool.genesis_ts`. Day 0 starts here. */
  genesisTs: Date
  /** `pool.seconds_per_day`: 86_400 in production, seconds in a run. */
  secondsPerDay: number
  intervalsPerDay: number
}

/** `total_intervals` is a `u16` on chain, and a day cannot have more buckets. */
const MAX_INTERVALS_PER_DAY = 65_535
const MAX_DAY_INDEX = 4_294_967_295

function assertClock(clock: PoolClock): void {
  if (!Number.isInteger(clock.secondsPerDay) || clock.secondsPerDay < 1) {
    throw new RangeError(`secondsPerDay must be a positive integer: ${clock.secondsPerDay}`)
  }
  if (!Number.isInteger(clock.intervalsPerDay) || clock.intervalsPerDay < 1) {
    throw new RangeError(`intervalsPerDay must be a positive integer: ${clock.intervalsPerDay}`)
  }
  if (clock.intervalsPerDay > MAX_INTERVALS_PER_DAY) {
    throw new RangeError(`a day cannot have ${clock.intervalsPerDay} intervals: u16 on chain`)
  }
  if (!Number.isFinite(clock.genesisTs.getTime())) {
    throw new RangeError('genesisTs is not a valid date')
  }
}

/**
 * The day an instant falls in, or null before genesis — the same arithmetic as
 * `Pool::day_index`, which is why it floors and why it has no answer for an
 * instant the pool did not exist in.
 */
export function dayIndexAt(clock: PoolClock, at: Date): number | null {
  assertClock(clock)
  const elapsed = at.getTime() - clock.genesisTs.getTime()
  if (!Number.isFinite(elapsed) || elapsed < 0) return null
  const index = Math.floor(elapsed / (clock.secondsPerDay * 1000))
  return index > MAX_DAY_INDEX ? null : index
}

/**
 * Start of the `intervalIndex`-th interval of `dayIndex`.
 *
 * The arithmetic runs in `BigInt` and divides last: a day index near the top
 * of `u32` times a day in milliseconds passes 2^53, and a boundary that lands
 * one millisecond off is a reading in the wrong bucket. Dividing last is also
 * what keeps `intervalIndex = 0` exactly on the day boundary the program
 * computes, whether or not the intervals divide the day evenly — with
 * `secondsPerDay = 2` and 24 buckets they do not, and the buckets then differ
 * in length by a millisecond rather than drifting away from the day.
 */
export function intervalStart(clock: PoolClock, dayIndex: number, intervalIndex: number): Date {
  assertClock(clock)
  if (!Number.isInteger(dayIndex) || dayIndex < 0) {
    throw new RangeError(`dayIndex is not a non-negative integer: ${dayIndex}`)
  }
  if (!Number.isInteger(intervalIndex) || intervalIndex < 0) {
    throw new RangeError(`intervalIndex is not a non-negative integer: ${intervalIndex}`)
  }
  const perDay = BigInt(clock.intervalsPerDay)
  const ordinal = BigInt(dayIndex) * perDay + BigInt(intervalIndex)
  const offset = (ordinal * BigInt(clock.secondsPerDay) * 1000n) / perDay
  return new Date(Number(BigInt(clock.genesisTs.getTime()) + offset))
}

/** Start of a day — `intervalStart(clock, dayIndex, 0)`, by construction. */
export function dayStart(clock: PoolClock, dayIndex: number): Date {
  return intervalStart(clock, dayIndex, 0)
}

/** Boundaries of every interval of a day, plus the start of the next day. */
function dayBoundaries(clock: PoolClock, dayIndex: number): Date[] {
  const boundaries: Date[] = []
  for (let i = 0; i < clock.intervalsPerDay; i += 1) {
    boundaries.push(intervalStart(clock, dayIndex, i))
  }
  boundaries.push(dayStart(clock, dayIndex + 1))
  return boundaries
}

/* -------------------------------------------------------------------------- */
/* Closing an interval                                                        */
/* -------------------------------------------------------------------------- */

/** The registry parameters aggregation reads. All three are published. */
export type AggregationParams = {
  kind: ReadingKindName
  /** `FR-010`: independent votes an interval needs to get a value at all. */
  minimumVotes: number
  /** `FR-047`: `pool.dry_day_threshold_mm_x100`. */
  dryThresholdX100: number
  /** `FR-048`: hundredths of a day's intervals that must carry a value. */
  minimumCoverageX100: number
}

/** One closed interval of one cell. */
export type ClosedInterval = {
  cellId: bigint
  kind: ReadingKindName
  dayIndex: number
  intervalIndex: number
  start: Date
  /** Null when the interval fell short of the minimum votes — `FR-010`. */
  medianX100: number | null
  /** Independent operators, not sensors — `FR-009`. */
  voteCount: number
  /** Every vote, whether or not it counted; the operator page shows them. */
  votes: OperatorVote[]
  /** Base58 root over the signed readings, null when there were none. */
  readingsRoot: string | null
  /**
   * Slots of the sensors whose readings the interval accepted, as the on-chain
   * bitmask indexes them. Whether they end up in the day's mask is the day's
   * decision, not this one's: an interval without a value contributes nobody.
   */
  contributors: number
}

/** Where an interval sits. Passed in because a bucket of readings cannot say. */
export type IntervalPosition = {
  cellId: bigint
  dayIndex: number
  intervalIndex: number
  start: Date
}

const MAX_SENSORS_PER_CELL = 32

/** The bitmask of one sensor slot, refusing a slot the mask cannot address. */
function slotBit(slotInCell: number): number {
  if (!Number.isInteger(slotInCell) || slotInCell < 0 || slotInCell >= MAX_SENSORS_PER_CELL) {
    // A registration error, not bad input: the unique index on
    // `(cell_id, slot_in_cell)` hands out slots and the cell holds 32. A mask
    // with a bit the program calls out of range is refused on chain, which is
    // a worse place to find out than here.
    throw new RangeError(`slot ${slotInCell} is outside the cell's ${MAX_SENSORS_PER_CELL}`)
  }
  return 1 << slotInCell
}

/**
 * Readings in the order the tree hashes them: by sensor, then by counter.
 *
 * Sorted here rather than trusted from the query. The root has to be
 * reproducible by a stranger holding the same readings (`SC-010`), so the
 * order has to be a property of the readings themselves and not of how a
 * database happened to return them.
 */
function inTreeOrder(readings: readonly AcceptedReading[]): AcceptedReading[] {
  return [...readings].sort((a, b) => {
    if (a.sensorPubkey !== b.sensorPubkey) return a.sensorPubkey < b.sensorPubkey ? -1 : 1
    if (a.counter === b.counter) return 0
    return a.counter < b.counter ? -1 : 1
  })
}

/**
 * The value of one interval of one cell — `FR-008`, `FR-009`, `FR-010`.
 *
 * The readings are the ones intake already accepted; filtering is the store's
 * job (`acceptedReadings`) and the median's contract says so. What happens
 * here is three things over the same set: the median, the root, and the mask
 * of who was in it.
 *
 * The root covers **every** accepted reading, including the ones from an
 * interval that ended up without a value. An interval below the minimum votes
 * is still an interval somebody published into, and an operator has to be able
 * to prove their reading arrived even when — especially when — the interval it
 * landed in did not count.
 */
export function closeInterval(
  readings: readonly AcceptedReading[],
  position: IntervalPosition,
  params: AggregationParams,
): ClosedInterval {
  const ordered = inTreeOrder(readings)

  const median = cellMedian(
    ordered.map((reading) => ({
      sensor: reading.sensorPubkey,
      operator: reading.operator,
      valueX100: reading.valueX100,
    })),
    { minimumVotes: params.minimumVotes },
  )

  let contributors = 0
  for (const reading of ordered) {
    contributors |= slotBit(reading.slotInCell)
  }

  const root = merkleRoot(
    ordered.map((reading) =>
      canonicalReadingBytes({
        sensor: reading.sensorPubkey,
        cellId: position.cellId,
        kind: params.kind,
        valueX100: reading.valueX100,
        measuredAt: reading.measuredAt,
        counter: reading.counter,
      }),
    ),
  )

  return {
    cellId: position.cellId,
    kind: params.kind,
    dayIndex: position.dayIndex,
    intervalIndex: position.intervalIndex,
    start: position.start,
    medianX100: median.medianX100,
    voteCount: median.voteCount,
    votes: median.votes,
    readingsRoot: root === null ? null : encodeBase58(root),
    contributors,
  }
}

/** The `cell_hours` row of a closed interval. */
export function intervalRow(interval: ClosedInterval): IntervalRow {
  return {
    cellId: interval.cellId,
    hourStart: interval.start,
    kind: interval.kind,
    medianX100: interval.medianX100,
    voteCount: interval.voteCount,
    merkleRoot: interval.readingsRoot,
    // `FR-013` is the reference check, and it is T042. Until then no interval
    // has been compared to anything, and `false` says exactly that.
    disputed: false,
  }
}

/* -------------------------------------------------------------------------- */
/* Closing a day                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The day record the chain gets, built from the day's closed intervals —
 * `FR-047`, `FR-048`, `FR-015`.
 *
 * Two things are worth naming here.
 *
 * **The mask is who was paid for, not who was on.** A day the network failed
 * to measure carries no contributors at all, even when sensors published into
 * some of its intervals — the program requires that, and it is the same rule
 * from the other side: `claim_reward` pays against this mask, and a day that
 * bought nobody any cover owes nobody a reward. `FR-064` returns the reserve
 * such days did not spend.
 *
 * **Every interval is a leaf, including the empty ones.** The tree has exactly
 * `intervalsPerDay` leaves, so the day commits to its own gaps: the trace can
 * prove that interval 14 had no value, which is a claim the insured is owed
 * (`FR-048`) and one that a tree of only the covered intervals could not make.
 */
export function closeDay(
  intervals: readonly ClosedInterval[],
  params: AggregationParams,
): DayRecord {
  const first = intervals[0]
  if (first === undefined) {
    throw new RangeError('a day has at least one interval')
  }
  for (const interval of intervals) {
    if (interval.cellId !== first.cellId || interval.dayIndex !== first.dayIndex) {
      throw new RangeError('intervals of one day record must share the cell and the day')
    }
  }

  const day = classifyDay(
    intervals.map((interval) => interval.medianX100),
    {
      dryThresholdX100: params.dryThresholdX100,
      minimumCoverageX100: params.minimumCoverageX100,
    },
  )

  let contributors = 0
  if (day.state !== DayState.NoCoverage) {
    for (const interval of intervals) {
      if (interval.medianX100 !== null) contributors |= interval.contributors
    }
  }

  const root = merkleRoot(
    intervals.map((interval) =>
      canonicalIntervalBytes({
        cellId: interval.cellId,
        kind: interval.kind,
        dayIndex: interval.dayIndex,
        intervalIndex: interval.intervalIndex,
        medianX100: interval.medianX100,
        voteCount: interval.voteCount,
        readingsRoot: interval.readingsRoot,
      }),
    ),
  )
  if (root === null) {
    throw new Error('a day with intervals has a root')
  }

  return {
    cellId: first.cellId,
    dayIndex: first.dayIndex,
    state: day.state,
    contributors,
    readingsRoot: root,
    rainfallX100: day.rainfallX100,
    coveredIntervals: day.coveredIntervals,
    totalIntervals: day.totalIntervals,
  }
}

/** The `cell_days` row of a record, keeping a signature it already carries. */
export function dayRow(record: DayRecord, txSignature: string | null): DayRow {
  return {
    cellId: record.cellId,
    dayIndex: record.dayIndex,
    state: record.state,
    rainfallX100: record.rainfallX100,
    coveredHours: record.coveredIntervals,
    merkleRoot: encodeBase58(record.readingsRoot),
    txSignature,
  }
}

/* -------------------------------------------------------------------------- */
/* Putting the day on chain                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whatever gets a signed instruction to a cluster and waits for it.
 *
 * An interface rather than a `Connection` because aggregation is arithmetic
 * and should be testable without one; the real implementation is
 * `rpcDaySubmitter` in `chain.ts`.
 */
export interface DaySubmitter {
  /** Sends and confirms, returning the transaction signature. */
  submit(instruction: TransactionInstruction): Promise<string>
}

export type AggregatorDeps = {
  store: IntervalStore
  submitter: DaySubmitter
  /** `FR-015`: must be `pool.aggregator`, and it signs. */
  aggregator: PublicKey
  clock: PoolClock
  params: AggregationParams
  programId?: PublicKey
}

export type DayOutcome =
  | { cellId: bigint; dayIndex: number; status: 'submitted'; txSignature: string }
  /** Already on chain; the log is append-only and will not take it twice. */
  | { cellId: bigint; dayIndex: number; status: 'recorded'; txSignature: string }
  | { cellId: bigint; dayIndex: number; status: 'failed'; error: Error }

/**
 * Closes one day of one cell and writes it to the chain — `FR-015`.
 *
 * The order is: intervals, then the day row, then the transaction, then the
 * signature. Storing before sending is what makes a crash recoverable — a day
 * with no signature is a day to retry, and a day with one is finished. The
 * reverse order would produce the state nobody can repair: money moved by a
 * record the aggregator has no row for.
 *
 * A day already carrying a signature is returned untouched. It is not a
 * failure and not a no-op worth hiding: `record_day` refuses anything that is
 * not strictly newer than the last, so resubmitting is not a retry, it is a
 * transaction that will be rejected for a reason unrelated to what is wrong.
 */
export async function closeCellDay(
  deps: AggregatorDeps,
  cellId: bigint,
  dayIndex: number,
): Promise<DayOutcome> {
  const existing = await deps.store.dayRecord(cellId, dayIndex)
  if (existing?.txSignature != null) {
    return { cellId, dayIndex, status: 'recorded', txSignature: existing.txSignature }
  }

  const boundaries = dayBoundaries(deps.clock, dayIndex)
  const from = boundaries[0]
  const to = boundaries[boundaries.length - 1]
  if (from === undefined || to === undefined) {
    throw new RangeError('a day has at least one interval')
  }

  const readings = await deps.store.acceptedReadings(cellId, deps.params.kind, from, to)

  const intervals: ClosedInterval[] = []
  for (let index = 0; index < deps.clock.intervalsPerDay; index += 1) {
    const start = boundaries[index]
    const end = boundaries[index + 1]
    if (start === undefined || end === undefined) {
      throw new RangeError(`day ${dayIndex} has no interval ${index}`)
    }
    const bucket = readings.filter((reading) => {
      const at = reading.measuredAt.getTime()
      return at >= start.getTime() && at < end.getTime()
    })
    intervals.push(
      closeInterval(bucket, { cellId, dayIndex, intervalIndex: index, start }, deps.params),
    )
  }

  await deps.store.saveIntervals(intervals.map(intervalRow))

  const record = closeDay(intervals, deps.params)
  await deps.store.saveDay(dayRow(record, null))

  const instruction = submitDayRecordInstruction({
    aggregator: deps.aggregator,
    record,
    ...(deps.programId === undefined ? {} : { programId: deps.programId }),
  })
  const txSignature = await deps.submitter.submit(instruction)
  await deps.store.markDaySubmitted(cellId, dayIndex, txSignature)

  return { cellId, dayIndex, status: 'submitted', txSignature }
}

/**
 * How far back a run will reach for days it never wrote.
 *
 * Not unbounded, and not one. Unbounded would have a worker that has been down
 * a fortnight replay a fortnight before it publishes today; one would leave
 * every day it missed permanently unwritten, which on chain reads as no
 * coverage and quietly breaks a run through days the network may well have
 * measured. Seven is the compromise, and it is a parameter rather than a
 * constant because the honest value depends on how long an outage the
 * deployment tolerates.
 */
export const DEFAULT_BACKLOG_DAYS = 7

/**
 * Closes every day that is over and not yet on chain, for every cell —
 * `FR-015`.
 *
 * Days ascend, because the on-chain log only grows forwards: writing today
 * before yesterday makes yesterday unwritable, and an unwritten day reads as
 * no coverage — a gap in a run that the network did not actually have. For the
 * same reason a cell stops at its first failure instead of skipping ahead.
 * Other cells carry on: one cell's RPC error is not a reason for the rest of
 * the network to miss a day.
 *
 * A cell with no readings at all still gets its day. Silence has to be written
 * down to count as silence — the ring buffer answers `None` for anything past
 * the last recorded day, so a policy whose window ends in an unwritten day
 * cannot be closed at all, however dry that day was.
 */
export async function closeDueDays(
  deps: AggregatorDeps,
  now: Date,
  backlogDays: number = DEFAULT_BACKLOG_DAYS,
): Promise<DayOutcome[]> {
  if (!Number.isInteger(backlogDays) || backlogDays < 1) {
    throw new RangeError(`backlogDays must be a positive integer: ${backlogDays}`)
  }

  const today = dayIndexAt(deps.clock, now)
  // Before genesis there is no day to close, and no clock to be wrong about.
  if (today === null || today === 0) return []

  const oldest = Math.max(0, today - backlogDays)
  const outcomes: DayOutcome[] = []

  for (const cellId of await deps.store.cellIds()) {
    for (let dayIndex = oldest; dayIndex < today; dayIndex += 1) {
      try {
        outcomes.push(await closeCellDay(deps, cellId, dayIndex))
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        outcomes.push({ cellId, dayIndex, status: 'failed', error })
        break
      }
    }
  }

  return outcomes
}
