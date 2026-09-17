import {
  BN,
  decodeInstruction,
  type PolicyAccount,
  type PoolAccount,
  PublicKey,
  type TransactionInstruction,
} from '@pumpking/anchor-client'
import type { AcceptedReading, DayRow, IntervalRow } from '@pumpking/db'
import { DayState } from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PoolSource } from './chain.ts'
import { type CycleDeps, clockOf, paramsOf, runCycle, summarise } from './cycle.ts'
import type { OpenPolicy } from './settle.ts'

/**
 * The order, and where the numbers it runs on come from.
 *
 * The three dispatchers each have their own tests. What only exists here is
 * that something calls them, in the order that makes `SC-001`'s sixty seconds
 * about confirmation, and that the clock they run on is the pool's rather than
 * this process's opinion of one.
 */

const CELL_ID = 613_196_570_331_971_583n
const key = (fill: number): PublicKey => new PublicKey(new Uint8Array(32).fill(fill))
const AGGREGATOR = key(1)
const MINT = key(2)
const OWNER = key(3)

const GENESIS = new Date('2026-08-01T00:00:00Z')

function pool(overrides: Partial<Record<string, unknown>> = {}): PoolAccount {
  return {
    authority: key(9),
    aggregator: AGGREGATOR,
    assetMint: MINT,
    vault: key(10),
    stakeVault: key(11),
    capitalTotal: new BN(1_000_000),
    reservedTotal: new BN(0),
    sharesTotal: new BN(1_000_000),
    cellExposureBps: 1_000,
    premiumRewardsBps: 1_000,
    riskLoadingBps: 3_000,
    minRateBps: 100,
    minSensorsPerCell: 3,
    minStake: new BN(0),
    unstakeDelayDays: 14,
    waitingPeriodDays: 3,
    dryDayThresholdMmX100: 100,
    secondsPerDay: 86_400,
    genesisTs: new BN(Math.floor(GENESIS.getTime() / 1000)),
    bump: 255,
    ...overrides,
  } as PoolAccount
}

function policy(spellDaysThreshold: number, address: PublicKey, nonce: number): OpenPolicy {
  return {
    address,
    account: {
      owner: OWNER,
      nonce: new BN(nonce),
      cellId: new BN(CELL_ID.toString()),
      spellDaysThreshold,
      payout: new BN(1_000_000),
      premium: new BN(21_000),
      windowStartDay: 0,
      windowEndDay: 1,
      state: { active: {} },
      bump: 254,
    } as PolicyAccount,
  }
}

/** Two dry days, both already on chain — a finished window with a run of two. */
function twoDryDays(): DayRow[] {
  return [0, 1].map((dayIndex) => ({
    cellId: CELL_ID,
    dayIndex,
    state: DayState.Dry,
    rainfallX100: 0,
    coveredHours: 24,
    merkleRoot: 'root',
    txSignature: `day-${dayIndex}`,
  }))
}

/** Records what reached the cluster, in order, and what the store was asked. */
class Chain {
  sent: TransactionInstruction[] = []
  submit(instruction: TransactionInstruction): Promise<string> {
    this.sent.push(instruction)
    return Promise.resolve(`tx-${this.sent.length}`)
  }
  /** The instruction names, in the order they were submitted. */
  get names(): string[] {
    return this.sent.map((one) => decodeInstruction(one.data)?.name ?? 'undecodable')
  }
}

class Store {
  cells: bigint[] = [CELL_ID]
  window: DayRow[] = []
  saved: DayRow[] = []
  submittedDays: number[] = []

  cellIds(): Promise<bigint[]> {
    return Promise.resolve(this.cells)
  }
  acceptedReadings(): Promise<AcceptedReading[]> {
    return Promise.resolve([])
  }
  /** No day is closed yet, so every due day is closed by this cycle. */
  dayRecord(): Promise<DayRow | null> {
    return Promise.resolve(null)
  }
  dayRecords(): Promise<DayRow[]> {
    return Promise.resolve(this.window)
  }
  saveIntervals(_rows: readonly IntervalRow[]): Promise<void> {
    return Promise.resolve()
  }
  saveDay(row: DayRow): Promise<void> {
    this.saved.push(row)
    return Promise.resolve()
  }
  markDaySubmitted(_cellId: bigint, dayIndex: number): Promise<void> {
    this.submittedDays.push(dayIndex)
    return Promise.resolve()
  }
}

let chain: Chain
let store: Store
let open: OpenPolicy[]
let account: PoolAccount | null
let deps: CycleDeps

beforeEach(() => {
  chain = new Chain()
  store = new Store()
  open = []
  account = pool()

  const source: PoolSource = { read: () => Promise.resolve(account) }
  deps = {
    store,
    submitter: chain,
    policies: { openPolicies: () => Promise.resolve(open) },
    pool: source,
    aggregator: AGGREGATOR,
    intervalsPerDay: 24,
    minimumCoverageX100: 75,
  }
})

