import { BN, BorshAccountsCoder, type Idl, utils } from '@coral-xyz/anchor'
import { describe, expect, it } from 'vitest'
import {
  accountDiscriminator,
  associatedTokenAddress,
  decodeCellState,
  decodePolicy,
  decodePool,
  isPolicyActive,
  POLICY_DISCRIMINATOR,
  type PolicyAccount,
} from './accounts.ts'
import { PUMPKING_IDL } from './idl/idl.ts'
import { PublicKey, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './web3.ts'

/**
 * The decoders, checked by encoding through the same coder and reading back.
 *
 * The round trip is the point, exactly as it is for instructions: a decoder
 * that has drifted from the program does not fail, it returns a struct of
 * plausible numbers read out of the wrong offsets, and the first thing that
 * notices is a payout going to a key nobody chose.
 */

const coder = new BorshAccountsCoder(PUMPKING_IDL as Idl)

const key = (fill: number): PublicKey => new PublicKey(new Uint8Array(32).fill(fill))

const POLICY: PolicyAccount = {
  owner: key(3),
  nonce: new BN(7),
  cellId: new BN('613196570331971583'),
  spellDaysThreshold: 14,
  payout: new BN(1_000_000),
  premium: new BN(21_000),
  windowStartDay: 11,
  windowEndDay: 40,
  state: { active: {} },
  bump: 254,
} as PolicyAccount

describe('decodePolicy', () => {
  it('reads back every field it was given', async () => {
    const encoded = await coder.encode('policy', POLICY)
    const policy = decodePolicy(Uint8Array.from(encoded))

    expect(policy.owner.equals(POLICY.owner)).toBe(true)
    expect(policy.nonce.toString()).toBe('7')
    expect(policy.cellId.toString()).toBe('613196570331971583')
    expect(policy.spellDaysThreshold).toBe(14)
    expect(policy.payout.toString()).toBe('1000000')
    expect(policy.premium.toString()).toBe('21000')
    expect(policy.windowStartDay).toBe(11)
    expect(policy.windowEndDay).toBe(40)
    expect(policy.bump).toBe(254)
  })

  it('refuses bytes that are not a policy', async () => {
    const pool = await coder.encode('pool', {
      authority: key(1),
      aggregator: key(2),
      assetMint: key(3),
      vault: key(4),
      stakeVault: key(5),
      capitalTotal: new BN(0),
      reservedTotal: new BN(0),
      sharesTotal: new BN(0),
      cellExposureBps: 1000,
      premiumRewardsBps: 2000,
      riskLoadingBps: 3000,
      minRateBps: 100,
      minSensorsPerCell: 3,
      minStake: new BN(0),
      unstakeDelayDays: 14,
      waitingPeriodDays: 3,
      dryDayThresholdMmX100: 100,
      secondsPerDay: 86_400,
      genesisTs: new BN(0),
      bump: 255,
    })
    // The discriminator is what makes this an error rather than a struct of
    // plausible nonsense read out of somebody else's bytes.
    expect(() => decodePolicy(Uint8Array.from(pool))).toThrow()
    expect(decodePool(Uint8Array.from(pool)).minSensorsPerCell).toBe(3)
  })
})

describe('isPolicyActive', () => {
  it('is true only while the index can still trigger it — FR-027', () => {
    expect(isPolicyActive(POLICY)).toBe(true)
    expect(isPolicyActive({ ...POLICY, state: { settled: {} } } as PolicyAccount)).toBe(false)
    expect(isPolicyActive({ ...POLICY, state: { closed: {} } } as PolicyAccount)).toBe(false)
    expect(isPolicyActive({ ...POLICY, state: { unclaimed: {} } } as PolicyAccount)).toBe(false)
  })
})

describe('discriminators', () => {
  it('come from the IDL, not from a copy of it', () => {
    expect([...POLICY_DISCRIMINATOR]).toEqual(
      PUMPKING_IDL.accounts.find((one) => one.name === 'policy')?.discriminator,
    )
    expect(accountDiscriminator('cellState')).toHaveLength(8)
    expect(() => accountDiscriminator('harvest')).toThrow(/no account named/)
  })

  it('is what a decoded cell state is checked against', async () => {
    const encoded = await coder.encode('cellState', {
      cellId: new BN('613196570331971583'),
      sensorCount: 3,
      underInvestigation: false,
      reserved: new BN(0),
      rewardsReserve: new BN(0),
      firstDayIndex: 0,
      lastDayIndex: 12,
      dayLog: Array.from<number>({ length: 128 }).fill(0),
      contributors: Array.from<number>({ length: 128 }).fill(0),
      bump: 253,
    })
    expect(decodeCellState(Uint8Array.from(encoded)).lastDayIndex).toBe(12)
  })
})

describe('associatedTokenAddress', () => {
  /**
   * Cross-checked against Anchor's own derivation rather than trusted: the
   * payout lands in this account, and an address derived a different way is a
   * transaction that fails for a reason naming nothing.
   */
  it('agrees with Anchor for the classic token program', () => {
    const owner = key(3)
    const mint = key(2)
    expect(associatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID).toBase58()).toBe(
      utils.token.associatedAddress({ mint, owner }).toBase58(),
    )
  })

  it('gives a different account under Token-2022 — FR-055', () => {
    const owner = key(3)
    const mint = key(2)
    expect(associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM_ID).toBase58()).not.toBe(
      associatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID).toBase58(),
    )
  })

  it('is a different account for every owner', () => {
    const mint = key(2)
    const addresses = [key(3), key(4), key(5)].map((owner) =>
      associatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID).toBase58(),
    )
    expect(new Set(addresses).size).toBe(3)
  })
})
