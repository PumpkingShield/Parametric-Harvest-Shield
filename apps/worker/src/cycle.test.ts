import {
  BN,
  decodeInstruction,
  type PolicyAccount,
  type PoolAccount,
  PublicKey,
  type TransactionInstruction,
} from '@pumpking/anchor-client'
import type {
  AcceptedReading,
  ChainSensor,
  DayRow,
  IntervalRow,
  OpenDay,
  PendingReferenceDay,
  RecordedDay,
  ReferenceStore,
  RegistryMirrorStore,
  RegistryRow,
  RetentionCutoffs,
  RetentionStore,
  SweepResult,
} from '@pumpking/db'
import { DayState, encodeBase58, type ReferenceHour } from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PoolSource } from './chain.ts'
import { type CycleDeps, clockOf, paramsOf, runCycle, summarise } from './cycle.ts'
import { type ReferenceSource, referenceChecker } from './reference.ts'
import { type RegistrySource, registryMirror } from './registry.ts'
import { retentionSweeper } from './retention.ts'
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
    unstakeDelayDays: 30,
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
  window: RecordedDay[] = []
  /** What the sensors sent; none, unless a test gives some. */
  readings: AcceptedReading[] = []
  saved: DayRow[] = []
  submittedDays: number[] = []

  /** No day is closed yet, so every day in range is open. */
  openDays(fromDay: number, toDay: number): Promise<OpenDay[]> {
    const open: OpenDay[] = []
    for (const cellId of this.cells) {
      for (let dayIndex = fromDay; dayIndex <= toDay; dayIndex += 1) open.push({ cellId, dayIndex })
    }
    return Promise.resolve(open)
  }
  /** The minimum stake each median was taken under, in order. */
  minStakes: bigint[] = []
  acceptedReadings(
    _cellId: bigint,
    _kind: string,
    from: Date,
    to: Date,
    minStake: bigint,
  ): Promise<AcceptedReading[]> {
    this.minStakes.push(minStake)
    return Promise.resolve(
      this.readings.filter((one) => one.measuredAt >= from && one.measuredAt < to),
    )
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
  replaceDayVerdicts(): Promise<void> {
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
    expect(summarise(report)).toEqual({
      submitted: 2,
      settled: 1,
      closed: 1,
      excluded: 0,
      failed: 0,
    })
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

describe('the reward history — T040', () => {
  it('is read after the money, told a day was just submitted, back to the backlog’s first day', async () => {
    const asked: { submitted: boolean; fromDay: number; sent: number }[] = []
    deps.rewards = {
      readIfDue: async (_now, submitted, fromDay) => {
        asked.push({ submitted, fromDay, sent: chain.sent.length })
        return []
      },
    }
    store.window = twoDryDays()
    open = [policy(1, key(20), 1)]

    const report = await runCycle(deps, new Date('2026-08-03T00:00:01Z'))

    // Two days and a settlement went out before it was asked.
    expect(asked).toEqual([{ submitted: true, fromDay: 0, sent: 3 }])
    expect(report.rewards).toEqual([])
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

/** Remembers what it was asked to sweep, and when relative to the chain. */
class Sweeps implements RetentionStore {
  asked: RetentionCutoffs[] = []
  /** How many instructions had reached the chain when each sweep ran. */
  sentBefore: number[] = []
  fail = false
  sweep(cutoffs: RetentionCutoffs): Promise<SweepResult> {
    this.asked.push(cutoffs)
    this.sentBefore.push(chain.sent.length)
    if (this.fail) return Promise.reject(new Error('statement timeout'))
    return Promise.resolve({ readings: 7, cellHours: 0, verdicts: 2, referenceHours: 0 })
  }
}

describe('retention in a cycle', () => {
  it('sweeps last, after every day is on chain', async () => {
    const sweeps = new Sweeps()
    const report = await runCycle(
      { ...deps, retention: retentionSweeper(sweeps) },
      new Date('2026-08-03T00:00:01Z'),
    )

    expect(chain.names).toEqual(['submitDayRecord', 'submitDayRecord'])
    expect(sweeps.sentBefore).toEqual([2])
    expect(report.swept).toEqual({
      status: 'swept',
      readings: 7,
      cellHours: 0,
      verdicts: 2,
      referenceHours: 0,
    })
  })

  it('never sweeps readings a backlog day could still be closed from', async () => {
    // A real clock with `BACKLOG_DAYS = 30` — the deployment's setting. On
    // 15 September day 45 is running, so day 15 (16 August) can still be
    // closed; retention alone would cut at 16 August noon and take the
    // morning of a day that has not reached the chain yet.
    const sweeps = new Sweeps()
    await runCycle(
      { ...deps, backlogDays: 30, retention: retentionSweeper(sweeps) },
      new Date('2026-09-15T12:00:00Z'),
    )

    expect(sweeps.asked).toEqual([
      {
        readings: new Date('2026-08-16T00:00:00Z'),
        cellHours: new Date('2025-09-15T12:00:00Z'),
      },
    ])
  })

  it('on a compressed clock the backlog is seconds, and retention decides', async () => {
    account = pool({ secondsPerDay: 2 })
    const sweeps = new Sweeps()
    const now = new Date(GENESIS.getTime() + 40 * 86_400_000)
    await runCycle({ ...deps, backlogDays: 30, retention: retentionSweeper(sweeps) }, now)

    expect(sweeps.asked[0]?.readings).toEqual(new Date(GENESIS.getTime() + 10 * 86_400_000))
  })

  it('a failed sweep is reported and the cycle keeps its days', async () => {
    const sweeps = new Sweeps()
    sweeps.fail = true
    const report = await runCycle(
      { ...deps, retention: retentionSweeper(sweeps) },
      new Date('2026-08-03T00:00:01Z'),
    )

    expect(summarise(report).submitted).toBe(2)
    expect(report.swept?.status).toBe('failed')
  })

  it('a cycle without a sweeper reports none', async () => {
    const report = await runCycle(deps, new Date('2026-08-03T00:00:01Z'))
    expect(report.swept).toBeNull()
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
      excluded: [
        { sensor: 's', status: 'failed' as const, judged: 72, outliers: 30, error: new Error('x') },
        { sensor: 't', status: 'excluded' as const, judged: 72, outliers: 30, txSignature: 'tx' },
      ],
      swept: null,
      registry: null,
      rewards: null,
      reference: null,
    }

    expect(summarise(failed)).toEqual({
      submitted: 1,
      settled: 0,
      closed: 0,
      excluded: 1,
      failed: 3,
    })
  })
})

/** A registry that answers from a list, and can be told to fail. */
class Registry implements RegistrySource, RegistryMirrorStore {
  chain: ChainSensor[] = []
  rows: RegistryRow[] = []
  fail = false
  /** How many instructions had reached the chain when each read ran. */
  sentBefore: number[] = []
  sensors(): Promise<ChainSensor[]> {
    this.sentBefore.push(chain.sent.length)
    if (this.fail) return Promise.reject(new Error('429 Too Many Requests'))
    return Promise.resolve(this.chain)
  }
  sensorRows(): Promise<RegistryRow[]> {
    return Promise.resolve(this.rows)
  }
  mirrorSensors(rows: readonly ChainSensor[]): Promise<void> {
    this.rows = [...this.rows, ...rows.map((row) => ({ ...row, mirrored: true }))]
    return Promise.resolve()
  }
}

describe('the registry in a cycle — T076', () => {
  it('is read first, before any day is closed', async () => {
    const registry = new Registry()
    const report = await runCycle(
      { ...deps, registry: registryMirror(registry, registry) },
      new Date('2026-08-03T00:00:01Z'),
    )

    expect(registry.sentBefore).toEqual([0])
    expect(chain.names).toEqual(['submitDayRecord', 'submitDayRecord'])
    expect(report.registry).toEqual({ status: 'mirrored', onChain: 0, written: 0, missing: [] })
  })

  it('closes no day until the chain has been read once', async () => {
    const registry = new Registry()
    registry.fail = true
    const mirror = registryMirror(registry, registry, 300_000, 30_000)

    const first = await runCycle({ ...deps, registry: mirror }, new Date('2026-08-03T00:00:01Z'))
    // A day closed now would be a median over whatever the database last held
    // — on a fresh one, nobody — and the chain keeps it for good.
    expect(first.skipped).toBe('registry-unread')
    expect(first.registry?.status).toBe('failed')
    expect(chain.sent).toEqual([])
    expect(store.saved).toEqual([])

    registry.fail = false
    const second = await runCycle({ ...deps, registry: mirror }, new Date('2026-08-03T00:00:31Z'))
    expect(second.skipped).toBeNull()
    expect(chain.names).toEqual(['submitDayRecord', 'submitDayRecord'])
  })

  it('keeps closing days on the last registry when a later read fails', async () => {
    const registry = new Registry()
    const mirror = registryMirror(registry, registry, 300_000, 30_000)
    await runCycle({ ...deps, registry: mirror }, new Date('2026-08-02T00:00:01Z'))

    store.submittedDays = []
    registry.fail = true
    const report = await runCycle({ ...deps, registry: mirror }, new Date('2026-08-03T00:05:01Z'))
    expect(report.skipped).toBeNull()
    expect(report.registry?.status).toBe('failed')
    expect(store.submittedDays).toEqual([0, 1])
  })

  it('takes the median under the minimum stake the pool publishes — FR-050', async () => {
    account = pool({ minStake: new BN(1_000_000) })
    await runCycle(deps, new Date('2026-08-03T00:00:01Z'))

    // A worker holding its own copy of the minimum would disagree with the
    // program the first time the authority changed it.
    expect(store.minStakes).toEqual([1_000_000n, 1_000_000n])
  })
})

/**
 * `FR-043`, `FR-044`, `T043` — the reference beside the money.
 *
 * The checker has its own tests; what only exists here is where it sits. The
 * day on chain is the sensors' median whatever the reference says of it, a
 * payout is owed on the sensors' run whatever the reference says of its days,
 * and a reference that is down or does not answer leaves both where they were.
 */
describe('the reference in a cycle — FR-043, FR-044', () => {
  const HOUR_MS = 3_600_000
  // Days 0 and 1 are over and their forecast has settled; day 2 is not over.
  const NOW = new Date('2026-08-03T12:00:01Z')

  /** Three operators, every hour of days 0 and 1, and not a drop between them. */
  function dryReadings(): AcceptedReading[] {
    const readings: AcceptedReading[] = []
    let counter = 0n
    for (let hour = 0; hour < 48; hour += 1) {
      for (const seed of [1, 2, 3]) {
        counter += 1n
        readings.push({
          sensorPubkey: encodeBase58(new Uint8Array(32).fill(seed)),
          operator: `operator-${seed}`,
          slotInCell: seed - 1,
          valueX100: 0,
          measuredAt: new Date(GENESIS.getTime() + hour * HOUR_MS + 1_800_000),
          counter,
          signature: 'signature',
        })
      }
    }
    return readings
  }

  /** Two millimetres an hour at the cell's centre — every day wet, by a lot. */
  const downpour: ReferenceSource = {
    hours(_cellId, from, to) {
      const hours: ReferenceHour[] = []
      for (let at = from.getTime(); at < to.getTime(); at += HOUR_MS) {
        hours.push({ hourStart: new Date(at), valueX100: 200 })
      }
      return Promise.resolve(hours)
    },
  }

  /**
   * The days this cycle put on chain, as the database would hand them to the
   * reference — and a note in `events` of when it was asked.
   */
  function referenceStoreOver(days: Store, events: string[]): ReferenceStore {
    const judged = new Set<number>()
    return {
      pendingDays() {
        events.push('reference')
        const pending: PendingReferenceDay[] = days.saved
          .filter((row) => days.submittedDays.includes(row.dayIndex) && !judged.has(row.dayIndex))
          .map(({ cellId, dayIndex, state, rainfallX100 }) => ({
            cellId,
            dayIndex,
            state,
            rainfallX100,
          }))
        return Promise.resolve(pending)
      },
      saveReference(_hours, verdicts) {
        for (const one of verdicts) judged.add(one.dayIndex)
        return Promise.resolve()
      },
      giveUp: () => Promise.resolve(0),
    }
  }

  /** A cycle over two dry days and a policy they trigger, with `reference` or none. */
  async function cycleWith(
    reference?: (days: Store, events: string[]) => NonNullable<CycleDeps['reference']>,
  ) {
    const events: string[] = []
    const ownChain = new Chain()
    const days = new Store()
    days.readings = dryReadings()
    days.window = twoDryDays()
    const submit = ownChain.submit.bind(ownChain)
    ownChain.submit = (instruction) => {
      events.push(decodeInstruction(instruction.data)?.name ?? 'undecodable')
      return submit(instruction)
    }
    const report = await runCycle(
      {
        ...deps,
        store: days,
        submitter: ownChain,
        policies: { openPolicies: () => Promise.resolve([policy(1, key(20), 1)]) },
        ...(reference === undefined ? {} : { reference: reference(days, events) }),
      },
      NOW,
    )
    return { report, sent: ownChain.sent, saved: days.saved, events }
  }

  it('a reference that calls every day wet changes nothing the chain is sent', async () => {
    const without = await cycleWith()
    const disputed = await cycleWith((days, events) =>
      referenceChecker({ store: referenceStoreOver(days, events), source: downpour }),
    )

    // Every day was judged against the sensors, and lost the argument on paper only.
    expect(disputed.report.reference).toMatchObject({
      status: 'checked',
      cells: [{ cellId: CELL_ID, status: 'checked', disputed: 2, agrees: 0 }],
    })
    // The days the sensors measured, dry and on chain, as they are without it.
    expect(disputed.saved.map((row) => [row.state, row.rainfallX100])).toEqual([
      [DayState.Dry, 0],
      [DayState.Dry, 0],
    ])
    expect(disputed.saved).toEqual(without.saved)
    expect(disputed.sent).toEqual(without.sent)
    // And the reference was asked after the money, not before it.
    expect(disputed.events).toEqual([
      'submitDayRecord',
      'submitDayRecord',
      'settlePolicy',
      'reference',
    ])
  })

  it('a window of disputed days still pays on the sensors’ run, and closes the same', async () => {
    const sentFor = async (window: RecordedDay[]) => {
      chain = new Chain()
      store = new Store()
      store.window = window
      await runCycle(
        {
          ...deps,
          store,
          submitter: chain,
          policies: {
            openPolicies: () => Promise.resolve([policy(1, key(20), 1), policy(5, key(21), 2)]),
          },
        },
        new Date('2026-08-03T00:00:01Z'),
      )
      return chain.sent
    }
    const undisputed = await sentFor(twoDryDays())
    // What `dayRecords` hands settlement once the reference has spoken.
    const disputed = await sentFor(
      twoDryDays().map((row) => ({
        ...row,
        reference: { state: 'disputed' as const, rainfallX100: 4_800 },
      })),
    )

    expect(chain.names).toEqual([
      'submitDayRecord',
      'submitDayRecord',
      'settlePolicy',
      'closePolicy',
    ])
    expect(disputed).toEqual(undisputed)
  })

  it('a reference that does not answer keeps the cycle no longer than its budget, and the money moves', async () => {
    const without = await cycleWith()
    const started = performance.now()
    const silent = await cycleWith((days, events) =>
      referenceChecker({
        store: referenceStoreOver(days, events),
        source: { hours: () => new Promise(() => {}) },
        budgetMs: 40,
      }),
    )
    const took = performance.now() - started

    expect(took).toBeLessThan(1_000)
    expect(silent.report.reference).toMatchObject({
      status: 'checked',
      cells: [{ cellId: CELL_ID, status: 'failed' }],
    })
    expect(silent.sent).toEqual(without.sent)
    expect(summarise(silent.report)).toEqual({
      submitted: 2,
      settled: 1,
      closed: 0,
      excluded: 0,
      failed: 0,
    })
  })

  it('a reference whose database is down fails its attempt, and the money moves', async () => {
    const without = await cycleWith()
    const down = await cycleWith(() =>
      referenceChecker({
        store: {
          pendingDays: () => Promise.reject(new Error('db down')),
          saveReference: () => Promise.reject(new Error('db down')),
          giveUp: () => Promise.reject(new Error('db down')),
        },
        source: downpour,
      }),
    )

    expect(down.report.reference).toMatchObject({ status: 'failed' })
    expect(down.sent).toEqual(without.sent)
    expect(summarise(down.report).failed).toBe(0)
  })
})
