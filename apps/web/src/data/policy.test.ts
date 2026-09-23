import { DayState } from '@pumpking/shared/day'
import { drySpell } from '@pumpking/shared/index-math'
import { describe, expect, it } from 'vitest'
import type { Day, Policy } from '../api/policy.ts'
import { basisRisk, formatAmount, policyFacts, policyWindow, runCaption } from './policy.ts'
import { longestDryRun } from './rainfall.ts'

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
  recordedDays: 8,
}

function day(dayIndex: number, state: number, rainfallX100: number | null): Day {
  return {
    dayIndex,
    state,
    rainfallX100,
    coveredHours: rainfallX100 === null ? 3 : 24,
    merkleRoot: 'root',
    txSignature: 'tx',
  }
}

/**
 * Days 10–17 recorded, 18 and 19 not. Wet, then three dry, then a day nobody
 * measured, then three dry again — a gap in the middle so the run cannot be
 * stitched through silence.
 */
const ROWS: Day[] = [
  day(10, DayState.Wet, 640),
  day(11, DayState.Dry, 0),
  day(12, DayState.Dry, 20),
  day(13, DayState.Dry, 0),
  day(14, DayState.NoCoverage, null),
  day(15, DayState.Dry, 0),
  day(16, DayState.Dry, 0),
  day(17, DayState.Dry, 0),
]

describe('policyWindow', () => {
  it('draws one square per day of the window, recorded or not', () => {
    const { cells } = policyWindow(POLICY, ROWS)
    expect(cells).toHaveLength(POLICY.windowDays)
  })

  it('leaves a day with no row as not recorded, never as dry', () => {
    const { cells } = policyWindow(POLICY, ROWS)

    // Days 18 and 19 have no row. Silence is not drought, and a screen that
    // painted them dry would show a run the chain would not pay on.
    expect(cells[8]?.state).toBe('future')
    expect(cells[9]?.state).toBe('future')
    expect(cells[8]?.detail).toContain('not recorded yet')
  })

  it('shows a recorded day without coverage as its own thing', () => {
    const { cells } = policyWindow(POLICY, ROWS)

    // A day the aggregator wrote as "nobody measured" is an answer; a day it
    // has not written is not. The two look different and read different.
    expect(cells[4]?.state).toBe('none')
    expect(cells[4]?.detail).toContain('no value')
    expect(cells[4]?.detail).toContain('3 intervals')
  })

  it('prints rainfall in millimetres from the hundredths on the wire', () => {
    const { cells } = policyWindow(POLICY, ROWS)
    expect(cells[0]?.detail).toBe('Day 10 — 6.4 mm — 24 intervals')
  })

  it('addresses a day by index, because the wire carries no date', () => {
    const { cells } = policyWindow(POLICY, ROWS)
    expect(cells[0]?.topLabel).toBe('10')
    expect(cells[1]?.topLabel).toBeUndefined()
  })

  it('counts a missing day as a break in the run, like the chain does', () => {
    const { days } = policyWindow(POLICY, ROWS)

    // Three at the start and three at the end, with the gap and the two
    // unrecorded days breaking both. Written out rather than derived, so a
    // fill that skipped missing days instead of breaking on them fails here.
    expect(days).toEqual([
      DayState.Wet,
      DayState.Dry,
      DayState.Dry,
      DayState.Dry,
      DayState.NoCoverage,
      DayState.Dry,
      DayState.Dry,
      DayState.Dry,
      DayState.NoCoverage,
      DayState.NoCoverage,
    ])
    expect(drySpell(days)).toBe(3)
  })

  it('places the bracket on the run the index counts', () => {
    const { days } = policyWindow(POLICY, ROWS)
    const bracket = longestDryRun(days)

    // The seam: the bracket is drawn positionally here, and its length is the
    // index, which only `drySpell` defines. A disagreement is a screen
    // promising a payout the program refuses.
    expect(bracket?.length).toBe(drySpell(days))
    expect(bracket?.length).toBe(POLICY.spell)
    expect(bracket?.start).toBe(1)
    expect(bracket?.end).toBe(3)
  })

  it('has no bracket on a window with no dry day at all', () => {
    const wet = [day(10, DayState.Wet, 640)]
    const { days } = policyWindow({ ...POLICY, spell: 0 }, wet)
    expect(longestDryRun(days)).toBeUndefined()
  })

  it('ignores a row outside the window', () => {
    // The route is asked for exactly the window, but a row from elsewhere must
    // not shift the strip by a square.
    const { cells } = policyWindow(POLICY, [...ROWS, day(99, DayState.Dry, 0)])
    expect(cells).toHaveLength(POLICY.windowDays)
  })
})

describe('formatAmount', () => {
  it('reads base units at the mint’s decimals', () => {
    expect(formatAmount('120000000', 6)).toBe('120.00')
    expect(formatAmount('9500000', 6)).toBe('9.50')
  })

  it('does not round a payout into a different number', () => {
    // The chain moves base units; the screen may shorten them for reading but
    // must never show more than was moved.
    expect(formatAmount('9999999', 6)).toBe('9.99')
  })

  it('handles a sum too large for a JS number', () => {
    expect(formatAmount('18446744073709551615', 6)).toBe('18446744073709.55')
  })

  it('handles a mint with no decimals at all', () => {
    expect(formatAmount('7', 0)).toBe('7.00')
  })

  it('handles a sum smaller than one unit', () => {
    expect(formatAmount('1', 6)).toBe('0.00')
    expect(formatAmount('0', 6)).toBe('0.00')
  })
})

