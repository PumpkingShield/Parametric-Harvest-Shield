import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  decodeInstruction,
  Keypair,
  PROGRAM_ID,
  PublicKey,
  TOKEN_PROGRAM_ID,
} from '@pumpking/anchor-client'
import { describe, expect, it } from 'vitest'
import {
  askFaucet,
  type Chain,
  cellOf,
  explorerUrl,
  keypairOf,
  LAMPORTS_TO_MOVE,
  LAMPORTS_TO_REGISTER,
  MOVE_SPACING_DAYS,
  type MoveStanding,
  movePlanFor,
  moveTransaction,
  type Network,
  needsFaucet,
  operatorKeyFile,
  planFor,
  readMoveStanding,
  registrationTransaction,
  type Standing,
  sendAndConfirm,
  TransactionFailed,
} from './register.ts'

const operator = keypairOf(new Uint8Array(32).fill(1))
const sensor = keypairOf(new Uint8Array(32).fill(2))
const CELL = 0x871e701b3ffffffn

const network: Network = {
  assetMint: new PublicKey(new Uint8Array(32).fill(5)),
  tokenProgram: TOKEN_PROGRAM_ID,
  decimals: 6,
  minStake: 1_000_000n,
}

function standing(overrides: Partial<Standing> = {}): Standing {
  return {
    lamports: 30_000_000n,
    tokens: 1_000_000n,
    sensor: null,
    cellSensors: null,
    ...overrides,
  }
}

describe('the cell of where the phone is', () => {
  it('is the H3 cell at the network’s level, as hex', () => {
    // Kyiv, Maidan: the same function the server would run, here on the phone.
    expect(cellOf(50.4501, 30.5234)).toMatch(/^87[0-9a-f]{13}$/)
  })

  it('refuses coordinates that are not on Earth rather than folding them over a pole', () => {
    expect(() => cellOf(100, 25)).toThrow(RangeError)
  })
})

describe('planFor', () => {
  it('registers and stakes the minimum for a key the chain has never seen', () => {
    expect(planFor(standing(), network, operator.publicKey)).toEqual({
      kind: 'register',
      stake: 1_000_000n,
    })
  })

  it('tops a registered sensor up to the minimum, and no further', () => {
    const plan = planFor(
      standing({ sensor: { operator: operator.publicKey, cellId: CELL, stake: 400_000n } }),
      network,
      operator.publicKey,
    )
    expect(plan).toEqual({ kind: 'stake', stake: 600_000n })
  })

  it('has nothing to do for a sensor staked at the minimum', () => {
    const plan = planFor(
      standing({ sensor: { operator: operator.publicKey, cellId: CELL, stake: 1_000_000n } }),
      network,
      operator.publicKey,
    )
    expect(plan).toEqual({ kind: 'done' })
  })

  it('will not touch a key registered under somebody else’s wallet', () => {
    const plan = planFor(
      standing({ sensor: { operator: sensor.publicKey, cellId: CELL, stake: 0n } }),
      network,
      operator.publicKey,
    )
    expect(plan).toEqual({ kind: 'foreign' })
  })

  it('says a full cell is full before the cluster does', () => {
    expect(planFor(standing({ cellSensors: 32 }), network, operator.publicKey)).toEqual({
      kind: 'cell-full',
    })
    expect(planFor(standing({ cellSensors: 31 }), network, operator.publicKey).kind).toBe(
      'register',
    )
  })
})

describe('needsFaucet', () => {
  const register = { kind: 'register', stake: 1_000_000n } as const

  it('is not needed by a wallet that has both', () => {
    expect(needsFaucet(standing(), register)).toBe(false)
  })

  it('is needed for too little SOL, or too little of the asset', () => {
    expect(needsFaucet(standing({ lamports: LAMPORTS_TO_REGISTER - 1n }), register)).toBe(true)
    expect(needsFaucet(standing({ tokens: 999_999n }), register)).toBe(true)
  })

  it('is never asked when there is nothing to send', () => {
    expect(needsFaucet(standing({ lamports: 0n, tokens: 0n }), { kind: 'done' })).toBe(false)
  })
})

describe('registrationTransaction', () => {
  it('opens the token account, registers and stakes, in one transaction both keys sign', () => {
    const tx = registrationTransaction({
      operator: operator.publicKey,
      sensorKey: sensor.publicKey,
      cellId: CELL,
      network,
      plan: { kind: 'register', stake: 1_000_000n },
    })
    expect(tx.instructions.map((ix) => ix.programId.toBase58())).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      PROGRAM_ID.toBase58(),
      PROGRAM_ID.toBase58(),
    ])
    tx.recentBlockhash = PublicKey.default.toBase58()
    const message = tx.compileMessage()
    // The operator pays; the sensor key co-signs, or anybody could register
    // somebody else's device.
    expect(message.header.numRequiredSignatures).toBe(2)
    expect(message.accountKeys[0]?.equals(operator.publicKey)).toBe(true)
    tx.sign(operator, sensor)
    // The packet limit: a registration that does not fit is one that never goes.
    expect(tx.serialize().length).toBeLessThanOrEqual(1232)
  })

  it('only stakes when the sensor is already registered, and asks only the operator', () => {
    const tx = registrationTransaction({
      operator: operator.publicKey,
      sensorKey: sensor.publicKey,
      cellId: CELL,
      network,
      plan: { kind: 'stake', stake: 600_000n },
    })
    expect(tx.instructions).toHaveLength(2)
    tx.recentBlockhash = PublicKey.default.toBase58()
    expect(tx.compileMessage().header.numRequiredSignatures).toBe(1)
  })
})

