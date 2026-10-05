import { ASSOCIATED_TOKEN_PROGRAM_ID } from './accounts.ts'
import {
  type PublicKey,
  SYSTEM_PROGRAM_ID,
  SystemProgram,
  TOKEN_PROGRAM_ID,
  TransactionInstruction,
} from './web3.ts'

/**
 * The three instructions outside this program that registering a sensor from a
 * phone needs (`T038a`): moving SOL, opening a token account, minting the mock
 * asset. And the two reads of token accounts that go with them.
 *
 * Written out rather than taken from `@solana/spl-token`, for the reason
 * `associatedTokenAddress` is: that package brings its own `@solana/web3.js`,
 * and two copies in one graph produce keys and instructions the other copy
 * rejects as foreign objects. The layouts below are the token programs' stable
 * wire format — the same bytes under Token and Token-2022 — and each one is a
 * handful of bytes, not an encoder.
 */

/** Lamports from one wallet to another — the faucet's SOL. */
export function systemTransferInstruction(input: {
  from: PublicKey
  to: PublicKey
  lamports: bigint
}): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: input.from,
    toPubkey: input.to,
    lamports: input.lamports,
  })
}

/**
 * Opens `owner`'s associated token account for `mint`, or does nothing if it is
 * already open — instruction 1 of the associated token program, the idempotent
 * form, so a second grant or an operator who already holds the asset is not a
 * failed transaction.
 */
export function createAssociatedTokenAccountIdempotentInstruction(input: {
  payer: PublicKey
  associatedToken: PublicKey
  owner: PublicKey
  mint: PublicKey
  tokenProgram?: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: input.associatedToken, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: input.tokenProgram ?? TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  })
}

/** `MintToChecked` — tag 14 of the token program. */
const MINT_TO_CHECKED = 14

/**
 * Mints `amount` base units to `destination`. The checked form carries the
 * mint's decimals, and the token program refuses the instruction when they
 * differ — an amount meant in whole tokens cannot land six orders of magnitude
 * off without the transaction failing.
 */
export function mintToCheckedInstruction(input: {
  mint: PublicKey
  destination: PublicKey
  authority: PublicKey
  amount: bigint
  decimals: number
  tokenProgram?: PublicKey
}): TransactionInstruction {
  const data = Buffer.alloc(10)
  data.writeUInt8(MINT_TO_CHECKED, 0)
  data.writeBigUInt64LE(input.amount, 1)
  data.writeUInt8(input.decimals, 9)
  return new TransactionInstruction({
    programId: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.mint, isSigner: false, isWritable: true },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.authority, isSigner: true, isWritable: false },
    ],
    data,
  })
}

/** `Mint.decimals`: after the authority option (36 bytes) and the supply (8). */
const MINT_DECIMALS_OFFSET = 44
/** `Account.amount`: after the mint and the owner. */
const TOKEN_AMOUNT_OFFSET = 64

/** The decimals of a mint account's data, under either token program. */
export function decodeMintDecimals(data: Uint8Array): number {
  const decimals = data[MINT_DECIMALS_OFFSET]
  if (data.length < 82 || decimals === undefined) {
    throw new Error(`not a mint account: ${data.length} bytes`)
  }
  return decimals
}

/** The balance of a token account's data, in base units. */
export function decodeTokenAmount(data: Uint8Array): bigint {
  if (data.length < 165) throw new Error(`not a token account: ${data.length} bytes`)
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
    TOKEN_AMOUNT_OFFSET,
    true,
  )
}
