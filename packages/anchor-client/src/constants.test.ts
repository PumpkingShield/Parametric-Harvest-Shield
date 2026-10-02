import type { Idl } from '@coral-xyz/anchor'
import { OUTLIER_WINDOW_DAYS } from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import { PUMPKING_IDL } from './idl/idl.ts'

/**
 * Constants the program and `@pumpking/shared` both state. The program's half
 * is read out of the IDL it emitted (`#[constant]`), not out of a copy, so a
 * value changed on one side only fails here instead of in somebody's thaw.
 */
function programConstant(name: string): string {
  const constant = (PUMPKING_IDL as Idl).constants?.find((one) => one.name === name)
  if (constant === undefined) {
    throw new Error(`the IDL has no constant named ${name}`)
  }
  return constant.value
}

describe('constants twinned with @pumpking/shared', () => {
  it('agrees with the program on the outlier observation window', () => {
    expect(programConstant('outlierWindowDays')).toBe(String(OUTLIER_WINDOW_DAYS))
  })
})