describe('a cycle with no pool to read', () => {
  it('does nothing at all, and says why', async () => {
    account = null
    const report = await runCycle(deps, new Date('2026-08-03T00:00:01Z'))

    // A worker started before `initialize_pool` waits for it. It does not
    // guess a genesis, and it does not need a restart when the pool appears.
    expect(report.skipped).toBe('no-pool')
    expect(chain.sent).toEqual([])
    expect(store.saved).toEqual([])
  })

  it('refuses a clock a day cannot be counted on', async () => {
    account = pool({ secondsPerDay: 0 })
    const report = await runCycle(deps, new Date('2026-08-03T00:00:01Z'))

    expect(report.skipped).toBe('unusable-clock')
    expect(chain.sent).toEqual([])
  })
})

describe('the order of a cycle', () => {
  it('closes days, then settles, then closes windows', async () => {
    store.window = twoDryDays()
    // One policy the run has triggered, one it has not.
    open = [policy(1, key(20), 1), policy(5, key(21), 2)]

    const report = await runCycle(deps, new Date('2026-08-03T00:00:01Z'))

    // Days 0 and 1 are over; day 2 is not. Then the payout, then the release
    // of capacity — `SC-001` is the only deadline in the cycle, so it goes
    // first, and a window that finished on the day it triggered is owed money
    // rather than a closure.
    expect(chain.names).toEqual([
      'submitDayRecord',
      'submitDayRecord',
      'settlePolicy',
      'closePolicy',
    ])
    expect(summarise(report)).toEqual({ submitted: 2, settled: 1, closed: 1, failed: 0 })
  })

  it('settles against the mint the pool publishes, not one it was told', async () => {
    store.window = twoDryDays()
    open = [policy(1, key(20), 1)]

    await runCycle(deps, new Date('2026-08-03T00:00:01Z'))

    const settle = chain.sent.filter((one) => decodeInstruction(one.data)?.name === 'settlePolicy')
    const [instruction] = settle
    expect(instruction).toBeDefined()
    // `assetMint` is a field of the pool (`FR-031`, `FR-055`); a worker holding
    // its own copy would be one deployment away from paying in the wrong token.
    expect(instruction?.keys.some((meta) => meta.pubkey.equals(MINT))).toBe(true)
  })

  it('a cell with no policies still gets its day', async () => {
    const report = await runCycle(deps, new Date('2026-08-03T00:00:01Z'))

    // Silence has to be written down to count as silence: an unwritten day
    // reads as no coverage on chain and makes a window unclosable.
    expect(chain.names).toEqual(['submitDayRecord', 'submitDayRecord'])
    expect(store.saved.map((row) => row.state)).toEqual([DayState.NoCoverage, DayState.NoCoverage])
    expect(report.settled).toEqual([])
    expect(report.closed).toEqual([])
  })
})

describe('the clock is the pool’s', () => {
  it('a compressed pool needs no worker configuration', async () => {
    // `seconds_per_day = 2` is what a scenario run is (`FR-049`). Nothing here
    // is told about it: three seconds after genesis, day 0 is over.
    account = pool({ secondsPerDay: 2 })
    await runCycle(deps, new Date(GENESIS.getTime() + 3_000))

    expect(store.submittedDays).toEqual([0])
  })

  it('reads genesis, the dry threshold and the vote count off the account', () => {
    const clock = clockOf(pool({ secondsPerDay: 2 }), 24)
    expect(clock.genesisTs).toEqual(GENESIS)
    expect(clock.secondsPerDay).toBe(2)
    expect(clock.intervalsPerDay).toBe(24)

    const params = paramsOf(pool(), 75)
    expect(params).toEqual({
      kind: 'precipitation_mm',
      minimumVotes: 3,
      dryThresholdX100: 100,
      minimumCoverageX100: 75,
    })
  })
})

describe('the key that signs a day record', () => {
  it('says so when it is not the aggregator the pool names', async () => {
    account = pool({ aggregator: key(42) })
    const report = await runCycle(deps, new Date('2026-08-03T00:00:01Z'))

    // Every `submit_day_record` will be rejected, and a network that records
    // nothing looks exactly like a network with nothing to record. Cheaper to
    // read here than out of a stream of failed transactions.
    expect(report.aggregatorMatches).toBe(false)
  })

  it('matches when it is', async () => {
    const report = await runCycle(deps, new Date('2026-08-03T00:00:01Z'))
    expect(report.aggregatorMatches).toBe(true)
  })
})

describe('summarise', () => {
  it('counts refusals from all three steps as failures', () => {
    const failed = {
      skipped: null,
      aggregatorMatches: true,
      days: [
        { cellId: CELL_ID, dayIndex: 0, status: 'failed' as const, error: new Error('rpc') },
        { cellId: CELL_ID, dayIndex: 1, status: 'submitted' as const, txSignature: 'tx' },
      ],
      settled: [
        { policy: 'a', status: 'failed' as const, spell: 3, error: new Error('blockhash') },
      ],
      closed: [{ policy: 'b', status: 'running' as const, spell: 1 }],
    }

    expect(summarise(failed)).toEqual({ submitted: 1, settled: 0, closed: 0, failed: 2 })
  })
})
