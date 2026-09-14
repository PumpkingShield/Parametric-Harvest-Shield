import {
  BN,
  decodeInstruction,
  type PolicyAccount,
  PublicKey,
  type TransactionInstruction,
} from '@pumpking/anchor-client'
import type { DayRow } from '@pumpking/db'
import { DayState } from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { type CloseDeps, closeAfterDays, closeFinishedWindows, windowIsFinished } from './close.ts'
import type { DayOutcome } from './interval.ts'
import type { OpenPolicy } from './settle.ts'

const CELL_ID = 613_196_570_331_971_583n
const OTHER_CELL = 613_196_570_331_971_584n

const key = (fill: number): PublicKey => new PublicKey(new Uint8Array(32).fill(fill))
const OWNER = key(3)
const WORKER = key(4)

/** A day as the aggregator stores it once its transaction has landed. */
function day(dayIndex: number, state: DayRow['state'], txSignature: string | null = 'tx'): DayRow {
  return {
    cellId: CELL_ID,
    dayIndex,
    state,
    rainfallX100: state === DayState.NoCoverage ? null : 0,
    coveredHours: state === DayState.NoCoverage ? 0 : 24,
    merkleRoot: null,
    txSignature,
  }
}

/** The whole window, wet, on chain — a window that finished without an event. */
function quietWindow(): DayRow[] {
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => day(index, DayState.Wet))
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
let deps: CloseDeps

beforeEach(() => {
  chain = new Chain()
  rows = []
  open = []
  deps = {
    store: { dayRecords: () => Promise.resolve(rows) },
    policies: { openPolicies: () => Promise.resolve(open) },
    submitter: chain,
    caller: WORKER,
  }
})

/* -------------------------------------------------------------------------- */

describe('windowIsFinished', () => {
  it('is finished when every day of the window reached the chain', () => {
    expect(windowIsFinished(quietWindow(), 0, 9)).toBe(true)
  })

  /**
   * A day the store has no row for is a day the ring answers `None` to, and
   * `check_closure` refuses on exactly that. Guessing otherwise would spend a
   * fee per cycle on a closure the program is bound to reject.
   */
  it('is not finished while a day of the window is missing', () => {
    expect(windowIsFinished(quietWindow().slice(0, 9), 0, 9)).toBe(false)
  })

  /**
   * The row is written before the transaction is sent, so a row without a
   * signature is a day the chain has never heard of.
   */
  it('is not finished while a day of the window has no signature', () => {
    const days = quietWindow()
    days[4] = day(4, DayState.Wet, null)
    expect(windowIsFinished(days, 0, 9)).toBe(false)
  })

  /**
   * A recorded day without coverage is an answer — it breaks the run and
   * finishes the window. Only an unrecorded day leaves the window open.
   */
  it('counts a recorded day without coverage as an answer', () => {
    const days = quietWindow()
    days[4] = day(4, DayState.NoCoverage)
    expect(windowIsFinished(days, 0, 9)).toBe(true)
  })

  it('ignores days outside the window it was asked about', () => {
    expect(windowIsFinished(quietWindow(), 2, 5)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */

describe('closeFinishedWindows', () => {
  it('closes a window that ended without the event', async () => {
    open = [policy()]
    rows = quietWindow()

    const outcomes = await closeFinishedWindows(deps, CELL_ID)
    expect(outcomes).toEqual([
      { policy: key(5).toBase58(), status: 'closed', spell: 0, txSignature: 'tx-1' },
    ])
    expect(decodeInstruction(chain.sent[0]?.data ?? new Uint8Array())?.name).toBe('closePolicy')
  })

  /**
   * `FR-028` releases the reservation and nothing else. A closure that carried
   * a vault, a mint or a token program would be moving money, and the shape of
   * the instruction is where that shows.
   */
  it('touches no token account and signs with the caller alone', async () => {
    open = [policy()]
    rows = quietWindow()
    await closeFinishedWindows(deps, CELL_ID)

    const instruction = chain.sent[0]
    if (instruction === undefined) throw new Error('nothing closed')
    expect(instruction.keys).toHaveLength(4)
    const signers = instruction.keys.filter((meta) => meta.isSigner)
    expect(signers).toHaveLength(1)
    expect(signers[0]?.pubkey.equals(WORKER)).toBe(true)
    expect(instruction.keys.some((meta) => meta.pubkey.equals(OWNER))).toBe(false)
  })

  it('leaves a window that is still running alone', async () => {
    open = [policy()]
    rows = quietWindow().slice(0, 6)

    expect(await closeFinishedWindows(deps, CELL_ID)).toEqual([
      { policy: key(5).toBase58(), status: 'running', spell: 0 },
    ])
    expect(chain.sent).toEqual([])
  })

  /**
   * The one thing this module must never do. A policy whose run reached the
   * threshold is owed money, and closing it would be the payout-denying role
   * `FR-030` exists to make impossible — the program refuses too, but the
   * dispatcher does not even ask.
   */
  it('never closes a policy the index has triggered', async () => {
    open = [policy()]
    rows = quietWindow()
    rows[2] = day(2, DayState.Dry)
    rows[3] = day(3, DayState.Dry)
    rows[4] = day(4, DayState.Dry)

    expect(await closeFinishedWindows(deps, CELL_ID)).toEqual([
      { policy: key(5).toBase58(), status: 'event', spell: 3 },
    ])
    expect(chain.sent).toEqual([])
  })

  /** A run that fell one day short is not an event, and the policy closes. */
  it('closes a window whose longest run fell short of the threshold', async () => {
    open = [policy()]
    rows = quietWindow()
    rows[2] = day(2, DayState.Dry)
    rows[3] = day(3, DayState.Dry)

    const outcomes = await closeFinishedWindows(deps, CELL_ID)
    expect(outcomes.map((one) => one.status)).toEqual(['closed'])
    expect(outcomes[0]?.spell).toBe(2)
  })

  it('reports a rejected closure and keeps going', async () => {
    open = [policy({}, key(5)), policy({ nonce: new BN(2) }, key(6))]
    rows = quietWindow()
    chain.failOn = 1

    const outcomes = await closeFinishedWindows(deps, CELL_ID)
    expect(outcomes.map((one) => one.status)).toEqual(['failed', 'closed'])
    expect(chain.sent).toHaveLength(2)
  })

  it('has nothing to do for a cell with no open policies', async () => {
    expect(await closeFinishedWindows(deps, CELL_ID)).toEqual([])
    expect(chain.sent).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */

describe('closeAfterDays', () => {
  const outcome = (cellId: bigint, dayIndex: number, status: DayOutcome['status']): DayOutcome =>
    status === 'failed'
      ? { cellId, dayIndex, status, error: new Error('rpc down') }
      : { cellId, dayIndex, status, txSignature: 'tx' }

  beforeEach(() => {
    open = [policy()]
    rows = quietWindow()
  })

  /** A day record is the only thing that can finish a window. */
  it('leaves alone the cells whose day did not reach the chain', async () => {
    const closed = await closeAfterDays(deps, [
      outcome(CELL_ID, 9, 'recorded'),
      outcome(OTHER_CELL, 9, 'failed'),
    ])
    expect(closed).toEqual([])
    expect(chain.sent).toEqual([])
  })

  it('visits a cell once however many days it wrote', async () => {
    const closed = await closeAfterDays(deps, [
      outcome(CELL_ID, 8, 'submitted'),
      outcome(CELL_ID, 9, 'submitted'),
    ])
    expect(closed).toHaveLength(1)
    expect(chain.sent).toHaveLength(1)
  })
})
