import { BorshAccountsCoder, type Idl, type IdlAccounts } from '@coral-xyz/anchor'
import { PUMPKING_IDL } from './idl/idl.ts'
import type { Pumpking } from './idl/pumpking.ts'
import { PublicKey } from './web3.ts'

/**
 * Reading the program's accounts back, decoded from the IDL the program itself
 * emitted — the mirror of `instructions.ts`.
 *
 * Nothing here restates a field, an order or a width: `BorshAccountsCoder`
 * reads the layout out of `PUMPKING_IDL`, so the only way for the client to
 * disagree with the program is for `pnpm idl:sync` not to have been run. The
 * discriminators come from the same file, which matters more here than it does
 * for instructions: a `getProgramAccounts` filter built on a hand-copied
 * discriminator returns nothing at all, and an empty list is indistinguishable
 * from a program that genuinely has no such accounts.
 */

const idl = PUMPKING_IDL as Idl
const coder = new BorshAccountsCoder(idl)

/** The on-chain `Policy`, as `state.rs` declares it. */
export type PolicyAccount = IdlAccounts<Pumpking>['policy']
/** The on-chain `CellState`. */
export type CellStateAccount = IdlAccounts<Pumpking>['cellState']
/** The on-chain `Pool`. */
export type PoolAccount = IdlAccounts<Pumpking>['pool']

/** The eight bytes an account of this type starts with. */
export function accountDiscriminator(name: string): Uint8Array {
  const account = idl.accounts?.find((one) => one.name === name)
  if (account === undefined) {
    throw new Error(`the IDL has no account named ${name}`)
  }
  return Uint8Array.from(account.discriminator)
}

/** `Policy`'s discriminator — the `memcmp` a scan filters on. */
export const POLICY_DISCRIMINATOR: Uint8Array = accountDiscriminator('policy')

function decode<T>(name: string, data: Uint8Array): T {
  // The coder wants a Buffer and checks the discriminator itself, so an
  // account of the wrong type is an error here rather than a struct of
  // plausible nonsense read out of somebody else's bytes.
  return coder.decode<T>(name, Buffer.from(data))
}

export function decodePolicy(data: Uint8Array): PolicyAccount {
  return decode<PolicyAccount>('policy', data)
}

export function decodeCellState(data: Uint8Array): CellStateAccount {
  return decode<CellStateAccount>('cellState', data)
}

export function decodePool(data: Uint8Array): PoolAccount {
  return decode<PoolAccount>('pool', data)
}

/**
 * `PolicyState` as the account stores it — Anchor encodes a fieldless enum as
 * an object with one key, so this is a name test rather than a number.
 */
export const POLICY_ACTIVE = 'active'

/** True when the policy can still be triggered — `FR-027` allows one outcome. */
export function isPolicyActive(policy: PolicyAccount): boolean {
  return POLICY_ACTIVE in policy.state
}

/**
 * The associated token account of an owner for a mint.
 *
 * Derived rather than taken from `@solana/spl-token`: it is one
 * `findProgramAddress` over three keys, and the alternative is a dependency
 * whose own `@solana/web3.js` copy would produce `PublicKey` values this
 * client's coder rejects as foreign objects — the reason `web3.ts` exists.
 */
export const ASSOCIATED_TOKEN_PROGRAM_ID: PublicKey = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
)

export function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return address
}
