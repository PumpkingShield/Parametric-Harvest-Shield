import { PublicKey } from '@pumpking/anchor-client'
import type { FaucetClaim, FaucetStore } from '@pumpking/db'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ErrorBody } from '../errors.ts'
import {
  callerAddress,
  createFaucetRoute,
  type FaucetChain,
  type FaucetGrantWire,
  FaucetRefusal,
} from './faucet.ts'

/** A valid wallet: 32 bytes of `fill`. */
function wallet(fill: number): string {
  return new PublicKey(new Uint8Array(32).fill(fill)).toBase58()
}

const WALLET = wallet(7)
const NOW = new Date('2026-10-05T12:00:00Z')

type Row = { pubkey: string; addressHash: string; grantedAt: Date; signature: string | null }

/** The ledger in memory, with the semantics `pgFaucetStore` has in SQL. */
function memoryStore(): FaucetStore & { rows: Row[] } {
  const rows: Row[] = []
  return {
    rows,
    countsSince(since, addressHash) {
      const recent = rows.filter((row) => row.grantedAt >= since)
      return Promise.resolve({
        total: recent.length,
        fromAddress: recent.filter((row) => row.addressHash === addressHash).length,
      })
    },
    claim(pubkey, addressHash, at, staleBefore): Promise<FaucetClaim> {
      const index = rows.findIndex(
        (row) => row.pubkey === pubkey && row.signature === null && row.grantedAt < staleBefore,
      )
      if (index >= 0) rows.splice(index, 1)
      const held = rows.find((row) => row.pubkey === pubkey)
      if (held !== undefined) return Promise.resolve({ claimed: false, signature: held.signature })
      rows.push({ pubkey, addressHash, grantedAt: at, signature: null })
      return Promise.resolve({ claimed: true })
    },
    settle(pubkey, signature) {
      const row = rows.find((one) => one.pubkey === pubkey)
      if (row !== undefined) row.signature = signature
      return Promise.resolve()
    },
    release(pubkey) {
      const index = rows.findIndex((row) => row.pubkey === pubkey && row.signature === null)
      if (index >= 0) rows.splice(index, 1)
      return Promise.resolve()
    },
  }
}

let store: ReturnType<typeof memoryStore>
let granted: string[]
let failWith: Error | null

const chain: FaucetChain = {
  grant(wallet: PublicKey) {
    if (failWith !== null) return Promise.reject(failWith)
    granted.push(wallet.toBase58())
    return Promise.resolve({
      signature: `sig-${granted.length}`,
      lamports: '30000000',
      tokens: '1000000',
      tokenAccount: 'ata',
    })
  },
}

beforeEach(() => {
  store = memoryStore()
  granted = []
  failWith = null
})

function route(overrides: Partial<Parameters<typeof createFaucetRoute>[0]> = {}) {
  return createFaucetRoute({
    chain,
    store,
    perAddress: 2,
    daily: 10,
    proxyHops: 1,
    now: () => NOW,
    ...overrides,
  })
}

async function ask(
  app: ReturnType<typeof route>,
  wallet = WALLET,
  forwardedFor = '203.0.113.9, 216.24.57.1',
): Promise<Response> {
  return await app.request(`/${wallet}`, {
    method: 'POST',
    headers: { 'x-forwarded-for': forwardedFor },
  })
}

