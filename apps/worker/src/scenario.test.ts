import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AcceptedReading } from '@pumpking/db'
import {
  type DayClassification,
  drySpell,
  type Reading,
  type SignedReading,
  verifyReadingSignature,
} from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import { type ClosedInterval, closeDay, closeInterval, intervalStart } from './interval.ts'
import {
  compression,
  DEFAULT_PUBLISH_CONCURRENCY,
  loadScenario,
  playScenario,
  readScenario,
  type Scenario,
  type ScenarioSensor,
  scenarioClock,
  scenarioDuration,
  scenarioParams,
  scenarioReadings,
  scenarioSensors,
  scenarioStart,
  signScenarioReadings,
} from './scenario.ts'

const GENESIS = new Date('2026-09-01T00:00:00.000Z')

/* -------------------------------------------------------------------------- */
/* The pipeline a scenario is meant to be read through                        */
/* -------------------------------------------------------------------------- */

/**
 * The scenario played through the real aggregation — the same `closeInterval`
 * and `closeDay` the worker calls on a live database. Nothing here predicts
 * what the scenario should say; it runs it and reports what came out.
 */
function classifyRun(
  scenario: Scenario,
  sensors: readonly ScenarioSensor[],
  readings: readonly Reading[],
  genesisTs: Date = GENESIS,
): DayClassification[] {
  const clock = scenarioClock(scenario, genesisTs)
  const params = scenarioParams(scenario)
  const slots = new Map(sensors.map((sensor) => [sensor.pubkey, sensor]))

  const accepted: AcceptedReading[] = readings.map((reading) => {
    const sensor = slots.get(reading.sensor)
    if (sensor === undefined) throw new Error(`no sensor ${reading.sensor}`)
    return {
      sensorPubkey: reading.sensor,
      operator: sensor.operator,
      slotInCell: sensor.slotInCell,
      valueX100: reading.valueX100,
      measuredAt: reading.measuredAt,
      counter: reading.counter,
      signature: 'unused',
    }
  })

  const first = readings[0]
  if (first === undefined) throw new Error('a scenario publishes at least one reading')
  const cellId = first.cellId

  const states: DayClassification[] = []
  for (let dayIndex = 0; dayIndex < scenario.expected.days; dayIndex += 1) {
    const intervals: ClosedInterval[] = []
    for (let index = 0; index < clock.intervalsPerDay; index += 1) {
      const start = intervalStart(clock, dayIndex, index)
      const end = intervalStart(clock, dayIndex, index + 1)
      const bucket = accepted.filter(
        (reading) =>
          reading.measuredAt.getTime() >= start.getTime() &&
          reading.measuredAt.getTime() < end.getTime(),
      )
      intervals.push(
        closeInterval(bucket, { cellId, dayIndex, intervalIndex: index, start }, params),
      )
    }
    states.push(closeDay(intervals, params).state)
  }
  return states
}

async function run(name: string): Promise<{
  scenario: Scenario
  sensors: ScenarioSensor[]
  readings: Reading[]
  states: DayClassification[]
}> {
  const scenario = readScenario(name)
  const sensors = await scenarioSensors(scenario)
  const readings = scenarioReadings(scenario, GENESIS, sensors)
  return { scenario, sensors, readings, states: classifyRun(scenario, sensors, readings) }
}

/* -------------------------------------------------------------------------- */

