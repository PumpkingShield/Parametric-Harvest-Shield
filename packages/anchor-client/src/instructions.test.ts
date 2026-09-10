import { BN, BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import { describe, expect, it } from 'vitest'
import { PUMPKING_IDL } from './idl/idl.ts'
import {
  buildInstruction,
  DayState,
  depositCapitalInstruction,
  initializePoolInstruction,
  issuePolicyInstruction,
  type PoolParams,
  settlePolicyInstruction,
  submitDayRecordInstruction,
} from './instructions.ts'
import {
  capitalPositionPda,
  cellPda,
  policyPda,
  poolPda,
  stakeVaultPda,
  vaultPda,
} from './pda.ts'
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
  riskLoadingBps: 2_500,
  minRateBps: 100,
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
    expect(encoded.riskLoadingBps).toBe(2_500)
    expect(encoded.minRateBps).toBe(100)
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
    // Deliberately not a name from the roadmap: settlePolicy and closePolicy
    // are coming, and a test that fails the day they land tests the calendar.
    expect(() => buildInstruction('reticulateSplines')).toThrow(
      /no instruction `reticulateSplines`/,
    )
  })

  /**
   * `issue_policy` seeds two accounts out of fields of its `params` argument,
   * and Anchor writes those paths in the Rust spelling (`params.cell_id`)
   * while naming the field itself `cellId`. Both halves have to line up or the
   * derived address is silently somebody else's.
   */
  it('follows a dotted argument path into a struct', () => {
    const terms = {
      nonce: 7n,
      cellId: 0x871e701b3ffffffn,
      spellDaysThreshold: 14,
      payout: 50_000n,
      maxPremium: 2_500n,
      windowStartDay: 13,
      windowEndDay: 42,
    }
    const { keys } = issuePolicyInstruction({
      owner: depositor,
      assetMint,
      ownerTokens: depositorTokens,
      programId,
      terms,
    })
    const index = accountNames('issuePolicy').indexOf('cell')
    expect(keys[index]?.pubkey.equals(cellPda(terms.cellId, programId).address)).toBe(true)
  })

  it('says which seed it is missing rather than deriving a wrong address', () => {
    expect(() =>
      buildInstruction('issuePolicy', {
        programId,
        accounts: {
          owner: depositor,
          assetMint,
          vault: key(9),
          ownerTokens: depositorTokens,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        args: { params: { nonce: new BN(1) } },
      }),
    ).toThrow(/cell_id/)
  })

  it('fills a fixed address from the IDL rather than from the caller', () => {
    const { keys } = initializePoolInstruction({ authority, assetMint, params, programId })
    const index = accountNames('initializePool').indexOf('systemProgram')
    expect(keys[index]?.pubkey.equals(SYSTEM_PROGRAM_ID)).toBe(true)
  })
})

/**
 * The round-trip that was missing when `premium` became `maxPremium`.
 *
 * Every other test here reads the IDL for names and derivations, so a client
 * field the program no longer has still lines up with itself and passes. Only
 * decoding the bytes back asks the coder what the *program* will read — and a
 * renamed field is silently dropped on the way in, which Borsh then fills with
 * a zero. A policy priced at a ceiling of zero is refused, not mispriced, but
 * the transaction fails on chain with nothing here having warned.
 */
