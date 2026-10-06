// Re-weighs the price of collusion — `set_pool_params` (T041a, FR-054).
// Run: node scripts/devnet-set-params.mjs --min-stake 1250 --exposure-bps 25 [--send]
//
// Without --send it only reads the pool and prints what would change: both
// parameters, the two bounds of the cell limit before and after, which one
// binds, and every cell whose live policies already owe more than the new
// limit allows. A lower limit refuses the next sale and leaves those policies
// alone, but a demo whose show cell is already over it sells nothing there
// until they close — better seen here than in the middle of a show.
//
// It also counts the sensors that stop voting: a higher minimum takes the
// vote from every sensor staked below it until its operator tops it up.

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  CELL_STATE_DISCRIMINATOR,
  Connection,
  decodeCellState,
  decodePool,
  decodeSensor,
  Keypair,
  PROGRAM_ID,
  PublicKey,
  poolPda,
  SENSOR_DISCRIMINATOR,
  sendAndConfirmTransaction,
  setPoolParamsInstruction,
  Transaction,
} from '../packages/anchor-client/src/index.ts'
import {
  capitalExposureLimit,
  cellExposureLimit,
  collusionExposureLimit,
  collusionFloor,
  collusionHolds,
  encodeBase58,
  h3IndexFromCellId,
} from '../packages/shared/src/index.ts'

const ENV_PATH =
  process.env.PUMPKING_ENV === undefined || process.env.PUMPKING_ENV === ''
    ? new URL('../.env', import.meta.url)
    : process.env.PUMPKING_ENV

const { values: args } = parseArgs({
  options: {
    'min-stake': { type: 'string' },
    'exposure-bps': { type: 'string' },
    decimals: { type: 'string', default: '6' },
    send: { type: 'boolean', default: false },
  },
})

function env() {
  const text = readFileSync(ENV_PATH, 'utf8')
  const found = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match !== null) found[match[1]] = match[2].trim()
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (/^[A-Z_]+$/.test(name) && value !== undefined && value !== '') found[name] = value
  }
  return found
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const decimals = BigInt(args.decimals)
const unit = 10n ** decimals
const tokens = (base) => {
  const whole = base / unit
  const frac = (base % unit).toString().padStart(Number(decimals), '0').replace(/0+$/, '')
  return frac === '' ? whole.toString() : `${whole}.${frac}`
}

const values = env()
const rpcUrl =
  values.SOLANA_RPC_URL === undefined || values.SOLANA_RPC_URL === ''
    ? 'https://api.devnet.solana.com'
    : values.SOLANA_RPC_URL
const programId =
  values.PUMPKING_PROGRAM_ID === undefined || values.PUMPKING_PROGRAM_ID === ''
    ? PROGRAM_ID
    : new PublicKey(values.PUMPKING_PROGRAM_ID)

const connection = new Connection(rpcUrl, 'confirmed')
const poolInfo = await connection.getAccountInfo(poolPda(programId).address)
if (poolInfo === null) fail('no pool on this cluster — run scripts/devnet-init.mjs first')
const pool = decodePool(Uint8Array.from(poolInfo.data))

const now = {
  minStake: BigInt(pool.minStake.toString()),
  minVotes: pool.minSensorsPerCell,
  capitalTotal: BigInt(pool.capitalTotal.toString()),
  cellExposureBps: pool.cellExposureBps,
}
const next = {
  ...now,
  minStake: args['min-stake'] === undefined ? now.minStake : BigInt(args['min-stake']) * unit,
  cellExposureBps:
    args['exposure-bps'] === undefined ? now.cellExposureBps : Number(args['exposure-bps']),
}
if (next.minStake <= 0n) fail('--min-stake must be above zero: the program refuses a free vote')
if (!Number.isInteger(next.cellExposureBps) || next.cellExposureBps < 1 || next.cellExposureBps > 10_000) {
  fail('--exposure-bps must be an integer in 1..10000')
}

// Origin only: the key rides in the query (Helius) or the path (Alchemy).
console.log('cluster  :', new URL(rpcUrl).origin)
console.log('program  :', programId.toBase58())
console.log('capital  :', tokens(now.capitalTotal), 'mock USDC')
console.log()
for (const [label, p] of [
  ['now ', now],
  ['next', next],
]) {
  const capital = capitalExposureLimit(p)
  const collusion = collusionExposureLimit(p)
  console.log(
    `${label}: min_stake ${tokens(p.minStake)}, cell_exposure_bps ${p.cellExposureBps}` +
      ` → share ${tokens(capital)}, half the floor ${tokens(collusion)},` +
      ` cell limit ${tokens(cellExposureLimit(p))} (${collusion < capital ? 'collusion' : 'capital'} binds);` +
      ` SC-014 on the parameters: ${collusionHolds(collusionFloor(p), capital) ? 'holds' : 'FAILS'}`,
  )
}

const limit = cellExposureLimit(next)
const cells = await connection.getProgramAccounts(programId, {
  filters: [{ memcmp: { offset: 0, bytes: encodeBase58(CELL_STATE_DISCRIMINATOR) } }],
})
const over = cells
  .map(({ account }) => decodeCellState(Uint8Array.from(account.data)))
  .filter((cell) => BigInt(cell.reserved.toString()) > limit)
console.log()
if (over.length === 0) {
  console.log('no cell owes more than the new limit.')
} else {
  console.log(`cells already over the new limit — no new cover there until their policies close:`)
  for (const cell of over) {
    console.log(`  ${h3IndexFromCellId(BigInt(cell.cellId.toString()))} owes ${tokens(BigInt(cell.reserved.toString()))}`)
  }
}

const sensors = await connection.getProgramAccounts(programId, {
  filters: [{ memcmp: { offset: 0, bytes: encodeBase58(SENSOR_DISCRIMINATOR) } }],
})
const losing = sensors
  .map(({ account }) => decodeSensor(Uint8Array.from(account.data)))
  .filter((s) => s.active && BigInt(s.stake.toString()) >= now.minStake && BigInt(s.stake.toString()) < next.minStake)
console.log(
  losing.length === 0
    ? 'no voting sensor falls below the new minimum.'
    : `${losing.length} voting sensor(s) fall below the new minimum and stop voting until topped up.`,
)

if (!args.send) {
  console.log('\ndry run — add --send to sign with POOL_AUTHORITY_KEYPAIR.')
  process.exit(0)
}

const secret = values.POOL_AUTHORITY_KEYPAIR
if (secret === undefined || secret === '') fail('POOL_AUTHORITY_KEYPAIR is missing from .env')
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)))
if (!authority.publicKey.equals(pool.authority)) {
  fail(`POOL_AUTHORITY_KEYPAIR is ${authority.publicKey.toBase58()}, the pool's authority is ${pool.authority.toBase58()}`)
}

const signature = await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    setPoolParamsInstruction({
      authority: authority.publicKey,
      params: { cellExposureBps: next.cellExposureBps, minStake: next.minStake },
      programId,
    }),
  ),
  [authority],
  { commitment: 'confirmed' },
)
console.log('\nsent:', signature)