describe('runCaption', () => {
  it('says how many days are left when the run is short', () => {
    expect(runCaption(POLICY)).toBe('dry days in a row — 2 more and you are paid')
  })

  it('says the threshold is met once it is', () => {
    expect(runCaption({ ...POLICY, spell: 5 })).toBe('dry days in a row — the threshold is met')
    expect(runCaption({ ...POLICY, spell: 6 })).toBe('dry days in a row — the threshold is met')
  })

  /**
   * The names are the program's — `active`, `paidOut`, `closedNoEvent`,
   * `unclaimed` — and that is the whole point of this test.
   *
   * It used to be written against `'settled'` and `'closed'`, which no layer
   * of this system produces. The comparison never matched, the test agreed
   * with the code because both spoke the same invented language, and a policy
   * the chain had paid read as one that closed without paying. Caught on
   * devnet, on the screen, with `paidOut` in the API's own answer.
   */
  it('says a paid policy was paid', () => {
    expect(runCaption({ ...POLICY, state: 'paidOut', spell: 5 })).toBe(
      'dry days in a row — this policy paid out',
    )
  })

  /**
   * `FR-029`: the drought happened and the transfer did not land, so the
   * payout is reserved and the owner can claim it. Saying "closed without
   * paying" here is the screen talking them out of money that is theirs.
   */
  it('tells an unclaimed owner the money is still theirs', () => {
    const caption = runCaption({ ...POLICY, state: 'unclaimed', spell: 5 })
    expect(caption).toBe('dry days in a row — the payout is yours and waiting to be claimed')
    expect(caption).not.toContain('without paying')
  })

  it('says a policy that ran out without the event closed without paying', () => {
    expect(runCaption({ ...POLICY, state: 'closedNoEvent', spell: 3 })).toBe(
      'dry days in a row — this policy closed without paying',
    )
  })

  /**
   * Every state the program has gets its own sentence, and no two share one.
   * A state added to `PolicyState` without a branch here is a `undefined`
   * caption on someone's screen — the compiler catches the missing branch,
   * and this catches a branch that was copied rather than written.
   */
  it('gives each of the four states its own words', () => {
    const states: Policy['state'][] = ['active', 'paidOut', 'closedNoEvent', 'unclaimed']
    const captions = states.map((state) => runCaption({ ...POLICY, state, spell: 5 }))
    expect(captions.every((one) => one.length > 0)).toBe(true)
    expect(new Set(captions).size).toBe(states.length)
  })
})

describe('policyFacts', () => {
  it('names every term FR-018 says a policy has', () => {
    expect(policyFacts(POLICY, 6)).toEqual([
      ['Pays out', '120.00 mock USDC'],
      ['When', '5 dry days in a row'],
      ['Cover period', 'days 10–19 (10 days)'],
      ['Premium paid', '9.00 mock USDC'],
      ['Days recorded', '8 of 10'],
    ])
  })

  it('marks the money as mock wherever a sum appears', () => {
    // `FR-056`: a demo where a mock balance looks like money is false
    // testimony whatever the accompanying material says.
    const sums = policyFacts(POLICY, 6).filter(
      ([label]) => label.includes('out') || label.includes('Premium'),
    )
    expect(sums.every(([, value]) => value.includes('mock'))).toBe(true)
  })
})

describe('basisRisk', () => {
  it('says the divergence goes both ways, as structure and not as prose', () => {
    // `FR-040` in one assertion. Two cases, and in each of them the index and
    // the field disagree — one pays a farmer who lost nothing, the other pays
    // nothing to a farmer who lost the crop. A disclosure that dropped either
    // corner would still read like a warning and would only be half true.
    const { cases } = basisRisk(POLICY, 6)

    expect(cases.map((entry) => entry.paid)).toEqual([true, false])
    expect(cases.map((entry) => entry.harmed)).toEqual([false, true])
    expect(cases.every((entry) => entry.paid !== entry.harmed)).toBe(true)
  })

  it('names what actually decides the money — the cell, not the field', () => {
    const { trigger } = basisRisk(POLICY, 6)
    expect(trigger).toContain(POLICY.cellId)
    expect(trigger).toContain('not on what happens in your field')
  })

  it('speaks in this policy’s own numbers, not about parametric cover in general', () => {
    // Small print about the product is what this requirement exists to refuse:
    // the owner is told the threshold that decides *their* payout and the sum
    // that arrives if it is crossed.
    const { cases } = basisRisk(POLICY, 6)

    expect(cases[0].index).toContain('5 dry days in a row')
    expect(cases[1].index).toContain('5 dry days in a row')
    expect(cases[0].money).toContain('120.00 mock USDC')
    expect(cases[1].money).toContain('nothing')
  })

  it('follows the payout when the terms do', () => {
    const bigger = basisRisk({ ...POLICY, spellDaysThreshold: 9, payout: '250000000' }, 6)
    expect(bigger.cases[0].index).toContain('9 dry days in a row')
    expect(bigger.cases[0].money).toContain('250.00 mock USDC')
  })

  it('does not soften once the policy is paid or closed', () => {
    // The disclosure is about how the product decides, and that does not change
    // with the state of one policy: a paid owner who was paid without a loss
    // is told the same thing as a closed one who lost a crop and was not.
    expect(basisRisk({ ...POLICY, state: 'paidOut' }, 6)).toEqual(basisRisk(POLICY, 6))
    expect(basisRisk({ ...POLICY, state: 'closedNoEvent' }, 6)).toEqual(basisRisk(POLICY, 6))
    expect(basisRisk({ ...POLICY, state: 'unclaimed' }, 6)).toEqual(basisRisk(POLICY, 6))
  })

  it('says what the owner gets for carrying it', () => {
    expect(basisRisk(POLICY, 6).trade).toContain('no claim form')
  })
})
