import type { StakeRow } from '@pumpking/db'
import { cellIdFromH3Index } from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import {
  type ChainCell,
  COLLUSION_MEANING,
  createMethodologyRoute,
  type MethodologyPool,
  type MethodologyWire,
  rpcCellSource,
  voteStakesByCell,
} from './methodology.ts'

/**
 * The price of collusion against the exposure limit — `T041`, `FR-054`,
 * `SC-014`. Computed from the pool as it is on every request, so a change of
 * either parameter is the next answer.
 */

const TOKEN = 1_000_000n
const A = '871e701b3ffffff'
const B = '871e701b2ffffff'
const C = '871e701b1ffffff'

/** `scripts/devnet-init.mjs`: one token, quorum 3, 10% of half a million tokens. */
const DEMO: MethodologyPool = {
  minStake: TOKEN,
  minVotes: 3,
  capitalTotal: 500_000n * TOKEN,
  cellExposureBps: 1_000,
}

const chainCell = (h3: string, overrides: Partial<ChainCell> = {}): ChainCell => ({
  cellId: cellIdFromH3Index(h3),
  sensorCount: 3,
  reserved: 0n,
  underInvestigation: false,
  ...overrides,
})

const stake = (h3: string, operator: string, overrides: Partial<StakeRow> = {}): StakeRow => ({
  cellId: cellIdFromH3Index(h3),
  operatorWallet: operator,
  stake: TOKEN,
  active: true,
  ...overrides,
})

async function get(
  pool: MethodologyPool | null,
  cells: ChainCell[] = [],
  rows: StakeRow[] = [],
): Promise<MethodologyWire> {
  const route = createMethodologyRoute({
    pool: async () => pool,
    cells: { cells: async () => cells },
    store: {
      stakes: async (kind) => {
        expect(kind).toBe('precipitation_mm')
        return rows
      },
    },
  })
  const response = await route.request('/')
  expect(response.status).toBe(200)
  return (await response.json()) as MethodologyWire
}

