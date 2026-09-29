// Registers and stakes the demo's own sensors on chain — T077, FR-001, FR-050.
// Run (after devnet-init.mjs): node scripts/devnet-register.mjs [--set show|feeder] [--check]
//
// Registration is open and on chain (`register_sensor`), and since T076 the
// aggregator counts a reading only from a sensor the chain knows and holds at
// least `pool.min_stake` for. The show's three sensors and the SC-008 feeder's
// hundred are no exception: the synthetic part of either is the weather, not
// the network. So their operators register and stake them here, the way any
// operator would, once per deployment — and the scenario and feeder routes
// refuse to start until the worker's mirror has seen every one of them vote.
//
// Who signs what is the program's rule, not this script's: `register_sensor`
// takes the operator (who pays and owns the vote) and the sensor key (so a
// device cannot be registered under somebody else's wallet); `stake_sensor`
// takes the operator alone. The sensor keys are the fixtures' — a byte
// repeated, public on purpose, for devnet weather and nothing else.
//
// Idempotent. A sensor already registered by the right operator in the right
// cell is only topped up to the minimum; one registered by anybody else, or in
// another cell, is reported and left alone — the chain fixed both at
// registration and nothing here can move them. `--check` changes nothing and
// exits non-zero if anything would need doing (devnet-show.mjs runs it first).
//
// Slots are the program's: it hands them out in the order sensors register,
// so a fresh cell gets the order this script sends in.

import { readdirSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  associatedTokenAddress,
  Connection,
  decodePool,
  decodeSensor,
  Keypair,
  PROGRAM_ID,
  PublicKey,
  poolPda,
  registerSensorInstruction,
  sendAndConfirmTransaction,
  sensorPda,
  stakeSensorInstruction,
  Transaction,
} from '../packages/anchor-client/src/index.ts'
import { cellIdFromH3Index, h3IndexFromCellId } from '../packages/shared/src/index.ts'
import { feederCellId, feederSensors } from '../apps/worker/src/feeder.ts'
import { readScenario, scenarioSensors } from '../apps/worker/src/scenario.ts'

const { values: args } = parseArgs({
  options: {
    set: { type: 'string', default: 'show' },
    check: { type: 'boolean', default: false },
  },
})
if (args.set !== 'show' && args.set !== 'feeder') {
  console.error(`--set must be show or feeder, got ${args.set}`)
  process.exit(1)
}

// `PUMPKING_ENV` names another file for another cluster (a local validator),
// so trying the path never edits the devnet `.env`.
const ENV_PATH =
  process.env.PUMPKING_ENV === undefined || process.env.PUMPKING_ENV === ''
    ? new URL('../.env', import.meta.url)
    : process.env.PUMPKING_ENV

function env() {
  const text = readFileSync(ENV_PATH, 'utf8')
  const found = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_0-9]+)=(.*)$/)
    if (match !== null) found[match[1]] = match[2].trim()
  }
  // The shell wins over the file, as in devnet-init.mjs.
  for (const [name, value] of Object.entries(process.env)) {
    if (/^[A-Z_0-9]+$/.test(name) && value !== undefined && value !== '') found[name] = value
  }
  return found
}

const values = env()

function keypair(name) {
  const json = values[name]
  if (json === undefined || json === '') {
    console.error(`${name} is missing — run: node scripts/devnet-keys.mjs`)
    process.exit(1)
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json)))
  } catch (cause) {
    console.error(`${name} is not a 64-byte JSON array: ${cause instanceof Error ? cause.message : cause}`)
    process.exit(1)
  }
}

const rpcUrl =
  values.SOLANA_RPC_URL === undefined || values.SOLANA_RPC_URL === ''
    ? 'https://api.devnet.solana.com'
    : values.SOLANA_RPC_URL
const programId =
  values.PUMPKING_PROGRAM_ID === undefined || values.PUMPKING_PROGRAM_ID === ''
    ? PROGRAM_ID
    : new PublicKey(values.PUMPKING_PROGRAM_ID)

