import { describe, expect, it } from 'vitest'
import { ASSOCIATED_TOKEN_PROGRAM_ID } from './accounts.ts'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  decodeMintDecimals,
  decodeTokenAmount,
  mintToCheckedInstruction,
  systemTransferInstruction,
} from './spl.ts'
import { PublicKey, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './web3.ts'

function key(fill: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(fill))
}

const payer = key(1)
const owner = key(2)
const mint = key(3)
const ata = key(4)

describe('the token-program instructions the faucet and the phone send', () => {
  it('opens a token account with the idempotent tag, payer first', () => {
    const ix = createAssociatedTokenAccountIdempotentInstruction({
      payer,
      associatedToken: ata,
      owner,
      mint,
    })
    expect(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true)
    // 0 is `Create`, which fails on an account that exists; 1 is the one that does not.
    expect([...ix.data]).toEqual([1])
    expect(ix.keys.map((one) => [one.pubkey.toBase58(), one.isSigner, one.isWritable])).toEqual([
      [payer.toBase58(), true, true],
      [ata.toBase58(), false, true],
      [owner.toBase58(), false, false],
      [mint.toBase58(), false, false],
      [SYSTEM_PROGRAM_ID.toBase58(), false, false],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
    ])
  })

  it('mints with the checked tag, the amount little-endian and the decimals last', () => {
    const ix = mintToCheckedInstruction({
      mint,
      destination: ata,
      authority: payer,
      amount: 1_000_000n,
      decimals: 6,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
    expect([...ix.data]).toEqual([14, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0, 6])
    expect(ix.keys.map((one) => [one.isSigner, one.isWritable])).toEqual([
      [false, true],
      [false, true],
      [true, false],
    ])
    expect(ix.keys[2]?.pubkey.equals(payer)).toBe(true)
  })

  it('carries an amount past 2^53 exactly', () => {
    const ix = mintToCheckedInstruction({
      mint,
      destination: ata,
      authority: payer,
      amount: 2n ** 63n + 1n,
      decimals: 0,
    })
    expect(new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true)).toBe(
      2n ** 63n + 1n,
    )
  })

  it('moves lamports as a system transfer', () => {
    const ix = systemTransferInstruction({ from: payer, to: owner, lamports: 30_000_000n })
    expect(ix.programId.equals(SYSTEM_PROGRAM_ID)).toBe(true)
    // Tag 2 (`Transfer`) as u32, then the lamports as u64.
    expect([...ix.data]).toEqual([2, 0, 0, 0, 0x80, 0xc3, 0xc9, 0x01, 0, 0, 0, 0])
  })
})

describe('reading token accounts', () => {
  it('finds the decimals at byte 44 of a mint', () => {
    const data = new Uint8Array(82)
    data[44] = 6
    expect(decodeMintDecimals(data)).toBe(6)
  })

  it('refuses data too short to be a mint', () => {
    expect(() => decodeMintDecimals(new Uint8Array(44))).toThrow(/not a mint/)
  })

  it('finds the balance at byte 64 of a token account', () => {
    const data = new Uint8Array(165)
    new DataView(data.buffer).setBigUint64(64, 1_500_000n, true)
    expect(decodeTokenAmount(data)).toBe(1_500_000n)
  })

  it('refuses data too short to be a token account', () => {
    expect(() => decodeTokenAmount(new Uint8Array(82))).toThrow(/not a token account/)
  })
})
