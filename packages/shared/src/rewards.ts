import type { SensorVerdict } from './outlier.ts'

/**
 * How a day's reward budget divides between the sensors that earned it —
 * `FR-036`, `FR-062`.
 *
 * **The unit is the vote, then the sensor.** In every interval with a value,
 * the interval's worth — `REWARD_WEIGHT_UNIT` — is split equally between its
 * votes, and a vote is an operator (`FR-009`): the same collapse the median
 * applies, so a second sensor on the same roof earns its operator nothing more
 * than the first did. An operator's part is then split equally between its
 * sensors that were accepted in that interval. Outliers earn nothing
 * (`FR-036`), and an interval without a value has nobody to pay.
 *
 * A slot's weight is the sum over the day. The program divides the day's
 * budget in proportion to the weights and checks only their shape — weight
 * where a slot was accepted and voted, and no more than its accepted intervals
 * can carry — so this function is the rule, and anybody holding the published
 * verdicts can rerun it.
 *
 * Both divisions round down. The dust never reaches anyone: the program
 * divides by the sum of the weights, not by the unit, so a rounded-down share
 * only shifts the proportions by less than one part in a million.
 */

/**
 * What one judged interval hands out. Twinned with `REWARD_WEIGHT_UNIT` in
 * `programs/pumpking/src/state.rs`; the client's test checks it against the
 * IDL.
 */
export const REWARD_WEIGHT_UNIT = 1_000_000

/**
 * Days a cell's reward schedule reaches ahead of its first unpaid day: a
 * policy's window has to end inside it. Twinned like the unit.
 */
export const REWARD_SCHEDULE_DAYS = 512

/**
 * The weights one interval contributes, per sensor — empty when nobody was
 * accepted. `operatorOf` names the operator of every judged sensor; a sensor
 * it cannot name is a sensor that was judged without being registered, and
 * that is refused rather than guessed.
 */
export function intervalWeights(
  verdicts: readonly SensorVerdict[],
  operatorOf: (sensor: string) => string | undefined,
): Map<string, number> {
  const byOperator = new Map<string, string[]>()
  for (const verdict of verdicts) {
    if (verdict.outlier) continue
    const operator = operatorOf(verdict.sensor)
    if (operator === undefined) {
      throw new RangeError(`sensor ${verdict.sensor} was judged without an operator`)
    }
    const own = byOperator.get(operator)
    if (own === undefined) byOperator.set(operator, [verdict.sensor])
    else own.push(verdict.sensor)
  }

  const weights = new Map<string, number>()
  if (byOperator.size === 0) return weights
  const perVote = Math.floor(REWARD_WEIGHT_UNIT / byOperator.size)
  for (const sensors of byOperator.values()) {
    const perSensor = Math.floor(perVote / sensors.length)
    for (const sensor of sensors) {
      weights.set(sensor, (weights.get(sensor) ?? 0) + perSensor)
    }
  }
  return weights
}

/** A day's weights: every interval's, summed per sensor. */
export function dayWeights(
  intervals: readonly (readonly SensorVerdict[])[],
  operatorOf: (sensor: string) => string | undefined,
): Map<string, number> {
  const total = new Map<string, number>()
  for (const verdicts of intervals) {
    for (const [sensor, weight] of intervalWeights(verdicts, operatorOf)) {
      total.set(sensor, (total.get(sensor) ?? 0) + weight)
    }
  }
  return total
}
