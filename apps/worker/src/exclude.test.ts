import {
  BN,
  type CellReputationAccount,
  PublicKey,
  reputationPda,
  type SensorAccount,
  SENSOR_SLOTS,
  type TransactionInstruction,
} from '@pumpking/anchor-client'
import type { CellSlot, CellSlotStore } from '@pumpking/db'
import { cellIdFromH3Index } from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import {
  type ExcludeDeps,
  type ExclusionSource,
  excludeAfterDays,
  excludeBreaching,
  outlierWindow,
} from './exclude.ts'
import type { DaySubmitter, PoolClock } from './interval.ts'

const CELL_ID = cellIdFromH3Index('871e701b3ffffff')
const GENESIS = new Date('2026-08-01T00:00:00.000Z')
const CLOCK: PoolClock = { genesisTs: GENESIS, secondsPerDay: 86_400, intervalsPerDay: 24 }
/** Noon of day 20: the window is days 6..=19. */
const NOW = new Date(GENESIS.getTime() + 20.5 * 86_400_000)

const key = (fill: number): PublicKey => new PublicKey(new Uint8Array(32).fill(fill))

/** A ring with every slot judged 24 times a day on days 6..=19, and `lies` outliers for `slot`. */
function ring(lies: Map<number, number>): CellReputationAccount {
  const days = Array.from({ length: 14 }, (_, index) => {
    const dayIndex = 6 + index
    return {
      dayIndex,
      judged: Array.from({ length: SENSOR_SLOTS }, (_, slot) => (slot < 3 ? 24 : 0)),
      outliers: Array.from({ length: SENSOR_SLOTS }, (_, slot) => lies.get(slot) ?? 0),
    }
  })
  return {
    cellId: new BN(CELL_ID.toString()),
    lastDayIndex: 19,
    bump: 255,
    hasDays: 1,
    padding: [0, 0],
    days,
  } as unknown as CellReputationAccount
}

/** The cell next door, where a sensor of the demo cell moves in one test. */
const NEIGHBOUR = cellIdFromH3Index('871e701b2ffffff')

const SLOTS: CellSlot[] = [
  { pubkey: key(1).toBase58(), slots: [{ cellId: CELL_ID, slotInCell: 0 }] },
  { pubkey: key(2).toBase58(), slots: [{ cellId: CELL_ID, slotInCell: 1 }] },
  { pubkey: key(3).toBase58(), slots: [{ cellId: CELL_ID, slotInCell: 2 }] },
]

class Chain implements ExclusionSource {
  constructor(
    readonly ring: CellReputationAccount | null,
    readonly excluded = new Set<string>(),
    /** Other cells' rings, by cell. */
    readonly others = new Map<bigint, CellReputationAccount>(),
    /** Sensors that moved: the cell they are in now, from the one in `CELL_ID`. */
    readonly moved = new Map<string, bigint>(),
  ) {}
  read: string[] = []
  reputation(cellId: bigint): Promise<CellReputationAccount | null> {
    return Promise.resolve(cellId === CELL_ID ? this.ring : (this.others.get(cellId) ?? null))
  }
  sensor(sensorKey: PublicKey): Promise<SensorAccount | null> {
    const pubkey = sensorKey.toBase58()
    this.read.push(pubkey)
    const now = this.moved.get(pubkey)
    return Promise.resolve({
      active: !this.excluded.has(pubkey),
      cellId: new BN((now ?? CELL_ID).toString()),
      previousCellId: new BN(CELL_ID.toString()),
    } as SensorAccount)
  }
}

class Submitter implements DaySubmitter {
  sent: TransactionInstruction[] = []
  failWith: Error | null = null
  submit(instruction: TransactionInstruction): Promise<string> {
    if (this.failWith !== null) return Promise.reject(this.failWith)
    this.sent.push(instruction)
    return Promise.resolve(`tx-${this.sent.length}`)
  }
}

function deps(chain: Chain, submitter = new Submitter()): ExcludeDeps & { submitter: Submitter } {
  const slots: CellSlotStore = { slotsOf: () => Promise.resolve(SLOTS) }
  return { slots, chain, submitter, caller: key(9), assetMint: key(8), clock: CLOCK }
}

describe('outlierWindow', () => {
  it('is the closed days before today, as the program has them', () => {
    expect(outlierWindow(0)).toBeNull()
    expect(outlierWindow(1)).toEqual({ from: 0, to: 0 })
    expect(outlierWindow(20)).toEqual({ from: 6, to: 19 })
  })
})

