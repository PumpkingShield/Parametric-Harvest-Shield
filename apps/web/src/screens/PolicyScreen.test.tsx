import { DayState } from '@pumpking/shared/day'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Day, Policy } from '../api/policy.ts'
import { basisRisk } from '../data/policy.ts'
import { PolicyView } from './PolicyScreen.tsx'

/**
 * What the owner is actually shown.
 *
 * The rest of `apps/web` is tested as pure modules, and that was enough while
 * every module fed a number to the screen. `FR-040` is the exception: it is a
 * requirement about the *page*, and a paragraph nothing renders is a paragraph
 * that can be deleted between two green runs. So the view is rendered — to a
 * string, with `react-dom/server`, which needs no DOM and adds no dependency —
 * and the disclosure is asserted where the farmer reads it.
 *
 * The expected words are taken from `basisRisk`, never copied: what the
 * disclosure says is held by `data/policy.test.ts`, and this file holds only
 * that the screen says it.
 */

const POLICY: Policy = {
  policy: 'BPFLoaderUpgradeab1e11111111111111111111111',
  owner: 'Vote111111111111111111111111111111111111111',
  nonce: '1',
  cellId: '871e701b3ffffff',
  spellDaysThreshold: 5,
  payout: '120000000',
  premium: '9000000',
  windowStartDay: 10,
  windowEndDay: 19,
  windowDays: 10,
  state: 'active',
  spell: 3,
  recordedDays: 4,
}

const ROWS: Day[] = [
  {
    dayIndex: 10,
    state: DayState.Wet,
    rainfallX100: 640,
    coveredHours: 24,
    merkleRoot: 'r',
    txSignature: 't',
  },
  {
    dayIndex: 11,
    state: DayState.Dry,
    rainfallX100: 0,
    coveredHours: 24,
    merkleRoot: 'r',
    txSignature: 't',
  },
  {
    dayIndex: 12,
    state: DayState.Dry,
    rainfallX100: 0,
    coveredHours: 24,
    merkleRoot: 'r',
    txSignature: 't',
  },
  {
    dayIndex: 13,
    state: DayState.Dry,
    rainfallX100: 0,
    coveredHours: 24,
    merkleRoot: 'r',
    txSignature: 't',
  },
]

function draw(policy: Policy): string {
  return renderToStaticMarkup(<PolicyView policy={policy} rows={ROWS} decimals={6} />)
}

/** The program's own four, so a test cannot invent a fifth. */
const STATES: Policy['state'][] = ['active', 'paidOut', 'closedNoEvent', 'unclaimed']

describe('PolicyView — the FR-040 disclosure', () => {
  it('tells the owner the payout is decided by the cell, not by the field', () => {
    expect(draw(POLICY)).toContain(basisRisk(POLICY, 6).trigger)
  })

  it('shows the divergence in both directions, on the page', () => {
    // The half of `FR-040` that is easy to lose. A screen may happily warn that
    // a dry cell pays a green field — that reads as generosity. The other
    // corner, a lost crop and no money, is the one an owner has to see before
    // it happens, and it is the one a tidy-up would drop first.
    const markup = draw(POLICY)
    const { cases } = basisRisk(POLICY, 6)
    const paying = cases.find((entry) => entry.paid && !entry.harmed)
    const silent = cases.find((entry) => !entry.paid && entry.harmed)

    expect(paying).toBeDefined()
    expect(silent).toBeDefined()
    for (const entry of [paying, silent]) {
      expect(markup).toContain(entry?.index)
      expect(markup).toContain(entry?.field)
      expect(markup).toContain(entry?.money)
    }
  })

  it('says what the owner carries the risk in exchange for', () => {
    expect(draw(POLICY)).toContain(basisRisk(POLICY, 6).trade)
  })

  it('keeps the disclosure whatever the policy has done', () => {
    // Including the state where it is most tempting to drop: a policy that has
    // already paid, whose owner is the one who might buy another.
    for (const state of STATES) {
      const markup = draw({ ...POLICY, state })
      expect(markup).toContain(basisRisk(POLICY, 6).trigger)
      expect(markup).toContain(basisRisk(POLICY, 6).cases[1].money)
    }
  })

  /**
   * The screen must not contradict the chain about the one fact that is money.
   *
   * This is the shape of a bug that reached a deployed page: `runCaption`
   * compared the state against `'settled'`, a name nothing produces, so
   * `paidOut` fell through to the branch for a policy that closed with
   * nothing. The API said `paidOut` in the same response the screen was
   * drawing from. Asserted on the markup, because the markup is what the
   * owner reads.
   */
  it('never tells a paid owner the policy closed without paying', () => {
    for (const state of ['paidOut', 'unclaimed'] as const) {
      const markup = draw({ ...POLICY, state })
      expect(markup).not.toContain('closed without paying')
    }
    expect(draw({ ...POLICY, state: 'paidOut' })).toContain('this policy paid out')
    expect(draw({ ...POLICY, state: 'closedNoEvent' })).toContain('closed without paying')
  })

  it('draws the strip and the terms it always drew', () => {
    // Not the subject of this task, but the assertions cost a line each and
    // they are what says the disclosure was added to the screen rather than
    // instead of it.
    const markup = draw(POLICY)
    expect(markup).toContain('120.00 mock USDC')
    expect(markup).toContain('days 10–19 (10 days)')
    expect(markup).toContain('Day 10 — 6.4 mm — 24 intervals')
    expect(markup).toContain('All numbers on this screen are synthetic.')
  })
})
