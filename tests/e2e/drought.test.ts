import {
  BN,
  decodeInstruction,
  type PolicyAccount,
  PublicKey,
  type TransactionInstruction,
} from '@pumpking/anchor-client'
import { createReadingsRoute } from '@pumpking/api/routes/readings'
import type {
  AcceptedReading,
  DayRow,
  IntervalRow,
  IntervalStore,
  ReadingRow,
  ReadingStore,
  SaveOutcome,
  SensorRegistration,
} from '@pumpking/db'
import {
  cellIdFromH3Index,
  type DayClassification,
  drySpell,
  type ReadingKindName,
  type SignedReading,
  toSignedReadingWire,
} from '@pumpking/shared'
import {
  type AggregatorDeps,
  closeCellDay,
  type DayOutcome,
  type DaySubmitter,
  dayStart,
} from '@pumpking/worker/interval'
import {
  readScenario,
  type Scenario,
  type ScenarioSensor,
  scenarioClock,
  scenarioDuration,
  scenarioParams,
  scenarioReadings,
  scenarioSensors,
  signScenarioReadings,
} from '@pumpking/worker/scenario'
import {
  type OpenPolicy,
  type PolicySource,
  type SettleDeps,
  type SettleOutcome,
  settleAfterDays,
} from '@pumpking/worker/settle'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The drought, end to end — `FR-042`, and the path `SC-001`, `SC-002` and
 * `SC-011` are measured on.
 *
 * Everything between a sensor's signature and the settlement instruction is
 * the real thing: the readings are signed with `signReading`, they go in
 * through `createReadingsRoute` and are verified there, the medians and the
 * day classification come out of the worker's own `closeCellDay`, and the
 * transactions are encoded by the IDL the program emitted and decoded back to
 * check they say what they were meant to say.
 *
 * **What this test does not do is execute the program.** Nothing in the
 * JavaScript world can, on this machine: `litesvm` publishes no Windows
 * binary, and `solana-test-validator` needs the WSL toolchain and a cluster.
 * So the boundary is drawn where it is honest to draw it — the test asserts
 * the exact instructions the chain would receive, and the rules the chain
 * applies to them are covered by `cargo test` in `programs/pumpking`. What is
 * still uncovered anywhere is the weaving of accounts: `init`, seeds,
 * `token::authority`. That needs `mollusk-svm` in Rust and is called out in
 * `docs/SCRATCHPAD.md` rather than papered over here.
 *
 * The scenario is `fixtures/scenarios/drought.json`, whose day sequence is the
 * case `fixtures/index-cases.json` already shares between the Rust program and
 * its TypeScript twin. So this is the golden case, played through signing,
 * intake, aggregation and settlement.
 */

const GENESIS = new Date('2026-09-01T00:00:00.000Z')

/** The pool's mock asset, and the keys the run is played with. */
const key = (fill: number): PublicKey => new PublicKey(new Uint8Array(32).fill(fill))
const AGGREGATOR = key(1)
const ASSET_MINT = key(2)
const POLICY_OWNER = key(3)
const WORKER = key(4)
const POLICY_ADDRESS = key(5)

/** `FR-046`: the run of dry days this policy was sold against. */
const SPELL_THRESHOLD = 14

/* -------------------------------------------------------------------------- */
/* The database, in memory                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One object behind both store interfaces, because in production one Postgres
 * is behind both: intake writes the rows aggregation reads, and a bug that
 * loses a reading between them is exactly what an end-to-end test is for.
 */
class Store implements ReadingStore, IntervalStore {
  registrations = new Map<string, SensorRegistration>()
  sensors = new Map<string, ScenarioSensor>()
  rows: ReadingRow[] = []
  byCounter = new Set<string>()
  intervals: IntervalRow[] = []
  days = new Map<number, DayRow>()

  constructor(readonly cellId: bigint) {}

  register(sensor: ScenarioSensor, kind: ReadingKindName): void {
    this.registrations.set(sensor.pubkey, {
      pubkey: sensor.pubkey,
      cellId: this.cellId,
      kind,
      active: true,
    })
    this.sensors.set(sensor.pubkey, sensor)
  }

  sensorFor(pubkey: string): Promise<SensorRegistration | null> {
    return Promise.resolve(this.registrations.get(pubkey) ?? null)
  }

