import './buffer-global.ts'
import {
  associatedTokenAddress,
  Connection,
  cellPda,
  claimRewardInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  decodeCellRewards,
  decodeCellState,
  decodeMintDecimals,
  decodePool,
  decodeSensor,
  decodeTokenAmount,
  Keypair,
  moveSensorInstruction,
  PROGRAM_ID,
  PUMPKING_IDL,
  PublicKey,
  poolPda,
  registerSensorInstruction,
  rewardsPda,
  SENSOR_SLOTS,
  sensorPda,
  stakeSensorInstruction,
  Transaction,
} from '@pumpking/anchor-client'
import { cellFromLatLng } from '@pumpking/shared/cell'
import { cellIdFromH3Index, h3IndexFromCellId } from '@pumpking/shared/cell-id'

/**
 * Registering this phone as a sensor, from this phone — `T038a`, `FR-005`,
 * `FR-007`, `FR-058`.
 *
 * Two keys sign one transaction. The operator's wallet pays the rent and the
 * stake and is who the sensor belongs to; the sensor key co-signs
 * `register_sensor`, so nobody can register a device under a wallet that is not
 * its owner's. Both keys were made on this phone and neither leaves it: the
 * transaction is built and signed here and sent to the cluster directly — the
 * API is not on the path, and no permission of anybody's is (`FR-007`).
 *
 * The instructions come from `@pumpking/anchor-client`, the same builders the
 * worker and the devnet scripts use, over the IDL the program emitted. A second
 * encoder here would be a second place for a discriminator to go stale.
 *
 * Moving the sensor to another cell (`T039`, `FR-059`) is here too: the same
 * two keys sign it, against the same chain, and it is the registration's
 * explicit act — a reading never moves a sensor by naming another cell.
 *
 * This module, Anchor, web3.js and `h3-js` load only when somebody opens
 * registration or a move: lazy chunks the policy screen (`SC-013`) never asks
 * for.
 */

/** What reading the chain needs — `Connection` has it all; a test fakes it. */
export type Chain = Pick<
  Connection,
  | 'getAccountInfo'
  | 'getBalance'
  | 'getLatestBlockhash'
  | 'sendRawTransaction'
  | 'getSignatureStatuses'
  | 'getBlockHeight'
>

/** The pool, as far as a registration cares. */
export type Network = {
  assetMint: PublicKey
  tokenProgram: PublicKey
  decimals: number
  minStake: bigint
}

/**
 * What the operator has, and what the chain already knows about this sensor
 * and its cell.
 */
export type Standing = {
  lamports: bigint
  tokens: bigint
  sensor: { operator: PublicKey; cellId: bigint; stake: bigint } | null
  /** Sensors already in the chosen cell; null when the cell has none yet. */
  cellSensors: number | null
}

/**
 * Enough SOL to register in a cell nobody has opened yet: rent for the
 * `Sensor` (~0.0016) and the `CellState` (~0.006), a token account (~0.002),
 * fees. The faucet sends 0.03; below this the page asks it before sending a
 * transaction the cluster would refuse.
 */
export const LAMPORTS_TO_REGISTER = 15_000_000n

/** The cluster at `rpcUrl`. Here, not in the view, so `Buffer` is in place first. */
export function chainAt(rpcUrl: string): Chain {
  return new Connection(rpcUrl, 'confirmed')
}

/** The program a build was pointed at, or the one the IDL names. */
export function programIdOf(text: string | undefined): PublicKey {
  return text === undefined || text === '' ? PROGRAM_ID : new PublicKey(text)
}

/** The `u64` a hex cell is on chain. */
export function cellIdOf(hex: string): bigint {
  return cellIdFromH3Index(hex)
}

/** The cell of a pair of coordinates, in the hex a reading carries. */
export function cellOf(lat: number, lng: number): string {
  return h3IndexFromCellId(cellFromLatLng(lat, lng))
}

