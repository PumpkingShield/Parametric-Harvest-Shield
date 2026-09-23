import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  cellIdFromH3Index,
  H3_CELL_PATTERN,
  type Reading,
  ReadingKind,
  type SignedReading,
  sensorPublicKey,
  signReading,
} from '@pumpking/shared'
import { z } from 'zod'
import { type AggregationParams, intervalStart, type PoolClock } from './interval.ts'

/**
 * Scenario runs: compressed time and the readings that fill it — `FR-042`,
 * `FR-049`.
 *
 * A scenario is a file, not a code path. Everything a run consists of — the
 * network, the weather, the clock and the parameters it is meant to be read
 * under — is data in `fixtures/scenarios/`, and this module turns that data
 * into signed readings that go in through the same door a real sensor uses
 * (`POST /v1/readings`). Nothing downstream knows a scenario happened: the
 * aggregator takes the same median, the program checks the same threshold, the
 * money moves the same way. That is the whole point of `FR-049` — **only the
 * step of the clock changes.**
 *
 * **Compression is presentation, not arithmetic.** A day is an index
 * (`Pool::day_index`), and `seconds_per_day` is what turns an index into an
 * instant. At 2 seconds a day, a 29-day drought plays in 58 seconds, and the
 * index, the consensus and the transfers are the ones production would compute.
 * What must never be lost is that the audience is watching a compressed clock:
 * `compression()` is the number the screen has to show beside the result
 * (`FR-049`), and `synthetic` is the flag that makes `FR-039` hard to forget —
 * a scenario file that does not declare itself synthetic does not load.
 *
 * **Determinism** (`FR-042`) is over the day indices and the values, not over
 * wall-clock instants: the same scenario replayed at a different genesis
 * produces the same day sequence, the same medians and the same policy result.
 * Sensor keys come from fixed seeds and counters from a fixed order, so two
 * runs produce byte-identical readings up to the genesis they are anchored to
 * and the point in the network's life they are played at — `ScenarioContinuation`
 * carries both, and both only translate a run; neither changes what it says.
 */

/* -------------------------------------------------------------------------- */
/* The file                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One stretch of weather, repeated for a number of days.
 *
 * `silentIntervals` are taken from the **start** of the day. Where the gap sits
 * makes no difference to any rule — coverage is a count (`FR-048`) — and
 * fixing the position is what keeps a run reproducible.
 */
const stretchSchema = z.strictObject({
  days: z.int().min(1).max(365),
  /** Rainfall each reporting sensor publishes per interval, before its offset. */
  intervalX100: z.int().min(0).max(100_000),
  /** Intervals at the start of the day nobody publishes in. */
  silentIntervals: z.int().min(0).default(0),
  /** Seeds of the sensors that stay quiet through these days. */
  silentSensors: z.array(z.int().min(1).max(255)).default([]),
})

const sensorSchema = z.strictObject({
  /** Byte the 32-byte secret seed is filled with. Fixed keys, fixed run. */
  seed: z.int().min(1).max(255),
  /**
   * Label of the operator this sensor belongs to. A label rather than a
   * wallet: `FR-009` groups votes by operator and a scenario has no opinion
   * about which on-chain key that is — the registration a run is set up with
   * maps labels to wallets.
   */
  operator: z.string().min(1),
  slotInCell: z.int().min(0).max(31),
  /**
   * Fixed deviation of this sensor from the day's weather, so the median has
   * something to do. Fixed and not random: a run has to repeat.
   */
  offsetX100: z.int().min(-100_000).max(100_000),
})

