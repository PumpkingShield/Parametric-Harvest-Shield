import {
  accountDiscriminator,
  BN,
  decodeInstruction,
  encodeAccount,
  PublicKey,
  poolPda,
  rewardsPda,
  sensorPda,
  TOKEN_PROGRAM_ID,
} from '@pumpking/anchor-client'
import { describe, expect, it } from 'vitest'
import {
  claimRefusal,
  claimTransaction,
  dayStart,
  type Earnings,
  LAMPORTS_TO_CLAIM,
  readEarnings,
} from './earnings.ts'
import { type Chain, keypairOf } from './register.ts'

/**
 * The operator's money, read off accounts as the program lays them out —
 * `T040`. The question that matters is which slot of which cell's schedule is
 * read: a sensor that moved holds two, and a wrong index shows a neighbour's
 * earnings as this phone's.
 */

const operator = keypairOf(new Uint8Array(32).fill(1))
const sensor = keypairOf(new Uint8Array(32).fill(2))
const MINT = new PublicKey(new Uint8Array(32).fill(5))
const CELL = 0x871e701b3ffffffn
const LEFT = 0x871e701b2ffffffn
const key = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill))

async function poolBytes(): Promise<Uint8Array> {
  return await encodeAccount('pool', {
    authority: key(11),
    aggregator: key(12),
    assetMint: MINT,
    vault: key(14),
    stakeVault: key(15),
    capitalTotal: new BN(0),
    reservedTotal: new BN(0),
    sharesTotal: new BN(0),
    cellExposureBps: 1000,
    premiumRewardsBps: 2000,
    riskLoadingBps: 3000,
    minRateBps: 100,
    minSensorsPerCell: 3,
    minStake: new BN(1_000_000),
    unstakeDelayDays: 30,
    waitingPeriodDays: 3,
    dryDayThresholdMmX100: 100,
    secondsPerDay: 86_400,
    genesisTs: new BN(1_790_000_000),
    bump: 255,
  })
}

async function sensorBytes(moved: boolean): Promise<Uint8Array> {
  return await encodeAccount('sensor', {
    sensorKey: sensor.publicKey,
    operator: operator.publicKey,
    cellId: new BN(CELL.toString()),
    slotInCell: 4,
    previousCellId: new BN((moved ? LEFT : CELL).toString()),
    previousSlot: moved ? 9 : 4,
    movedAt: moved ? new BN(1_790_500_000) : null,
    stake: new BN(1_000_000),
    unstaking: new BN(250_000),
    unlockAtDay: 40,
    accepted: 10,
    outliers: 1,
    active: true,
    bump: 254,
  })
}

/** `CellRewards`, zero-copy, laid out by hand as `accounts.test.ts` does. */
function rewardsBytes(cellId: bigint, accrued: Record<number, bigint>): Uint8Array {
  const bytes = new Uint8Array(8 + 8 + 8 + 4 + 1 + 3 + 8 * 32 + 8 * 512)
  const view = new DataView(bytes.buffer)
  bytes.set(accountDiscriminator('cellRewards'), 0)
  view.setBigUint64(8, cellId, true)
  for (const [slot, amount] of Object.entries(accrued)) {
    view.setBigUint64(32 + Number(slot) * 8, amount, true)
  }
  return bytes
}

function mintBytes(decimals: number): Uint8Array {
  const bytes = new Uint8Array(82)
  bytes[44] = decimals
  return bytes
}

async function chainWith(moved: boolean, withPool = true): Promise<Chain> {
  const accounts = new Map<string, { data: Uint8Array; owner: PublicKey }>()
  const put = (address: PublicKey, data: Uint8Array, owner = key(99)) =>
    accounts.set(address.toBase58(), { data, owner })
  if (withPool) put(poolPda().address, await poolBytes())
  put(MINT, mintBytes(6), TOKEN_PROGRAM_ID)
  put(sensorPda(sensor.publicKey).address, await sensorBytes(moved))
  // Slot 4 earned in the current cell; slot 9 in the one left. A neighbour's
  // slot 5 is in both, and must not be read as this phone's.
  put(rewardsPda(CELL).address, rewardsBytes(CELL, { 4: 41_666n, 5: 7n }))
  put(rewardsPda(LEFT).address, rewardsBytes(LEFT, { 9: 1_200n, 5: 7n }))
  return {
    getAccountInfo: async (address: PublicKey) => accounts.get(address.toBase58()) ?? null,
    getBalance: async () => 0,
  } as unknown as Chain
}

