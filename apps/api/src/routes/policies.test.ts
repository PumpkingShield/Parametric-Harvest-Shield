import { BN, type PolicyAccount, PublicKey } from '@pumpking/anchor-client'
import type { DayRow } from '@pumpking/db'
import { cellIdFromH3Index, DayState } from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPoliciesRoute, type PolicyLookup } from './policies.ts'

const H3 = '871e701b3ffffff'
const CELL_ID = cellIdFromH3Index(H3)

const key = (fill: number): PublicKey => new PublicKey(new Uint8Array(32).fill(fill))
const OWNER = key(3)
const ADDRESS = key(5).toBase58()
const NOT_A_POLICY = key(6).toBase58()

function policy(overrides: Partial<Record<string, unknown>> = {}): PolicyAccount {
  return {
    owner: OWNER,
    nonce: new BN(1),
    cellId: new BN(CELL_ID.toString()),
    spellDaysThreshold: 3,
    payout: new BN(1_000_000),
    premium: new BN(21_000),
    windowStartDay: 100,
    windowEndDay: 109,
    state: { active: {} },
    bump: 254,
    ...overrides,
  } as PolicyAccount
}

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

class FakeLookup implements PolicyLookup {
  accounts = new Map<string, PolicyAccount>()

  policyAt(address: string): Promise<PolicyAccount | null> {
    return Promise.resolve(this.accounts.get(address) ?? null)
  }
}

class FakeStore {
  rows: DayRow[] = []
  asked: { cellId: bigint; from: number; to: number }[] = []

  dayRecords(cellId: bigint, fromDay: number, toDay: number): Promise<DayRow[]> {
    this.asked.push({ cellId, from: fromDay, to: toDay })
    return Promise.resolve(
      this.rows.filter((row) => row.dayIndex >= fromDay && row.dayIndex <= toDay),
    )
  }
}

let policies: FakeLookup
let store: FakeStore

beforeEach(() => {
  policies = new FakeLookup()
  store = new FakeStore()
  policies.accounts.set(ADDRESS, policy())
})

async function get(address: string): Promise<Response> {
  return await createPoliciesRoute({ policies, store }).request(`/${address}`)
}

describe('GET /v1/policies/:pubkey', () => {
  it('answers with the policy the chain holds', async () => {
    const response = await get(ADDRESS)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      policy: ADDRESS,
      owner: OWNER.toBase58(),
      nonce: '1',
      cellId: H3,
      spellDaysThreshold: 3,
      payout: '1000000',
      premium: '21000',
      windowStartDay: 100,
      windowEndDay: 109,
      windowDays: 10,
      state: 'active',
      spell: 0,
      recordedDays: 0,
    })
  })

  /**
   * `u64` does not survive a JSON number, and a payout rounded by the wire is
   * a number the screen and the chain disagree about.
   */
  it('carries the amounts as decimal strings', async () => {
    policies.accounts.set(ADDRESS, policy({ payout: new BN('18446744073709551615') }))

    const body = (await (await get(ADDRESS)).json()) as { payout: string }
    expect(body.payout).toBe('18446744073709551615')
  })

  it('reads the days of the policy window and nothing else', async () => {
    await get(ADDRESS)
    expect(store.asked).toEqual([{ cellId: CELL_ID, from: 100, to: 109 }])
  })

  it('counts the run the same way the worker does', async () => {
    store.rows = [
      day(100, DayState.Dry),
      day(101, DayState.Wet),
      day(102, DayState.Dry),
      day(103, DayState.Dry),
      day(104, DayState.Dry),
    ]

    const body = (await (await get(ADDRESS)).json()) as { spell: number; recordedDays: number }
    expect(body.spell).toBe(3)
    expect(body.recordedDays).toBe(5)
  })

  /**
   * A day the aggregator has no row for breaks the run — the same answer the
   * on-chain ring gives for a day it cannot speak for.
   */
  it('breaks the run on a day nothing was recorded for', async () => {
    store.rows = [day(100, DayState.Dry), day(102, DayState.Dry), day(103, DayState.Dry)]

    const body = (await (await get(ADDRESS)).json()) as { spell: number }
    expect(body.spell).toBe(2)
  })

  /**
   * Zero is two different things, and the pair tells them apart: no run, and
   * nothing known. A screen that showed the second as the first would tell a
   * farmer the rain fell.
   */
  it('says how much of the window it actually has', async () => {
    const body = (await (await get(ADDRESS)).json()) as { spell: number; recordedDays: number }
    expect(body).toEqual(expect.objectContaining({ spell: 0, recordedDays: 0 }))
  })

  it('names the state a settled policy is in', async () => {
    policies.accounts.set(ADDRESS, policy({ state: { settled: {} } }))

    const body = (await (await get(ADDRESS)).json()) as { state: string }
    expect(body.state).toBe('settled')
  })

  it('hands back the arguments the days route takes', async () => {
    const body = (await (await get(ADDRESS)).json()) as {
      cellId: string
      windowStartDay: number
      windowEndDay: number
    }
    expect(body.cellId).toMatch(/^8[0-9a-f]{14}$/)
    expect(body.windowEndDay - body.windowStartDay + 1).toBe(10)
  })
})

describe('GET /v1/policies/:pubkey — refusals', () => {
  it('refuses an address that is not base58', async () => {
    const response = await get('not-an-address')
    expect(response.status).toBe(400)
    const body = (await response.json()) as { fields: { field: string }[] }
    expect(body.fields[0]?.field).toBe('pubkey')
  })

  it('refuses an address of the wrong width', async () => {
    const response = await get('3Nx7')
    expect(response.status).toBe(400)
  })

  it('does not touch the chain for an address it already knows is wrong', async () => {
    await get('not-an-address')
    expect(store.asked).toEqual([])
  })

  /**
   * Nothing at the address, somebody else's account, or one of ours of another
   * type: `rpcPolicyLookup` folds all three into null, and all three are the
   * caller's wrong address rather than a broken server.
   */
  it('answers 404 when no policy lives at the address', async () => {
    const response = await get(NOT_A_POLICY)
    expect(response.status).toBe(404)
    expect(store.asked).toEqual([])
  })
})