describe('POST /v1/faucet/:pubkey', () => {
  it('grants SOL and the minimum stake once, marked as mock', async () => {
    const response = await ask(route())
    expect(response.status).toBe(201)
    const body = (await response.json()) as FaucetGrantWire
    expect(body).toEqual({
      mock: true,
      signature: 'sig-1',
      lamports: '30000000',
      tokens: '1000000',
      tokenAccount: 'ata',
    })
    expect(granted).toEqual([WALLET])
    expect(store.rows[0]?.signature).toBe('sig-1')
  })

  it('refuses a second grant to the same wallet and names the first', async () => {
    const app = route()
    await ask(app)
    const response = await ask(app, WALLET, '198.51.100.4, 216.24.57.1')
    expect(response.status).toBe(409)
    const body = (await response.json()) as ErrorBody
    expect(body.error.details).toEqual({ signature: 'sig-1' })
    expect(granted).toHaveLength(1)
  })

  it('pays one of two requests racing for the same wallet', async () => {
    const app = route()
    const [a, b] = await Promise.all([ask(app), ask(app)])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(granted).toHaveLength(1)
  })

  it('limits one caller, counted from the right of the forwarded chain', async () => {
    const app = route()
    // The client writes whatever it likes on the left; the edge's entries are
    // on the right, and the caller is the one before the platform's proxy.
    expect((await ask(app, wallet(1), 'spoof-1, 203.0.113.9, 216.24.57.1')).status).toBe(201)
    expect((await ask(app, wallet(2), '1.1.1.1, 203.0.113.9, 216.24.57.2')).status).toBe(201)
    const third = await ask(app, wallet(3), '8.8.8.8, 203.0.113.9, 216.24.57.1')
    expect(third.status).toBe(429)
    expect(granted).toHaveLength(2)
  })

  it('stops everyone once the daily allowance is gone', async () => {
    const app = route({ daily: 1 })
    expect((await ask(app, wallet(1))).status).toBe(201)
    const response = await ask(app, wallet(2), '198.51.100.4, 216.24.57.1')
    expect(response.status).toBe(429)
    expect(((await response.json()) as ErrorBody).error.message).toMatch(/daily allowance/)
  })

  it('counts only the last 24 hours', async () => {
    store.rows.push({
      pubkey: wallet(1),
      addressHash: 'x',
      grantedAt: new Date(NOW.getTime() - 86_400_001),
      signature: 's',
    })
    expect((await ask(route({ daily: 1 }))).status).toBe(201)
  })

  it('gives the wallet back its turn when the transaction fails', async () => {
    const app = route()
    failWith = new Error('blockhash not found')
    let errors = 0
    const failing = route({ onError: () => errors++ })
    const response = await ask(failing)
    expect(response.status).toBe(503)
    expect(errors).toBe(1)
    expect(store.rows).toEqual([])

    failWith = null
    expect((await ask(app)).status).toBe(201)
  })

  it('says why when the chain cannot be granted from at all', async () => {
    failWith = new FaucetRefusal('there is no pool on this network yet')
    const response = await ask(route())
    expect(response.status).toBe(409)
    expect(((await response.json()) as ErrorBody).error.message).toBe(
      'there is no pool on this network yet',
    )
    expect(store.rows).toEqual([])
  })

  it('takes over a grant whose process died before recording it', async () => {
    store.rows.push({
      pubkey: WALLET,
      addressHash: 'x',
      grantedAt: new Date(NOW.getTime() - 121_000),
      signature: null,
    })
    expect((await ask(route())).status).toBe(201)
  })

  it('leaves a grant still in flight alone', async () => {
    store.rows.push({
      pubkey: WALLET,
      addressHash: 'x',
      grantedAt: new Date(NOW.getTime() - 5_000),
      signature: null,
    })
    const response = await ask(route())
    expect(response.status).toBe(409)
    expect(((await response.json()) as ErrorBody).error.details).toEqual({ signature: null })
  })

  it('refuses a wallet that is not 32 bytes of base58', async () => {
    const response = await ask(route(), 'not-a-wallet')
    expect(response.status).toBe(400)
    expect(granted).toEqual([])
  })

  it('is not there without a faucet key', async () => {
    const response = await ask(route({ chain: null }))
    expect(response.status).toBe(404)
  })
})

describe('callerAddress', () => {
  it('steps over a private tail and then the platform hop', () => {
    expect(callerAddress('9.9.9.9, 203.0.113.9, 216.24.57.1, 10.0.0.3', '10.0.0.9', 1)).toBe(
      '203.0.113.9',
    )
  })

  it('trusts no header with no proxies in front', () => {
    expect(callerAddress('203.0.113.9', '127.0.0.1', 0)).toBe('127.0.0.1')
  })

  it('falls back to the socket when the chain is shorter than the hops', () => {
    expect(callerAddress('216.24.57.1', '10.0.0.9', 1)).toBe('10.0.0.9')
  })
})
