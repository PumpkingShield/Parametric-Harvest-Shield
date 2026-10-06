/**
 * How far a minority can move a cell's value — `SC-003`.
 *
 * A group holding **less than half** of a cell's independent votes (`FR-009`)
 * cannot move the median past the honest votes that are left: whatever it
 * reports, at least one honest vote sits on each side of the result. So the
 * worst it can do is drag the value to an honest order statistic, and how far
 * that is depends on how much the honest gauges disagree — on the weather and
 * the hardware, not on this code. This file computes that worst case. What
 * it does to real cells is measured on real gauges
 * (`fixtures/sc003-gauges.json`, `sc003.test.ts`).
 *
 * `SC-003` used to promise "no more than 5%". Measured on 4 163 cell-days of
 * CoCoRaHS gauges, honest neighbours a couple of kilometres apart already
 * disagree by a median 22% on a wet day, so no median could keep that promise;
 * it was a promise about the weather. What the mechanism does guarantee — the
 * value stays inside the honest votes — and what a payout can feel — whether
 * the day changes class — are what is claimed instead.
 *
 * The model is the stronger one: the group is **part of** the cell's votes and
 * picks which of them it is. It turns the votes on the side it pushes away
 * from and reports the most extreme value the column holds. The median is
 * monotone in every input, so no other choice of values does more — the test
 * checks that claim against arbitrary values rather than taking it on trust.
 *
 * Exactly half is a different case: the median of an even count averages its
 * two middle votes, and with half of them the group owns one of the two
 * (`collusion.ts` prices control from that point). It is refused here, not
 * computed.
 */

import { medianX100 } from './median.ts'

const COLUMN_MIN = -2_147_483_648
const COLUMN_MAX = 2_147_483_647

/** The largest group that is still less than half of `voteCount` votes. */
export function largestMinority(voteCount: number): number {
  if (!Number.isInteger(voteCount) || voteCount < 0) {
    throw new RangeError(`voteCount must be a non-negative integer: ${voteCount}`)
  }
  return voteCount === 0 ? 0 : Math.ceil(voteCount / 2) - 1
}

/** The value a minority can drive the cell to, in each direction. */
export type MinorityReach = {
  /** The cell's value with every vote honest. */
  honestX100: number
  /** The lowest value the group can produce. */
  downX100: number
  /** The highest value the group can produce. */
  upX100: number
}

/**
 * The worst a group of `colluders` votes can do to a cell whose honest votes
 * are `votes` (one per operator, as `cellMedian` returns them).
 *
 * Returns null when there is nothing to move (no votes) and throws when the
 * group is not a minority — at half or more the answer is "anything", and a
 * number here would hide that.
 */
export function minorityReach(votes: readonly number[], colluders: number): MinorityReach | null {
  if (!Number.isInteger(colluders) || colluders < 0) {
    throw new RangeError(`colluders must be a non-negative integer: ${colluders}`)
  }
  if (colluders > largestMinority(votes.length)) {
    throw new RangeError(`${colluders} of ${votes.length} votes is not a minority`)
  }
  const honestX100 = medianX100(votes)
  if (honestX100 === null) return null

  const sorted = [...votes].sort((a, b) => a - b)
  const turned = (value: number) => Array.from({ length: colluders }, () => value)
  // Pushing down: the group is the highest votes, now reporting the floor of
  // the column. Pushing up: the lowest, reporting its ceiling.
  const down = medianX100([...sorted.slice(0, sorted.length - colluders), ...turned(COLUMN_MIN)])
  const up = medianX100([...turned(COLUMN_MAX), ...sorted.slice(colluders)])
  if (down === null || up === null) return null

  return { honestX100, downX100: down, upX100: up }
}

/**
 * Whether the worst a minority can do changes the day's class — dry or not —
 * against `dryThresholdX100`, with the same inclusive comparison as
 * `classifyDay` (`FR-047`: dry means it did not exceed the threshold).
 *
 * This is the part of `SC-003` that a payout can feel. A shift that stays on
 * one side of the threshold moves no policy; a flip moves a run of dry days by
 * one. It can only happen where the honest gauges themselves straddle the
 * threshold, since the reach never leaves them.
 */
export function minorityFlipsDay(reach: MinorityReach, dryThresholdX100: number): boolean {
  const dry = (value: number) => value <= dryThresholdX100
  const honest = dry(reach.honestX100)
  return dry(reach.downX100) !== honest || dry(reach.upX100) !== honest
}
