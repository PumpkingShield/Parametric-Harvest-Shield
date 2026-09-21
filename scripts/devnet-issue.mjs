// Issues the demo policy on devnet, while a scenario run is in flight —
// the step after step 0 of docs/DEPLOY.md, and the source of VITE_POLICY_PUBKEY.
//
// Run, in a second terminal, before or right after POST /v1/scenario/run:
//   node scripts/devnet-issue.mjs [--payout 1000] [--spell 5] [--window-days 10]
//                                 [--max-premium <tokens>] [--nonce 1] [--timeout 180]
//
// Why this cannot be part of step 0. `issue_policy` refuses a cell nobody is
// publishing on (FR-022: the latest recorded day must carry min_sensors votes)
// and a cell it cannot price (FR-021: MIN_HISTORY_DAYS covered days in the
// ring). Both come from the day log, and the day log is written by the worker
// as the run plays — so the policy is bought in the middle of the run, on the
// history the run has produced so far, and its window has to fit in what is
// left of it. Once the run ends the worker keeps writing silent days, the
// latest day has no votes, and the cell is uninsurable again until the next
// run. Sixty seconds is the whole shop window.
//
// So the script polls. Every second it reads the cell and the chain clock,
// and the moment the program's own preconditions hold it quotes the premium
// with the TypeScript twin of the pricing, and sends `issue_policy`. Nothing
// here talks to the API or the database: the chain is what the instruction
// will be checked against, and the chain is what is read.
//
// The window starts at today + waiting_period + 1. The extra day is slack for
// the clock: `today` is computed from the latest block's timestamp, and the
// instruction is checked against the timestamp of the block it lands in,
// which is later. Without it a policy bought at the edge of a day would be
// refused for a waiting period it did miss by a second.
//
// Idempotent on (owner, nonce): a policy that already exists is reported and
// left alone. A second policy for a second show is `--nonce 2`.

import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  associatedTokenAddress,
  cellPda,
  Connection,
  decodeCellState,
  decodePolicy,
  decodePool,
  isPolicyActive,
  issuePolicyInstruction,
  Keypair,
  PROGRAM_ID,
  PublicKey,
  policyPda,
  poolPda,
  sendAndConfirmTransaction,
  TOKEN_PROGRAM_ID,
  Transaction,
} from '../packages/anchor-client/src/index.ts'
import { cellIdFromH3Index } from '../packages/shared/src/cell.ts'
import {
  dryDayFrequencyBps,
  MIN_HISTORY_DAYS,
  premiumFor,
  premiumRateBps,
} from '../packages/shared/src/premium.ts'

const ENV_PATH = new URL('../.env', import.meta.url)
const SCENARIO_PATH = new URL('../fixtures/scenarios/drought.json', import.meta.url)

const DECIMALS = 6n
/** `MAX_COVERAGE_DAYS` in `state.rs`. */
const MAX_COVERAGE_DAYS = 90
/** Between reads of the cell. A compressed day is two seconds; one is enough. */
const POLL_MS = 1_000

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

const { values: args } = parseArgs({
  options: {
    /** Whole tokens paid out on the event. */
    payout: { type: 'string', default: '1000' },
    /** `FR-046`: consecutive dry days that trigger it. */
    spell: { type: 'string', default: '5' },
    /** Length of the coverage window, in days. */
    'window-days': { type: 'string', default: '10' },
    /**
     * Whole tokens, the most the buyer will pay. Defaults to 125% of the
     * payout — the arithmetic ceiling of the rate, so the default can never be
     * the reason the purchase fails on a cell whose history is all drought.
     */
    'max-premium': { type: 'string' },
    nonce: { type: 'string', default: '1' },
    /** Seconds to keep polling before giving up. */
    timeout: { type: 'string', default: '180' },
  },
})

function whole(name, text) {
  if (!/^\d+$/.test(text)) {
    console.error(`--${name} must be a whole number, got ${JSON.stringify(text)}`)
    process.exit(2)
  }
  return BigInt(text)
}