  save(row: ReadingRow): Promise<SaveOutcome> {
    const used = `${row.sensorPubkey}/${row.counter}`
    if (this.byCounter.has(used)) {
      const existing = this.rows.find(
        (one) => one.sensorPubkey === row.sensorPubkey && one.counter === row.counter,
      )
      if (existing === undefined) throw new Error('unreachable')
      return Promise.resolve({
        stored: false,
        existingSignature: existing.signature,
        status: existing.status,
      })
    }
    this.byCounter.add(used)
    this.rows.push(row)
    return Promise.resolve({ stored: true, status: row.status })
  }

  cellIds(): Promise<bigint[]> {
    return Promise.resolve([this.cellId])
  }

  acceptedReadings(
    _cellId: bigint,
    _kind: ReadingKindName,
    from: Date,
    to: Date,
  ): Promise<AcceptedReading[]> {
    const accepted: AcceptedReading[] = []
    for (const row of this.rows) {
      if (row.status !== 'accepted') continue
      if (row.measuredAt.getTime() < from.getTime()) continue
      if (row.measuredAt.getTime() >= to.getTime()) continue
      const sensor = this.sensors.get(row.sensorPubkey)
      if (sensor === undefined) continue
      accepted.push({
        sensorPubkey: row.sensorPubkey,
        operator: sensor.operator,
        slotInCell: sensor.slotInCell,
        valueX100: row.valueX100,
        measuredAt: row.measuredAt,
        counter: row.counter,
        signature: row.signature,
      })
    }
    return Promise.resolve(accepted)
  }

  dayRecord(_cellId: bigint, dayIndex: number): Promise<DayRow | null> {
    return Promise.resolve(this.days.get(dayIndex) ?? null)
  }

  dayRecords(_cellId: bigint, fromDay: number, toDay: number): Promise<DayRow[]> {
    const rows: DayRow[] = []
    for (let day = fromDay; day <= toDay; day += 1) {
      const row = this.days.get(day)
      if (row !== undefined) rows.push(row)
    }
    return Promise.resolve(rows)
  }

  saveIntervals(rows: readonly IntervalRow[]): Promise<void> {
    this.intervals.push(...rows)
    return Promise.resolve()
  }

  saveDay(row: DayRow): Promise<void> {
    this.days.set(row.dayIndex, row)
    return Promise.resolve()
  }

  markDaySubmitted(_cellId: bigint, dayIndex: number, txSignature: string): Promise<void> {
    const row = this.days.get(dayIndex)
    if (row !== undefined) this.days.set(dayIndex, { ...row, txSignature })
    return Promise.resolve()
  }
}

/* -------------------------------------------------------------------------- */
/* The chain, as far as this test can honestly go                             */
/* -------------------------------------------------------------------------- */

/** Every instruction the run produced, in order, with its signature. */
class Ledger implements DaySubmitter {
  sent: TransactionInstruction[] = []

  submit(instruction: TransactionInstruction): Promise<string> {
    this.sent.push(instruction)
    return Promise.resolve(`tx-${this.sent.length}`)
  }
}

/**
 * The policies a cell holds.
 *
 * Settlement is removed from the list the way the program removes it: once
 * (`FR-027`). Not a convenience — it is the property being tested, and a
 * source that kept offering a settled policy would let a second payout pass
 * unnoticed here even though the chain would refuse it.
 */
class Policies implements PolicySource {
  settled = false

  constructor(readonly policy: OpenPolicy) {}

  openPolicies(cellId: bigint): Promise<OpenPolicy[]> {
    if (this.settled) return Promise.resolve([])
    if (BigInt(this.policy.account.cellId.toString()) !== cellId) return Promise.resolve([])
    return Promise.resolve([this.policy])
  }
}

