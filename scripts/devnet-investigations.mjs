// Cells under investigation, and closing one — `close_investigation` (T044, FR-045).
// Run: node scripts/devnet-investigations.mjs [--close <h3 index> [--send]]
//
// Without arguments it lists every cell under investigation. The worker opens
// an investigation by itself when a cell's disputed dry days reach the
// published count; only the pool authority closes one, and that is a judgement
// made after looking at the evidence, so this script never closes anything it
// was not named. The disputed days are in the `InvestigationOpened` event and
// in `/v1/cells/:cellId/days` (`reference.state = "disputed"`).
//
// Without --send, `--close` only says what it would do.

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  CELL_STATE_DISCRIMINATOR,
  Connection,
  cellPda,
  closeInvestigationInstruction,
  decodeCellState,
  decodePool,
  Keypair,
  PROGRAM_ID,
  PublicKey,
  poolPda,
  sendAndConfirmTransaction,
  Transaction,
} from '../packages/anchor-client/src/index.ts'
import { encodeBase58, h3IndexFromCellId } from '../packages/shared/src/index.ts'

const ENV_PATH =
  process.env.PUMPKING_ENV === undefined || process.env.PUMPKING_ENV === ''
    ? new URL('../.env', import.meta.url)
    : process.env.PUMPKING_ENV

const { values: args } = parseArgs({
  options: {
    close: { type: 'string' },
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

// Origin only: the key rides in the query (Helius) or the path (Alchemy).
console.log('cluster  :', new URL(rpcUrl).origin)
console.log('program  :', programId.toBase58())

if (args.close === undefined) {
  const cells = await connection.getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: encodeBase58(CELL_STATE_DISCRIMINATOR) } }],
  })
  const flagged = cells
    .map(({ account }) => decodeCellState(Uint8Array.from(account.data)))
    .filter((cell) => cell.underInvestigation)
  console.log()
  if (flagged.length === 0) console.log('no cell is under investigation.')
  for (const cell of flagged) {
    console.log(
      `  ${h3IndexFromCellId(BigInt(cell.cellId.toString()))} — under investigation, owes ${cell.reserved.toString()} to live policies`,
    )
  }
  process.exit(0)
}

if (!/^[0-9a-f]{15}$/i.test(args.close)) fail('--close takes an H3 index in hex, 15 digits')
const cellId = BigInt(`0x${args.close}`)
const info = await connection.getAccountInfo(cellPda(cellId, programId).address)
if (info === null) fail(`no cell ${args.close} on this cluster`)
if (!decodeCellState(Uint8Array.from(info.data)).underInvestigation) {
  fail(`cell ${args.close} is not under investigation — nothing to close`)
}

if (!args.send) {
  console.log(`\nwould close the investigation of ${args.close} — add --send to sign with POOL_AUTHORITY_KEYPAIR.`)
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
    closeInvestigationInstruction({ authority: authority.publicKey, cellId, programId }),
  ),
  [authority],
  { commitment: 'confirmed' },
)
console.log('\nsent:', signature)
