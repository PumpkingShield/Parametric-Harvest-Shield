// Initialises the pool and seeds its capital — step 0 of docs/DEPLOY.md.
// Run (after devnet-deploy.sh and devnet-prepare.sh): node scripts/devnet-init.mjs
//
// The two instructions here are the program's own, so they are built with the
// project's own builders rather than by hand: a pool whose parameters disagree
// with the scenario file is a run whose result does not match the fixture, and
// nobody would be able to tell from the outside which of the two was wrong.
//
// Capital is seeded through `deposit_capital` — the same public instruction an
// outside underwriter would use — and not through a separate seeding path. A
// second way into the vault would be one nobody exercises in production, which
// is to say an untested one, and it would hand the authority power over money
// that FR-030 deliberately denies it.

import { readFileSync } from 'node:fs'
import {
  Connection,
  depositCapitalInstruction,
  initializePoolInstruction,
  Keypair,
  PROGRAM_ID,
  PublicKey,
  decodePool,
  poolPda,
  sendAndConfirmTransaction,
  Transaction,
  vaultPda,
} from '../packages/anchor-client/src/index.ts'

const ENV_PATH = new URL('../.env', import.meta.url)
const SCENARIO_PATH = new URL('../fixtures/scenarios/drought.json', import.meta.url)

/** Whole tokens moved into the pool as underwriting capital. */
const CAPITAL_TOKENS = 500_000n
const DECIMALS = 6n

function env() {
  const text = readFileSync(ENV_PATH, 'utf8')
  const found = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match !== null) found[match[1]] = match[2].trim()
  }
  return found
}

function required(values, name, hint) {
  const value = values[name]
  if (value === undefined || value === '') {
    console.error(`${name} is missing from .env — ${hint}`)
    process.exit(1)
  }
  return value
}

function keypair(json, name) {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json)))
  } catch (cause) {
    console.error(`${name} is not a 64-byte JSON array: ${cause instanceof Error ? cause.message : cause}`)
    process.exit(1)
  }
}

const values = env()
const rpcUrl = values.SOLANA_RPC_URL === undefined || values.SOLANA_RPC_URL === ''
  ? 'https://api.devnet.solana.com'
  : values.SOLANA_RPC_URL

const authority = keypair(
  required(values, 'POOL_AUTHORITY_KEYPAIR', 'run: node scripts/devnet-keys.mjs'),
  'POOL_AUTHORITY_KEYPAIR',
)
const aggregator = keypair(
  required(values, 'AGGREGATOR_KEYPAIR', 'run: node scripts/devnet-keys.mjs'),
  'AGGREGATOR_KEYPAIR',
)
const assetMint = new PublicKey(
  required(values, 'ASSET_MINT', 'run scripts/devnet-prepare.sh in WSL'),
)
const treasury = new PublicKey(
  required(values, 'TREASURY_TOKENS', 'run scripts/devnet-prepare.sh in WSL'),
)
const programId = values.PUMPKING_PROGRAM_ID === undefined || values.PUMPKING_PROGRAM_ID === ''
  ? PROGRAM_ID
  : new PublicKey(values.PUMPKING_PROGRAM_ID)

// The clock and the thresholds come from the scenario the demo plays back, so
// the pool cannot disagree with the fixture the index case was written from.
const scenario = JSON.parse(readFileSync(SCENARIO_PATH, 'utf8'))

const params = {
  aggregator: aggregator.publicKey,
  // The rest are the M1 path's own numbers (programs/pumpking/tests/m1_path.rs).
  cellExposureBps: 1_000,
  premiumRewardsBps: 1_000,
  riskLoadingBps: 2_500,
  minRateBps: 100,
  minSensorsPerCell: scenario.params.minimumVotes,
  minStake: 1_000_000n,
  unstakeDelayDays: 30,
  waitingPeriodDays: 3,
  dryDayThresholdMmX100: scenario.params.dryThresholdX100,
  secondsPerDay: scenario.clock.secondsPerDay,
}

