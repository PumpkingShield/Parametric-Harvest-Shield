import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DayState, classifyDay, drySpell } from './index-math.ts'

const fixtures = JSON.parse(
  readFileSync(new URL('../../../fixtures/index-cases.json', import.meta.url), 'utf8'),
) as { cases: { name: string; days: number[]; drySpell: number }[] }

describe('drySpell', () => {
  for (const testCase of fixtures.cases) {
    it(testCase.name, () => {
      expect(drySpell(testCase.days)).toBe(testCase.drySpell)
    })
  }
})

describe('classifyDay', () => {
  it('is dry strictly below the threshold', () => {
    expect(classifyDay(199, 200)).toBe(DayState.Dry)
  })

  it('is wet exactly at the threshold', () => {
    expect(classifyDay(200, 200)).toBe(DayState.Wet)
  })

  it('is no coverage when the cell had no value', () => {
    expect(classifyDay(null, 200)).toBe(DayState.NoCoverage)
  })
})
