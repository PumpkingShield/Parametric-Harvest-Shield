import { describe, expect, it } from 'vitest'
import { dayRewardedFromLogs } from './events.ts'
import { PUMPKING_IDL } from './idl/idl.ts'
import { PROGRAM_ID } from './program.ts'
import { PublicKey } from './web3.ts'

/**
 * The event, laid out by hand from `rewards.rs` — not through the coder that
 * reads it. A round trip through one coder agrees with itself whatever the
 * layout; bytes written from the struct declaration are what the program
 * actually logs: discriminator, `cell_id: u64`, `day_index: u32`,
 * `earned: [u64; 32]`, `returned: u64`, little-endian, no padding.
 */

function eventBytes(cellId: bigint, dayIndex: number, earned: bigint[], returned: bigint): string {
  const event = PUMPKING_IDL.events.find((one) => one.name === 'dayRewarded')
  if (event === undefined) throw new Error('no dayRewarded in the IDL')
  const bytes = new Uint8Array(8 + 8 + 4 + 32 * 8 + 8)
  const view = new DataView(bytes.buffer)
  bytes.set(event.discriminator, 0)
  view.setBigUint64(8, cellId, true)
  view.setUint32(16, dayIndex, true)
  for (const [slot, amount] of earned.entries()) view.setBigUint64(20 + slot * 8, amount, true)
  view.setBigUint64(20 + 32 * 8, returned, true)
  return Buffer.from(bytes).toString('base64')
}

function logsOf(program: PublicKey, data: string): string[] {
  const id = program.toBase58()
  return [
    `Program ${id} invoke [1]`,
    'Program log: Instruction: SubmitDayRecord',
    `Program ${id} consumed 9000 of 400000 compute units`,
    `Program ${id} success`,
    `Program ${id} invoke [1]`,
    'Program log: Instruction: SubmitDayReputation',
    `Program data: ${data}`,
    `Program ${id} consumed 21000 of 391000 compute units`,
    `Program ${id} success`,
  ]
}

const CELL = 0x871e701b3ffffffn

describe('dayRewardedFromLogs', () => {
  it('reads what each slot earned on the day, as the program logged it', () => {
    const earned = Array.from({ length: 32 }, () => 0n)
    earned[3] = 41_666n
    earned[31] = 2n ** 63n + 5n
    const event = dayRewardedFromLogs(logsOf(PROGRAM_ID, eventBytes(CELL, 812, earned, 7n)))
    expect(event).toEqual({ cellId: CELL, dayIndex: 812, earned, returned: 7n })
  })

  it('is null for a transaction that logged no such event', () => {
    expect(dayRewardedFromLogs([`Program ${PROGRAM_ID.toBase58()} invoke [1]`])).toBeNull()
  })

  it('does not take another program’s line for ours', () => {
    const stranger = new PublicKey(new Uint8Array(32).fill(9))
    const data = eventBytes(
      CELL,
      1,
      Array.from({ length: 32 }, () => 1n),
      0n,
    )
    expect(dayRewardedFromLogs(logsOf(stranger, data))).toBeNull()
    // Control: the same bytes under the program's own frame are read.
    expect(dayRewardedFromLogs(logsOf(PROGRAM_ID, data))?.dayIndex).toBe(1)
  })
})
