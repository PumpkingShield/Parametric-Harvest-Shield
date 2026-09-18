// Generates the keys the devnet demo needs and writes them into `.env` —
// step 0 of docs/DEPLOY.md.
//
// Three roles, three keys, and they are deliberately not one:
//
//   POOL_AUTHORITY_KEYPAIR  sets the pool's parameters and pays its rent. It
//                           is never a signer over the vaults (FR-030): it
//                           cannot stop a payout or move capital.
//   AGGREGATOR_KEYPAIR      the only key `submit_day_record` accepts (FR-015),
//                           and the fee payer for settlement and closure. It
//                           needs SOL because it sends every transaction the
//                           worker sends.
//   the mint authority      stays the deployer's CLI wallet in WSL and is
//                           never the pool authority: a pool that can print
//                           its own asset is solvent by definition, which
//                           makes the SC-006 check meaningless.
//
// Run: node scripts/devnet-keys.mjs
// Idempotent: a key already in `.env` is kept, never regenerated.

import { readFileSync, writeFileSync } from 'node:fs'
import { Keypair } from '../packages/anchor-client/src/index.ts'

const ENV_PATH = new URL('../.env', import.meta.url)

const ROLES = [
  {
    name: 'POOL_AUTHORITY_KEYPAIR',
    what: 'sets pool parameters, pays rent for Pool and the two vaults',
    sol: '~0.05',
  },
  {
    name: 'AGGREGATOR_KEYPAIR',
    what: 'signs every day record; fee payer for settle and close',
    sol: '~0.10',
  },
]

function readEnv() {
  try {
    return readFileSync(ENV_PATH, 'utf8')
  } catch {
    console.error('.env is missing. Copy .env.example to .env first.')
    process.exit(1)
  }
}

/** Replaces `NAME=...` in place, or appends the line if the file has no such key. */
function setVariable(text, name, value) {
  const line = `${name}=${value}`
  const pattern = new RegExp(`^${name}=.*$`, 'm')
  if (pattern.test(text)) return text.replace(pattern, line)
  // Appended only if the key is absent entirely; the newline check matters
  // because a file without a trailing one would glue two variables together.
  return `${text.endsWith('\n') ? text : `${text}\n`}${line}\n`
}

function currentValue(text, name) {
  const found = text.match(new RegExp(`^${name}=(.*)$`, 'm'))
  return found === null ? '' : found[1].trim()
}

let env = readEnv()
const report = []

for (const role of ROLES) {
  const existing = currentValue(env, role.name)
  if (existing !== '') {
    const secret = Uint8Array.from(JSON.parse(existing))
    report.push({ ...role, pubkey: Keypair.fromSecretKey(secret).publicKey.toBase58(), fresh: false })
    continue
  }

  const key = Keypair.generate()
  env = setVariable(env, role.name, JSON.stringify([...key.secretKey]))
  report.push({ ...role, pubkey: key.publicKey.toBase58(), fresh: true })
}

writeFileSync(ENV_PATH, env, 'utf8')

console.log('Keys in .env (never printed, never committed — .env is git-ignored):\n')
for (const role of report) {
  console.log(`  ${role.name}${role.fresh ? '  [generated now]' : '  [kept]'}`)
  console.log(`    ${role.pubkey}`)
  console.log(`    ${role.what}`)
  console.log(`    devnet SOL needed: ${role.sol}\n`)
}
console.log('Fund both from https://faucet.solana.com, then run scripts/devnet-deploy.sh in WSL.')