const payoutTokens = whole('payout', args.payout)
const spellDaysThreshold = Number(whole('spell', args.spell))
const windowDays = Number(whole('window-days', args['window-days']))
const nonce = whole('nonce', args.nonce)
const timeoutMs = Number(whole('timeout', args.timeout)) * 1_000
const payout = payoutTokens * 10n ** DECIMALS
const maxPremium =
  args['max-premium'] === undefined
    ? (payout * 125n) / 100n
    : whole('max-premium', args['max-premium']) * 10n ** DECIMALS

if (payout === 0n) {
  console.error('--payout must be positive: the program refuses a policy that pays nothing')
  process.exit(2)
}
if (windowDays < 1 || windowDays > MAX_COVERAGE_DAYS) {
  console.error(`--window-days must be 1..${MAX_COVERAGE_DAYS} (FR-024)`)
  process.exit(2)
}
if (spellDaysThreshold < 1 || spellDaysThreshold > windowDays || spellDaysThreshold > 255) {
  console.error('--spell must be 1..window-days: a threshold the window cannot hold never pays')
  process.exit(2)
}

/* -------------------------------------------------------------------------- */
/* .env                                                                       */
/* -------------------------------------------------------------------------- */

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

/** Replaces `NAME=...` in place, or appends the line if the file has no such key. */
function setVariable(name, value) {
  const text = readFileSync(ENV_PATH, 'utf8')
  const line = `${name}=${value}`
  const pattern = new RegExp(`^${name}=.*$`, 'm')
  const next = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text.endsWith('\n') ? text : `${text}\n`}${line}\n`
  writeFileSync(ENV_PATH, next, 'utf8')
}

const values = env()
const rpcUrl =
  values.SOLANA_RPC_URL === undefined || values.SOLANA_RPC_URL === ''
    ? 'https://api.devnet.solana.com'
    : values.SOLANA_RPC_URL
const owner = keypair(
  required(values, 'POLICY_OWNER_KEYPAIR', 'run: node scripts/devnet-keys.mjs'),
  'POLICY_OWNER_KEYPAIR',
)
const programId =
  values.PUMPKING_PROGRAM_ID === undefined || values.PUMPKING_PROGRAM_ID === ''
    ? PROGRAM_ID
    : new PublicKey(values.PUMPKING_PROGRAM_ID)

/* -------------------------------------------------------------------------- */
/* Chain                                                                      */
/* -------------------------------------------------------------------------- */

// The cell is the scenario's: the run registers it from the same file, and the
// worker writes its days under the same id.
const scenario = JSON.parse(readFileSync(SCENARIO_PATH, 'utf8'))
const cellId = cellIdFromH3Index(scenario.cell)

const connection = new Connection(rpcUrl, 'confirmed')
const pool = poolPda(programId).address
const cell = cellPda(cellId, programId).address
const policy = policyPda(owner.publicKey, nonce, programId).address

const poolInfo = await connection.getAccountInfo(pool)
if (poolInfo === null) {
  console.error('the pool is not on this cluster — run scripts/devnet-init.mjs first')
  process.exit(1)
}
const poolNow = decodePool(Uint8Array.from(poolInfo.data))
const assetMint = poolNow.assetMint
// The classic token program: devnet-prepare.sh creates the mint with it, and
// the worker derives the payout destination the same way (`settle.ts`).
const ownerTokens = associatedTokenAddress(owner.publicKey, assetMint, TOKEN_PROGRAM_ID)
const genesisTs = Number(poolNow.genesisTs.toString())
const secondsPerDay = poolNow.secondsPerDay

console.log('cluster        :', rpcUrl)
console.log('program        :', programId.toBase58())
console.log('cell           :', scenario.cell, '→', cell.toBase58())
console.log('owner          :', owner.publicKey.toBase58())
console.log('owner tokens   :', ownerTokens.toBase58())
console.log('policy         :', policy.toBase58(), `(nonce ${nonce})`)
console.log('payout         :', payoutTokens.toString(), 'tokens')
console.log('threshold      :', spellDaysThreshold, 'consecutive dry days')
console.log('window         :', windowDays, 'days')
console.log('max premium    :', (maxPremium / 10n ** DECIMALS).toString(), 'tokens')
console.log()

const existing = await connection.getAccountInfo(policy)
if (existing !== null) {
  const account = decodePolicy(Uint8Array.from(existing.data))
  console.log('the policy already exists — leaving it alone.')
  console.log('   state         :', Object.keys(account.state)[0])
  console.log('   window        :', account.windowStartDay, '..', account.windowEndDay)
  console.log('   premium paid  :', account.premium.toString(), 'base units')
  if (!isPolicyActive(account)) console.log('   (not active: use --nonce', String(nonce + 1n), 'for a new one)')
  console.log('\nVITE_POLICY_PUBKEY =', policy.toBase58())
  process.exit(0)
}

const tokens = await connection.getTokenAccountBalance(ownerTokens).catch(() => null)
if (tokens === null) {
  console.error('the farmer has no token account — run scripts/devnet-prepare.sh in WSL')
  process.exit(1)
}
const held = BigInt(tokens.value.amount)
if (held < maxPremium) {
  console.error(
    `the farmer holds ${held} base units and the premium may reach ${maxPremium} — run scripts/devnet-prepare.sh in WSL`,
  )
  process.exit(1)
}

/* -------------------------------------------------------------------------- */
/* Waiting for the cell                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The clock the program will read is the cluster's, not this machine's, and
 * at two seconds a day a few seconds of drift is a few days. The offset is
 * measured against the latest block once, and again right before sending —
 * not on every poll, because the public devnet endpoint rate-limits a worker
 * and a poller sharing one address, and two calls a second is what it can
 * spare.
 */
let clockOffsetSeconds = 0
async function measureClock() {
  const slot = await connection.getSlot('confirmed')
  const time = await connection.getBlockTime(slot)
  if (time !== null) clockOffsetSeconds = time - Date.now() / 1_000
}

function chainToday() {
  const time = Date.now() / 1_000 + clockOffsetSeconds
  if (time < genesisTs) return null
  return Math.floor((time - genesisTs) / secondsPerDay)
}

/**
 * What the program checks in `check_underwriting` and `price_of`, read off the
 * cell so the instruction is sent when it will pass rather than sent to see.
 */
function assess(state, poolState) {
  const dayLog = Array.from(state.dayLog)
  const contributors = Array.from(state.contributors)
  const last = state.lastDayIndex
  const votes = last === null ? 0 : bitCount(contributors[last % dayLog.length])
  const covered = dayLog.filter((day) => day === 1 || day === 2).length
  const frequency = dryDayFrequencyBps(dayLog)
  const capital = BigInt(poolState.capitalTotal.toString())
  const reserved = BigInt(poolState.reservedTotal.toString())
  const free = capital > reserved ? capital - reserved : 0n
  const cellLimit = (capital * BigInt(poolState.cellExposureBps)) / 10_000n
  const cellAfter = BigInt(state.reserved.toString()) + payout

  const blockers = []
  if (votes < poolState.minSensorsPerCell) {
    blockers.push(`latest day ${last ?? '—'} has ${votes} votes, needs ${poolState.minSensorsPerCell}`)
  }
  if (frequency === null) blockers.push(`${covered} covered days, needs ${MIN_HISTORY_DAYS}`)
  if (free < payout) blockers.push(`free liquidity ${free} < payout ${payout}`)
  if (cellAfter > cellLimit) blockers.push(`cell exposure ${cellAfter} > limit ${cellLimit}`)

  let premium = null
  if (frequency !== null) {
    const rate = premiumRateBps(frequency, poolState.riskLoadingBps, poolState.minRateBps)
    premium = premiumFor(payout, rate)
    if (premium > maxPremium) blockers.push(`premium ${premium} > max ${maxPremium}`)
  }

  return { last, votes, covered, frequency, premium, blockers }
}

function bitCount(mask) {
  let n = mask >>> 0
  let count = 0
  while (n !== 0) {
    count += n & 1
    n >>>= 1
  }
  return count
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The program's error name out of a failed send, or the message as it came. */
function explain(cause) {
  const text = cause instanceof Error ? cause.message : String(cause)
  const logs = Array.isArray(cause?.logs) ? cause.logs.join('\n') : ''
  const code = `${text}\n${logs}`.match(/Error Code: (\w+)/)
  return code === null ? text : code[1]
}

const started = Date.now()
let lastLine = ''
let attempts = 0

/** One line, rewritten in place on a terminal; only its changes in a log. */
let previousProgress = ''
function progress(line) {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r${line}`.padEnd(100))
  } else if (line !== previousProgress) {
    console.log(line)
  }
  previousProgress = line
}