/** A cluster that answers from a script. */
function fakeChain(script: {
  statuses?: Array<{ err: unknown; confirmationStatus?: string } | null>
  heights?: number[]
  sendError?: unknown
}): Chain & { sent: Uint8Array[] } {
  const statuses = [...(script.statuses ?? [])]
  const heights = [...(script.heights ?? [])]
  const sent: Uint8Array[] = []
  const chain = {
    sent,
    getLatestBlockhash: () =>
      Promise.resolve({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }),
    sendRawTransaction: (raw: Uint8Array) => {
      if (script.sendError !== undefined) return Promise.reject(script.sendError)
      sent.push(raw)
      return Promise.resolve('sig')
    },
    getSignatureStatuses: () =>
      Promise.resolve({ context: { slot: 1 }, value: [statuses.shift() ?? null] }),
    getBlockHeight: () => Promise.resolve(heights.shift() ?? 0),
    getAccountInfo: () => Promise.resolve(null),
    getBalance: () => Promise.resolve(0),
  }
  return chain as unknown as Chain & { sent: Uint8Array[] }
}

function stakeTx() {
  return registrationTransaction({
    operator: operator.publicKey,
    sensorKey: sensor.publicKey,
    cellId: CELL,
    network,
    plan: { kind: 'stake', stake: 1n },
  })
}

describe('sendAndConfirm', () => {
  it('asks until the cluster says confirmed', async () => {
    const chain = fakeChain({
      statuses: [
        null,
        { err: null, confirmationStatus: 'processed' },
        { err: null, confirmationStatus: 'confirmed' },
      ],
    })
    expect(await sendAndConfirm(chain, stakeTx(), [operator], 0)).toBe('sig')
    expect(chain.sent).toHaveLength(1)
  })

  it('reports a transaction that landed and failed', async () => {
    const chain = fakeChain({ statuses: [{ err: { InstructionError: [1, 'Custom'] } }] })
    await expect(sendAndConfirm(chain, stakeTx(), [operator], 0)).rejects.toThrow(TransactionFailed)
  })

  it('stops waiting once the blockhash has expired', async () => {
    const chain = fakeChain({ statuses: [null, null], heights: [99, 101] })
    await expect(sendAndConfirm(chain, stakeTx(), [operator], 0)).rejects.toThrow(/expired/)
  })

  it('gives the program’s own reason when preflight refuses', async () => {
    const refusal = Object.assign(new Error('Simulation failed'), {
      logs: [
        'Program log: AnchorError occurred. Error Code: CellIsFull. Error Number: 6046. Error Message: The cell has no free slot left in its contributors mask.',
      ],
    })
    const chain = fakeChain({ sendError: refusal })
    await expect(sendAndConfirm(chain, stakeTx(), [operator], 0)).rejects.toThrow(
      'The cell has no free slot left in its contributors mask.',
    )
  })
})

describe('askFaucet', () => {
  const answer = (status: number, body: unknown) => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))

  it('reads a grant', async () => {
    expect(
      await askFaucet('http://api', 'w', answer(201, { mock: true, signature: 'abc' })),
    ).toEqual({ kind: 'granted', signature: 'abc' })
  })

  it('takes "had it already" as an answer, not a failure', async () => {
    const body = { error: { code: 'CONFLICT', message: 'x', details: { signature: 'abc' } } }
    expect(await askFaucet('http://api', 'w', answer(409, body))).toEqual({ kind: 'already' })
  })

  it('passes on a refusal’s reason', async () => {
    const body = {
      error: { code: 'CONFLICT', message: 'there is no pool on this network yet', details: {} },
    }
    expect(await askFaucet('http://api', 'w', answer(409, body))).toEqual({
      kind: 'refused',
      message: 'there is no pool on this network yet',
    })
  })

  it('says how to register without a faucet when the deployment has none', async () => {
    const result = await askFaucet('http://api', 'w', answer(404, {}))
    expect(result.kind).toBe('refused')
    expect(result.kind === 'refused' && result.message).toMatch(/no faucet/)
  })

  it('survives no answer at all', async () => {
    const result = await askFaucet('http://api', 'w', () =>
      Promise.reject(new TypeError('offline')),
    )
    expect(result).toEqual({
      kind: 'refused',
      message: 'The faucet did not answer. Check the connection.',
    })
  })
})

