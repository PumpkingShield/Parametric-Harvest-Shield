import {
  cellIdFromH3Index,
  type Reading,
  ReadingKind,
  type SignedReading,
  sensorPublicKey,
  signReading,
} from '@pumpking/shared'

/**
 * The `SC-008` load: a hundred sensors, a reading an hour each, on a real
 * clock — `T058`.
 *
 * `SC-008` asks whether the free infrastructure carries a network of this size
 * for thirty days, and nothing short of that network running for thirty days
 * answers it. There is no hardware and no host of our own to run a hundred
 * devices from, so the devices live here, and something outside wakes them
 * (`POST /v1/feeder/tick`, from cron-job.org every few minutes).
 *
 * **Stateless on purpose.** Nothing here remembers what it sent. The hour is a
 * function of the clock, the value a function of the hour, and the counter *is*
 * the hour — so the reading for a given sensor and hour is the same bytes and
 * the same signature every time it is made (ed25519 is deterministic). A tick
 * that runs twice, or a platform that restarts the process between two ticks,
 * resends what intake already has, and intake answers a retry with 200, not a
 * conflict. What a tick needs to know — where the network left off — it reads
 * from the readings table, the same place a real device's history is.
 *
 * **Synthetic, and says so** (`FR-039`). The weather is invented: a cell is dry
 * most hours and rains now and then, with each sensor a few hundredths off its
 * neighbours. That is enough for the medians, the coverage and the day records
 * to be the same work they are for a real network, which is what `SC-008`
 * measures. Nothing reads a payout off these numbers.
 *
 * Keys are a byte repeated, like the scenario sensors' — and from a range the
 * scenarios do not use, so the two networks can never claim the same key.
 */

/** Four res-7 cells around the demo cell (`gridDisk` ring 1, first four sorted). */
export const FEEDER_CELLS = [
  '871e70186ffffff',
  '871e70194ffffff',
  '871e70195ffffff',
  '871e701b0ffffff',
] as const

export const FEEDER_SENSORS = 100
/** The first seed; the scenario fixtures use 11..13. */
export const FEEDER_FIRST_SEED = 101
export const HOUR_MS = 3_600_000

export type FeederSensor = {
  secretKey: Uint8Array
  pubkey: string
  seed: number
  /** Index into `FEEDER_CELLS`. */
  cell: number
  /**
   * Which of the three operators registers and stakes it (`OPERATOR_A…C` in
   * `scripts/devnet-register.mjs`). `FR-009`: three operators, three votes.
   */
  operator: number
}

/**
 * The network: sensor `k` sits in cell `k mod 4` and belongs to operator
 * `k mod 3` — so every cell holds all three operators and gets its three
 * votes. Twenty-five sensors a cell, under the program's thirty-two; the slot
 * each gets is the program's to hand out (`T077`).
 */
export async function feederSensors(): Promise<FeederSensor[]> {
  return await Promise.all(
    Array.from({ length: FEEDER_SENSORS }, async (_, k) => {
      const seed = FEEDER_FIRST_SEED + k
      const secretKey = new Uint8Array(32).fill(seed)
      return {
        secretKey,
        pubkey: await sensorPublicKey(secretKey),
        seed,
        cell: k % FEEDER_CELLS.length,
        operator: k % 3,
      }
    }),
  )
}

/**
 * Where each sensor has to be registered, for the registry check a tick makes
 * before it publishes (`votingProblems`) and for `scripts/devnet-register.mjs`.
 */
export function feederCellId(sensor: FeederSensor): bigint {
  const hex = FEEDER_CELLS[sensor.cell]
  if (hex === undefined) throw new RangeError(`no feeder cell ${sensor.cell}`)
  return cellIdFromH3Index(hex)
}

/** The hour an instant falls in, counted from the unix epoch. */
export function hourOf(at: Date): number {
  return Math.floor(at.getTime() / HOUR_MS)
}

/** A 32-bit mix — the same inputs, the same weather, on any machine. */
function mix(a: number, b: number): number {
  let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * Rain in a cell for an hour, in hundredths of a millimetre: dry six hours in
 * seven, otherwise 0.20 to 4.00 mm.
 */
export function cellRainX100(cell: number, hour: number): number {
  const roll = mix(cell + 1, hour)
  if (roll % 7 !== 0) return 0
  return 20 + (mix(hour, cell + 7) % 381)
}

/** One sensor's reading of its cell's hour: the cell's rain, a little off. */
export function feederReading(sensor: FeederSensor, hour: number): Reading {
  const rain = cellRainX100(sensor.cell, hour)
  // A dry hour reads dry on every sensor; a wet one within ±3 hundredths.
  const offset = rain === 0 ? 0 : (sensor.seed % 7) - 3
  return {
    sensor: sensor.pubkey,
    cellId: cellIdFromH3Index(FEEDER_CELLS[sensor.cell] ?? FEEDER_CELLS[0]),
    kind: ReadingKind.PrecipitationMm,
    valueX100: rain + offset,
    // A device reads the gauge a few seconds past the hour, not all at once.
    measuredAt: new Date(hour * HOUR_MS + (sensor.seed % 60) * 1000),
    counter: BigInt(hour),
  }
}

/**
 * The hours a tick at `now` should publish.
 *
 * Every hour after the one the network last reached, up to the one now
 * running — but no further back than `lookbackHours`, past which every
 * reading would be late anyway (`feederReadings` makes the exact cut). A
 * network that has never published starts with the current hour.
 */
export function dueHours(now: Date, lastHour: number | null, lookbackHours: number): number[] {
  const current = hourOf(now)
  const from = Math.max(lastHour === null ? current : lastHour + 1, current - lookbackHours)
  const hours: number[] = []
  for (let hour = from; hour <= current; hour += 1) hours.push(hour)
  return hours
}

/**
 * Where the network left off: the lowest of each sensor's last counter, or
 * null when any sensor has never published. The lowest rather than the highest,
 * because a tick interrupted halfway leaves some sensors an hour behind, and
 * those are the ones the next tick has to reach.
 */
export function lastFullHour(
  sensors: readonly FeederSensor[],
  counters: ReadonlyMap<string, bigint>,
): number | null {
  let lowest: bigint | null = null
  for (const sensor of sensors) {
    const last = counters.get(sensor.pubkey)
    if (last === undefined) return null
    if (lowest === null || last < lowest) lowest = last
  }
  return lowest === null ? null : Number(lowest)
}

/**
 * The readings of these hours that intake would count at `now`, signed: already
 * taken (a sensor reads a few seconds past the hour) and not yet older than
 * `maxAgeMs`, the window past which intake files a reading as late (`FR-004`).
 * A late reading is stored and counted for nothing, so it is not sent at all.
 */
export async function feederReadings(
  sensors: readonly FeederSensor[],
  hours: readonly number[],
  now: Date,
  maxAgeMs: number,
): Promise<SignedReading[]> {
  const readings = hours.flatMap((hour) => sensors.map((sensor) => feederReading(sensor, hour)))
  const due = readings.filter((reading) => {
    const age = now.getTime() - reading.measuredAt.getTime()
    return age >= 0 && age <= maxAgeMs
  })
  const keys = new Map(sensors.map((sensor) => [sensor.pubkey, sensor.secretKey]))
  return await Promise.all(
    due.map(async (reading) => {
      const secretKey = keys.get(reading.sensor)
      if (secretKey === undefined) throw new Error(`no key for sensor ${reading.sensor}`)
      return { ...reading, signature: await signReading(reading, secretKey) }
    }),
  )
}