export async function readNetwork(
  chain: Chain,
  programId: PublicKey = PROGRAM_ID,
): Promise<Network | null> {
  const poolInfo = await chain.getAccountInfo(poolPda(programId).address)
  if (poolInfo === null) return null
  const pool = decodePool(Uint8Array.from(poolInfo.data))
  const mintInfo = await chain.getAccountInfo(pool.assetMint)
  if (mintInfo === null) return null
  return {
    assetMint: pool.assetMint,
    tokenProgram: mintInfo.owner,
    decimals: decodeMintDecimals(Uint8Array.from(mintInfo.data)),
    minStake: BigInt(pool.minStake.toString()),
  }
}

export async function readStanding(
  chain: Chain,
  network: Network,
  operator: PublicKey,
  sensorKey: PublicKey,
  cellId: bigint,
  programId: PublicKey = PROGRAM_ID,
): Promise<Standing> {
  const tokenAccount = associatedTokenAddress(operator, network.assetMint, network.tokenProgram)
  const [lamports, tokenInfo, sensorInfo, cellInfo] = await Promise.all([
    chain.getBalance(operator),
    chain.getAccountInfo(tokenAccount),
    chain.getAccountInfo(sensorPda(sensorKey, programId).address),
    chain.getAccountInfo(cellPda(cellId, programId).address),
  ])
  const sensor = sensorInfo === null ? null : decodeSensor(Uint8Array.from(sensorInfo.data))
  return {
    lamports: BigInt(lamports),
    tokens: tokenInfo === null ? 0n : decodeTokenAmount(Uint8Array.from(tokenInfo.data)),
    sensor:
      sensor === null
        ? null
        : {
            operator: sensor.operator,
            cellId: BigInt(sensor.cellId.toString()),
            stake: BigInt(sensor.stake.toString()),
          },
    cellSensors:
      cellInfo === null ? null : decodeCellState(Uint8Array.from(cellInfo.data)).sensorCount,
  }
}

/** What is left to do, decided from the chain and nothing else. */
export type Plan =
  | { kind: 'register'; stake: bigint }
  | { kind: 'stake'; stake: bigint }
  | { kind: 'done' }
  /** The key is registered under a wallet that is not this phone's operator. */
  | { kind: 'foreign' }
  /** The cell holds as many sensors as the program allows. */
  | { kind: 'cell-full' }

export function planFor(standing: Standing, network: Network, operator: PublicKey): Plan {
  const { sensor } = standing
  if (sensor === null) {
    if (standing.cellSensors !== null && standing.cellSensors >= SENSOR_SLOTS) {
      return { kind: 'cell-full' }
    }
    return { kind: 'register', stake: network.minStake }
  }
  if (!sensor.operator.equals(operator)) return { kind: 'foreign' }
  if (sensor.stake < network.minStake)
    return { kind: 'stake', stake: network.minStake - sensor.stake }
  return { kind: 'done' }
}

/** Whether the operator has to ask the faucet before the plan can be sent. */
export function needsFaucet(standing: Standing, plan: Plan): boolean {
  if (plan.kind !== 'register' && plan.kind !== 'stake') return false
  const lamportsNeeded = plan.kind === 'register' ? LAMPORTS_TO_REGISTER : 100_000n
  return standing.lamports < lamportsNeeded || standing.tokens < plan.stake
}

/**
 * The transaction, unsigned: the operator's token account (opened if the
 * faucet has not already), the registration when there is one to make, the
 * stake. One transaction, so a phone never ends up registered and unstaked —
 * a sensor whose readings the API would store and not count.
 */