console.log('waiting for the cell to be insurable — start the scenario run now if it is not running.')
await measureClock()

while (true) {
  if (Date.now() - started > timeoutMs) {
    console.error(`\ngave up after ${timeoutMs / 1_000} s: ${lastLine || 'the cell never appeared'}`)
    process.exit(1)
  }

  // One request for both accounts: see `measureClock` on why calls are counted.
  const [cellInfo, poolInfo] = await connection.getMultipleAccountsInfo([cell, pool])
  const today = chainToday()

  if (cellInfo === null) {
    lastLine = 'the cell is not on chain yet (the first day record creates it)'
    progress(`  day ${today ?? '?'}: ${lastLine}`)
    await sleep(POLL_MS)
    continue
  }
  if (poolInfo === null || today === null) {
    await sleep(POLL_MS)
    continue
  }

  const state = assess(
    decodeCellState(Uint8Array.from(cellInfo.data)),
    decodePool(Uint8Array.from(poolInfo.data)),
  )
  lastLine = `last day ${state.last ?? '—'}, ${state.votes} votes, ${state.covered} covered, dry ${state.frequency === null ? '—' : `${state.frequency / 100}%`}`
  progress(`  day ${today}: ${lastLine}${state.blockers.length === 0 ? '' : ` — ${state.blockers[0]}`}`)

  if (state.blockers.length > 0) {
    await sleep(POLL_MS)
    continue
  }

  await measureClock()
  const windowStartDay = chainToday() + poolNow.waitingPeriodDays + 1
  const windowEndDay = windowStartDay + windowDays - 1
  console.log(`\n\nissuing: window ${windowStartDay}..${windowEndDay}, quoted premium ${state.premium} base units`)

  attempts += 1
  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        issuePolicyInstruction({
          owner: owner.publicKey,
          assetMint,
          ownerTokens,
          terms: {
            nonce,
            cellId,
            spellDaysThreshold,
            payout,
            maxPremium,
            windowStartDay,
            windowEndDay,
          },
          programId,
        }),
      ),
      [owner],
      { commitment: 'confirmed' },
    )
    console.log('  ', signature)
    break
  } catch (cause) {
    const why = explain(cause)
    // The clock moved, or the worker wrote a day between the read and the
    // send. Both are the cell changing under the script, and the answer is
    // the same as before the first attempt: read it again.
    if (attempts < 3) {
      console.log(`  refused: ${why} — reading the cell again`)
      continue
    }
    console.error(`  refused three times, last: ${why}`)
    process.exit(1)
  }
}

const issued = await connection.getAccountInfo(policy)
if (issued === null) {
  console.error('the transaction confirmed but the policy account is not there — nothing here can explain that')
  process.exit(1)
}
const account = decodePolicy(Uint8Array.from(issued.data))
const premium = BigInt(account.premium.toString())

console.log('\npolicy:')
console.log('  address       :', policy.toBase58())
console.log('  owner         :', account.owner.toBase58())
console.log('  cell          :', account.cellId.toString())
console.log('  window        :', account.windowStartDay, '..', account.windowEndDay)
console.log('  threshold     :', account.spellDaysThreshold, 'dry days')
console.log('  payout        :', account.payout.toString(), 'base units')
console.log('  premium       :', premium.toString(), `base units (${Number((premium * 10_000n) / payout) / 100}% of the payout)`)
console.log('  state         :', Object.keys(account.state)[0])

setVariable('VITE_POLICY_PUBKEY', policy.toBase58())
console.log('\nVITE_POLICY_PUBKEY written to .env. For Pages (step 3 of docs/DEPLOY.md):')
console.log('  VITE_POLICY_PUBKEY =', policy.toBase58())
console.log(`  ?policy=${policy.toBase58()} opens it on any deployment`)
