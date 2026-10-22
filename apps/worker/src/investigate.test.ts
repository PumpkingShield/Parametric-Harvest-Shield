import { decodeInstruction, PublicKey, type TransactionInstruction } from '@pumpking/anchor-client'
import type { DisputedDryDays } from '@pumpking/db'
import { INVESTIGATION_WINDOW_DAYS } from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import { type InvestigateDeps, investigateDisputes } from './investigate.ts'

/**
 * `FR-045`, `T044`: the worker's half of an investigation — which cells it
 * calls, with which days, and what it leaves alone. The program's half is in
 * `programs/pumpking/tests/m1_path.rs`.
 */

const key = (fill: number): PublicKey => new PublicKey(new Uint8Array(32).fill(fill))
const AGGREGATOR = key(1)
const CELL = 613_196_570_331_971_583n
const OTHER = 613_196_570_331_971_584n
const GENESIS = new Date('2026-08-01T00:00:00Z')
const DAY_MS = 86_400_000
/** Day 20 of the pool. */
const NOW = new Date(GENESIS.getTime() + 20 * DAY_MS + 1_000)

function world(cells: DisputedDryDays[], flagged: Record<string, boolean | null> = {}) {
  const sent: TransactionInstruction[] = []
  const asked: { fromDay: number[]; chain: bigint[] } = { fromDay: [], chain: [] }
  let failNext = false
  const deps: InvestigateDeps = {
    store: {
      disputedDryDays(fromDay) {
        asked.fromDay.push(fromDay)
        return Promise.resolve(cells)
      },
    },
    chain: {
      underInvestigation(cellId) {
        asked.chain.push(cellId)
        const known = flagged[cellId.toString()]
        return Promise.resolve(known === undefined ? false : known)
      },
    },
    submitter: {
      submit(instruction) {
        if (failNext) {
          failNext = false
          return Promise.reject(new Error('blockhash not found'))
        }
        sent.push(instruction)
        // The chain raises the flag the call asked for.
        flagged[decoded(instruction).cellId] = true
        return Promise.resolve(`tx-${sent.length}`)
      },
    },
    aggregator: AGGREGATOR,
    clock: { genesisTs: GENESIS, secondsPerDay: 86_400, intervalsPerDay: 24 },
  }
  return {
    deps,
    sent,
    asked,
    failOnce() {
      failNext = true
    },
  }
}

function decoded(instruction: TransactionInstruction) {
  const one = decodeInstruction(instruction.data)
  const params = one?.data.params as { cellId: unknown; disputedDays: number[] }
  return { name: one?.name, cellId: String(params.cellId), days: params.disputedDays }
}

describe('investigateDisputes', () => {
  it('puts a cell under investigation with the disputed days, signed by the aggregator', async () => {
    const { deps, sent } = world([{ cellId: CELL, days: [14, 3, 8] }])

    const outcomes = await investigateDisputes(deps, NOW)

    expect(outcomes).toEqual([
      { cellId: CELL, status: 'opened', days: [3, 8, 14], txSignature: 'tx-1' },
    ])
    expect(sent.map(decoded)).toEqual([
      { name: 'openInvestigation', cellId: CELL.toString(), days: [3, 8, 14] },
    ])
    expect(sent[0]?.keys.filter((meta) => meta.isSigner).map((meta) => meta.pubkey)).toEqual([
      AGGREGATOR,
    ])
  })

  it('leaves a cell below the published count alone, without asking the chain', async () => {
    const { deps, sent, asked } = world([{ cellId: CELL, days: [3, 8] }])

    expect(await investigateDisputes(deps, NOW)).toEqual([])
    expect(sent).toEqual([])
    expect(asked.chain).toEqual([])
  })

  it('reads one coverage window back from today', async () => {
    const { deps, asked } = world([])
    await investigateDisputes(deps, NOW)
    // Day 20 of the pool: the window reaches back past genesis.
    expect(asked.fromDay).toEqual([0])

    const later = new Date(GENESIS.getTime() + 200 * DAY_MS)
    await investigateDisputes(deps, later)
    expect(asked.fromDay[1]).toBe(200 - INVESTIGATION_WINDOW_DAYS)
  })

  it('sends nothing for a cell already under investigation — only the authority lowers it', async () => {
    const { deps, sent } = world([{ cellId: CELL, days: [3, 8, 14] }], {
      [CELL.toString()]: true,
    })

    expect(await investigateDisputes(deps, NOW)).toEqual([
      { cellId: CELL, status: 'already-open', days: [3, 8, 14] },
    ])
    expect(sent).toEqual([])
  })

  it('tries a failed call again on the next attempt, and one cell failing holds up no other', async () => {
    const { deps, sent, failOnce } = world([
      { cellId: CELL, days: [3, 8, 14] },
      { cellId: OTHER, days: [4, 9, 15] },
    ])
    failOnce()

    const first = await investigateDisputes(deps, NOW)
    expect(first.map((one) => [one.cellId, one.status])).toEqual([
      [CELL, 'failed'],
      [OTHER, 'opened'],
    ])

    const second = await investigateDisputes(deps, NOW)
    expect(second.map((one) => [one.cellId, one.status])).toEqual([
      [CELL, 'opened'],
      [OTHER, 'already-open'],
    ])
    expect(sent.map((one) => decoded(one).cellId)).toEqual([OTHER.toString(), CELL.toString()])
  })

  it('does nothing before genesis', async () => {
    const { deps, asked } = world([{ cellId: CELL, days: [3, 8, 14] }])
    expect(await investigateDisputes(deps, new Date(GENESIS.getTime() - 1))).toEqual([])
    expect(asked.fromDay).toEqual([])
  })
})