export const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  /**
   * `FR-039`, `FR-056`. Not decoration and not defaulted: a file that does not
   * say its readings are invented cannot be loaded, so the badge on the screen
   * has something behind it that a forgotten flag cannot switch off.
   */
  synthetic: z.literal(true),
  note: z.string().min(1),
  clock: z.strictObject({
    /** `pool.seconds_per_day` for the run. 2 compresses a day into 2 seconds. */
    secondsPerDay: z.int().min(1).max(86_400),
    intervalsPerDay: z.int().min(1).max(65_535),
  }),
  /** H3 index in hex. One cell per scenario — a run is one cell's weather. */
  cell: z.string().regex(H3_CELL_PATTERN, 'must be an H3 cell index in hex'),
  kind: z.enum([ReadingKind.PrecipitationMm]),
  /**
   * The pool and registry parameters the run is meant to be read under. They
   * are in the file because `expected` is only checkable against them: the
   * same weather under a different dry threshold is a different scenario.
   */
  params: z.strictObject({
    minimumVotes: z.int().min(1),
    dryThresholdX100: z.int().min(0),
    minimumCoverageX100: z.int().min(0).max(100),
  }),
  sensors: z.array(sensorSchema).min(1).max(32),
  programme: z.array(stretchSchema).min(1),
  /**
   * What the author of the fixture meant it to say.
   *
   * Not a second implementation of the index — the number is produced by the
   * real pipeline and compared to this. It catches the edit that changes a
   * scenario's meaning without anyone noticing, which for a golden file is the
   * failure that matters.
   */
  expected: z.strictObject({
    days: z.int().min(1),
    longestDrySpell: z.int().min(0),
  }),
})

export type Scenario = z.infer<typeof scenarioSchema>
export type ScenarioStretch = z.infer<typeof stretchSchema>

/** Parses and validates a scenario, naming the field when it is wrong. */
export function loadScenario(source: unknown): Scenario {
  const scenario = scenarioSchema.parse(source)

  const days = scenario.programme.reduce((total, stretch) => total + stretch.days, 0)
  if (days !== scenario.expected.days) {
    throw new RangeError(`programme is ${days} days, expected.days says ${scenario.expected.days}`)
  }
  for (const stretch of scenario.programme) {
    if (stretch.silentIntervals > scenario.clock.intervalsPerDay) {
      throw new RangeError(
        `a day of ${scenario.clock.intervalsPerDay} intervals cannot have ${stretch.silentIntervals} silent`,
      )
    }
  }

  const seeds = new Set(scenario.sensors.map((sensor) => sensor.seed))
  if (seeds.size !== scenario.sensors.length) {
    throw new RangeError('two sensors share a seed, and would share a key')
  }
  const slots = new Set(scenario.sensors.map((sensor) => sensor.slotInCell))
  if (slots.size !== scenario.sensors.length) {
    // The unique index on (cell_id, slot_in_cell) would refuse it, and the
    // on-chain contributors mask would credit one sensor for another's day.
    throw new RangeError('two sensors share a slot in the cell')
  }
  for (const stretch of scenario.programme) {
    for (const seed of stretch.silentSensors) {
      if (!seeds.has(seed)) throw new RangeError(`no sensor with seed ${seed} to silence`)
    }
  }

  return scenario
}

/** Where the scenario files live. */
const SCENARIOS_DIR = new URL('../../../fixtures/scenarios/', import.meta.url)

/** A scenario name is a file name, so it is a name and not a path. */
const SCENARIO_NAME = /^[a-z][a-z0-9-]*$/

/** Reads `fixtures/scenarios/<name>.json`. */
export function readScenario(name: string): Scenario {
  if (!SCENARIO_NAME.test(name)) {
    throw new RangeError(`not a scenario name: ${name}`)
  }
  const path = fileURLToPath(new URL(`${name}.json`, SCENARIOS_DIR))
  return loadScenario(JSON.parse(readFileSync(path, 'utf8')))
}

/* -------------------------------------------------------------------------- */
/* What the scenario means                                                    */
/* -------------------------------------------------------------------------- */

/** Seconds in an astronomical day, the number compression is measured against. */
const SECONDS_PER_REAL_DAY = 86_400

/**
 * How much faster than the sky this run moves — `FR-049`.
 *
 * The number the screen shows beside the result. Without it a demo says that a
 * drought payout arrives ninety seconds after the drought, which is a claim
 * about the product that the product does not make.
 */
