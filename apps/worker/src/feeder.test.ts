import { readdirSync, readFileSync } from 'node:fs'
import { cellIdFromH3Index, cellResolution, verifyReadingSignature } from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import {
  cellRainX100,
  dueHours,
  FEEDER_CELLS,
  FEEDER_SENSORS,
  feederCellId,
  feederReading,
  feederReadings,
  feederSensors,
  HOUR_MS,
  hourOf,
  lastFullHour,
} from './feeder.ts'

const HOUR = hourOf(new Date('2026-10-01T10:00:00Z'))
const at = (hour: number, minutes: number) => new Date(hour * HOUR_MS + minutes * 60_000)
const MAX_AGE = 90 * 60_000

describe('the feeder network', () => {
  it('is a hundred sensors with a hundred keys', async () => {
    const sensors = await feederSensors()
    expect(sensors).toHaveLength(FEEDER_SENSORS)
    expect(new Set(sensors.map((sensor) => sensor.pubkey)).size).toBe(FEEDER_SENSORS)
  })

  it('never claims a key a scenario fixture uses', async () => {
    const dir = new URL('../../../fixtures/scenarios/', import.meta.url)
    const scenarioSeeds = new Set<number>()
    for (const name of readdirSync(dir)) {
      const file = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as {
        sensors: { seed: number }[]
      }
      for (const sensor of file.sensors) scenarioSeeds.add(sensor.seed)
    }
    const sensors = await feederSensors()
    expect(sensors.filter((sensor) => scenarioSeeds.has(sensor.seed))).toEqual([])
  })

  it('fills four res-7 cells, none of them the demo cell, within the 32-slot mask', () => {
    expect(new Set(FEEDER_CELLS).size).toBe(4)
    expect(FEEDER_CELLS).not.toContain('871e701b3ffffff')
    for (const hex of FEEDER_CELLS) expect(cellResolution(cellIdFromH3Index(hex))).toBe(7)
  })

  it('gives every cell 25 sensors and all three operators', async () => {
    const sensors = await feederSensors()
    for (const [index, hex] of FEEDER_CELLS.entries()) {
      const inCell = sensors.filter((sensor) => feederCellId(sensor) === cellIdFromH3Index(hex))
      expect(inCell.every((sensor) => sensor.cell === index)).toBe(true)
      // Under the program's 32 slots, so every one of them can register.
      expect(inCell).toHaveLength(25)
      // `FR-009`: the operator is the vote; three of them make a covered hour.
      expect(new Set(inCell.map((sensor) => sensor.operator))).toEqual(new Set([0, 1, 2]))
    }
  })
})

describe('the weather', () => {
  it('is the same reading, byte for byte, every time it is made', async () => {
    // What makes a tick stateless: a resend is a retry, and intake answers it
    // 200 rather than calling it a replay.
    const [sensor] = await feederSensors()
    if (sensor === undefined) throw new Error('no sensor')
    const [first] = await feederReadings([sensor], [HOUR], at(HOUR, 5), MAX_AGE)
    const [again] = await feederReadings([sensor], [HOUR], at(HOUR, 30), MAX_AGE)
    expect(again).toEqual(first)
    if (first === undefined) throw new Error('no reading')
    expect(await verifyReadingSignature(first)).toBe(true)
  })

  it('counts by the hour, so the counter climbs as the clock does', async () => {
    const [sensor] = await feederSensors()
    if (sensor === undefined) throw new Error('no sensor')
    expect(feederReading(sensor, HOUR + 1).counter).toBe(feederReading(sensor, HOUR).counter + 1n)
  })

  it('is mostly dry and sometimes wet, and never negative', async () => {
    const hours = Array.from({ length: 7 * 24 * 4 }, (_, i) => HOUR + i)
    const wet = hours.filter((hour) => cellRainX100(0, hour) > 0).length / hours.length
    expect(wet).toBeGreaterThan(0.08)
    expect(wet).toBeLessThan(0.22)
    const sensors = await feederSensors()
    for (const hour of hours.slice(0, 48)) {
      for (const sensor of sensors)
        expect(feederReading(sensor, hour).valueX100).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('which hours a tick publishes', () => {
  it('starts with the current hour on a network that never spoke', () => {
    expect(dueHours(at(HOUR, 5), null, 2)).toEqual([HOUR])
  })

  it('publishes nothing when the network is already current', () => {
    expect(dueHours(at(HOUR, 40), HOUR, 2)).toEqual([])
  })

  it('catches up the hours in between, but no further back than the window', () => {
    expect(dueHours(at(HOUR + 1, 5), HOUR - 1, 2)).toEqual([HOUR, HOUR + 1])
    expect(dueHours(at(HOUR + 10, 5), HOUR, 2)).toEqual([HOUR + 8, HOUR + 9, HOUR + 10])
  })

  it('sends neither a reading not yet taken nor one intake would file as late', async () => {
    const sensors = await feederSensors()
    // Ten seconds past the hour: only the sensors that read in the first ten.
    const early = await feederReadings(sensors, [HOUR], new Date(HOUR * HOUR_MS + 10_000), MAX_AGE)
    expect(early.length).toBeGreaterThan(0)
    expect(early.length).toBeLessThan(sensors.length)
    // Two hours on, the hour is past the ninety-minute window for everyone.
    expect(await feederReadings(sensors, [HOUR], at(HOUR + 2, 0), MAX_AGE)).toEqual([])
  })

  it('reaches back to the slowest sensor, and waits for all of them to have spoken', async () => {
    const sensors = await feederSensors()
    const counters = new Map(sensors.map((sensor) => [sensor.pubkey, BigInt(HOUR)]))
    const [first] = sensors
    if (first === undefined) throw new Error('no sensor')
    counters.set(first.pubkey, BigInt(HOUR - 1))
    expect(lastFullHour(sensors, counters)).toBe(HOUR - 1)
    counters.delete(first.pubkey)
    expect(lastFullHour(sensors, counters)).toBeNull()
  })
})