/** The three operators of both sets. `operator-a` in a fixture is OPERATOR_A_KEYPAIR. */
const OPERATORS = ['A', 'B', 'C'].map((letter) => keypair(`OPERATOR_${letter}_KEYPAIR`))

function operatorOfLabel(label) {
  const match = label.match(/^operator-([a-c])$/)
  if (match === null) throw new Error(`no operator key for the label ${label}`)
  return OPERATORS['abc'.indexOf(match[1])]
}

/**
 * The sensors of a set, each with its signing key, its operator and its cell,
 * in the order they are registered. The key is rebuilt with `Keypair.fromSeed`
 * and checked against the one the readings are signed under, so the key that
 * registers is provably the key that publishes.
 */
async function sensorsOf(set) {
  if (set === 'feeder') {
    return (await feederSensors()).map((sensor) => ({
      seed: sensor.seed,
      pubkey: sensor.pubkey,
      operator: OPERATORS[sensor.operator],
      cellId: feederCellId(sensor),
    }))
  }
  // Every scenario the show can play. They share their sensors today; a key
  // two fixtures place in different cells is a fixture error, not a choice.
  const byKey = new Map()
  const dir = new URL('../fixtures/scenarios/', import.meta.url)
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const scenario = readScenario(file.replace(/\.json$/, ''))
    const cellId = cellIdFromH3Index(scenario.cell)
    for (const sensor of await scenarioSensors(scenario)) {
      const seen = byKey.get(sensor.pubkey)
      if (seen !== undefined && seen.cellId !== cellId) {
        throw new Error(`seed ${sensor.seed} sits in two cells across the fixtures`)
      }
      byKey.set(sensor.pubkey, {
        seed: sensor.seed,
        pubkey: sensor.pubkey,
        operator: operatorOfLabel(sensor.operator),
        cellId,
      })
    }
  }
  return [...byKey.values()]
}