function policyAccount(cellId: bigint): PolicyAccount {
  return {
    owner: POLICY_OWNER,
    nonce: new BN(1),
    cellId: new BN(cellId.toString()),
    spellDaysThreshold: SPELL_THRESHOLD,
    payout: new BN(1_000_000),
    premium: new BN(21_000),
    windowStartDay: 0,
    windowEndDay: 28,
    state: { active: {} },
    bump: 254,
  } as PolicyAccount
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

type Run = {
  scenario: Scenario
  store: Store
  ledger: Ledger
  policies: Policies
  dayOutcomes: DayOutcome[]
  settlements: { dayIndex: number; outcomes: SettleOutcome[] }[]
  rejected: { status: number; body: unknown }[]
}

async function playDrought(signed: readonly SignedReading[], scenario: Scenario): Promise<Run> {
  const cellId = cellIdFromH3Index(scenario.cell)
  const sensors = await scenarioSensors(scenario)
  const store = new Store(cellId)
  for (const sensor of sensors) store.register(sensor, scenario.kind)

  // The sensor publishes the moment it measures; intake decides whether that
  // is inside the window (`FR-004`), and on this clock everything is.
  let publishedAt = GENESIS
  const route = createReadingsRoute({ store, now: () => publishedAt })

  const rejected: Run['rejected'] = []
  for (const reading of signed) {
    publishedAt = reading.measuredAt
    const response = await route.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toSignedReadingWire(reading)),
    })
    if (response.status !== 201) {
      rejected.push({ status: response.status, body: await response.json() })
    }
  }

  const ledger = new Ledger()
  const policies = new Policies({ address: POLICY_ADDRESS, account: policyAccount(cellId) })

  const aggregator: AggregatorDeps = {
    store,
    submitter: ledger,
    aggregator: AGGREGATOR,
    clock: scenarioClock(scenario, GENESIS),
    params: scenarioParams(scenario),
  }
  const settlement: SettleDeps = {
    store,
    policies,
    submitter: ledger,
    caller: WORKER,
    assetMint: ASSET_MINT,
  }

  const dayOutcomes: DayOutcome[] = []
  const settlements: Run['settlements'] = []
  // The worker's own cadence: close the day that just ended, then settle what
  // it triggered. `SC-001` is the gap between those two lines.
  for (let dayIndex = 0; dayIndex < scenario.expected.days; dayIndex += 1) {
    const outcome = await closeCellDay(aggregator, cellId, dayIndex)
    dayOutcomes.push(outcome)
    const outcomes = await settleAfterDays(settlement, [outcome])
    if (outcomes.some((one) => one.status === 'settled')) policies.settled = true
    settlements.push({ dayIndex, outcomes })
  }

  return { scenario, store, ledger, policies, dayOutcomes, settlements, rejected }
}

let run: Run
let scenario: Scenario
let signed: SignedReading[]

beforeAll(async () => {
  scenario = readScenario('drought')
  const sensors = await scenarioSensors(scenario)
  signed = await signScenarioReadings(scenarioReadings(scenario, GENESIS, sensors), sensors)
  run = await playDrought(signed, scenario)
}, 120_000)

const states = (current: Run): DayClassification[] =>
  Array.from({ length: current.scenario.expected.days }, (_unused, day) => {
    const row = current.store.days.get(day)
    if (row === undefined) throw new Error(`day ${day} was never closed`)
    return row.state
  })

/* -------------------------------------------------------------------------- */

describe('intake', () => {
  it('accepts every reading the scenario signed', () => {
    expect(run.rejected).toEqual([])
    expect(run.store.rows).toHaveLength(signed.length)
    expect(run.store.rows.every((row) => row.status === 'accepted')).toBe(true)
  })

  it('publishes nothing at all through the two days of silence', () => {
    const clock = scenarioClock(scenario, GENESIS)
    for (const dayIndex of [4, 5]) {
      const from = dayStart(clock, dayIndex).getTime()
      const to = dayStart(clock, dayIndex + 1).getTime()
      const inside = run.store.rows.filter(
        (row) => row.measuredAt.getTime() >= from && row.measuredAt.getTime() < to,
      )
      expect(inside).toEqual([])
    }
  })
})