describe('readEarnings', () => {
  it('reads the stake, the thaw and what the sensor’s own slot holds', async () => {
    const earnings = await readEarnings(await chainWith(false), sensor.publicKey)
    expect(earnings?.sensor).toMatchObject({
      stake: 1_000_000n,
      unstaking: 250_000n,
      unlockAtDay: 40,
      active: true,
    })
    expect(earnings?.network.decimals).toBe(6)
    expect(earnings?.claimable).toEqual([
      { cellId: CELL, cell: '871e701b3ffffff', amount: 41_666n },
    ])
  })

  it('reads the slot left behind on a move from the cell it was left in — FR-059', async () => {
    const earnings = await readEarnings(await chainWith(true), sensor.publicKey)
    expect(earnings?.claimable).toEqual([
      { cellId: CELL, cell: '871e701b3ffffff', amount: 41_666n },
      { cellId: LEFT, cell: '871e701b2ffffff', amount: 1_200n },
    ])
  })

  it('reads nothing into a network without a pool', async () => {
    expect(await readEarnings(await chainWith(false, false), sensor.publicKey)).toBeNull()
  })
})

describe('dayStart', () => {
  it('is genesis plus whole pool days', () => {
    const pool = { genesisTs: 1_790_000_000n, secondsPerDay: 86_400 }
    expect(dayStart(pool, 2).getTime()).toBe((1_790_000_000 + 2 * 86_400) * 1000)
  })
})

describe('claimRefusal', () => {
  async function earnings(): Promise<Earnings> {
    const read = await readEarnings(await chainWith(false), sensor.publicKey)
    if (read === null) throw new Error('no earnings')
    return read
  }

  it('lets the operator claim what is there, with SOL for the fee', async () => {
    const read = await earnings()
    const [claim] = read.claimable
    if (claim === undefined) throw new Error('no claim')
    expect(claimRefusal(read, claim, operator.publicKey, LAMPORTS_TO_CLAIM)).toBeNull()
  })

  it('refuses nothing to claim, another wallet’s sensor, an excluded one and an empty wallet', async () => {
    const read = await earnings()
    const [claim] = read.claimable
    if (claim === undefined || read.sensor === null) throw new Error('no claim')
    expect(
      claimRefusal(read, { ...claim, amount: 0n }, operator.publicKey, LAMPORTS_TO_CLAIM),
    ).toBe('nothing')
    expect(claimRefusal(read, claim, sensor.publicKey, LAMPORTS_TO_CLAIM)).toBe('foreign')
    expect(
      claimRefusal(
        { ...read, sensor: { ...read.sensor, active: false } },
        claim,
        operator.publicKey,
        LAMPORTS_TO_CLAIM,
      ),
    ).toBe('excluded')
    expect(claimRefusal(read, claim, operator.publicKey, LAMPORTS_TO_CLAIM - 1n)).toBe('no-sol')
  })
})

describe('claimTransaction', () => {
  it('opens the operator’s token account if need be, then claims from the cell asked for', () => {
    const tx = claimTransaction({
      operator: operator.publicKey,
      sensorKey: sensor.publicKey,
      cellId: LEFT,
      network: { assetMint: MINT, tokenProgram: TOKEN_PROGRAM_ID, decimals: 6, minStake: 1n },
    })
    expect(tx.feePayer?.equals(operator.publicKey)).toBe(true)
    const [open, claim] = tx.instructions
    // The associated-token program's "create idempotent" is tag 1.
    expect(open?.data[0]).toBe(1)
    const decoded = claim === undefined ? null : decodeInstruction(claim.data)
    expect(decoded?.name).toBe('claimReward')
    // The schedule is the cell's PDA: the program checks the seeds.
    expect(claim?.keys.some((meta) => meta.pubkey.equals(rewardsPda(LEFT).address))).toBe(true)
  })
})
