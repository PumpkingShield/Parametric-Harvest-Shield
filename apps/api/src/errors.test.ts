import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { errorBody, fieldErrors } from './errors.ts'

describe('errorBody', () => {
  it('derives the code from the status', () => {
    expect(
      ([400, 401, 404, 409, 429, 500] as const).map((status) => errorBody(status, 'x').error.code),
    ).toEqual(['INVALID_INPUT', 'UNAUTHORIZED', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'INTERNAL'])
  })

  it('always carries details, empty when there is nothing to add', () => {
    expect(errorBody(404, 'not found')).toEqual({
      error: { code: 'NOT_FOUND', message: 'not found', details: {} },
    })
  })
})

describe('fieldErrors', () => {
  it('names the field by its path, and the root when the issue is the whole', () => {
    const schema = z.object({ a: z.object({ b: z.int() }) })
    const nested = schema.safeParse({ a: { b: 'x' } })
    const whole = schema.safeParse('x')
    if (nested.success || whole.success) throw new Error('both must fail')

    expect(fieldErrors(nested.error, '(body)').map((one) => one.field)).toEqual(['a.b'])
    expect(fieldErrors(whole.error, '(body)').map((one) => one.field)).toEqual(['(body)'])
  })
})