describe('the fixtures', () => {
  it('all load, and all declare themselves synthetic', () => {
    for (const name of ['drought', 'normal', 'gaps']) {
      expect(readScenario(name).synthetic).toBe(true)
    }
  })

  /**
   * The drought scenario is not a new claim about the index: its day sequence
   * is the case `fixtures/index-cases.json` already shares between the Rust
   * program and the TypeScript twin. This is that case played back through
   * signing, bucketing, medians and classification.
   */
  it('drought reproduces the reference trace of index-cases.json', async () => {
    const { states } = await run('drought')
    const cases = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../fixtures/index-cases.json', import.meta.url)),
        'utf8',
      ),
    ) as { cases: { name: string; days: number[]; drySpell: number }[] }
    const reference = cases.cases.find((one) => one.name === 'policy window of the reference trace')
    if (reference === undefined) throw new Error('the reference trace case is gone')

    expect(states).toEqual(reference.days)
    expect(drySpell(states)).toBe(reference.drySpell)
  })

  it('drought pays the run its fixture promises', async () => {
    const { scenario, states } = await run('drought')
    expect(drySpell(states)).toBe(scenario.expected.longestDrySpell)
  })

  it('normal never starts a run', async () => {
    const { scenario, states } = await run('normal')
    expect(new Set(states)).toEqual(new Set([2]))
    expect(drySpell(states)).toBe(scenario.expected.longestDrySpell)
  })

  /**
   * `FR-048` at the boundary: 18 of 24 intervals is exactly 75 per cent and the
   * comparison is inclusive, so those days are measured; 17 is not. And
   * `FR-010`: three days of full intervals with only two operators have no
   * value however dry the sky was. A dry sky is not a dry day.
   */
  it('gaps counts nine of its fourteen dry days, and pays for five', async () => {
    const { scenario, states } = await run('gaps')
    expect(states).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1])
    expect(drySpell(states)).toBe(scenario.expected.longestDrySpell)
  })
})

/* -------------------------------------------------------------------------- */

describe('compressed time', () => {
  it('reports how much faster than the sky the run moves', () => {
    // FR-049: the number the screen has to show beside the result.
    expect(compression(readScenario('drought'))).toBe(43_200)
  })

  /** `SC-011`: from the first reading to the payout in under 90 seconds. */
  it('plays the drought inside the budget SC-011 allows', () => {
    expect(scenarioDuration(readScenario('drought'))).toBe(58)
    expect(scenarioDuration(readScenario('drought'))).toBeLessThan(90)
  })

  it('puts a day on the pool clock, not on a calendar', () => {
    const scenario = readScenario('drought')
    const clock = scenarioClock(scenario, GENESIS)
    expect(clock.secondsPerDay).toBe(2)
    expect(intervalStart(clock, 1, 0).getTime()).toBe(GENESIS.getTime() + 2000)
  })
})

/* -------------------------------------------------------------------------- */