// Everything that talks to the cluster is in here and ends by returning a
// code, not by `process.exit`: with the RPC's keep-alive sockets still open,
// Node 26 on Windows aborts inside libuv (`UV_HANDLE_CLOSING`) and exits 127
// whatever the code was — and devnet-show.mjs reads that code.
async function main() {
  const connection = new Connection(rpcUrl, 'confirmed')
  const origin = new URL(rpcUrl).origin

  console.log(`cluster : ${origin}`)
  console.log(`program : ${programId.toBase58()}`)
  console.log(`set     : ${args.set}${args.check ? ' (check only)' : ''}`)

  const poolInfo = await connection.getAccountInfo(poolPda(programId).address)
  if (poolInfo === null) {
    console.error('no pool on this cluster — run: node scripts/devnet-init.mjs')
    return 1
  }
  const pool = decodePool(poolInfo.data)
  const minStake = BigInt(pool.minStake.toString())
  const mintInfo = await connection.getAccountInfo(pool.assetMint)
  if (mintInfo === null) {
    console.error(`the pool's asset mint ${pool.assetMint.toBase58()} does not exist here`)
    return 1
  }
  const tokenProgram = mintInfo.owner
  console.log(`minimum : ${minStake} base units (pool.min_stake)`)
  console.log()

  const sensors = await sensorsOf(args.set)

  // One read for every sensor account, a hundred at a time — the RPC's limit.
  const accounts = []
  for (let start = 0; start < sensors.length; start += 100) {
    const chunk = sensors.slice(start, start + 100)
    accounts.push(
      ...(await connection.getMultipleAccountsInfo(
        chunk.map((sensor) => sensorPda(new PublicKey(sensor.pubkey), programId).address),
      )),
    )
  }

  const plan = []
  const blocked = []
  for (const [index, sensor] of sensors.entries()) {
    const signer = Keypair.fromSeed(new Uint8Array(32).fill(sensor.seed))
    if (signer.publicKey.toBase58() !== sensor.pubkey) {
      throw new Error(`seed ${sensor.seed}: Keypair.fromSeed disagrees with the reading key`)
    }
    const info = accounts[index]
    if (info === null || info === undefined) {
      plan.push({ sensor, signer, register: true, stake: minStake })
      continue
    }
    const account = decodeSensor(info.data)
    const cellId = BigInt(account.cellId.toString())
    if (!account.operator.equals(sensor.operator.publicKey)) {
      blocked.push(`${sensor.pubkey} is registered to ${account.operator.toBase58()}, not our operator`)
      continue
    }
    if (cellId !== sensor.cellId) {
      blocked.push(`${sensor.pubkey} is registered in ${h3IndexFromCellId(cellId)}, not ${h3IndexFromCellId(sensor.cellId)}`)
      continue
    }
    if (!account.active) {
      blocked.push(`${sensor.pubkey} is excluded on chain (FR-012)`)
      continue
    }
    const stake = BigInt(account.stake.toString())
    if (stake < minStake) plan.push({ sensor, signer, register: false, stake: minStake - stake })
  }

  const ready = sensors.length - plan.length - blocked.length
  console.log(`${sensors.length} sensors: ${ready} vote, ${plan.length} to do, ${blocked.length} blocked`)
  for (const line of blocked) console.log(`  blocked: ${line}`)

  if (args.check || plan.length === 0) {
    for (const step of plan) {
      console.log(`  to do  : ${step.sensor.pubkey} ${step.register ? 'register + ' : ''}stake ${step.stake}`)
    }
    return plan.length + blocked.length === 0 ? 0 : 1
  }

  // What each operator is about to spend, checked before the first transaction
  // rather than discovered at the fortieth.
  const tokensOf = new Map()
  for (const operator of OPERATORS) {
    const need = plan
      .filter((step) => step.sensor.operator === operator)
      .reduce((sum, step) => sum + step.stake, 0n)
    if (need === 0n) continue
    const account = associatedTokenAddress(operator.publicKey, pool.assetMint, tokenProgram)
    const balance = await connection.getTokenAccountBalance(account).catch(() => null)
    const have = balance === null ? 0n : BigInt(balance.value.amount)
    if (have < need) {
      console.error(
        `operator ${operator.publicKey.toBase58()} holds ${have} of the ${need} it stakes — run scripts/devnet-prepare.sh`,
      )
      return 1
    }
    tokensOf.set(operator, account)
  }

  let done = 0
  for (const step of plan) {
    const { sensor, signer } = step
    const operator = sensor.operator
    const transaction = new Transaction()
    if (step.register) {
      transaction.add(
        registerSensorInstruction({
          operator: operator.publicKey,
          sensorKey: signer.publicKey,
          cellId: sensor.cellId,
          programId,
        }),
      )
    }
    transaction.add(
      stakeSensorInstruction({
        operator: operator.publicKey,
        sensorKey: signer.publicKey,
        assetMint: pool.assetMint,
        operatorTokens: tokensOf.get(operator),
        amount: step.stake,
        stakeVault: pool.stakeVault,
        // The mint's own program: the mock asset is classic SPL, and a
        // Token-2022 asset (FR-055) would be refused under the wrong one.
        tokenProgram,
        programId,
      }),
    )
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      step.register ? [operator, signer] : [operator],
      { commitment: 'confirmed' },
    )
    done += 1
    console.log(
      `  ${String(done).padStart(3)}/${plan.length} ${sensor.pubkey} ${step.register ? 'registered, ' : ''}staked ${step.stake}  ${signature}`,
    )
  }

  console.log()
  console.log(
    'Done. The worker mirrors the registry every REGISTRY_SYNC_MS (5 min) — on the demo, turn the loop on (RUN_WORKER=on) and let it turn once before a show.',
  )
  return 0
}

process.exitCode = await main()
