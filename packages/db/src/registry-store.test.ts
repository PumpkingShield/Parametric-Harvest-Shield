import { describe, expect, it } from 'vitest'
import { type RegistryRow, votingProblems } from './registry-store.ts'

/**
 * Whether a run's sensors vote — `FR-050`, `FR-012`, `T077`.
 *
 * The same conditions as `votingSensor`, asked before a run instead of inside
 * a median, plus the one only a run can state: the cell it expects them in.
 */

const CELL = 613_196_570_331_971_583n
const MIN = 1_000_000n

function row(pubkey: string, overrides: Partial<RegistryRow> = {}): RegistryRow {
  return {
    pubkey,
    operatorWallet: 'operator',
    cellId: CELL,
    slotInCell: 0,
    previousCellId: null,
    previousSlot: null,
    movedAt: null,
    stake: MIN,
    accepted: 0,
    outliers: 0,
    active: true,
    mirrored: true,
    ...overrides,
  }
}

const expect1 = [{ pubkey: 'a', cellId: CELL }]

describe('votingProblems', () => {
  it('is empty when the sensor is mirrored, in its cell, active and staked exactly the minimum', () => {
    expect(votingProblems(expect1, [row('a')], MIN)).toEqual([])
  })

  it('calls a sensor with no row, or a row never found on chain, unregistered', () => {
    expect(votingProblems(expect1, [], MIN)).toEqual([{ pubkey: 'a', problem: 'unregistered' }])
    // A row the pre-T077 scenario door wrote: present, never on chain.
    expect(votingProblems(expect1, [row('a', { mirrored: false })], MIN)).toEqual([
      { pubkey: 'a', problem: 'unregistered' },
    ])
  })

  it('names the cell before the stake — a vote in the wrong cell is no vote here', () => {
    const rows = [row('a', { cellId: CELL + 1n, stake: 0n })]
    expect(votingProblems(expect1, rows, MIN)).toEqual([{ pubkey: 'a', problem: 'wrong-cell' }])
  })

  it('refuses an excluded sensor whatever its stake — FR-012', () => {
    expect(votingProblems(expect1, [row('a', { active: false })], MIN)).toEqual([
      { pubkey: 'a', problem: 'excluded' },
    ])
  })

  it('refuses one unit under the minimum — FR-050', () => {
    expect(votingProblems(expect1, [row('a', { stake: MIN - 1n })], MIN)).toEqual([
      { pubkey: 'a', problem: 'understaked' },
    ])
  })

  it('reports every sensor in the order the run lists them, and ignores rows it did not ask about', () => {
    const expected = [
      { pubkey: 'b', cellId: CELL },
      { pubkey: 'a', cellId: CELL },
      { pubkey: 'c', cellId: CELL },
    ]
    const rows = [row('a', { stake: 0n }), row('c'), row('z', { active: false })]
    expect(votingProblems(expected, rows, MIN)).toEqual([
      { pubkey: 'b', problem: 'unregistered' },
      { pubkey: 'a', problem: 'understaked' },
    ])
  })
})
