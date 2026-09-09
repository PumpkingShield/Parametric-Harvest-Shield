import { PROGRAM_ID } from './program.ts'
import { PublicKey } from './web3.ts'

/**
 * Addresses of the accounts the program owns.
 *
 * Every seed here is stated a second time — the first is `state.rs`, and this
 * is the same class of duplication as `dry_spell`: two implementations that
 * have to agree byte for byte, in a place where disagreement is silent. A
 * client deriving the wrong address does not get an error, it gets an account
 * that does not exist, and the instruction fails for a reason that names
 * nothing.
 *
 * The guard is `pda.test.ts`, which re-derives these addresses from the seed
 * description carried in the IDL — that is, from the program itself. Every
 * account the program can build a PDA for is checked there, so the day
 * `issue_policy` lands with a different seed order, the test fails rather than
 * the transaction.
 */

const utf8 = new TextEncoder()

/** `["pool"]` — the singleton. */
export const POOL_SEED = utf8.encode('pool')
/** `["vault", pool]` — capital. */
export const VAULT_SEED = utf8.encode('vault')
/** `["stake_vault", pool]` — sensor stake, kept apart from capital (`FR-051`). */
export const STAKE_VAULT_SEED = utf8.encode('stake_vault')
/** `["cell", cell_id]`. */
export const CELL_SEED = utf8.encode('cell')
/** `["sensor", sensor_key]` — seeded by the key the sensor signs readings with. */
export const SENSOR_SEED = utf8.encode('sensor')
/** `["policy", owner, nonce]`. */
export const POLICY_SEED = utf8.encode('policy')
/** `["lp", owner]` — a capital position. */
export const CAPITAL_SEED = utf8.encode('lp')

/** A derived address and the bump that produced it. */
export interface Pda {
  address: PublicKey
  bump: number
}

function derive(seeds: Uint8Array[], programId: PublicKey): Pda {
  const [address, bump] = PublicKey.findProgramAddressSync(seeds, programId)
  return { address, bump }
}

/**
 * A `u64` as Anchor writes it into seeds: eight bytes, little-endian. The same
 * layout `to_le_bytes()` produces on the program side — a big-endian client
 * would derive a valid address for the wrong cell and never learn why.
 */
export function u64Seed(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`not a u64: ${value}`)
  }
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return bytes
}

export function poolPda(programId: PublicKey = PROGRAM_ID): Pda {
  return derive([POOL_SEED], programId)
}

export function vaultPda(pool: PublicKey, programId: PublicKey = PROGRAM_ID): Pda {
  return derive([VAULT_SEED, pool.toBytes()], programId)
}

export function stakeVaultPda(pool: PublicKey, programId: PublicKey = PROGRAM_ID): Pda {
  return derive([STAKE_VAULT_SEED, pool.toBytes()], programId)
}

export function cellPda(cellId: bigint, programId: PublicKey = PROGRAM_ID): Pda {
  return derive([CELL_SEED, u64Seed(cellId)], programId)
}

export function sensorPda(sensorKey: PublicKey, programId: PublicKey = PROGRAM_ID): Pda {
  return derive([SENSOR_SEED, sensorKey.toBytes()], programId)
}

export function policyPda(owner: PublicKey, nonce: bigint, programId: PublicKey = PROGRAM_ID): Pda {
  return derive([POLICY_SEED, owner.toBytes(), u64Seed(nonce)], programId)
}

export function capitalPositionPda(owner: PublicKey, programId: PublicKey = PROGRAM_ID): Pda {
  return derive([CAPITAL_SEED, owner.toBytes()], programId)
}