const connection = new Connection(rpcUrl, 'confirmed')
const pool = poolPda(programId)
const vault = vaultPda(pool.address, programId)

// Origin only: the key rides in the query (Helius) or the path (Alchemy).
console.log('cluster        :', new URL(rpcUrl).origin)
console.log('program        :', programId.toBase58())
console.log('pool           :', pool.address.toBase58())
console.log('vault          :', vault.address.toBase58())
console.log('authority      :', authority.publicKey.toBase58())
console.log('aggregator     :', params.aggregator.toBase58())
console.log('asset mint     :', assetMint.toBase58())
console.log('seconds/day    :', params.secondsPerDay, '(compressed time — FR-049)')
console.log('dry threshold  :', params.dryDayThresholdMmX100, 'x100 mm')
console.log('min sensors    :', params.minSensorsPerCell)
console.log()

async function poolData() {
  const account = await connection.getAccountInfo(pool.address)
  if (account === null) {
    console.error('the pool account vanished between transactions — nothing here can recover from that')
    process.exit(1)
  }
  return account.data
}

const programAccount = await connection.getAccountInfo(programId)
if (programAccount === null) {
  console.error('the program is not on this cluster — run scripts/devnet-deploy.sh first')
  process.exit(1)
}

const existing = await connection.getAccountInfo(pool.address)
if (existing === null) {
  console.log('initialising the pool…')
  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      initializePoolInstruction({
        authority: authority.publicKey,
        assetMint,
        params,
        programId,
      }),
    ),
    [authority],
    { commitment: 'confirmed' },
  )
  console.log('  ', signature)
} else {
  const decoded = decodePool(existing.data)
  console.log('the pool already exists — leaving it alone.')
  console.log('   aggregator on chain :', decoded.aggregator.toBase58())
  console.log('   seconds per day     :', decoded.secondsPerDay)
  if (!decoded.aggregator.equals(params.aggregator)) {
    console.error('   MISMATCH: the worker would sign day records this pool refuses.')
    process.exitCode = 1
  }
  if (decoded.secondsPerDay !== params.secondsPerDay) {
    console.error('   MISMATCH: the pool keeps a different clock than the scenario file.')
    process.exitCode = 1
  }
}

const capital = CAPITAL_TOKENS * 10n ** DECIMALS
const before = await connection.getAccountInfo(vault.address)
const poolNow = decodePool(await poolData())

if (BigInt(poolNow.capitalTotal.toString()) > 0n) {
  console.log(`\nthe pool already holds ${poolNow.capitalTotal.toString()} base units of capital — not depositing again.`)
} else {
  console.log(`\ndepositing ${CAPITAL_TOKENS} tokens of capital…`)
  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      depositCapitalInstruction({
        depositor: authority.publicKey,
        assetMint,
        depositorTokens: treasury,
        amount: capital,
        programId,
      }),
    ),
    [authority],
    { commitment: 'confirmed' },
  )
  console.log('  ', signature)
}

const final = decodePool(await poolData())
console.log('\npool state:')
console.log('  capital total :', final.capitalTotal.toString())
console.log('  reserved      :', final.reservedTotal.toString())
console.log('  shares        :', final.sharesTotal.toString())
console.log('  genesis ts    :', new Date(Number(final.genesisTs.toString()) * 1000).toISOString())
console.log('  vault existed before deposit:', before !== null)

console.log('\nFor Render (step 2 of docs/DEPLOY.md):')
console.log('  PUMPKING_PROGRAM_ID =', programId.toBase58())
console.log('  AGGREGATOR_KEYPAIR  = (the value already in .env)')
console.log('  DATABASE_URL        = (the :6543 pooler string)')
console.log('\nFor Pages (step 3):')
console.log('  VITE_ASSET_DECIMALS =', String(DECIMALS))
console.log('  VITE_POLICY_PUBKEY  = set once a policy is issued, after the cell has days')
