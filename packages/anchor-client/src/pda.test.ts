import type { Idl } from '@coral-xyz/anchor'
import { describe, expect, it } from 'vitest'
import { PUMPKING_IDL } from './idl/idl.ts'
import {
  buildInstruction,
  depositCapitalInstruction,
  initializePoolInstruction,
} from './instructions.ts'
import {
  CAPITAL_SEED,
  CELL_SEED,
  capitalPositionPda,
  cellPda,
  POLICY_SEED,
  POOL_SEED,
  policyPda,
  poolPda,
  SENSOR_SEED,
  STAKE_VAULT_SEED,
  sensorPda,
  stakeVaultPda,
  u64Seed,
  VAULT_SEED,
  vaultPda,
} from './pda.ts'
import { PublicKey } from './web3.ts'

/** Keys with no meaning beyond being fixed, so an address is reproducible. */
function key(fill: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(fill))
}

/** Not the deployed id: these vectors pin the seeds, not the deployment. */
const programId = key(7)
const owner = key(2)
const sensorKey = key(1)
const cellId = 0x871e701b3ffffffn

const idl = PUMPKING_IDL as Idl

describe('u64Seed', () => {
  it('writes eight bytes, least significant first', () => {
    expect([...u64Seed(1n)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect([...u64Seed(0x0102030405060708n)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1])
  })

  it('covers the whole range and refuses what is outside it', () => {
    expect([...u64Seed(0xffff_ffff_ffff_ffffn)]).toEqual([255, 255, 255, 255, 255, 255, 255, 255])
    expect(() => u64Seed(-1n)).toThrow(RangeError)
    expect(() => u64Seed(1n << 64n)).toThrow(RangeError)
  })
})

describe('derived addresses', () => {
  /**
   * Frozen vectors. `cell`, `sensor` and `policy` have no instruction yet, so
   * the IDL cannot confirm them the way it confirms the rest below, and these
   * lines are all that stands between a seed edit and a client that quietly
   * addresses an account nobody ever created.
   */
  it('matches the recorded vectors', () => {
    const pool = poolPda(programId)
    expect(pool.address.toBase58()).toBe('8UWpUPDPaTMbqPRwwDGJYz8vLuE7GCvFhPyZxd8qZyYo')
    expect(vaultPda(pool.address, programId).address.toBase58()).toBe(
      'H7Yg22Sjp14ot7c9aMsnDGdeDmaRpbCp9Jk44xpE5fAm',
    )
    expect(stakeVaultPda(pool.address, programId).address.toBase58()).toBe(
      'EwtABN3FhaR4uauvg98z6crDz9aKZQpncrbhho6ft9jz',
    )
    expect(cellPda(cellId, programId).address.toBase58()).toBe(
      '4tGVhKfxFwxKHxZxS38PtYYyBmm7mjzXVBuYNk4Lty7N',
    )
    expect(sensorPda(sensorKey, programId).address.toBase58()).toBe(
      'E3nT7UfmB1nDd8eCvUa8MdJMG5UyiNnZkYjJEit6XVEH',
    )
    expect(policyPda(owner, 3n, programId).address.toBase58()).toBe(
      'C4Q8os5Ez8c28R1ZKEG9vjBDPJvp4sXkHQ8zu77MpHQy',
    )
    expect(capitalPositionPda(owner, programId).address.toBase58()).toBe(
      '8WjtNvKZp8fBCT1WKeGKbwTzx5hFrL9sP5N79XjLsQsY',
    )
  })

  it('carries the bump that produced the address', () => {
    const pool = poolPda(programId)
    const [address, bump] = PublicKey.findProgramAddressSync([POOL_SEED], programId)
    expect(pool.address.equals(address)).toBe(true)
    expect(pool.bump).toBe(bump)
  })

  it('separates the two vaults of one pool', () => {
    const pool = poolPda(programId).address
    expect(vaultPda(pool, programId).address.equals(stakeVaultPda(pool, programId).address)).toBe(
      false,
    )
  })

  it('gives each policy of one owner its own address', () => {
    const first = policyPda(owner, 0n, programId).address
    const second = policyPda(owner, 1n, programId).address
    expect(first.equals(second)).toBe(false)
  })

  it('keeps the owner in the seeds, so one nonce is not one policy', () => {
    // `FR-066` fixes the recipient at issue. The owner is a seed rather than
    // only a field, so two farmers picking the same nonce address two accounts
    // instead of racing for one.
    const mine = policyPda(owner, 0n, programId).address
    const theirs = policyPda(key(8), 0n, programId).address
    expect(mine.equals(theirs)).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Agreement with the program                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The seeds in `pda.ts` are the second copy; `state.rs` holds the first. The
 * IDL is generated from the program, so everything it can describe is checked
 * against it here rather than trusted — the defence the shared fixtures give
 * `dry_spell`, applied to addresses.
 */
describe('agreement with the IDL', () => {
  const seeds = [
    POOL_SEED,
    VAULT_SEED,
    STAKE_VAULT_SEED,
    CELL_SEED,
    SENSOR_SEED,
    POLICY_SEED,
    CAPITAL_SEED,
  ]

  it('declares every literal seed the program uses', () => {
    const known = new Set(seeds.map((seed) => seed.join(',')))
    const text = new TextDecoder()
    for (const instruction of idl.instructions) {
      for (const account of instruction.accounts) {
        if (!('pda' in account) || account.pda === undefined) continue
        for (const seed of account.pda.seeds) {
          if (seed.kind !== 'const') continue
          expect(
            known.has(seed.value.join(',')),
            `\`${instruction.name}.${account.name}\` is seeded by ` +
              `"${text.decode(Uint8Array.from(seed.value))}", which pda.ts does not declare`,
          ).toBe(true)
        }
      }
    }
  })

  /** The address the program's own seed description puts at that position. */
  function addressAt(
    instructionName: string,
    accountName: string,
    keys: readonly { pubkey: PublicKey }[],
  ): PublicKey {
    const instruction = idl.instructions.find((one) => one.name === instructionName)
    const index = instruction?.accounts.findIndex((one) => one.name === accountName) ?? -1
    const meta = index >= 0 ? keys[index] : undefined
    if (meta === undefined) {
      throw new Error(`no account \`${accountName}\` in \`${instructionName}\``)
    }
    return meta.pubkey
  }

  it('derives the pool and both vaults the way initialize_pool declares them', () => {
    const { keys } = initializePoolInstruction({
      authority: key(3),
      assetMint: key(4),
      programId,
      params: {
        aggregator: key(5),
        cellExposureBps: 1_000,
        premiumRewardsBps: 500,
        minSensorsPerCell: 3,
        minStake: 1_000_000n,
        unstakeDelayDays: 14,
        waitingPeriodDays: 7,
        dryDayThresholdMmX100: 100,
        secondsPerDay: 86_400,
      },
    })
    const pool = poolPda(programId).address
    expect(addressAt('initializePool', 'pool', keys).equals(pool)).toBe(true)
    expect(
      addressAt('initializePool', 'vault', keys).equals(vaultPda(pool, programId).address),
    ).toBe(true)
    expect(
      addressAt('initializePool', 'stakeVault', keys).equals(
        stakeVaultPda(pool, programId).address,
      ),
    ).toBe(true)
  })

  it('derives the capital position the way deposit_capital declares it', () => {
    const { keys } = depositCapitalInstruction({
      depositor: owner,
      assetMint: key(4),
      depositorTokens: key(6),
      amount: 1n,
      programId,
    })
    expect(addressAt('depositCapital', 'pool', keys).equals(poolPda(programId).address)).toBe(true)
    expect(
      addressAt('depositCapital', 'position', keys).equals(
        capitalPositionPda(owner, programId).address,
      ),
    ).toBe(true)
  })

  it('refuses an instruction the program does not have', () => {
    expect(() => buildInstruction('settlePolicy')).toThrow(/no instruction/)
  })
})
