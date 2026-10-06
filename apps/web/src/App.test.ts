import { describe, expect, it } from 'vitest'
import { initialView } from './App.tsx'

/**
 * The landing links into the app by query (`T070`): `?policy=` for the farmer,
 * `?view=sensor` for the operator. A link that stops opening its screen fails
 * nowhere else — the app still loads, just on the wrong tab.
 */
describe('initialView', () => {
  it('opens the screen the link names', () => {
    expect(initialView('?view=sensor')).toBe('sensor')
    expect(initialView('?view=proof')).toBe('proof')
    expect(initialView('?policy=EdLC&view=sensor')).toBe('sensor')
  })

  it('falls back to the policy screen for no view or an unknown one', () => {
    expect(initialView('')).toBe('policy')
    expect(initialView('?policy=EdLC')).toBe('policy')
    expect(initialView('?view=admin')).toBe('policy')
    expect(initialView('?view=')).toBe('policy')
  })
})