export function registrationTransaction(input: {
  operator: PublicKey
  sensorKey: PublicKey
  cellId: bigint
  network: Network
  plan: { kind: 'register' | 'stake'; stake: bigint }
  programId?: PublicKey
}): Transaction {
  const { operator, sensorKey, network, plan } = input
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
  )
  if (plan.kind === 'register') {
    tx.add(registerSensorInstruction({ operator, sensorKey, cellId: input.cellId, programId }))
  }
  tx.add(
    stakeSensorInstruction({
      operator,
      sensorKey,
      assetMint: network.assetMint,
      operatorTokens,
      amount: plan.stake,
      tokenProgram: network.tokenProgram,
      programId,
    }),
  )
  return tx
}

/** A transaction the cluster refused, with the line of its logs that says why. */
export class TransactionFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransactionFailed'
  }
}

/** The program's own words for a failure, when its logs carry them. */
function reasonOf(cause: unknown): string {
  const logs =
    typeof cause === 'object' && cause !== null && 'logs' in cause && Array.isArray(cause.logs)
      ? (cause.logs as unknown[]).filter((line): line is string => typeof line === 'string')
      : []
  const anchor = logs.find((line) => line.includes('Error Message:'))
  if (anchor !== undefined) return anchor.slice(anchor.indexOf('Error Message:') + 15).trim()
  return cause instanceof Error ? cause.message : String(cause)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Signs, sends, and waits for `confirmed` by asking — not by a websocket
 * subscription, which a phone on a flaky link loses without saying so. Gives up
 * once the blockhash has expired: past that height the transaction can no
 * longer land, and saying so is better than waiting forever.
 */
export async function sendAndConfirm(
  chain: Chain,
  tx: Transaction,
  signers: readonly Keypair[],
  pollMs = 1000,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.sign(...signers)
  let signature: string
  try {
    signature = await chain.sendRawTransaction(tx.serialize(), {
      preflightCommitment: 'confirmed',
    })
  } catch (cause) {
    throw new TransactionFailed(reasonOf(cause))
  }
  for (;;) {
    const {
      value: [status],
    } = await chain.getSignatureStatuses([signature])
    if (status?.err)
      throw new TransactionFailed(`the transaction failed: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return signature
    }
    if ((await chain.getBlockHeight('confirmed')) > lastValidBlockHeight) {
      throw new TransactionFailed('the transaction expired before the cluster confirmed it')
    }
    await sleep(pollMs)
  }
}

/** A key pair from a 32-byte seed — both keys on this phone are kept that way. */
export function keypairOf(seed: Uint8Array): Keypair {
  return Keypair.fromSeed(seed)
}

/**
 * The operator's key as `solana-keygen` writes it: a JSON array of 64 bytes,
 * secret then public. A file the Solana CLI and every wallet import.
 */
export function operatorKeyFile(seed: Uint8Array): string {
  return JSON.stringify([...keypairOf(seed).secretKey])
}

/** Where a person can see a transaction for themselves. */
export function explorerUrl(signature: string, rpcUrl: string): string {
  const base = `https://explorer.solana.com/tx/${signature}`
  if (rpcUrl.includes('devnet')) return `${base}?cluster=devnet`
  if (rpcUrl.includes('testnet')) return `${base}?cluster=testnet`
  if (rpcUrl.includes('mainnet')) return base
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`
}

/* -------------------------------------------------------------------------- */
/* Moving — `T039`, `FR-059`                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Days between two moves: the old slot's record has to leave every window an
 * exclusion reads before the pointer may drop it. The program's constant, read
 * out of the IDL it emitted rather than copied.
 */
export const MOVE_SPACING_DAYS =
  Number(
    (PUMPKING_IDL as { constants?: { name: string; value: string }[] }).constants?.find(
      (constant) => constant.name === 'outlierWindowDays',
    )?.value ?? Number.NaN,
  ) + 1

/** Rent for a cell nobody has opened (~0.006 SOL) and the fee, with room. */
export const LAMPORTS_TO_MOVE = 8_000_000n

/** What the chain says about a move this phone is about to ask for. */
export type MoveStanding = {
  lamports: bigint
  sensor: {
    operator: PublicKey
    cellId: bigint
    /** The cell left on the last move; null when there is none to answer for. */
    previousCellId: bigint | null
    active: boolean
    /** Pool day of the last move, or null for a sensor that never moved. */
    lastMoveDay: number | null
  } | null
  /** What the slot before the last move still holds, in that cell's schedule. */
  unclaimed: bigint
  /** Sensors already in the new cell; null when the cell has none yet. */
  cellSensors: number | null
  /** The pool's day now. */
  today: number
}

/** The pool's day at `unixSeconds` — `Pool::day_index`. */
function poolDay(pool: { genesisTs: bigint; secondsPerDay: number }, unixSeconds: bigint): number {
  return Number((unixSeconds - pool.genesisTs) / BigInt(pool.secondsPerDay))
}

export async function readMoveStanding(
  chain: Chain,
  operator: PublicKey,
  sensorKey: PublicKey,
  cellId: bigint,
  now: Date,
  programId: PublicKey = PROGRAM_ID,
): Promise<MoveStanding | null> {
  const [poolInfo, lamports, sensorInfo, cellInfo] = await Promise.all([
    chain.getAccountInfo(poolPda(programId).address),
    chain.getBalance(operator),
    chain.getAccountInfo(sensorPda(sensorKey, programId).address),
    chain.getAccountInfo(cellPda(cellId, programId).address),
  ])
  if (poolInfo === null) return null
  const decodedPool = decodePool(Uint8Array.from(poolInfo.data))
  const pool = {
    genesisTs: BigInt(decodedPool.genesisTs.toString()),
    secondsPerDay: decodedPool.secondsPerDay,
  }
  const today = poolDay(pool, BigInt(Math.floor(now.getTime() / 1000)))
  const cellSensors =
    cellInfo === null ? null : decodeCellState(Uint8Array.from(cellInfo.data)).sensorCount
  if (sensorInfo === null) {
    return { lamports: BigInt(lamports), sensor: null, unclaimed: 0n, cellSensors, today }
  }

  const sensor = decodeSensor(Uint8Array.from(sensorInfo.data))
  const current = BigInt(sensor.cellId.toString())
  const previous = BigInt(sensor.previousCellId.toString())
  // "No previous slot" is the current one on chain.
  const moved = previous !== current || sensor.previousSlot !== sensor.slotInCell
  let unclaimed = 0n
  if (moved) {
    const rewardsInfo = await chain.getAccountInfo(rewardsPda(previous, programId).address)
    if (rewardsInfo !== null) {
      const rewards = decodeCellRewards(Uint8Array.from(rewardsInfo.data))
      unclaimed = BigInt((rewards.accrued[sensor.previousSlot] ?? 0).toString())
    }
  }
  return {
    lamports: BigInt(lamports),
    sensor: {
      operator: sensor.operator,
      cellId: current,
      previousCellId: moved ? previous : null,
      active: sensor.active,
      lastMoveDay:
        sensor.movedAt === null ? null : poolDay(pool, BigInt(sensor.movedAt.toString())),
    },
    unclaimed,
    cellSensors,
    today,
  }
}

/** What moving to the chosen cell comes to, decided from the chain. */
export type MovePlan =
  /** `claim` is what the slot left behind earned: claimed in the same transaction, first. */
  | { kind: 'move'; previousCellId: bigint; claim: bigint }
  | { kind: 'unregistered' }
  | { kind: 'foreign' }
  | { kind: 'excluded' }
  | { kind: 'same-cell' }
  | { kind: 'cell-full' }
  /** The last move was too recent; the pool day it may move again on. */
  | { kind: 'too-soon'; day: number }
  | { kind: 'no-sol' }

export function movePlanFor(standing: MoveStanding, cellId: bigint, operator: PublicKey): MovePlan {
  const { sensor } = standing
  if (sensor === null) return { kind: 'unregistered' }
  if (!sensor.operator.equals(operator)) return { kind: 'foreign' }
  if (!sensor.active) return { kind: 'excluded' }
  if (sensor.cellId === cellId) return { kind: 'same-cell' }
  if (sensor.lastMoveDay !== null && standing.today < sensor.lastMoveDay + MOVE_SPACING_DAYS) {
    return { kind: 'too-soon', day: sensor.lastMoveDay + MOVE_SPACING_DAYS }
  }
  if (standing.cellSensors !== null && standing.cellSensors >= SENSOR_SLOTS) {
    return { kind: 'cell-full' }
  }
  if (standing.lamports < LAMPORTS_TO_MOVE) return { kind: 'no-sol' }
  return {
    kind: 'move',
    // The program seeds the schedule it checks by the pointer as it stands:
    // the cell left last time, or the sensor's own cell if it never moved.
    previousCellId: sensor.previousCellId ?? sensor.cellId,
    claim: standing.unclaimed,
  }
}

/**
 * The move, unsigned: what the slot left last time earned, claimed to the
 * operator's token account when there is any — the program will not let the
 * pointer move past a slot with earnings on it — then `move_sensor`.
 */
export function moveTransaction(input: {
  operator: PublicKey
  sensorKey: PublicKey
  cellId: bigint
  network: Network
  plan: { kind: 'move'; previousCellId: bigint; claim: bigint }
  programId?: PublicKey
}): Transaction {
  const { operator, sensorKey, network, plan } = input
  const programId = input.programId ?? PROGRAM_ID
  const tx = new Transaction()
  tx.feePayer = operator
  if (plan.claim > 0n) {
    tx.add(
      claimRewardInstruction({
        caller: operator,
        sensorKey,
        cellId: plan.previousCellId,
        assetMint: network.assetMint,
        operatorTokens: associatedTokenAddress(operator, network.assetMint, network.tokenProgram),
        tokenProgram: network.tokenProgram,
        programId,
      }),
    )
  }
  tx.add(
    moveSensorInstruction({
      operator,
      sensorKey,
      cellId: input.cellId,
      previousCellId: plan.previousCellId,
      programId,
    }),
  )
  return tx
}

/* -------------------------------------------------------------------------- */
/* The faucet                                                                 */
/* -------------------------------------------------------------------------- */

export type FaucetAnswer =
  | { kind: 'granted'; signature: string }
  /** The wallet had its grant already — what it holds is what it gets. */
  | { kind: 'already' }
  | { kind: 'refused'; message: string }

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** `POST /v1/faucet/:pubkey` — `apps/api/src/routes/faucet.ts`. */
export async function askFaucet(
  apiUrl: string,
  wallet: string,
  fetchFn: Fetch,
): Promise<FaucetAnswer> {
  let response: Response
  try {
    response = await fetchFn(`${apiUrl}/v1/faucet/${wallet}`, { method: 'POST' })
  } catch {
    return { kind: 'refused', message: 'The faucet did not answer. Check the connection.' }
  }
  const json = record(await response.json().catch(() => null))
  if (response.status === 201) {
    const signature = json?.signature
    if (typeof signature === 'string') return { kind: 'granted', signature }
    return { kind: 'refused', message: 'The faucet answered in a shape this page does not know.' }
  }
  if (response.status === 404) {
    return {
      kind: 'refused',
      message:
        'This deployment has no faucet. Send devnet SOL and the pool’s asset to the operator wallet above, then register.',
    }
  }
  const error = record(json?.error)
  // A 409 that names a signature is "this wallet had its grant"; one without is
  // a refusal with a reason (no pool on this network).
  const details = record(error?.details)
  if (response.status === 409 && details !== null && 'signature' in details) {
    return { kind: 'already' }
  }
  const message = error?.message
  return {
    kind: 'refused',
    message: typeof message === 'string' ? message : `The faucet answered ${response.status}.`,
  }
}
