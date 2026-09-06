import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { drySpell } from './index-math.ts'

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
