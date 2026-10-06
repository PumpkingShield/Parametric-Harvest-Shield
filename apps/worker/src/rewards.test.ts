import type { DayRewardedEvent } from '@pumpking/anchor-client'
import type {
  CellSlot,
  CellSlotStore,
  RewardMirrorStore,
  SlotRewardRow,
  UnreadRewardDay,
} from '@pumpking/db'
import { describe, expect, it } from 'vitest'
import { type DayRewardSource, readDayRewards, rewardMirror, slotRewardRows } from './rewards.ts'

/**
 * The reward history — `T040`, `FR-036`. What the program logged per slot,
 * copied under the sensor holding the slot, and a day marked read only when
 * its numbers are written.
 */

const CELL = 0x871e701b3ffffffn
const OTHER = 0x871e701b2ffffffn

function event(dayIndex: number, earned: Record<number, bigint>, cellId = CELL): DayRewardedEvent {
  return {
    cellId,
    dayIndex,
    earned: Array.from({ length: 32 }, (_unused, slot) => earned[slot] ?? 0n),
    returned: 0n,
  }
}

function memoryStore(unread: UnreadRewardDay[]) {
  const saved = new Map<string, SlotRewardRow[]>()
  const store: RewardMirrorStore = {
    async unreadDays(fromDay) {
      return unread.filter(
        (day) => day.dayIndex >= fromDay && !saved.has(`${day.cellId}:${day.dayIndex}`),
      )
    },
    async saveDayRewards(cellId, dayIndex, rows) {
      saved.set(`${cellId}:${dayIndex}`, [...rows])
    },
  }
  return { store, saved }
}

const slots = (rows: CellSlot[]): CellSlotStore => ({ slotsOf: async () => rows })

function source(bySignature: Record<string, DayRewardedEvent | null | undefined>): DayRewardSource {
  return { dayRewarded: async (signature) => bySignature[signature] }
}

describe('slotRewardRows', () => {
  it('keeps the slots that earned, under the sensor that holds each', () => {
    const rows = slotRewardRows(event(5, { 0: 10n, 3: 7n }), new Map([[0, 'alice']]))
    expect(rows).toEqual([
      { slot: 0, sensorPubkey: 'alice', earned: 10n },
      // Unknown to the mirror: the number is kept, the name is not invented.
      { slot: 3, sensorPubkey: null, earned: 7n },
    ])
  })
})

describe('readDayRewards', () => {
  it('writes each unread day and names the holder of the slot in that cell only', async () => {
    const { store, saved } = memoryStore([
      { cellId: CELL, dayIndex: 4, txSignature: 'a' },
      { cellId: CELL, dayIndex: 5, txSignature: 'b' },
    ])
    // `bob` moved here from OTHER, where his old slot 0 was; here he holds 1.
    const holders = slots([
      { pubkey: 'alice', slots: [{ cellId: CELL, slotInCell: 0 }] },
      {
        pubkey: 'bob',
        slots: [
          { cellId: CELL, slotInCell: 1 },
          { cellId: OTHER, slotInCell: 0 },
        ],
      },
    ])
    const outcomes = await readDayRewards(
      {
        store,
        slots: holders,
        source: source({ a: event(4, { 0: 3n }), b: event(5, { 0: 1n, 1: 2n }) }),
      },
      0,
    )
    expect(outcomes.map((one) => one.status)).toEqual(['read', 'read'])
    expect(saved.get(`${CELL}:5`)).toEqual([
      { slot: 0, sensorPubkey: 'alice', earned: 1n },
      { slot: 1, sensorPubkey: 'bob', earned: 2n },
    ])
  })

  it('leaves a day the cluster does not have yet unread, for the next try', async () => {
    const { store, saved } = memoryStore([{ cellId: CELL, dayIndex: 4, txSignature: 'a' }])
    const outcomes = await readDayRewards({ store, slots: slots([]), source: source({}) }, 0)
    expect(outcomes).toEqual([{ cellId: CELL, dayIndex: 4, status: 'missing' }])
    expect(saved.size).toBe(0)
  })

  it('marks a day whose transaction has no event read, with nothing under it', async () => {
    const { store, saved } = memoryStore([{ cellId: CELL, dayIndex: 4, txSignature: 'a' }])
    await readDayRewards({ store, slots: slots([]), source: source({ a: null }) }, 0)
    expect(saved.get(`${CELL}:4`)).toEqual([])
  })

  it('refuses an event of another day, and writes nothing for it', async () => {
    const { store, saved } = memoryStore([{ cellId: CELL, dayIndex: 4, txSignature: 'a' }])
    const [outcome] = await readDayRewards(
      { store, slots: slots([]), source: source({ a: event(9, { 0: 1n }) }) },
      0,
    )
    expect(outcome?.status).toBe('failed')
    expect(saved.size).toBe(0)
  })
})

describe('rewardMirror', () => {
  function counted() {
    const log = { reads: 0 }
    const store: RewardMirrorStore = {
      unreadDays: async () => {
        log.reads += 1
        return []
      },
      saveDayRewards: async () => undefined,
    }
    return { log, mirror: rewardMirror({ store, slots: slots([]), source: source({}) }, 1000) }
  }
  const at = (ms: number) => new Date(ms)

  it('leaves the history to the first quiet cycle while days are going out', async () => {
    const { log, mirror } = counted()

    expect(await mirror.readIfDue(at(0), true, 0)).toEqual([]) // nothing read yet: read
    expect(await mirror.readIfDue(at(200), true, 0)).toBeNull() // busy: the days come first
    expect(await mirror.readIfDue(at(400), true, 0)).toBeNull()
    expect(await mirror.readIfDue(at(600), false, 0)).toEqual([]) // quiet, and owed: read now
    expect(await mirror.readIfDue(at(800), false, 0)).toBeNull() // quiet, nothing owed
    expect(log.reads).toBe(2)
  })

  it('still reads once a period for a worker that is never quiet', async () => {
    // A scenario pool's day is two seconds: every cycle submits, forever.
    const { log, mirror } = counted()
    for (let ms = 0; ms <= 3000; ms += 100) await mirror.readIfDue(at(ms), true, 0)
    // At 0, 1000, 2000 and 3000 — not thirty-one times.
    expect(log.reads).toBe(4)
  })

  it('reads a real day straight after it, and the leftovers once a period', async () => {
    // Control: a day of 86 400 s submits once and then sits quiet. The history
    // must not wait a period for the day that was just sent.
    const { log, mirror } = counted()
    expect(await mirror.readIfDue(at(0), false, 0)).toEqual([])
    expect(await mirror.readIfDue(at(500), true, 0)).toBeNull()
    expect(await mirror.readIfDue(at(505), false, 0)).toEqual([])
    expect(await mirror.readIfDue(at(1400), false, 0)).toBeNull()
    expect(await mirror.readIfDue(at(1505), false, 0)).toEqual([])
    expect(log.reads).toBe(3)
  })
})
