/**
 * The price of collusion — `FR-050`, `FR-054`, `SC-014`.
 *
 * What it takes to hold **half or more** of a cell's votes. Half, not a strict
 * majority: the median of an even count is the mean of its two middle votes
 * (`medianX100`), so exactly half of them already moves the value by up to a
 * half — the complement of `SC-003`, which promises that less than half moves
 * it by no more than 5%. Counting from a strict majority would overstate the
 * price by one vote.
 *
 * A vote is an operator, not a sensor (`FR-009`). There are two ways to get
 * one, and an attacker mixes them:
 *
 * - **Buy** an operator who already votes here. What that costs is taken to be
 *   the stake behind its vote — every voting sensor it has in the cell — and
 *   the cheapest are bought first. A bought vote counts twice: one more for
 *   the attacker, one fewer against.
 * - **Add** an operator of its own: registration is open (`FR-007`), and a
 *   new vote costs one sensor at `min_stake`. It needs a free slot, and slots
 *   are never freed (`slot_in_cell` is assigned once), so a full cell can only
 *   be bought.
 *
 * Either way the cell must still reach its quorum (`FR-010`): a cell short of
 * it has no value at all, which an attacker cannot use either.
 *
 * **This is stake the attacker has to lock, not money it loses.** A majority
 * is never an outlier — outliers are judged against the median it sets
 * (`FR-011`) — and an interval the reference disputes still counts (`FR-017`).
 * Nothing in the mechanism burns a colluding majority's stake; the number is
 * the collateral in play, and anything said about it has to say so.
 */

/** A cell as the price of collusion sees it. */
export type CollusionCell = {
  /**
   * The stake behind each vote that counts here now — one entry per operator,
   * the sum of its voting sensors' stake in this cell. Order does not matter.
   */
  voteStakes: readonly bigint[]
  /** Slots still free for a new sensor: `MAX_SENSORS_PER_CELL − sensor_count`. */
  freeSlots: number
}

export type CollusionParams = {
  /** `pool.min_stake` — the price of a vote an attacker adds. */
  minStake: bigint
  /** `pool.min_sensors_per_cell` — votes an interval needs to have a value. */
  minVotes: number
}

/** The cheapest way to half of a cell's votes. */
export type CollusionPath = {
  /** Votes bought from operators already here. */
  bought: number
  /** Votes added as new operators, each at `min_stake`. */
  added: number
  cost: bigint
}

/**
 * The cheapest path to half of a cell's votes, or null when there is none:
 * the cell is short of its quorum and has too few free slots to reach it, so
 * no interval in it can get a value for anyone.
 *
 * With `v` votes here and `b` of them bought, `a` added: the attacker holds
 * `b + a` of `v + a`, which is half or more when `a ≥ v − 2b`; the quorum
 * needs `a ≥ m − v`. Buying the cheapest first is optimal for a given `b`, so
 * the search is over `b` alone.
 */
export function collusionCost(cell: CollusionCell, params: CollusionParams): CollusionPath | null {
  assertParams(params)
  if (!Number.isInteger(cell.freeSlots) || cell.freeSlots < 0) {
    throw new RangeError(`free slots must be a non-negative integer: ${cell.freeSlots}`)
  }

  const stakes = [...cell.voteStakes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const votes = stakes.length
  let best: CollusionPath | null = null
  let bought = 0n

  for (let b = 0; b <= votes; b += 1) {
    if (b > 0) bought += stakes[b - 1] ?? 0n
    // At least one vote of its own: half of nothing is not control.
    const added = Math.max(b === 0 ? 1 : 0, votes - 2 * b, params.minVotes - votes)
    if (added > cell.freeSlots) continue
    const cost = bought + BigInt(added) * params.minStake
    if (best === null || cost < best.cost) best = { bought: b, added, cost }
  }
  return best
}

/**
 * The price of the cheapest cell there can be — `SC-014`'s "any cell": one at
 * its quorum, every vote at the minimum stake, room to add more.
 * `max(1, ⌈m / 2⌉) · min_stake`.
 *
 * It is a lower bound on `collusionCost` for **every** cell, not only that
 * one: half of at least `m` votes is at least `⌈m / 2⌉` votes, and no vote,
 * bought or added, is held below `min_stake`. So it is the number that moves
 * when either parameter does, whatever the cells look like.
 */
export function collusionFloor(params: CollusionParams): bigint {
  assertParams(params)
  return BigInt(Math.max(1, Math.ceil(params.minVotes / 2))) * params.minStake
}

/** How many times over the exposure limit a price is — `SC-014` asks for two. */
export const COLLUSION_COVER_TIMES = 2n

/**
 * Whether a price of collusion holds against a cell's exposure limit:
 * `cost ≥ 2 × limit`, in integers. A limit of zero is nothing to win, so any
 * price holds against it.
 */
export function collusionHolds(cost: bigint, exposureLimit: bigint): boolean {
  return cost >= COLLUSION_COVER_TIMES * exposureLimit
}

/**
 * `cost / limit` for reading, or null against a limit of zero. A float on
 * purpose: it is shown, never compared — `collusionHolds` decides — and a
 * ratio of 4·10⁻⁵ has to survive the trip, which basis points would not.
 */
export function collusionRatio(cost: bigint, exposureLimit: bigint): number | null {
  if (exposureLimit === 0n) return null
  return Number(cost) / Number(exposureLimit)
}

function assertParams(params: CollusionParams): void {
  if (!Number.isInteger(params.minVotes) || params.minVotes < 0) {
    throw new RangeError(`minimum votes must be a non-negative integer: ${params.minVotes}`)
  }
  if (params.minStake < 0n) {
    throw new RangeError(`minimum stake must not be negative: ${params.minStake}`)
  }
}