export function compression(scenario: Scenario): number {
  return SECONDS_PER_REAL_DAY / scenario.clock.secondsPerDay
}

/** The clock a run is played on, anchored to the genesis of its pool. */
export function scenarioClock(scenario: Scenario, genesisTs: Date): PoolClock {
  return {
    genesisTs,
    secondsPerDay: scenario.clock.secondsPerDay,
    intervalsPerDay: scenario.clock.intervalsPerDay,
  }
}

/** The parameters the run's aggregation reads. */
export function scenarioParams(scenario: Scenario): AggregationParams {
  return {
    kind: scenario.kind,
    minimumVotes: scenario.params.minimumVotes,
    dryThresholdX100: scenario.params.dryThresholdX100,
    minimumCoverageX100: scenario.params.minimumCoverageX100,
  }
}

/** Wall-clock seconds a run takes, start to finish. `SC-011` allows 90. */
export function scenarioDuration(scenario: Scenario): number {
  return scenario.expected.days * scenario.clock.secondsPerDay
}

/* -------------------------------------------------------------------------- */
/* Picking up where the last run stopped                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a run inherits from the ones before it — `T067`.
 *
 * A scenario file describes weather, not a moment: its days are numbered from
 * zero and its sensors are the same fixed keys every time. Played twice
 * against one pool and one database, that would be the same readings twice —
 * the same counters, refused by `readings_sensor_counter_uq`, over days the
 * aggregator has already closed. Both halves of the collision are here, and
 * both are answered the way the real network answers them: a device resumes
 * its counter, and the sky goes on from today rather than from the day the
 * pool was born.
 *
 * **This is what makes a demo able to tell a story.** The eighteen-day dry
 * spell `tests/e2e/drought.test.ts` proves is unreachable inside one run: a
 * policy cannot exist before fourteen covered days and three waiting days, and
 * by then the fixture's dry stretch is nearly over. Two runs — a wet history,
 * then the drought — put the whole spell inside the policy's window, which is
 * the sequence the product is actually claiming.
 */
export type ScenarioContinuation = {
  /**
   * The pool day this run's day zero lands on.
   *
   * Zero for the first run. For a later one it is the next day boundary, so a
   * run never writes into a day the aggregator has already closed and never
   * leaves an uncovered day behind it — and an uncovered day breaks a spell
   * (`FR-048`).
   */
  dayOffset: number
  /** The last counter each sensor has already used, by public key. */
  counters: ReadonlyMap<string, bigint>
}

/** Where and when a run that starts at `at` has to begin. */
export type ScenarioStart = {
  dayOffset: number
  /** The instant of that day boundary — what `playScenario` anchors to. */
  startsAt: Date
}

/**
 * The first day **strictly after** the day `at` falls in — or day zero, when
 * the pool begins with the run.
 *
 * Strictly after, and not merely the next boundary, because the day `at` falls
 * in is a day something may already have been written into: the run before
 * this one finishes when its last reading is published, which is somewhere
 * inside its final day and not at the end of it. Starting on that day would
 * put two chapters' readings in one interval, and the median would be over
 * weather from both.
 *
 * The price is that a chapter may be preceded by an uncovered day — two
 * seconds at demo speed. That is deliberate and it is safe here: an uncovered
 * day breaks a spell (`FR-048`), and the break falls **between** the chapters,
 * before the drought the second one tells. A demo whose spell has to span the
 * seam is a demo that needs one scenario, not two.
 *
 * `playScenario` waits for the boundary on its own — the first reading is
 * simply not due yet — so there is nothing for a caller to sleep on.
 *
 * A genesis in the future gives day zero, not a negative one: the pool has no
 * days before it exists, and `intervalStart` refuses to name one.
 */