describe('excludeBreaching', () => {
  it('excludes the slot over the line and nobody else', async () => {
    // Slot 2 lies 5 of 24 a day: 70 of 336. Slot 1 lies 4: 56 of 336, inside.
    const d = deps(new Chain(ring(new Map([[1, 4], [2, 5]]))))
    const outcomes = await excludeBreaching(d, CELL_ID, NOW)

    expect(outcomes).toEqual([
      { sensor: key(3).toBase58(), status: 'excluded', judged: 336, outliers: 70, txSignature: 'tx-1' },
    ])
    expect(d.submitter.sent).toHaveLength(1)
    // The sensor and the cell's ring are the accounts the program will read.
    const keys = d.submitter.sent[0]?.keys.map((meta) => meta.pubkey.toBase58()) ?? []
    expect(keys[0]).toBe(key(9).toBase58())
  })

  it('sends nothing for a sensor the chain has already excluded', async () => {
    // The mirror is minutes behind; the chain is not.
    const chain = new Chain(ring(new Map([[2, 24]])), new Set([key(3).toBase58()]))
    const d = deps(chain)
    expect(await excludeBreaching(d, CELL_ID, NOW)).toEqual([
      { sensor: key(3).toBase58(), status: 'already-excluded', judged: 336, outliers: 336 },
    ])
    expect(d.submitter.sent).toEqual([])
  })

  it('does not read a sensor whose record is clean', async () => {
    const chain = new Chain(ring(new Map()))
    expect(await excludeBreaching(deps(chain), CELL_ID, NOW)).toEqual([])
    expect(chain.read).toEqual([])
  })

  it('judges a moved sensor on both slots, as the program will', async () => {
    // Key 3 left slot 2 of the demo cell for slot 0 next door — FR-059.
    const moved = new Map([[key(3).toBase58(), NEIGHBOUR]])
    const bothSlots = {
      slotsOf: () =>
        Promise.resolve([
          {
            pubkey: key(3).toBase58(),
            slots: [
              { cellId: NEIGHBOUR, slotInCell: 0 },
              { cellId: CELL_ID, slotInCell: 2 },
            ],
          },
        ]),
    }

    // It lied 5 of 24 a day here and none next door: 70 of 672 is inside
    // the line, and the program would refuse the exclusion — so none is sent.
    const diluted = deps(
      new Chain(ring(new Map([[2, 5]])), new Set(), new Map([[NEIGHBOUR, ring(new Map())]]), moved),
    )
    diluted.slots = bothSlots
    expect(await excludeBreaching(diluted, CELL_ID, NOW)).toEqual([])
    // Control: on this cell's ring alone, the same sensor is over the line.
    diluted.slots = {
      slotsOf: () =>
        Promise.resolve([
          { pubkey: key(3).toBase58(), slots: [{ cellId: CELL_ID, slotInCell: 2 }] },
        ]),
    }
    expect(await excludeBreaching(diluted, CELL_ID, NOW)).toHaveLength(1)

    // It lied in every interval here: 336 of 672 is over, wherever it went.
    const liar = deps(
      new Chain(ring(new Map([[2, 24]])), new Set(), new Map([[NEIGHBOUR, ring(new Map())]]), moved),
    )
    liar.slots = bothSlots
    expect(await excludeBreaching(liar, CELL_ID, NOW)).toEqual([
      { sensor: key(3).toBase58(), status: 'excluded', judged: 672, outliers: 336, txSignature: 'tx-1' },
    ])
    // The rings of both cells, seeded by the chain's account.
    const keys = liar.submitter.sent[0]?.keys.map((meta) => meta.pubkey.toBase58()) ?? []
    expect(keys[3]).toBe(reputationPda(NEIGHBOUR).address.toBase58())
    expect(keys[4]).toBe(reputationPda(CELL_ID).address.toBase58())
  })

  it('does nothing for a cell with no ring yet', async () => {
    expect(await excludeBreaching(deps(new Chain(null)), CELL_ID, NOW)).toEqual([])
  })

  it('reports a refused exclusion and goes on', async () => {
    const submitter = new Submitter()
    submitter.failWith = new Error('blockhash not found')
    const outcomes = await excludeBreaching(
      deps(new Chain(ring(new Map([[2, 24]]))), submitter),
      CELL_ID,
      NOW,
    )
    expect(outcomes.map((one) => one.status)).toEqual(['failed'])
  })
})

describe('excludeAfterDays', () => {
  it('visits only the cells that got a new day, once each', async () => {
    let asked = 0
    const chain = new Chain(ring(new Map()))
    chain.reputation = () => {
      asked += 1
      return Promise.resolve(null)
    }
    await excludeAfterDays(
      deps(chain),
      [
        { cellId: CELL_ID, dayIndex: 18, status: 'submitted', txSignature: 'a' },
        { cellId: CELL_ID, dayIndex: 19, status: 'submitted', txSignature: 'b' },
        { cellId: 7n, dayIndex: 19, status: 'recorded', txSignature: 'c' },
      ],
      NOW,
    )
    expect(asked).toBe(1)
  })
})
