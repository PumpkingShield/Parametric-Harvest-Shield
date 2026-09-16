import {
  associatedTokenAddress,
  BN,
  decodeInstruction,
  type PolicyAccount,
  PublicKey,
  TOKEN_PROGRAM_ID,
  type TransactionInstruction,
} from '@pumpking/anchor-client'
import type { DayRow } from '@pumpking/db'
import { DayState } from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DayOutcome } from './interval.ts'
import { type OpenPolicy, type SettleDeps, settleAfterDays, settleTriggered } from './settle.ts'

const CELL_ID = 613_196_570_331_971_583n
const OTHER_CELL = 613_196_570_331_971_584n

const key = (fill: number): PublicKey => new PublicKey(new Uint8Array(32).fill(fill))
const OWNER = key(3)
const WORKER = key(4)
const ASSET_MINT = key(2)

function day(dayIndex: number, state: DayRow['state']): DayRow {
  return {
    cellId: CELL_ID,
    dayIndex,
    state,
    rainfallX100: state === DayState.NoCoverage ? null : 0,
    coveredHours: state === DayState.NoCoverage ? 0 : 24,
    merkleRoot: null,
    txSignature: 'tx',
  }
}

function policy(overrides: Partial<Record<string, unknown>> = {}, address = key(5)): OpenPolicy {
  return {
    address,
    account: {
      owner: OWNER,
      nonce: new BN(1),
      cellId: new BN(CELL_ID.toString()),
      spellDaysThreshold: 3,
      payout: new BN(1_000_000),
      premium: new BN(21_000),
      windowStartDay: 0,
      windowEndDay: 9,
      state: { active: {} },
      bump: 254,
      ...overrides,
    } as PolicyAccount,
  }
}

class Chain {
  sent: TransactionInstruction[] = []
  failOn: number | null = null

  submit(instruction: TransactionInstruction): Promise<string> {
    this.sent.push(instruction)
    if (this.failOn === this.sent.length) return Promise.reject(new Error('blockhash not found'))
    return Promise.resolve(`tx-${this.sent.length}`)
  }
}

let chain: Chain
let rows: DayRow[]
let open: OpenPolicy[]
let deps: SettleDeps

beforeEach(() => {
  chain = new Chain()
  rows = []
  open = []
  deps = {
    store: { dayRecords: () => Promise.resolve(rows) },
    policies: { openPolicies: () => Promise.resolve(open) },
    submitter: chain,
    caller: WORKER,
    assetMint: ASSET_MINT,
  }
})

/* -------------------------------------------------------------------------- */

describe('settleTriggered', () => {
  it('does not call while the run is short of the threshold', async () => {
    open = [policy()]
    rows = [day(0, DayState.Dry), day(1, DayState.Dry)]

    expect(await settleTriggered(deps, CELL_ID)).toEqual([
      { policy: key(5).toBase58(), status: 'waiting', spell: 2 },
    ])
    expect(chain.sent).toEqual([])
  })

  /**
   * The window does not have to be over. A run that has reached the threshold
   * cannot be un-reached by the days after it, and `SC-001` measures the delay
   * waiting for day nine would add.
   */
  it('calls the moment the run reaches the threshold, window still open', async () => {
    open = [policy()]
    rows = [day(0, DayState.Dry), day(1, DayState.Dry), day(2, DayState.Dry)]

    const outcomes = await settleTriggered(deps, CELL_ID)
    expect(outcomes).toEqual([
      { policy: key(5).toBase58(), status: 'settled', spell: 3, txSignature: 'tx-1' },
    ])
    expect(decodeInstruction(chain.sent[0]?.data ?? new Uint8Array())?.name).toBe('settlePolicy')
  })

  it('sends the payout to the owner and to no chosen address — FR-066', async () => {
    open = [policy()]
    rows = [day(0, DayState.Dry), day(1, DayState.Dry), day(2, DayState.Dry)]
    await settleTriggered(deps, CELL_ID)

    const instruction = chain.sent[0]
    if (instruction === undefined) throw new Error('nothing settled')
    const ata = associatedTokenAddress(OWNER, ASSET_MINT, TOKEN_PROGRAM_ID)
    expect(instruction.keys.some((meta) => meta.pubkey.equals(ata))).toBe(true)
    // FR-030: the caller pays for the transaction and is checked against
    // nothing, so it signs and the owner does not.
    const signers = instruction.keys.filter((meta) => meta.isSigner)
    expect(signers).toHaveLength(1)
    expect(signers[0]?.pubkey.equals(WORKER)).toBe(true)
    expect(instruction.keys.some((meta) => meta.pubkey.equals(OWNER) && meta.isSigner)).toBe(false)
  })

  it('reports a rejected settlement and keeps going', async () => {
    open = [policy({}, key(5)), policy({ nonce: new BN(2) }, key(6))]
    rows = [day(0, DayState.Dry), day(1, DayState.Dry), day(2, DayState.Dry)]
    chain.failOn = 1

    const outcomes = await settleTriggered(deps, CELL_ID)
    expect(outcomes.map((one) => one.status)).toEqual(['failed', 'settled'])
    expect(chain.sent).toHaveLength(2)
  })

  it('has nothing to do for a cell with no open policies', async () => {
    expect(await settleTriggered(deps, CELL_ID)).toEqual([])
    expect(chain.sent).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */

describe('settleAfterDays', () => {
  const outcome = (cellId: bigint, dayIndex: number, status: DayOutcome['status']): DayOutcome =>
    status === 'failed'
      ? { cellId, dayIndex, status, error: new Error('rpc down') }
      : { cellId, dayIndex, status, txSignature: 'tx' }

  beforeEach(() => {
    open = [policy()]
    rows = [day(0, DayState.Dry), day(1, DayState.Dry), day(2, DayState.Dry)]
  })

  /** A day record is the only thing that can start a run. */
  it('leaves alone the cells whose day did not reach the chain', async () => {
    const settled = await settleAfterDays(deps, [
      outcome(CELL_ID, 0, 'recorded'),
      outcome(OTHER_CELL, 0, 'failed'),
    ])
    expect(settled).toEqual([])
    expect(chain.sent).toEqual([])
  })

  it('visits a cell once however many days it wrote', async () => {
    const settled = await settleAfterDays(deps, [
      outcome(CELL_ID, 0, 'submitted'),
      outcome(CELL_ID, 1, 'submitted'),
      outcome(CELL_ID, 2, 'submitted'),
    ])
    expect(settled).toHaveLength(1)
    expect(chain.sent).toHaveLength(1)
  })
})