describe('GET /v1/methodology', () => {
  it('fails SC-014 on the demo pool, and says so with the number', async () => {
    const wire = await get(DEMO)
    expect(wire.pool).toEqual({
      minStake: '1000000',
      minVotes: 3,
      capitalTotal: '500000000000',
      cellExposureBps: 1_000,
      capitalExposureLimit: '50000000000',
      collusionExposureLimit: '1000000',
      cellExposureLimit: '1000000',
      binding: 'collusion',
    })
    expect(wire.collusion?.coverTimes).toBe(2)
    expect(wire.collusion?.floor).toEqual({
      votes: 2,
      cost: '2000000',
      ratio: 4e-5,
      holds: false,
    })
  })

  it('holds once the floor reaches twice the limit, and not one unit before', async () => {
    // Limit 1 000 tokens; floor = 2 votes × min_stake; holding needs 2 000.
    const pool = { ...DEMO, capitalTotal: 10_000n * TOKEN }
    expect((await get({ ...pool, minStake: 1_000n * TOKEN })).collusion?.floor.holds).toBe(true)
    expect((await get({ ...pool, minStake: 1_000n * TOKEN - 1n })).collusion?.floor.holds).toBe(
      false,
    )
    // The other parameter moves the verdict too.
    expect(
      (await get({ ...pool, minStake: 500n * TOKEN, cellExposureBps: 500 })).collusion?.floor.holds,
    ).toBe(true)
  })

  it('prices every cell on the chain from the votes in the mirror', async () => {
    const wire = await get(
      DEMO,
      [
        chainCell(B, { sensorCount: 32, reserved: 1_000n * TOKEN }),
        chainCell(A, { sensorCount: 4 }),
        chainCell(C, { sensorCount: 31 }),
      ],
      [
        // A: three operators, one of them on two sensors — still one vote.
        stake(A, 'x', { stake: 40n * TOKEN }),
        stake(A, 'y', { stake: 9n * TOKEN }),
        stake(A, 'y', { stake: 1n * TOKEN }),
        stake(A, 'z', { stake: 50n * TOKEN }),
        // B: full, so it can only be bought; the two dearest are the half.
        stake(B, 'p', { stake: 7n * TOKEN }),
        stake(B, 'q', { stake: 5n * TOKEN }),
        stake(B, 'r', { stake: 3n * TOKEN }),
        stake(B, 's', { stake: 2n * TOKEN }),
        // Neither votes: excluded, and under the minimum.
        stake(B, 't', { stake: 100n * TOKEN, active: false }),
        stake(B, 'u', { stake: TOKEN - 1n }),
      ],
    )
    expect(wire.collusion?.cells).toEqual([
      // Sorted by cell id; C has one free slot and no votes, so no quorum ever.
      {
        cellId: C,
        votes: 0,
        freeSlots: 1,
        reserved: '0',
        underInvestigation: false,
        path: null,
        ratio: null,
        holds: true,
      },
      {
        cellId: B,
        votes: 4,
        freeSlots: 0,
        reserved: '1000000000',
        underInvestigation: false,
        path: { bought: 2, added: 0, cost: '5000000' },
        ratio: 1e-4,
        holds: false,
      },
      {
        cellId: A,
        votes: 3,
        freeSlots: 28,
        reserved: '0',
        underInvestigation: false,
        // Three new votes at the minimum beat buying y (10) or y and x (50).
        path: { bought: 0, added: 3, cost: '3000000' },
        ratio: 6e-5,
        holds: false,
      },
    ])
  })

  it('says the price is stake locked, not money lost', async () => {
    expect((await get(DEMO)).collusion?.meaning).toBe(COLLUSION_MEANING)
    expect(COLLUSION_MEANING).toMatch(/not money it loses/)
    expect(COLLUSION_MEANING).toMatch(/mock USDC/)
  })

  it('has nothing to say before the pool exists', async () => {
    expect(await get(null)).toEqual({ pool: null, collusion: null })
  })
})

describe('the two bounds', () => {
  it('names the capital share when it is the lower', async () => {
    // Parameters that keep SC-014 on their own: the share of 1 246 sits under
    // half the floor, 1 250 — the demo's numbers after the upgrade.
    const wire = await get({
      ...DEMO,
      capitalTotal: 498_766_080_000n,
      minStake: 1_250n * TOKEN,
      cellExposureBps: 25,
    })
    expect(wire.pool?.capitalExposureLimit).toBe('1246915200')
    expect(wire.pool?.collusionExposureLimit).toBe('1250000000')
    expect(wire.pool?.cellExposureLimit).toBe('1246915200')
    expect(wire.pool?.binding).toBe('capital')
    expect(wire.collusion?.floor.holds).toBe(true)
  })
})

describe('voteStakesByCell', () => {
  it('counts a sensor at exactly the minimum, and not one below', () => {
    const map = voteStakesByCell([stake(A, 'a'), stake(A, 'b', { stake: TOKEN - 1n })], TOKEN)
    expect(map.get(cellIdFromH3Index(A))).toEqual([TOKEN])
  })
})

describe('rpcCellSource', () => {
  it('scans once per window, and asks again after a failure', async () => {
    let scans = 0
    let fail = true
    let clock = 0
    const connection = {
      getProgramAccounts: async () => {
        scans += 1
        if (fail) throw new Error('rpc down')
        return []
      },
    } as unknown as Parameters<typeof rpcCellSource>[0]
    const source = rpcCellSource(connection, undefined, 30_000, () => clock)

    await expect(source.cells()).rejects.toThrow('rpc down')
    fail = false
    expect(await source.cells()).toEqual([])
    expect(await source.cells()).toEqual([])
    expect(scans).toBe(2)
    clock = 30_000
    await source.cells()
    expect(scans).toBe(3)
  })
})