describe('issuePolicyInstruction', () => {
  const terms = {
    nonce: 7n,
    cellId: 0x871e701b3ffffffn,
    spellDaysThreshold: 14,
    payout: 50_000n,
    maxPremium: 2_500n,
    windowStartDay: 13,
    windowEndDay: 42,
  }
  const input = {
    owner: depositor,
    assetMint,
    ownerTokens: depositorTokens,
    programId,
    terms,
  }

  it('carries the discriminator the program compiled', () => {
    const instruction = issuePolicyInstruction(input)
    const expected = idl.instructions.find((one) => one.name === 'issuePolicy')?.discriminator
    expect(expected).toHaveLength(8)
    expect([...instruction.data.subarray(0, 8)]).toEqual(expected)
  })

  it('round-trips every term through the wire format', () => {
    const { name, data } = decode(issuePolicyInstruction(input).data)
    expect(name).toBe('issuePolicy')

    const encoded = data.params as Record<string, unknown>
    expect(Object.keys(encoded).sort()).toEqual([
      'cellId',
      'maxPremium',
      'nonce',
      'payout',
      'spellDaysThreshold',
      'windowEndDay',
      'windowStartDay',
    ])
    expect(String(encoded.nonce)).toBe('7')
    expect(String(encoded.cellId)).toBe(terms.cellId.toString())
    expect(encoded.spellDaysThreshold).toBe(14)
    expect(String(encoded.payout)).toBe('50000')
    expect(String(encoded.maxPremium)).toBe('2500')
    expect(encoded.windowStartDay).toBe(13)
    expect(encoded.windowEndDay).toBe(42)
  })

  /** `FR-021`: the program prices the policy, so no price is on the wire. */
  it('sends a ceiling and never a price', () => {
    const { data } = decode(issuePolicyInstruction(input).data)
    expect(data.params as Record<string, unknown>).not.toHaveProperty('premium')
  })

  it('keeps a payout and a ceiling larger than a double can hold', () => {
    const payout = 18_446_744_073_709_551_615n
    const maxPremium = 9_007_199_254_740_993n
    const { data } = decode(
      issuePolicyInstruction({ ...input, terms: { ...terms, payout, maxPremium } }).data,
    )
    const encoded = data.params as Record<string, unknown>
    expect(String(encoded.payout)).toBe(payout.toString())
    expect(String(encoded.maxPremium)).toBe(maxPremium.toString())
  })
})

describe('submitDayRecordInstruction', () => {
  const aggregator = key(11)
  const cellId = 0x871e701b3ffffffn
  const readingsRoot = Uint8Array.from({ length: 32 }, (_value, index) => index)

  const record = {
    cellId,
    dayIndex: 9,
    state: DayState.Dry,
    contributors: 0b111,
    readingsRoot,
    rainfallX100: 50,
    coveredIntervals: 24,
    totalIntervals: 24,
  }
  const input = { aggregator, record, programId }

  it('carries the discriminator the program compiled', () => {
    const instruction = submitDayRecordInstruction(input)
    const expected = idl.instructions.find((one) => one.name === 'submitDayRecord')?.discriminator
    expect(expected).toHaveLength(8)
    expect([...instruction.data.subarray(0, 8)]).toEqual(expected)
  })

  it('round-trips every field through the wire format', () => {
    const { name, data } = decode(submitDayRecordInstruction(input).data)
    expect(name).toBe('submitDayRecord')

    const encoded = data.params as Record<string, unknown>
    expect(Object.keys(encoded).sort()).toEqual([
      'cellId',
      'contributors',
      'coveredIntervals',
      'dayIndex',
      'rainfallX100',
      'readingsRoot',
      'state',
      'totalIntervals',
    ])
    expect(String(encoded.cellId)).toBe(cellId.toString())
    expect(encoded.dayIndex).toBe(9)
    expect(encoded.state).toBe(DayState.Dry)
    expect(encoded.contributors).toBe(0b111)
    expect([...(encoded.readingsRoot as number[])]).toEqual([...readingsRoot])
    expect(encoded.rainfallX100).toBe(50)
    expect(encoded.coveredIntervals).toBe(24)
    expect(encoded.totalIntervals).toBe(24)
  })

  /**
   * `null` and `0` are different days: one is silence, the other is a real
   * reading of a dry sky. Borsh encodes the option as a leading byte, so a
   * client that collapsed them would submit a day the program then refuses —
   * or worse, one it accepts as measured.
   */
  it('keeps a day without coverage apart from a day that measured nothing', () => {
    const silent = { ...record, state: DayState.NoCoverage, rainfallX100: null, contributors: 0 }
    const { data: none } = decode(submitDayRecordInstruction({ ...input, record: silent }).data)
    expect((none.params as Record<string, unknown>).rainfallX100).toBeNull()

    const measured = { ...record, rainfallX100: 0 }
    const { data: zero } = decode(submitDayRecordInstruction({ ...input, record: measured }).data)
    expect((zero.params as Record<string, unknown>).rainfallX100).toBe(0)
  })

  it('derives the cell from the id and lists the accounts in order', () => {
    const instruction = submitDayRecordInstruction(input)
    expect(accountNames('submitDayRecord')).toEqual([
      'aggregator',
      'pool',
      'cell',
      'systemProgram',
    ])
    expect(instruction.keys.map((meta) => meta.pubkey.toBase58())).toEqual([
      aggregator.toBase58(),
      poolPda(programId).address.toBase58(),
      cellPda(cellId, programId).address.toBase58(),
      SYSTEM_PROGRAM_ID.toBase58(),
    ])
  })

  it('marks the aggregator the only signer', () => {
    const { keys } = submitDayRecordInstruction(input)
    expect(keys.filter((meta) => meta.isSigner).map((meta) => meta.pubkey.toBase58())).toEqual([
      aggregator.toBase58(),
    ])
  })

  /**
   * Borsh writes a fixed-width array without a length, so a short root would
   * be padded and a long one would silently eat the fields after it. Refusing
   * at the edge names the mistake where it was made.
   */
  it('refuses a root that is not 32 bytes', () => {
    expect(() =>
      submitDayRecordInstruction({
        ...input,
        record: { ...record, readingsRoot: new Uint8Array(31) },
      }),
    ).toThrow(/32 bytes, got 31/)
  })
})

