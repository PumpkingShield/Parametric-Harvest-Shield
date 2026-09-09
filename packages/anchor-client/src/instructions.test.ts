import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import { describe, expect, it } from 'vitest'
import { PUMPKING_IDL } from './idl/idl.ts'
import {
  buildInstruction,
  depositCapitalInstruction,
  initializePoolInstruction,
  type PoolParams,
} from './instructions.ts'
import { capitalPositionPda, poolPda, stakeVaultPda, vaultPda } from './pda.ts'
import { PROGRAM_ID } from './program.ts'
import { PublicKey, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './web3.ts'

function key(fill: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(fill))
}

const idl = PUMPKING_IDL as Idl
const coder = new BorshInstructionCoder(idl)

const authority = key(3)
const assetMint = key(4)
const aggregator = key(5)
const depositor = key(2)
const depositorTokens = key(6)
const programId = key(7)

const params: PoolParams = {
  aggregator,
  cellExposureBps: 1_000,
  premiumRewardsBps: 500,
  minSensorsPerCell: 3,
  minStake: 1_000_000n,
  unstakeDelayDays: 14,
  waitingPeriodDays: 7,
  dryDayThresholdMmX100: 100,
  secondsPerDay: 86_400,
}

type InstructionData = ReturnType<typeof coder.encode>

/** Reads back what the program will read: the wire bytes, not our inputs. */
function decode(data: InstructionData): { name: string; data: Record<string, unknown> } {
  const decoded = coder.decode(data)
  if (decoded === null) {
    throw new Error('the coder did not recognise the instruction')
  }
  return decoded as unknown as { name: string; data: Record<string, unknown> }
}

/** The account names the IDL lists, in the order it lists them. */
function accountNames(instructionName: string): string[] {
  const instruction = idl.instructions.find((one) => one.name === instructionName)
  if (instruction === undefined) {
    throw new Error(`no instruction \`${instructionName}\``)
  }
  return instruction.accounts.map((account) => account.name)
}

describe('initializePoolInstruction', () => {
  it('carries the discriminator the program compiled', () => {
    const instruction = initializePoolInstruction({ authority, assetMint, params, programId })
    const expected = idl.instructions.find((one) => one.name === 'initializePool')?.discriminator
    expect(expected).toHaveLength(8)
    expect([...instruction.data.subarray(0, 8)]).toEqual(expected)
  })

  it('round-trips every parameter through the wire format', () => {
    const instruction = initializePoolInstruction({ authority, assetMint, params, programId })
    const { name, data } = decode(instruction.data)
    expect(name).toBe('initializePool')

    const encoded = data.params as Record<string, unknown>
    expect((encoded.aggregator as PublicKey).equals(aggregator)).toBe(true)
    expect(encoded.cellExposureBps).toBe(1_000)
    expect(encoded.premiumRewardsBps).toBe(500)
    expect(encoded.minSensorsPerCell).toBe(3)
    expect(String(encoded.minStake)).toBe('1000000')
    expect(encoded.unstakeDelayDays).toBe(14)
    expect(encoded.waitingPeriodDays).toBe(7)
    expect(encoded.dryDayThresholdMmX100).toBe(100)
    expect(encoded.secondsPerDay).toBe(86_400)
  })

  it('lists the accounts in the order the program reads them', () => {
    const instruction = initializePoolInstruction({ authority, assetMint, params, programId })
    const pool = poolPda(programId).address
    expect(accountNames('initializePool')).toEqual([
      'authority',
      'pool',
      'assetMint',
      'vault',
      'stakeVault',
      'tokenProgram',
      'systemProgram',
    ])
    expect(instruction.keys.map((meta) => meta.pubkey.toBase58())).toEqual([
      authority.toBase58(),
      pool.toBase58(),
      assetMint.toBase58(),
      vaultPda(pool, programId).address.toBase58(),
      stakeVaultPda(pool, programId).address.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      SYSTEM_PROGRAM_ID.toBase58(),
    ])
  })

  it('marks the authority the only signer, and only what is written writable', () => {
    const { keys } = initializePoolInstruction({ authority, assetMint, params, programId })
    expect(keys.map((meta) => meta.isSigner)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
    expect(keys.map((meta) => meta.isWritable)).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
      false,
    ])
  })

  it('takes the token program from the caller, so a Token-2022 asset works', () => {
    const { keys } = initializePoolInstruction({
      authority,
      assetMint,
      params,
      programId,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    const index = accountNames('initializePool').indexOf('tokenProgram')
    expect(keys[index]?.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
  })

  it('addresses the deployed program when no id is given', () => {
    const instruction = initializePoolInstruction({ authority, assetMint, params })
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true)
    expect(instruction.keys[1]?.pubkey.equals(poolPda().address)).toBe(true)
  })
})

describe('depositCapitalInstruction', () => {
  const input = { depositor, assetMint, depositorTokens, amount: 250_000n, programId }

  it('round-trips the amount and finds the pool accounts itself', () => {
    const instruction = depositCapitalInstruction(input)
    const { name, data } = decode(instruction.data)
    expect(name).toBe('depositCapital')
    expect(String(data.amount)).toBe('250000')

    const pool = poolPda(programId).address
    expect(instruction.keys.map((meta) => meta.pubkey.toBase58())).toEqual([
      depositor.toBase58(),
      pool.toBase58(),
      assetMint.toBase58(),
      vaultPda(pool, programId).address.toBase58(),
      depositorTokens.toBase58(),
      capitalPositionPda(depositor, programId).address.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      SYSTEM_PROGRAM_ID.toBase58(),
    ])
  })

  /**
   * `u64` is not `number`. An asset with six decimals passes 2^53 at nine
   * billion units — a large pool, not an impossible one — and a client that
   * lost precision there would move a different amount than it displayed.
   */
  it('keeps an amount larger than a double can hold', () => {
    const amount = 18_446_744_073_709_551_615n
    const { data } = decode(depositCapitalInstruction({ ...input, amount }).data)
    expect(String(data.amount)).toBe(amount.toString())
  })

  it('lets the caller name a vault the seeds do not derive', () => {
    const vault = key(9)
    const { keys } = depositCapitalInstruction({ ...input, vault })
    const index = accountNames('depositCapital').indexOf('vault')
    expect(keys[index]?.pubkey.equals(vault)).toBe(true)
  })

  it('marks the depositor the only signer', () => {
    const { keys } = depositCapitalInstruction(input)
    expect(keys.filter((meta) => meta.isSigner).map((meta) => meta.pubkey.toBase58())).toEqual([
      depositor.toBase58(),
    ])
  })
})

describe('buildInstruction', () => {
  it('names the account it cannot resolve instead of guessing one', () => {
    expect(() =>
      buildInstruction('depositCapital', {
        programId,
        accounts: { depositor },
        args: { amount: 1 },
      }),
    ).toThrow(/assetMint/)
  })

  it('refuses an instruction the IDL does not describe', () => {
    expect(() => buildInstruction('issuePolicy')).toThrow(/no instruction `issuePolicy`/)
  })

  it('fills a fixed address from the IDL rather than from the caller', () => {
    const { keys } = initializePoolInstruction({ authority, assetMint, params, programId })
    const index = accountNames('initializePool').indexOf('systemProgram')
    expect(keys[index]?.pubkey.equals(SYSTEM_PROGRAM_ID)).toBe(true)
  })
})