describe('aggregation', () => {
  it('classifies the days into the reference trace', () => {
    expect(states(run)).toEqual([2, 2, 2, 2, 0, 0, 2, 1, 1, 1, 2, ...Array<number>(18).fill(1)])
    expect(drySpell(states(run))).toBe(18)
  })

  it('writes one day record per day, and the chain gets what the row says', () => {
    const records = run.ledger.sent.filter(
      (instruction) => decodeInstruction(instruction.data)?.name === 'submitDayRecord',
    )
    expect(records).toHaveLength(scenario.expected.days)

    for (const [index, instruction] of records.entries()) {
      const decoded = decodeInstruction(instruction.data)
      if (decoded === null) throw new Error('a day record that decodes to nothing')
      const params = decoded.data.params as {
        dayIndex: number
        state: number
        rainfallX100: number | null
        coveredIntervals: number
        totalIntervals: number
      }
      const row = run.store.days.get(index)
      if (row === undefined) throw new Error(`day ${index} was never closed`)

      expect(params.dayIndex).toBe(index)
      expect(params.state).toBe(row.state)
      expect(params.rainfallX100).toBe(row.rainfallX100)
      expect(params.coveredIntervals).toBe(row.coveredHours)
      expect(params.totalIntervals).toBe(24)
    }
  })

  it('records every day under the aggregator key and nobody else', () => {
    for (const instruction of run.ledger.sent) {
      if (decodeInstruction(instruction.data)?.name !== 'submitDayRecord') continue
      const signers = instruction.keys.filter((meta) => meta.isSigner)
      expect(signers).toHaveLength(1)
      expect(signers[0]?.pubkey.equals(AGGREGATOR)).toBe(true)
    }
  })
})

describe('settlement', () => {
  /**
   * The run reaches fourteen days on day 24 — days 11 through 24 — and that is
   * the day the payout is owed. Not the day the window ends: a run that has
   * reached the threshold cannot be un-reached by the days after it, and
   * waiting for day 28 would be four days of delay `SC-001` has no budget for.
   */
  it('settles on the day the run reaches the threshold, not when the window ends', () => {
    const settled = run.settlements.filter((day) =>
      day.outcomes.some((outcome) => outcome.status === 'settled'),
    )
    expect(settled.map((day) => day.dayIndex)).toEqual([24])
    expect(settled[0]?.outcomes[0]).toMatchObject({ status: 'settled', spell: SPELL_THRESHOLD })
  })

  it('waits, without ever calling, while the run is still short', () => {
    for (const day of run.settlements.slice(0, 24)) {
      expect(day.outcomes.map((outcome) => outcome.status)).toEqual(['waiting'])
    }
  })

  /** `FR-027`: the index triggers a policy once, whatever the days after say. */
  it('pays once', () => {
    const settles = run.ledger.sent.filter(
      (instruction) => decodeInstruction(instruction.data)?.name === 'settlePolicy',
    )
    expect(settles).toHaveLength(1)
    for (const day of run.settlements.slice(25)) {
      expect(day.outcomes).toEqual([])
    }
  })

  /**
   * `SC-002`, as a property of the transactions rather than a promise: between
   * buying the policy and the money arriving, the owner signs nothing. Not
   * because the worker is diligent — because `FR-030` leaves the owner no
   * button to press and no button to withhold.
   */
  it('costs the owner nothing to do — SC-002', () => {
    for (const instruction of run.ledger.sent) {
      for (const meta of instruction.keys) {
        if (meta.pubkey.equals(POLICY_OWNER)) expect(meta.isSigner).toBe(false)
      }
    }
  })

  it('sends the payout to the owner and to no chosen address — FR-066', () => {
    const settle = run.ledger.sent.find(
      (instruction) => decodeInstruction(instruction.data)?.name === 'settlePolicy',
    )
    if (settle === undefined) throw new Error('nothing settled')
    const signers = settle.keys.filter((meta) => meta.isSigner)
    expect(signers).toHaveLength(1)
    // The worker pays for the transaction and has no other part in it.
    expect(signers[0]?.pubkey.equals(WORKER)).toBe(true)
    expect(settle.keys.some((meta) => meta.pubkey.equals(POLICY_ADDRESS))).toBe(false)
    expect(decodeInstruction(settle.data)?.data).toEqual({})
  })
})

describe('the run itself', () => {
  /** `SC-011`: 29 days at two seconds each. */
  it('plays inside the compressed budget', () => {
    expect(scenarioDuration(scenario)).toBe(58)
    expect(scenarioDuration(scenario)).toBeLessThan(90)
  })

  /** `FR-042`: the same scenario gives the same index and the same result. */
  it('is deterministic', async () => {
    const again = await playDrought(signed, scenario)

    expect(states(again)).toEqual(states(run))
    expect(again.settlements.map((day) => day.outcomes.map((one) => one.status))).toEqual(
      run.settlements.map((day) => day.outcomes.map((one) => one.status)),
    )
    expect(again.ledger.sent.map((instruction) => [...instruction.data])).toEqual(
      run.ledger.sent.map((instruction) => [...instruction.data]),
    )
  }, 120_000)
})