describe('the operator key file', () => {
  it('is what solana-keygen writes: 64 bytes, the public key last', () => {
    const seed = new Uint8Array(32).fill(1)
    const bytes = JSON.parse(operatorKeyFile(seed)) as number[]
    expect(bytes).toHaveLength(64)
    expect(Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey.equals(operator.publicKey)).toBe(
      true,
    )
  })
})

describe('explorerUrl', () => {
  it('names the cluster the page sent to', () => {
    expect(explorerUrl('s', 'https://api.devnet.solana.com')).toBe(
      'https://explorer.solana.com/tx/s?cluster=devnet',
    )
    expect(explorerUrl('s', 'http://127.0.0.1:8899')).toBe(
      'https://explorer.solana.com/tx/s?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899',
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Moving — T039                                                              */
/* -------------------------------------------------------------------------- */

const NEIGHBOUR = 0x871e701b2ffffffn

function moveStanding(
  sensorOverrides: Partial<NonNullable<MoveStanding['sensor']>> = {},
  overrides: Partial<MoveStanding> = {},
): MoveStanding {
  return {
    lamports: 30_000_000n,
    sensor: {
      operator: operator.publicKey,
      cellId: CELL,
      previousCellId: null,
      active: true,
      lastMoveDay: null,
      ...sensorOverrides,
    },
    unclaimed: 0n,
    cellSensors: 3,
    today: 40,
    ...overrides,
  }
}

describe('movePlanFor', () => {
  it('moves a sensor that never moved, the program checking its own cell for the pointer', () => {
    expect(movePlanFor(moveStanding(), NEIGHBOUR, operator.publicKey)).toEqual({
      kind: 'move',
      previousCellId: CELL,
      claim: 0n,
    })
  })

  it('claims what the slot left last time earned in the same transaction', () => {
    const plan = movePlanFor(
      moveStanding(
        { cellId: NEIGHBOUR, previousCellId: CELL, lastMoveDay: 20 },
        { unclaimed: 2_500n },
      ),
      CELL,
      operator.publicKey,
    )
    expect(plan).toEqual({ kind: 'move', previousCellId: CELL, claim: 2_500n })
  })

  it('waits a window and a day after the last move, as the program does', () => {
    expect(MOVE_SPACING_DAYS).toBe(15)
    const standing = moveStanding({ cellId: NEIGHBOUR, previousCellId: CELL, lastMoveDay: 30 })
    expect(movePlanFor({ ...standing, today: 44 }, CELL, operator.publicKey)).toEqual({
      kind: 'too-soon',
      day: 45,
    })
    expect(movePlanFor({ ...standing, today: 45 }, CELL, operator.publicKey).kind).toBe('move')
  })

  it('says why it will not send, before the chain does', () => {
    const other = keypairOf(new Uint8Array(32).fill(9)).publicKey
    const cases: Array<[MoveStanding, bigint, string]> = [
      [{ ...moveStanding(), sensor: null }, NEIGHBOUR, 'unregistered'],
      [moveStanding({ operator: other }), NEIGHBOUR, 'foreign'],
      [moveStanding({ active: false }), NEIGHBOUR, 'excluded'],
      [moveStanding(), CELL, 'same-cell'],
      [moveStanding({}, { cellSensors: 32 }), NEIGHBOUR, 'cell-full'],
      [moveStanding({}, { lamports: LAMPORTS_TO_MOVE - 1n }), NEIGHBOUR, 'no-sol'],
    ]
    for (const [standing, cell, kind] of cases) {
      expect(movePlanFor(standing, cell, operator.publicKey).kind).toBe(kind)
    }
  })
})

describe('moveTransaction', () => {
  it('is one move both keys sign, the operator paying', () => {
    const tx = moveTransaction({
      operator: operator.publicKey,
      sensorKey: sensor.publicKey,
      cellId: NEIGHBOUR,
      network,
      plan: { kind: 'move', previousCellId: CELL, claim: 0n },
    })
    expect(tx.instructions).toHaveLength(1)
    tx.recentBlockhash = PublicKey.default.toBase58()
    const message = tx.compileMessage()
    expect(message.header.numRequiredSignatures).toBe(2)
    expect(message.accountKeys[0]?.equals(operator.publicKey)).toBe(true)
  })

  it('claims the slot left last time first, when it holds anything', () => {
    const tx = moveTransaction({
      operator: operator.publicKey,
      sensorKey: sensor.publicKey,
      cellId: CELL,
      network,
      plan: { kind: 'move', previousCellId: CELL, claim: 2_500n },
    })
    expect(tx.instructions.map((ix) => decodeInstruction(ix.data)?.name)).toEqual([
      'claimReward',
      'moveSensor',
    ])
    tx.recentBlockhash = PublicKey.default.toBase58()
    tx.sign(operator, sensor)
    expect(tx.serialize().length).toBeLessThanOrEqual(1232)
  })
})

describe('readMoveStanding', () => {
  it('reads nothing into a network without a pool', async () => {
    expect(
      await readMoveStanding(fakeChain({}), operator.publicKey, sensor.publicKey, CELL, new Date()),
    ).toBeNull()
  })
})