export function scenarioStart(scenario: Scenario, genesisTs: Date, at: Date): ScenarioStart {
  const clock = scenarioClock(scenario, genesisTs)
  const elapsed = at.getTime() - genesisTs.getTime()
  const dayMs = scenario.clock.secondsPerDay * 1000
  const dayOffset = elapsed <= 0 ? 0 : Math.floor(elapsed / dayMs) + 1
  return { dayOffset, startsAt: intervalStart(clock, dayOffset, 0) }
}

/** A sensor of the run, with the identity its readings are signed under. */
export type ScenarioSensor = {
  /** 32 bytes, every one of them `seed`. Fixed keys make a run repeatable. */
  secretKey: Uint8Array
  /** Base58 ed25519 public key — what the registry and the readings name. */
  pubkey: string
  operator: string
  slotInCell: number
  offsetX100: number
  seed: number
}

/**
 * The sensors of a run, in the order the file lists them.
 *
 * The secret seed is a constant byte repeated, which is a terrible way to make
 * a key and exactly the right one here: these keys sign invented weather on a
 * devnet, they are written down in a fixture on purpose, and anything that
 * looked like a real key would invite somebody to treat it as one.
 */
export async function scenarioSensors(scenario: Scenario): Promise<ScenarioSensor[]> {
  return await Promise.all(
    scenario.sensors.map(async (sensor) => {
      const secretKey = new Uint8Array(32).fill(sensor.seed)
      return {
        secretKey,
        pubkey: await sensorPublicKey(secretKey),
        operator: sensor.operator,
        slotInCell: sensor.slotInCell,
        offsetX100: sensor.offsetX100,
        seed: sensor.seed,
      }
    }),
  )
}

/** The stretch a day falls in, and the day's position is all it takes. */
function stretchOf(scenario: Scenario, dayIndex: number): ScenarioStretch {
  let remaining = dayIndex
  for (const stretch of scenario.programme) {
    if (remaining < stretch.days) return stretch
    remaining -= stretch.days
  }
  throw new RangeError(`day ${dayIndex} is past the end of the programme`)
}

/**
 * What one sensor publishes for a stretch, floored at nothing.
 *
 * The offset is what gives the median work to do, and a sensor whose offset
 * takes it below zero reports nothing rather than negative rain. Negative
 * rainfall is not a measurement, the chain refuses a day summing to one
 * (`RainfallNegative`), and a scenario that produced one would be testing the
 * refusal rather than the weather.
 */
function valueFor(stretch: ScenarioStretch, sensor: ScenarioSensor): number {
  return Math.max(0, stretch.intervalX100 + sensor.offsetX100)
}

/**
 * Every reading the scenario produces, in the order it produces them —
 * `FR-042`.
 *
 * Unsigned, because the values are the scenario's claim and the signature is
 * the sensor's: separating them keeps a determinism check cheap, and lets a
 * caller sign only the readings it is about to send. `signScenarioReadings`
 * is the second pass.
 *
 * Counters are per sensor and ascend with time, which is what `FR-003`
 * requires of a real device. They start at one only when nothing is carried
 * in: given a `continuation`, each sensor resumes from the counter it last
 * used, exactly as hardware does after a restart. Without that, replaying a
 * fixture against a live database is the same sensor publishing two different
 * readings under one counter, and `readings_sensor_counter_uq` refuses every
 * one of them.
 *
 * `dayOffset` moves the whole programme forward by whole days, so the second
 * run's weather lands on days the pool has not lived yet. It shifts the
 * instants and nothing else: the day indices stay consecutive, the intervals
 * keep their place inside a day, and every median, threshold and transfer
 * downstream is computed from the same numbers it would be computed from at
 * offset zero.
 */