describe('scenarioReadings', () => {
  it('produces the same readings every time — FR-042', async () => {
    const scenario = readScenario('drought')
    const sensors = await scenarioSensors(scenario)
    expect(scenarioReadings(scenario, GENESIS, sensors)).toEqual(
      scenarioReadings(scenario, GENESIS, sensors),
    )
  })

  /**
   * Determinism is over the day indices and the values, not over instants: a
   * run anchored to a different genesis is the same weather, later.
   */
  it('gives the same run at a different genesis', async () => {
    const scenario = readScenario('drought')
    const sensors = await scenarioSensors(scenario)
    const later = new Date(GENESIS.getTime() + 7 * 86_400_000)

    const first = scenarioReadings(scenario, GENESIS, sensors)
    const second = scenarioReadings(scenario, later, sensors)

    expect(second.map((reading) => reading.valueX100)).toEqual(
      first.map((reading) => reading.valueX100),
    )
    expect(classifyRun(scenario, sensors, second, later)).toEqual(
      classifyRun(scenario, sensors, first),
    )
  })

  it('gives every sensor a fixed key from its seed', async () => {
    const sensors = await scenarioSensors(readScenario('drought'))
    const again = await scenarioSensors(readScenario('drought'))
    expect(sensors.map((sensor) => sensor.pubkey)).toEqual(again.map((sensor) => sensor.pubkey))
    expect(new Set(sensors.map((sensor) => sensor.pubkey)).size).toBe(3)
  })

  it('counts each sensor up from one, in time order — FR-003', async () => {
    const { readings, sensors } = await run('drought')
    for (const sensor of sensors) {
      const own = readings.filter((reading) => reading.sensor === sensor.pubkey)
      expect(own.map((reading) => reading.counter)).toEqual(
        own.map((_reading, index) => BigInt(index + 1)),
      )
      for (let i = 1; i < own.length; i += 1) {
        const previous = own[i - 1]
        const current = own[i]
        if (previous === undefined || current === undefined) throw new Error('fixture')
        expect(current.measuredAt.getTime()).toBeGreaterThanOrEqual(previous.measuredAt.getTime())
      }
    }
  })

  it('publishes nothing at all on a day of silence', async () => {
    const { scenario, readings } = await run('drought')
    const clock = scenarioClock(scenario, GENESIS)
    // Days 4 and 5 are the two the reference trace records as no coverage.
    for (const dayIndex of [4, 5]) {
      const from = intervalStart(clock, dayIndex, 0).getTime()
      const to = intervalStart(clock, dayIndex + 1, 0).getTime()
      const inside = readings.filter(
        (reading) => reading.measuredAt.getTime() >= from && reading.measuredAt.getTime() < to,
      )
      expect(inside).toEqual([])
    }
  })

  it('keeps a silenced sensor quiet and the others publishing', async () => {
    const { scenario, sensors, readings } = await run('gaps')
    const clock = scenarioClock(scenario, GENESIS)
    const quiet = sensors.find((sensor) => sensor.seed === 13)
    if (quiet === undefined) throw new Error('fixture')

    // Days 7..9 are the three the fixture silences the third operator through.
    const from = intervalStart(clock, 7, 0).getTime()
    const to = intervalStart(clock, 10, 0).getTime()
    const inside = readings.filter(
      (reading) => reading.measuredAt.getTime() >= from && reading.measuredAt.getTime() < to,
    )
    expect(inside.length).toBeGreaterThan(0)
    expect(inside.some((reading) => reading.sensor === quiet.pubkey)).toBe(false)
  })

  it('never publishes negative rainfall', async () => {
    const { readings } = await run('gaps')
    expect(readings.every((reading) => reading.valueX100 >= 0)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */

/**
 * `T067` — a second run of the same fixture against the same pool.
 *
 * Two things stop a fixture being played twice, and both are checked here:
 * counters that begin at one collide with the first run on
 * `readings_sensor_counter_uq`, and days that begin at zero fall on days the
 * aggregator has already closed. A continuation answers both the way the real
 * network does — a device resumes its log, and the weather goes on from today.
 */
describe('continuing a run — T067', () => {
  /** The counter each sensor stopped at, as the database would report it. */
  function lastCounters(readings: readonly Reading[]): Map<string, bigint> {
    const last = new Map<string, bigint>()
    for (const reading of readings) {
      const seen = last.get(reading.sensor)
      if (seen === undefined || reading.counter > seen) last.set(reading.sensor, reading.counter)
    }
    return last
  }

  it('resumes each sensor from the counter it stopped at — FR-003', async () => {
    const scenario = readScenario('drought')
    const sensors = await scenarioSensors(scenario)
    const first = scenarioReadings(scenario, GENESIS, sensors)
    const counters = lastCounters(first)

    const second = scenarioReadings(scenario, GENESIS, sensors, {
      dayOffset: scenario.expected.days,
      counters,
    })

    for (const sensor of sensors) {
      const before = first.filter((reading) => reading.sensor === sensor.pubkey)
      const after = second.filter((reading) => reading.sensor === sensor.pubkey)
      const stopped = counters.get(sensor.pubkey)
      if (stopped === undefined) throw new Error('fixture')
      expect(before.length).toBeGreaterThan(0)
      expect(after.map((reading) => reading.counter)).toEqual(
        after.map((_reading, index) => stopped + BigInt(index + 1)),
      )
    }
  })

  /**
   * The collision the whole task exists to remove. Asserted as a set of
   * `(sensor, counter)` pairs because that pair is exactly what the unique
   * index refuses — this is the constraint, stated in TypeScript.
   */
  it('shares no sensor-and-counter pair with the run before it', async () => {
    const scenario = readScenario('drought')
    const sensors = await scenarioSensors(scenario)
    const first = scenarioReadings(scenario, GENESIS, sensors)
    const second = scenarioReadings(scenario, GENESIS, sensors, {
      dayOffset: scenario.expected.days,
      counters: lastCounters(first),
    })

    const key = (reading: Reading): string => `${reading.sensor}:${reading.counter}`
    const taken = new Set(first.map(key))
    expect(second.filter((reading) => taken.has(key(reading)))).toEqual([])
  })

  it('starts the second run on the day after the first one ended', async () => {
    const scenario = readScenario('drought')
    const sensors = await scenarioSensors(scenario)
    const clock = scenarioClock(scenario, GENESIS)
    const offset = scenario.expected.days

    const second = scenarioReadings(scenario, GENESIS, sensors, {
      dayOffset: offset,
      counters: new Map(),
    })

    const firstInstant = second[0]
    if (firstInstant === undefined) throw new Error('fixture')
    expect(firstInstant.measuredAt.getTime()).toBe(intervalStart(clock, offset, 0).getTime())
    for (const reading of second) {
      expect(reading.measuredAt.getTime()).toBeGreaterThanOrEqual(
        intervalStart(clock, offset, 0).getTime(),
      )
    }
  })

  /**
   * The offset moves the run; it does not change what the run says. If it did,
   * the second chapter of a demo would be a different scenario wearing the
   * first one's name.
   */
  it('changes the instants and nothing else — FR-042', async () => {
    const scenario = readScenario('drought')
    const sensors = await scenarioSensors(scenario)
    const plain = scenarioReadings(scenario, GENESIS, sensors)
    const moved = scenarioReadings(scenario, GENESIS, sensors, {
      dayOffset: 40,
      counters: new Map(),
    })

    expect(moved.map((reading) => reading.valueX100)).toEqual(
      plain.map((reading) => reading.valueX100),
    )
    expect(moved.map((reading) => reading.sensor)).toEqual(plain.map((reading) => reading.sensor))
    // A shifted run is the same weather forty days later, so reading it needs
    // a genesis forty days later: `classifyRun` then walks the same day
    // indices through the real aggregation and gets the same spell.
    const shifted = new Date(GENESIS.getTime() + 40 * scenario.clock.secondsPerDay * 1000)
    expect(classifyRun(scenario, sensors, moved, shifted)).toEqual(
      classifyRun(scenario, sensors, plain),
    )
  })

  it('refuses an offset that is not a whole number of days', async () => {
    const scenario = readScenario('drought')
    const sensors = await scenarioSensors(scenario)
    expect(() =>
      scenarioReadings(scenario, GENESIS, sensors, { dayOffset: -1, counters: new Map() }),
    ).toThrow(RangeError)
    expect(() =>
      scenarioReadings(scenario, GENESIS, sensors, { dayOffset: 1.5, counters: new Map() }),
    ).toThrow(RangeError)
  })

  it('does not write into the counters it was given', async () => {
    const scenario = readScenario('gaps')
    const sensors = await scenarioSensors(scenario)
    const given = new Map<string, bigint>(sensors.map((sensor) => [sensor.pubkey, 7n]))
    scenarioReadings(scenario, GENESIS, sensors, { dayOffset: 0, counters: given })
    for (const sensor of sensors) expect(given.get(sensor.pubkey)).toBe(7n)
  })
})

/* -------------------------------------------------------------------------- */

describe('scenarioStart', () => {
  const scenario = (): Scenario => readScenario('drought')

  it('is day zero when the pool is born with the run', () => {
    const start = scenarioStart(scenario(), GENESIS, GENESIS)
    expect(start.dayOffset).toBe(0)
    expect(start.startsAt.getTime()).toBe(GENESIS.getTime())
  })

  it('skips the day the request arrived in', () => {
    const run = scenario()
    const dayMs = run.clock.secondsPerDay * 1000
    const start = scenarioStart(run, GENESIS, new Date(GENESIS.getTime() + dayMs * 3 + 1))
    expect(start.dayOffset).toBe(4)
    expect(start.startsAt.getTime()).toBe(GENESIS.getTime() + dayMs * 4)
  })

  /**
   * Even on an exact boundary. The run before this one stopped when its last
   * reading was published, and that instant is inside its final day, not at
   * the end of it — the day the clock names is a day that may already have
   * been written into.
   */
  it('moves past a boundary it lands exactly on', () => {
    const run = scenario()
    const dayMs = run.clock.secondsPerDay * 1000
    const start = scenarioStart(run, GENESIS, new Date(GENESIS.getTime() + dayMs * 29))
    expect(start.dayOffset).toBe(30)
    expect(start.startsAt.getTime()).toBe(GENESIS.getTime() + dayMs * 30)
  })

  it('gives day zero for a genesis still in the future', () => {
    const start = scenarioStart(scenario(), GENESIS, new Date(GENESIS.getTime() - 60_000))
    expect(start.dayOffset).toBe(0)
    expect(start.startsAt.getTime()).toBe(GENESIS.getTime())
  })
})

/* -------------------------------------------------------------------------- */

describe('signScenarioReadings', () => {
  it('signs the way a device signs, so the API cannot tell the difference', async () => {
    const { readings, sensors } = await run('drought')
    const signed = await signScenarioReadings(readings.slice(0, 6), sensors)
    expect(signed).toHaveLength(6)
    for (const reading of signed) {
      expect(await verifyReadingSignature(reading)).toBe(true)
    }
  })

  it('refuses to sign for a sensor it has no key for', async () => {
    const { readings } = await run('drought')
    await expect(signScenarioReadings(readings.slice(0, 1), [])).rejects.toThrow(/no key/)
  })
})

/* -------------------------------------------------------------------------- */

describe('playScenario', () => {
  const signed = (measuredAt: Date, counter: bigint): SignedReading => ({
    sensor: 'sensor',
    cellId: 1n,
    kind: 'precipitation_mm',
    valueX100: 0,
    measuredAt,
    counter,
    signature: 'signature',
  })

  it('publishes a reading when the compressed clock says it is due', async () => {
    const slept: number[] = []
    const published: bigint[] = []
    let clock = GENESIS.getTime()

    await playScenario(
      [
        signed(new Date(GENESIS.getTime() + 2000), 2n),
        signed(new Date(GENESIS.getTime()), 1n),
        signed(new Date(GENESIS.getTime() + 500), 3n),
      ],
      {
        publish(reading) {
          published.push(reading.counter)
          return Promise.resolve()
        },
      },
      {
        genesisTs: GENESIS,
        startedAt: GENESIS,
        now: () => new Date(clock),
        sleep: (ms) => {
          slept.push(ms)
          clock += ms
          return Promise.resolve()
        },
      },
    )

    expect(published).toEqual([1n, 3n, 2n])
    expect(slept).toEqual([500, 1500])
  })

  /**
   * Due times come from `startedAt`, never from the previous sleep. A slow sink
   * makes a run late rather than making every reading after it later still, and
   * a finished run replays at full speed.
   */
  it('does not wait for a reading that is already due', async () => {
    const slept: number[] = []
    await playScenario(
      [signed(new Date(GENESIS.getTime()), 1n), signed(new Date(GENESIS.getTime() + 1000), 2n)],
      { publish: () => Promise.resolve() },
      {
        genesisTs: GENESIS,
        // The run began a minute ago: every reading of it is overdue.
        startedAt: new Date(GENESIS.getTime() - 60_000),
        now: () => GENESIS,
        sleep: (ms) => {
          slept.push(ms)
          return Promise.resolve()
        },
      },
    )
    expect(slept).toEqual([])
  })

  /**
   * A sink that answers only when the test lets it, so what the run does while
   * a publication is unfinished is visible rather than inferred.
   */
  const gatedSink = () => {
    const started: bigint[] = []
    const gates: (() => void)[] = []
    let live = 0
    let peak = 0
    return {
      started,
      peak: () => peak,
      pending: () => gates.length,
      release(count: number) {
        for (let i = 0; i < count; i += 1) {
          const gate = gates.shift()
          if (gate === undefined) break
          gate()
        }
      },
      sink: {
        publish(reading: SignedReading) {
          started.push(reading.counter)
          live += 1
          peak = Math.max(peak, live)
          return new Promise<void>((resolve) => {
            gates.push(() => {
              live -= 1
              resolve()
            })
          })
        },
      },
    }
  }

  /** Lets every microtask queued so far run, and nothing else. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  }

  /**
   * `T069`, and the reason the bound is on readings rather than on intervals:
   * the fourth reading starts while the first three are still unfinished, and
   * it belongs to the *next* interval. A run that published an interval at a
   * time would be sitting here waiting for the second sensor of the first one.
   */
  it('publishes past the interval a reading belongs to while earlier ones are unfinished', async () => {
    const gated = gatedSink()
    const overdue = new Date(GENESIS.getTime() - 60_000)
    // Three intervals, two sensors each. Every one of them is already due.
    const readings = [
      signed(new Date(GENESIS.getTime()), 1n),
      signed(new Date(GENESIS.getTime()), 2n),
      signed(new Date(GENESIS.getTime() + 83), 3n),
      signed(new Date(GENESIS.getTime() + 83), 4n),
      signed(new Date(GENESIS.getTime() + 166), 5n),
      signed(new Date(GENESIS.getTime() + 166), 6n),
    ]

    const run = playScenario(readings, gated.sink, {
      genesisTs: GENESIS,
      startedAt: overdue,
      now: () => GENESIS,
      sleep: () => Promise.resolve(),
      concurrency: 3,
    })

    await settle()
    expect(gated.started).toEqual([1n, 2n, 3n])

    // One finishes, and the reading that takes its slot is from the interval
    // after the one still in the air.
    gated.release(1)
    await settle()
    expect(gated.started).toEqual([1n, 2n, 3n, 4n])

    // Released a slot at a time from here on: a reading that has not been
    // launched yet has no gate to open, so releasing six at once would leave
    // the last two of them waiting on a gate that was opened before they
    // existed.
    let finished = false
    const ended = run.then(() => {
      finished = true
    })
    for (let i = 0; i < 20 && !finished; i += 1) {
      gated.release(gated.pending())
      await settle()
    }
    await ended
    expect(gated.started).toHaveLength(6)
    expect(gated.peak()).toBe(3)
  })

  /**
   * The bound is a bound. Overdue readings are the case that would break it:
   * every one of them is ready to launch and nothing makes the loop pause.
   */
  it('never has more publications in the air than it was given room for', async () => {
    const gated = gatedSink()
    const readings = Array.from({ length: 20 }, (_, index) =>
      signed(new Date(GENESIS.getTime() + index), BigInt(index + 1)),
    )

    const run = playScenario(readings, gated.sink, {
      genesisTs: GENESIS,
      startedAt: new Date(GENESIS.getTime() - 60_000),
      now: () => GENESIS,
      sleep: () => Promise.resolve(),
      concurrency: 4,
    })

    await settle()
    expect(gated.started).toHaveLength(4)
    for (let i = 0; i < 16; i += 1) {
      gated.release(1)
      await settle()
      expect(gated.peak()).toBeLessThanOrEqual(4)
    }
    gated.release(4)
    await run
    expect(gated.started).toHaveLength(20)
  })

  /**
   * A run reports what it published, so it cannot end while publications are
   * still landing: `status: "done"` is the signal the second chapter and the
   * policy script both key off.
   */
  it('does not finish while a publication is still in the air', async () => {
    const gated = gatedSink()
    let finished = false
    const run = playScenario(
      [signed(new Date(GENESIS.getTime()), 1n), signed(new Date(GENESIS.getTime()), 2n)],
      gated.sink,
      {
        genesisTs: GENESIS,
        startedAt: new Date(GENESIS.getTime() - 60_000),
        now: () => GENESIS,
        sleep: () => Promise.resolve(),
        concurrency: 4,
      },
    ).then(() => {
      finished = true
    })

    await settle()
    gated.release(1)
    await settle()
    expect(finished).toBe(false)

    gated.release(1)
    await run
    expect(finished).toBe(true)
  })

  it('ends the run on a sink that throws, and stops publishing', async () => {
    const started: bigint[] = []
    const run = playScenario(
      [
        signed(new Date(GENESIS.getTime()), 1n),
        signed(new Date(GENESIS.getTime()), 2n),
        signed(new Date(GENESIS.getTime()), 3n),
      ],
      {
        publish(reading) {
          started.push(reading.counter)
          return reading.counter === 2n
            ? Promise.reject(new Error('the door fell over'))
            : Promise.resolve()
        },
      },
      {
        genesisTs: GENESIS,
        startedAt: new Date(GENESIS.getTime() - 60_000),
        now: () => GENESIS,
        sleep: () => Promise.resolve(),
        concurrency: 1,
      },
    )

    await expect(run).rejects.toThrow('the door fell over')
    expect(started).toEqual([1n, 2n])
  })

  it('refuses a concurrency that is not a positive whole number', async () => {
    const play = (concurrency: number): Promise<void> =>
      playScenario(
        [signed(GENESIS, 1n)],
        { publish: () => Promise.resolve() },
        {
          genesisTs: GENESIS,
          startedAt: GENESIS,
          now: () => GENESIS,
          concurrency,
        },
      )
    await expect(play(0)).rejects.toThrow(RangeError)
    await expect(play(1.5)).rejects.toThrow(RangeError)
  })

  /**
   * The default is a rate, and this is the rate it has to clear — `T069`.
   * Lowering it below what the demo clock asks for is the failure this guards:
   * the run falls behind, the aggregator closes the days it was still
   * publishing into, and the policy sees a cell with no coverage.
   */
  it('leaves room for the demo clock at the round trip that was measured', () => {
    // 24 intervals x 3 sensors on a two-second day - fixtures/scenarios/*.json.
    const readingsPerSecond = (24 * 3) / 2
    // Two round trips per reading, at the p90 measured from Render on
    // 2026-09-24. The p50 was 45 ms; the margin is wanted over the slow half.
    const secondsPerReading = 2 * 0.076
    expect(DEFAULT_PUBLISH_CONCURRENCY / secondsPerReading).toBeGreaterThan(readingsPerSecond)
  })
})

/* -------------------------------------------------------------------------- */

describe('loadScenario', () => {
  const base = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(readScenario('gaps'), (_key, value) => value)) as Record<
      string,
      unknown
    >

  it('refuses a file that does not declare its readings invented', () => {
    // FR-039 with teeth: the badge on the screen cannot be switched off by a
    // flag somebody forgot to set.
    expect(() => loadScenario({ ...base(), synthetic: false })).toThrow()
    const withoutFlag = base()
    delete withoutFlag.synthetic
    expect(() => loadScenario(withoutFlag)).toThrow()
  })

  it('refuses a programme that is not as long as it claims', () => {
    expect(() => loadScenario({ ...base(), expected: { days: 99, longestDrySpell: 5 } })).toThrow(
      /programme is/,
    )
  })

  it('refuses two sensors in one slot', () => {
    const scenario = base()
    const sensors = scenario.sensors as { slotInCell: number }[]
    const second = sensors[1]
    if (second === undefined) throw new Error('fixture')
    second.slotInCell = 0
    expect(() => loadScenario(scenario)).toThrow(/share a slot/)
  })

  it('refuses two sensors sharing a seed, and therefore a key', () => {
    const scenario = base()
    const sensors = scenario.sensors as { seed: number }[]
    const second = sensors[1]
    if (second === undefined) throw new Error('fixture')
    second.seed = 11
    expect(() => loadScenario(scenario)).toThrow(/share a seed/)
  })

  it('refuses to silence a sensor the scenario does not have', () => {
    const scenario = base()
    const programme = scenario.programme as { silentSensors?: number[] }[]
    const first = programme[0]
    if (first === undefined) throw new Error('fixture')
    first.silentSensors = [99]
    expect(() => loadScenario(scenario)).toThrow(/no sensor with seed 99/)
  })

  it('refuses more silent intervals than a day has', () => {
    const scenario = base()
    const programme = scenario.programme as { silentIntervals?: number }[]
    const first = programme[0]
    if (first === undefined) throw new Error('fixture')
    first.silentIntervals = 25
    expect(() => loadScenario(scenario)).toThrow(/cannot have 25 silent/)
  })

  it('refuses an unknown field rather than dropping it', () => {
    expect(() => loadScenario({ ...base(), rainfall: 'lots' })).toThrow()
  })

  it('refuses a name that is a path', () => {
    expect(() => readScenario('../../secrets')).toThrow(RangeError)
    expect(() => readScenario('Drought')).toThrow(RangeError)
  })
})
