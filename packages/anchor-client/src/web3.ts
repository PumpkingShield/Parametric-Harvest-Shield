import { web3 } from '@coral-xyz/anchor'

/**
 * The web3.js surface this client speaks, re-exported from the copy Anchor
 * itself carries.
 *
 * Not a stylistic choice. `PublicKey` is compared by `instanceof` deep inside
 * the transaction encoder, so two copies of `@solana/web3.js` in one graph
 * produce keys that look identical and are rejected as foreign objects. Taking
 * the class from `@coral-xyz/anchor` makes a second copy impossible: there is
 * one dependency, and the coder and the caller share its identity.
 */

export const PublicKey = web3.PublicKey
export type PublicKey = web3.PublicKey

export const TransactionInstruction = web3.TransactionInstruction
export type TransactionInstruction = web3.TransactionInstruction

export type AccountMeta = web3.AccountMeta

/**
 * Sending, as opposed to encoding. Re-exported for the same reason as
 * `PublicKey`: the worker builds an instruction here and signs it there, and
 * two copies of `@solana/web3.js` in one graph produce a `Transaction` the
 * other copy's `sendAndConfirmTransaction` rejects as a foreign object.
 *
 * The type annotations are not decoration. Without them `tsc` cannot name the
 * inferred type without pointing inside `.pnpm` and fails with `TS2883`.
 */
export const Connection: typeof web3.Connection = web3.Connection
export type Connection = web3.Connection

export const Keypair: typeof web3.Keypair = web3.Keypair
export type Keypair = web3.Keypair

export const Transaction: typeof web3.Transaction = web3.Transaction
export type Transaction = web3.Transaction

export const sendAndConfirmTransaction: typeof web3.sendAndConfirmTransaction =
  web3.sendAndConfirmTransaction

export type Commitment = web3.Commitment

/** `11111111111111111111111111111111` — every `init` needs it. */
export const SYSTEM_PROGRAM_ID: PublicKey = web3.SystemProgram.programId

/**
 * The two token programs a pool asset can live under — `FR-055` makes the
 * asset a parameter, and Token-2022 mints are a real deployment choice rather
 * than a hypothetical: the program takes `Interface<TokenInterface>` precisely
 * so both work.
 */
export const TOKEN_PROGRAM_ID: PublicKey = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
)
export const TOKEN_2022_PROGRAM_ID: PublicKey = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
)