export function scenarioReadings(
  scenario: Scenario,
  genesisTs: Date,
  sensors: readonly ScenarioSensor[],
  continuation?: ScenarioContinuation,
): Reading[] {
  const clock = scenarioClock(scenario, genesisTs)
  const cellId = cellIdFromH3Index(scenario.cell)
  const dayOffset = continuation?.dayOffset ?? 0
  if (!Number.isInteger(dayOffset) || dayOffset < 0) {
    throw new RangeError(`dayOffset is not a non-negative integer: ${dayOffset}`)
  }
  // Copied rather than held: the caller's map is a reading of the database at
  // one instant, and a run must not write into it.
  const counters = new Map<string, bigint>(continuation?.counters ?? [])
  const readings: Reading[] = []

  for (let dayIndex = 0; dayIndex < scenario.expected.days; dayIndex += 1) {
    const stretch = stretchOf(scenario, dayIndex)
    const silent = new Set(stretch.silentSensors)

    for (let interval = stretch.silentIntervals; interval < clock.intervalsPerDay; interval += 1) {
      const measuredAt = intervalStart(clock, dayOffset + dayIndex, interval)
      for (const sensor of sensors) {
        if (silent.has(sensor.seed)) continue
        const counter = (counters.get(sensor.pubkey) ?? 0n) + 1n
        counters.set(sensor.pubkey, counter)
        readings.push({
          sensor: sensor.pubkey,
          cellId,
          kind: scenario.kind,
          valueX100: valueFor(stretch, sensor),
          measuredAt,
          counter,
        })
      }
    }
  }

  return readings
}

/**
 * Signs the readings with the keys of the sensors that produced them.
 *
 * The same `signReading` a browser sensor calls (`FR-005`), for the reason
 * stated there: a second implementation of the signing side is a second
 * definition of the format. A scenario run is therefore signed exactly as
 * hardware would sign, and the API cannot tell the difference — which is the
 * property that makes an end-to-end run worth anything.
 */
export async function signScenarioReadings(
  readings: readonly Reading[],
  sensors: readonly ScenarioSensor[],
): Promise<SignedReading[]> {
  const keys = new Map(sensors.map((sensor) => [sensor.pubkey, sensor.secretKey]))
  return await Promise.all(
    readings.map(async (reading) => {
      const secretKey = keys.get(reading.sensor)
      if (secretKey === undefined) {
        throw new Error(`no key for sensor ${reading.sensor}`)
      }
      return { ...reading, signature: await signReading(reading, secretKey) }
    }),
  )
}

/* -------------------------------------------------------------------------- */
/* Playing it                                                                 */
/* -------------------------------------------------------------------------- */

/** Where a played reading goes — the API, a queue, or a test's array. */
export interface ScenarioSink {
  publish(reading: SignedReading): Promise<void>
}

export type PlayOptions = {
  /** Genesis of the pool the run is anchored to. */
  genesisTs: Date
  /** When the run began in real time; the first reading is due at this instant. */
  startedAt: Date
  now?: () => Date
  /** Injected so a test plays a 58-second run without waiting 58 seconds. */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Publishes the readings in time, on the compressed clock — `FR-049`.
 *
 * A reading measured `n` milliseconds after genesis is published `n`
 * milliseconds after the run started, so the compression in the file is the
 * compression the audience sees. Due times are computed from `startedAt` and
 * never accumulated from the previous sleep: a slow sink then makes a run late
 * rather than making every reading after it later still, and the run still
 * ends when the scenario says it does.
 *
 * A reading already due is published without waiting. That is what lets the
 * same function replay a finished run at full speed — the schedule is a floor
 * on when a reading may appear, not a promise that the sink can keep up.
 */
export async function playScenario(
  readings: readonly SignedReading[],
  sink: ScenarioSink,
  options: PlayOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? realSleep
  const genesis = options.genesisTs.getTime()
  const started = options.startedAt.getTime()

  const ordered = [...readings].sort(
    (a, b) => a.measuredAt.getTime() - b.measuredAt.getTime() || Number(a.counter - b.counter),
  )

  for (const reading of ordered) {
    const due = started + (reading.measuredAt.getTime() - genesis)
    const wait = due - now().getTime()
    if (wait > 0) await sleep(wait)
    await sink.publish(reading)
  }
}
