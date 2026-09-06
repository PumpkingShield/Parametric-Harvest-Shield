/**
 * The value of a cell for one interval — `FR-008`, `FR-009`, `FR-010`.
 *
 * The input is the readings the aggregator has already accepted for one cell,
 * one kind and one interval: signature checked (`FR-002`), counter fresh
 * (`FR-003`), inside the window (`FR-004`), sensor not excluded (`FR-012`).
 * Filtering is the caller's job; this file is arithmetic and nothing else.
 *
 * Marking outliers against the median (`FR-011`) is T034 and deliberately not
 * here: reputation is a second pass over the result, and folding it in would
 * make the median depend on the reputation it is supposed to produce.
 */

/** One accepted reading, carrying the operator the sensor belongs to. */
export type SensorReading = {
  /** Base58 ed25519 key of the sensor. */
  sensor: string
  /** Operator wallet. Sensors sharing one are one vote — `FR-009`. */
  operator: string
  valueX100: number
}

/** What one operator contributed, however many sensors it owns. */
export type OperatorVote = {
  operator: string
  valueX100: number
  /** The sensors behind the vote, sorted. Shown on the operator page. */
  sensors: string[]
}

export type CellMedian = {
  /**
   * Null when the interval fell short of the minimum number of independent
   * votes — `FR-010`. Not zero, and not the median of what little there was:
   * an interval without coverage triggers no policy, and a number here would
   * be indistinguishable from a measured drought.
   */
  medianX100: number | null
  /** Independent operators, not sensors — the count `cell_hours` stores. */
  voteCount: number
  /** Every vote, sorted by value then operator, whether or not it counted. */
  votes: OperatorVote[]
}

export type MedianParams = {
  /** Minimum independent votes for the interval to have a value — `FR-010`. */
  minimumVotes: number
}

/**
 * Median of integers, without leaving the integers.
 *
 * An even count averages the two middle values and rounds **down**. The
 * addition runs in `BigInt` because two values at the edge of `i32` sum past
 * it, and the shift is an arithmetic one, so the rounding is a floor for
 * negative sums too rather than a truncation toward zero — the direction has
 * to be one rule, not two, or a reimplementation elsewhere picks the other.
 * The effect is bounded by one hundredth of a unit and lands in favour of the
 * insured, which is the safe side to be off by.
 *
 * Returns null for an empty set: the median of nothing is not zero.
 */
export function medianX100(values: readonly number[]): number | null {
  if (values.length === 0) return null

  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const upper = sorted[middle]
  if (upper === undefined) return null

  if (sorted.length % 2 === 1) return upper

  const lower = sorted[middle - 1]
  if (lower === undefined) return null

  return Number((BigInt(lower) + BigInt(upper)) >> 1n)
}

/**
 * The cell value for an interval: one vote per operator, then the median of
 * the votes.
 *
 * An operator running thirty sensors in a cell carries the same weight as one
 * running a single sensor (`FR-009`) — otherwise buying influence over a cell
 * would cost the price of hardware. Its own sensors are collapsed by the same
 * median, so the collapse is the same operation at both levels and neither
 * introduces a rounding rule the other does not have.
 *
 * Votes are returned even when the interval has no value, because the trace
 * (`FR-037`) has to be able to show that the interval fell short and by how
 * much, and because an operator has to be able to see that its reading was
 * received (the aggregator staying silent is the open risk in the model).
 */
export function cellMedian(readings: readonly SensorReading[], params: MedianParams): CellMedian {
  if (!Number.isInteger(params.minimumVotes) || params.minimumVotes < 1) {
    throw new RangeError(`minimumVotes must be a positive integer: ${params.minimumVotes}`)
  }

  const byOperator = new Map<string, SensorReading[]>()
  for (const reading of readings) {
    const own = byOperator.get(reading.operator)
    if (own === undefined) byOperator.set(reading.operator, [reading])
    else own.push(reading)
  }

  const votes: OperatorVote[] = []
  for (const [operator, own] of byOperator) {
    const valueX100 = medianX100(own.map((reading) => reading.valueX100))
    if (valueX100 === null) continue
    votes.push({
      operator,
      valueX100,
      sensors: [...new Set(own.map((reading) => reading.sensor))].sort(),
    })
  }

  // Sorted by value, then by operator to break ties: the same readings in a
  // different arrival order have to give the same result, byte for byte, or
  // SC-011 stops being reproducible and the Merkle root moves under the trace.
  votes.sort((a, b) => a.valueX100 - b.valueX100 || (a.operator < b.operator ? -1 : 1))

  const voteCount = votes.length
  const medianOfVotes =
    voteCount < params.minimumVotes ? null : medianX100(votes.map((vote) => vote.valueX100))

  return { medianX100: medianOfVotes, voteCount, votes }
}
