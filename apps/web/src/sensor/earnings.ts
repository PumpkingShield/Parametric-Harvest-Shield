import './buffer-global.ts'
import {
  associatedTokenAddress,
  claimRewardInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  decodeCellRewards,
  decodePool,
  decodeSensor,
  PROGRAM_ID,
  type PublicKey,
  poolPda,
  rewardsPda,
  sensorPda,
  Transaction,
} from '@pumpking/anchor-client'
import { h3IndexFromCellId } from '@pumpking/shared/cell-id'
import { type Chain, type Network, readNetwork } from './register.ts'

/**
 * The operator's money, read from the chain — `T040`, `FR-036`, `FR-053`.
 *
 * Stake, stake on its way out, and what each slot holds unclaimed in its
 * cell's schedule: all fields of accounts a claim or an unstake changes the
 * moment it lands. The API's mirror would show them minutes late, and a page
 * that offers to claim a sum it already paid is worse than one that shows
 * nothing. So these are read here, from the same chain the claim is sent to,
 * and read again after it.
 *
 * Two cells, not one: a sensor that moved (`FR-059`) left what its old slot
 * earned in the old cell's schedule — the reserve is the cell's and does not
 * travel — and claims it from there with the same instruction.
 */

/** What one slot of one cell holds for the operator to claim. */
export type Claimable = { cellId: bigint; cell: string; amount: bigint }

export type Earnings = {
  network: Network
  pool: { genesisTs: bigint; secondsPerDay: number }
  /** Null when the chain has no sensor with this key. */
  sensor: {
    operator: PublicKey
    active: boolean
    stake: bigint
    unstaking: bigint
    /** Pool day the thaw ends, null while nothing thaws. */
    unlockAtDay: number | null
  } | null
  /** The sensor's own cell first, then the one it left; amounts may be zero. */
  claimable: Claimable[]
}

function big(value: { toString(): string }): bigint {
  return BigInt(value.toString())
}

export async function readEarnings(
  chain: Chain,
  sensorKey: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Promise<Earnings | null> {
  const [network, poolInfo, sensorInfo] = await Promise.all([
    readNetwork(chain, programId),
    chain.getAccountInfo(poolPda(programId).address),
    chain.getAccountInfo(sensorPda(sensorKey, programId).address),
  ])
  if (network === null || poolInfo === null) return null
  const decodedPool = decodePool(Uint8Array.from(poolInfo.data))
  const pool = {
    genesisTs: big(decodedPool.genesisTs),
    secondsPerDay: decodedPool.secondsPerDay,
  }
  if (sensorInfo === null) return { network, pool, sensor: null, claimable: [] }

  const sensor = decodeSensor(Uint8Array.from(sensorInfo.data))
  const current = big(sensor.cellId)
  const previous = big(sensor.previousCellId)
  // "No previous slot" is the current one on chain (`Sensor.previous_*`).
  const moved = previous !== current || sensor.previousSlot !== sensor.slotInCell
  const slots: { cellId: bigint; slot: number }[] = [
    { cellId: current, slot: sensor.slotInCell },
    ...(moved ? [{ cellId: previous, slot: sensor.previousSlot }] : []),
  ]
  const schedules = await Promise.all(
    slots.map(({ cellId }) => chain.getAccountInfo(rewardsPda(cellId, programId).address)),
  )
  const claimable = slots.map(({ cellId, slot }, index) => {
    const info = schedules[index]
    // A cell whose schedule was never opened has paid nobody yet.
    const amount =
      info === null || info === undefined
        ? 0n
        : big(decodeCellRewards(Uint8Array.from(info.data)).accrued[slot] ?? 0)
    return { cellId, cell: h3IndexFromCellId(cellId), amount }
  })

  return {
    network,
    pool,
    sensor: {
      operator: sensor.operator,
      active: sensor.active,
      stake: big(sensor.stake),
      unstaking: big(sensor.unstaking),
      unlockAtDay: sensor.unlockAtDay ?? null,
    },
    claimable,
  }
}

/** When pool day `day` begins. */
export function dayStart(pool: Earnings['pool'], day: number): Date {
  return new Date(Number(pool.genesisTs + BigInt(day) * BigInt(pool.secondsPerDay)) * 1000)
}

/** Why a claim cannot be sent, or null when it can. */
export type ClaimRefusal = 'unregistered' | 'foreign' | 'excluded' | 'nothing' | 'no-sol'

/** Rent of a token account (~0.002 SOL) and the fee, with room. */
export const LAMPORTS_TO_CLAIM = 3_000_000n

export function claimRefusal(
  earnings: Earnings,
  claim: Claimable,
  operator: PublicKey,
  lamports: bigint,
): ClaimRefusal | null {
  const { sensor } = earnings
  if (sensor === null) return 'unregistered'
  // The program pays the operator wherever the claim comes from. A phone that
  // is not the operator's could send it — it would pay a stranger's rent.
  if (!sensor.operator.equals(operator)) return 'foreign'
  if (!sensor.active) return 'excluded'
  if (claim.amount === 0n) return 'nothing'
  if (lamports < LAMPORTS_TO_CLAIM) return 'no-sol'
  return null
}

/**
 * The claim, unsigned: the operator's token account, opened if it is not
 * already — it is where the program pays, and it must exist — then
 * `claim_reward` for one cell.
 */
export function claimTransaction(input: {
  operator: PublicKey
  sensorKey: PublicKey
  cellId: bigint
  network: Network
  programId?: PublicKey
}): Transaction {
  const { operator, network } = input
  const programId = input.programId ?? PROGRAM_ID
  const operatorTokens = associatedTokenAddress(operator, network.assetMint, network.tokenProgram)
  const tx = new Transaction()
  tx.feePayer = operator
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction({
      payer: operator,
      associatedToken: operatorTokens,
      owner: operator,
      mint: network.assetMint,
      tokenProgram: network.tokenProgram,
    }),
    claimRewardInstruction({
      caller: operator,
      sensorKey: input.sensorKey,
      cellId: input.cellId,
      assetMint: network.assetMint,
      operatorTokens,
      tokenProgram: network.tokenProgram,
      programId,
    }),
  )
  return tx
}
