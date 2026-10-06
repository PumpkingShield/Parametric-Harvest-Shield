import { PublicKey, TOKEN_PROGRAM_ID } from '@pumpking/anchor-client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  EarningsView,
  type EarningsViewProps,
  earnedDayLabel,
  stakeRows,
  stakeText,
} from './Earnings.tsx'
import type { ClaimRefusal, Earnings } from './earnings.ts'

/**
 * What the operator is told about their money — `T040`, `FR-056`. Every sum
 * carries the asset's name, because the asset is a test token.
 */

const CELL = '871e701b3ffffff'
const LEFT = '871e701b2ffffff'

function earnings(overrides: Partial<NonNullable<Earnings['sensor']>> = {}): Earnings {
  return {
    network: {
      assetMint: new PublicKey(new Uint8Array(32).fill(5)),
      tokenProgram: TOKEN_PROGRAM_ID,
      decimals: 6,
      minStake: 1_000_000n,
    },
    pool: { genesisTs: 1_790_000_000n, secondsPerDay: 86_400 },
    sensor: {
      operator: new PublicKey(new Uint8Array(32).fill(1)),
      active: true,
      stake: 1_000_000n,
      unstaking: 0n,
      unlockAtDay: null,
      ...overrides,
    },
    claimable: [
      { cellId: 1n, cell: CELL, amount: 41_666n },
      { cellId: 2n, cell: LEFT, amount: 0n },
    ],
  }
}

function view(overrides: Partial<EarningsViewProps> = {}): string {
  return renderToStaticMarkup(
    <EarningsView
      earnings={earnings()}
      refusals={new Map<string, ClaimRefusal>([[LEFT, 'nothing']])}
      earned={{
        total: '41666',
        days: [
          { cellId: CELL, dayIndex: 4, startsAt: '2026-10-05T00:00:00.000Z', amount: '41666' },
        ],
      }}
      claim={{ kind: 'idle' }}
      onClaim={() => undefined}
      {...overrides}
    />,
  )
}

describe('EarningsView', () => {
  it('names the asset next to every sum — FR-056', () => {
    const html = view()
    const sums = html.match(/\d+\.\d+(?= )/g) ?? []
    const named = html.match(/\d+\.\d+ mock USDC/g) ?? []
    expect(sums.length).toBeGreaterThan(0)
    expect(named.length).toBe(sums.length)
  })

  it('offers a claim per cell that holds something, and none for a cell that holds nothing', () => {
    const html = view()
    expect(html).toContain(`Claim 0.041666 mock USDC from ${CELL}`)
    expect(html).not.toContain(`from ${LEFT}</button>`)
    expect(html).toContain('left on the last move')
  })

  it('says why a claim cannot go, under its button, and does not let it be sent', () => {
    const html = view({
      refusals: new Map<string, ClaimRefusal>([
        [CELL, 'foreign'],
        [LEFT, 'nothing'],
      ]),
    })
    expect(html).toContain('Its owner claims')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Claim/)
  })

  it('shows the history by day, and says when there is none', () => {
    expect(view()).toContain('0.041666 mock USDC in all')
    expect(view({ earned: { total: '0', days: [] } })).toContain(
      'Nothing earned in the last 30 days',
    )
  })
})

describe('stake', () => {
  it('names the thaw and the day it ends — FR-053', () => {
    const rows = stakeRows(earnings({ unstaking: 250_000n, unlockAtDay: 40 }))
    expect(rows[1]?.[0]).toMatch(/^Leaving the stake, back on /)
    expect(rows[1]?.[1]).toBe('0.25 mock USDC')
  })

  it('says whether the stake gives a vote — FR-050', () => {
    expect(stakeText(earnings())).toContain('count toward the median')
    expect(stakeText(earnings({ stake: 999_999n }))).toContain('not counted until it is topped up')
    expect(stakeText(earnings({ active: false }))).toContain('excluded')
  })
})

describe('earnedDayLabel', () => {
  const day = { cellId: CELL, dayIndex: 22, startsAt: '2026-10-06T10:42:47.000Z', amount: '1' }

  it('is the date on a pool whose day is a calendar day', () => {
    expect(earnedDayLabel(day, 86_400)).not.toContain('day 22')
  })

  it('names the pool day and its start on a compressed pool, where dates repeat — FR-049', () => {
    const label = earnedDayLabel(day, 60)
    expect(label).toMatch(/^day 22, /)
    const next = { ...day, dayIndex: 23, startsAt: '2026-10-06T10:43:47.000Z' }
    expect(label).not.toBe(earnedDayLabel(next, 60))
  })

  it('falls back to the pool day before there is a clock', () => {
    expect(earnedDayLabel({ ...day, startsAt: null }, 60)).toBe('day 22')
  })
})