describe('settlePolicyInstruction', () => {
  const caller = key(12)
  const owner = key(13)
  const ownerTokens = key(14)
  const nonce = 7n
  const cellId = 0x871e701b3ffffffn
  const input = { caller, owner, nonce, cellId, assetMint, ownerTokens, programId }

  it('carries the discriminator the program compiled', () => {
    const instruction = settlePolicyInstruction(input)
    const expected = idl.instructions.find((one) => one.name === 'settlePolicy')?.discriminator
    expect(expected).toHaveLength(8)
    expect([...instruction.data.subarray(0, 8)]).toEqual(expected)
  })

  /**
   * `FR-026`: nothing about the payout is negotiable at the call site, so
   * there is nothing on the wire but the discriminator. A future argument
   * would be a future way to influence the outcome, and this is the test that
   * would notice one arriving.
   */
  it('sends the discriminator and not one byte more', () => {
    const { name, data } = decode(settlePolicyInstruction(input).data)
    expect(name).toBe('settlePolicy')
    expect(data).toEqual({})
    expect(settlePolicyInstruction(input).data).toHaveLength(8)
  })

  it('lists the accounts in the order the program reads them', () => {
    const instruction = settlePolicyInstruction(input)
    const pool = poolPda(programId).address
    expect(accountNames('settlePolicy')).toEqual([
      'caller',
      'pool',
      'cell',
      'policy',
      'assetMint',
      'vault',
      'ownerTokens',
      'tokenProgram',
    ])
    expect(instruction.keys.map((meta) => meta.pubkey.toBase58())).toEqual([
      caller.toBase58(),
      pool.toBase58(),
      cellPda(cellId, programId).address.toBase58(),
      policyPda(owner, nonce, programId).address.toBase58(),
      assetMint.toBase58(),
      vaultPda(pool, programId).address.toBase58(),
      ownerTokens.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ])
  })

  /**
   * `FR-030`: the caller is the only signer and is checked against nothing.
   * A second required signature — the owner's, an authority's — would be a
   * key that could withhold a payout by declining to sign.
   */
  it('needs one signature, and it is not the owner or an authority', () => {
    const { keys } = settlePolicyInstruction(input)
    expect(keys.filter((meta) => meta.isSigner).map((meta) => meta.pubkey.toBase58())).toEqual([
      caller.toBase58(),
    ])
    expect(keys.some((meta) => meta.pubkey.equals(owner))).toBe(false)
  })

  it('builds the same instruction whoever the caller is', () => {
    const stranger = settlePolicyInstruction({ ...input, caller: key(15) })
    const worker = settlePolicyInstruction(input)
    expect(stranger.data).toEqual(worker.data)
    expect(stranger.keys.slice(1)).toEqual(worker.keys.slice(1))
  })
})
