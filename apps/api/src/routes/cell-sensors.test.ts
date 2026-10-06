import type { CellSensorRow } from '@pumpking/db'
import { cellIdFromH3Index, OUTLIER_WINDOW_DAYS } from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import type { PoolClock } from './activity.ts'
import { type CellSensorsWire, createCellSensorsRoute } from './cell-sensors.ts'

/**
 * Who measures a cell, and who of them counts — `T040`, `FR-050`. The list is
 * the price of collusion made visible: a sensor without the stake is listed,
 * and listed as not counted.
 */

const H3 = '871e701b3ffffff'
const MIN = 1_000_000n
const CLOCK: PoolClock = { genesisTs: new Date('2026-10-01T00:00:00Z'), secondsPerDay: 86_400 }

const sensor = (pubkey: string, overrides: Partial<CellSensorRow> = {}): CellSensorRow => ({
  pubkey,
  operatorWallet: `op-${pubkey}`,
  slotInCell: 0,
  stake: MIN,
  active: true,
  judged: 24,
  outliers: 0,
  ...overrides,
})

async function get(
  rows: CellSensorRow[],
  minStake: bigint | null = MIN,
  cell = H3,
): Promise<{ status: number; wire: CellSensorsWire; asked: number[] }> {
  const asked: number[] = []
  const route = createCellSensorsRoute({
    store: {
      cellSensors: async (cellId, _kind, fromDay, toDay) => {
        expect(cellId).toBe(cellIdFromH3Index(H3))
        asked.push(fromDay, toDay)
        return rows
      },
    },
    minStake: async () => minStake,
    clock: async () => CLOCK,
    now: () => new Date('2026-10-20T12:00:00Z'),
  })
  const response = await route.request(`/${cell}/sensors`)
  return { status: response.status, wire: (await response.json()) as CellSensorsWire, asked }
}

describe('GET /v1/cells/:cellId/sensors', () => {
  it('says which sensors vote and why the others do not', async () => {
    const { status, wire } = await get([
      sensor('a'),
      sensor('b', { slotInCell: 1, stake: MIN - 1n }),
      sensor('c', { slotInCell: 2, active: false, outliers: 9 }),
    ])
    expect(status).toBe(200)
    expect(wire.minStake).toBe('1000000')
    expect(
      wire.sensors.map(({ pubkey, voting, problem }) => ({ pubkey, voting, problem })),
    ).toEqual([
      { pubkey: 'a', voting: true, problem: null },
      { pubkey: 'b', voting: false, problem: 'understaked' },
      { pubkey: 'c', voting: false, problem: 'excluded' },
    ])
    expect(wire.sensors[1]?.stake).toBe('999999')
  })

  it('counts the record over the window an exclusion reads, ending today', async () => {
    const { asked, wire } = await get([])
    // 2026-10-20 is pool day 19.
    expect(asked).toEqual([19 - OUTLIER_WINDOW_DAYS + 1, 19])
    expect(wire.windowDays).toBe(OUTLIER_WINDOW_DAYS)
  })

  it('has nobody voting before there is a pool', async () => {
    const { wire } = await get([sensor('a')], null)
    expect(wire.sensors[0]).toMatchObject({ voting: false, problem: 'no-pool' })
  })

  it('refuses what is not a cell', async () => {
    const { status } = await get([], MIN, 'nope')
    expect(status).toBe(400)
  })
})
