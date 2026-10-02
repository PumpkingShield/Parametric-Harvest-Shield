import { medianX100 } from './median.ts'

/**
 * Outliers and a sensor's reputation — `FR-011`, `FR-012`.
 *
 * **What is judged is a sensor in an interval**, not each reading. A sensor's
 * value for an interval is the median of its own readings there — the same
 * collapse `cellMedian` applies to an operator's sensors (`FR-009`) — and that
 * one value is compared with the cell's median. Judging readings one by one
 * would let a sensor dilute its outliers by publishing sixty agreeable
 * readings an hour; judged per interval, its denominator is the number of
 * intervals it took part in, and nothing it sends changes that.
 *
 * **Only an interval with a value is a judgement.** One that fell short of the
 * minimum votes (`FR-010`) has no median to be off from, and counting it either
 * way would make a quiet network look like a clean or a dirty one.
 *
 * Every number here is published and stated twice: `OUTLIER_*` constants live
 * in `programs/pumpking/src/state.rs` as `#[constant]`, and the client's test
 * checks these twins against the values the program put in its IDL. The share
 * rule runs on both sides off `fixtures/outlier-cases.json`, because the
 * program excludes on it (`T035`); the distance rule runs only here — the
 * program never sees a reading.
 */

/** Basis points, as everywhere else. */
const BPS = 10_000

/**
 * Days over which a sensor's outliers are counted before it is excluded.
 *
 * A constant rather than a pool parameter, on the chain as here: a window the
 * authority could shorten in the middle of somebody's thaw would let that stake
 * leave before the count that should have burnt it was finished.
 */
export const OUTLIER_WINDOW_DAYS = 14

/**
 * The smallest distance from the median that is ever an outlier: 0.20 mm, the
 * step of a typical tipping-bucket gauge. Below it, a difference is the
 * gauge's resolution, and in a dry hour — median zero — any relative rule
 * alone would call the first drop on one funnel a lie.
 */
export const OUTLIER_FLOOR_X100 = 20

/**
 * The share of the median a value may be off by: half. In a downpour two gauges
 * a field apart honestly differ by millimetres, and a fixed distance would
 * either be blind in the dry season or burn honest sensors in the wet one.
 */
export const OUTLIER_REL_BPS = 5_000

/** Above this share of outlier intervals in the window, a sensor is excluded. */
export const OUTLIER_SHARE_BPS = 2_000

/**
 * Judged intervals a window needs before its share means anything: three days
 * of hourly intervals. Below it one bad hour is a hundred per cent, and a
 * sensor registered this morning would be excluded by its first reading.
 */
export const OUTLIER_MIN_JUDGED = 72

/**
 * Whether a sensor's value is an outlier against the cell's — `FR-011`.
 *
 * `|value − median| > max(floor, |median| · rel)`, compared in integers scaled
 * by `BPS` so that no division rounds the boundary either way: the case
 * exactly on it is not an outlier, on every machine.
 */
export function isOutlier(valueX100: number, cellMedianX100: number): boolean {
  if (!Number.isInteger(valueX100) || !Number.isInteger(cellMedianX100)) {
    throw new RangeError(`values are integer hundredths: ${valueX100}, ${cellMedianX100}`)
  }
  const distance = BigInt(Math.abs(valueX100 - cellMedianX100)) * BigInt(BPS)
  const relative = BigInt(Math.abs(cellMedianX100)) * BigInt(OUTLIER_REL_BPS)
  const floor = BigInt(OUTLIER_FLOOR_X100) * BigInt(BPS)
  return distance > (relative > floor ? relative : floor)
}

/** One reading of an interval, as far as judging it is concerned. */
export type JudgedReading = { sensor: string; valueX100: number }

/** A sensor's standing in one interval. */
export type SensorVerdict = {
  sensor: string
  /** The median of the sensor's own readings in the interval. */
  valueX100: number
  /** The cell's median it was judged against. */
  medianX100: number
  outlier: boolean
}

/**
 * Every sensor of an interval, judged against the interval's value — or
 * nothing at all when the interval has none.
 *
 * Sorted by sensor, so the same readings give the same list whatever order
 * they were fetched in.
 */
export function judgeInterval(
  readings: readonly JudgedReading[],
  cellMedianX100: number | null,
): SensorVerdict[] {
  if (cellMedianX100 === null) return []

  const bySensor = new Map<string, number[]>()
  for (const reading of readings) {
    const own = bySensor.get(reading.sensor)
    if (own === undefined) bySensor.set(reading.sensor, [reading.valueX100])
    else own.push(reading.valueX100)
  }

  const verdicts: SensorVerdict[] = []
  for (const [sensor, values] of bySensor) {
    const value = medianX100(values)
    if (value === null) continue
    verdicts.push({
      sensor,
      valueX100: value,
      medianX100: cellMedianX100,
      outlier: isOutlier(value, cellMedianX100),
    })
  }
  return verdicts.sort((a, b) => (a.sensor < b.sensor ? -1 : a.sensor > b.sensor ? 1 : 0))
}

/** A sensor's judgements over the window. */
export type OutlierCounts = { judged: number; outliers: number }

/**
 * The share of judged intervals that were outliers, in basis points rounded
 * down, or null before anything was judged. For display: whether a sensor
 * crosses the line is `breachesOutlierShare`, which does not round.
 */
export function outlierShareBps(counts: OutlierCounts): number | null {
  assertCounts(counts)
  if (counts.judged === 0) return null
  return Math.floor((counts.outliers * BPS) / counts.judged)
}

/**
 * Whether a sensor's record over the window excludes it — `FR-012`.
 *
 * Strictly above `OUTLIER_SHARE_BPS`, and only once at least
 * `OUTLIER_MIN_JUDGED` intervals were judged. Cross-multiplied rather than
 * divided, so the threshold is exact: 20 of 100 is not over a fifth, 15 of 72
 * is.
 */
export function breachesOutlierShare(counts: OutlierCounts): boolean {
  assertCounts(counts)
  if (counts.judged < OUTLIER_MIN_JUDGED) return false
  return counts.outliers * BPS > counts.judged * OUTLIER_SHARE_BPS
}

function assertCounts({ judged, outliers }: OutlierCounts): void {
  if (!Number.isInteger(judged) || !Number.isInteger(outliers) || outliers < 0) {
    throw new RangeError(`counts are non-negative integers: ${judged}, ${outliers}`)
  }
  if (outliers > judged) {
    throw new RangeError(`more outliers than judged intervals: ${outliers} of ${judged}`)
  }
}
