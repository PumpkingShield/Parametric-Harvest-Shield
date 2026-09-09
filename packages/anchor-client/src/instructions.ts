import { BN, BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import { PUMPKING_IDL } from './idl/idl.ts'
import { poolPda, vaultPda } from './pda.ts'
import { PROGRAM_ID } from './program.ts'
import { type AccountMeta, PublicKey, TOKEN_PROGRAM_ID, TransactionInstruction } from './web3.ts'

/**
 * Instructions, encoded from the IDL the program itself emitted.
 *
 * Nothing here restates a discriminator, an account order or a field layout:
 * all three are read out of `PUMPKING_IDL`, so the only way for the client to
 * disagree with the program is for `pnpm idl:sync` not to have been run. Even
 * the addresses of PDA accounts come from the IDL's own seed description —
 * `buildInstruction` derives them the way the program declared them, which is
 * why a caller passes `authority` and `assetMint` and never a pool address.
 *
 * Anchor's own `Program` would do the same job, but it insists on a
 * `Provider`, that is a connection and a wallet. The worker signs offline and
 * the tests touch no cluster; encoding is arithmetic and should need neither.
 */

const idl = PUMPKING_IDL as Idl
const coder = new BorshInstructionCoder(idl)

type IdlInstruction = Idl['instructions'][number]
type IdlAccountItem = IdlInstruction['accounts'][number]
type IdlCompositeAccount = Extract<IdlAccountItem, { accounts: unknown }>
type IdlAccount = Exclude<IdlAccountItem, IdlCompositeAccount>
type IdlPda = NonNullable<IdlAccount['pda']>
type IdlSeed = IdlPda['seeds'][number]
type IdlType = IdlInstruction['args'][number]['type']

/** Widths of the integer seeds Anchor writes little-endian. */
const SEED_INT_BYTES: Readonly<Record<string, number>> = {
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  u128: 16,
}

interface Resolution {
  instruction: IdlInstruction
  args: Readonly<Record<string, unknown>>
  supplied: Readonly<Record<string, PublicKey>>
  resolved: Map<string, PublicKey>
  programId: PublicKey
}

/** Composite account groups flatten into the list the program actually reads. */
function flattenAccounts(items: readonly IdlAccountItem[]): IdlAccount[] {
  const flat: IdlAccount[] = []
  for (const item of items) {
    if ('accounts' in item && item.accounts !== undefined) {
      flat.push(...flattenAccounts(item.accounts))
    } else {
      flat.push(item as IdlAccount)
    }
  }
  return flat
}

function argSeedBytes(where: string, type: IdlType, value: unknown): Uint8Array {
  if (value === undefined) {
    throw new Error(`seed \`${where}\` needs the argument, and it was not given`)
  }
  if (value instanceof PublicKey) {
    return value.toBytes()
  }
  const width = typeof type === 'string' ? SEED_INT_BYTES[type] : undefined
  if (width === undefined) {
    throw new Error(`seed \`${where}\` has type ${JSON.stringify(type)}, which is not encodable`)
  }
  const encoded = BN.isBN(value) ? value : new BN(String(value))
  return Uint8Array.from(encoded.toArray('le', width))
}

function seedBytes(account: string, seed: IdlSeed, ctx: Resolution): Uint8Array {
  switch (seed.kind) {
    case 'const':
      return Uint8Array.from(seed.value)
    case 'account': {
      // A dotted path reads a field out of an account that only the chain
      // holds. Resolving it would mean fetching, and this module never fetches.
      if (seed.path.includes('.')) {
        throw new Error(
          `\`${account}\` is seeded by \`${seed.path}\`, a field of an on-chain account; ` +
            'supply the address instead',
        )
      }
      const address = ctx.resolved.get(seed.path)
      if (address === undefined) {
        throw new Error(`\`${account}\` is seeded by account \`${seed.path}\`, which is unknown`)
      }
      return address.toBytes()
    }
    case 'arg': {
      const field = ctx.instruction.args.find((candidate) => candidate.name === seed.path)
      if (field === undefined) {
        throw new Error(`\`${account}\` is seeded by argument \`${seed.path}\`, which is unknown`)
      }
      return argSeedBytes(`${account}.${seed.path}`, field.type, ctx.args[seed.path])
    }
  }
}

/** Derives an account from the seeds the IDL describes it by. */
export function derivePdaFromIdl(account: string, pda: IdlPda, ctx: Resolution): PublicKey {
  if (pda.program !== undefined) {
    throw new Error(`\`${account}\` is derived under another program, which is not supported`)
  }
  const seeds = pda.seeds.map((seed) => seedBytes(account, seed, ctx))
  return PublicKey.findProgramAddressSync(seeds, ctx.programId)[0]
}

function resolveAccount(account: IdlAccount, ctx: Resolution): PublicKey {
  const supplied = ctx.supplied[account.name]
  if (supplied !== undefined) {
    return supplied
  }
  if (account.address !== undefined) {
    return new PublicKey(account.address)
  }
  if (account.pda !== undefined) {
    return derivePdaFromIdl(account.name, account.pda, ctx)
  }
  throw new Error(`account \`${account.name}\` has no address of its own and none was supplied`)
}

export interface InstructionInput {
  /** Addresses the IDL cannot derive: signers, mints, token accounts. */
  accounts?: Readonly<Record<string, PublicKey>>
  /** Argument values in the shape the Borsh coder expects — `BN` for `u64`. */
  args?: Readonly<Record<string, unknown>>
  programId?: PublicKey
}

/**
 * One instruction of the program, by its IDL name.
 *
 * Accounts come out in the IDL's order. The order is part of the wire format,
 * and a client that sorts or drops them builds a transaction the program reads
 * as a different call.
 */
export function buildInstruction(
  name: string,
  input: InstructionInput = {},
): TransactionInstruction {
  const instruction = idl.instructions.find((candidate) => candidate.name === name)
  if (instruction === undefined) {
    throw new Error(`the IDL has no instruction \`${name}\``)
  }

  const ctx: Resolution = {
    instruction,
    args: input.args ?? {},
    supplied: input.accounts ?? {},
    resolved: new Map(),
    programId: input.programId ?? PROGRAM_ID,
  }

  const keys: AccountMeta[] = []
  for (const account of flattenAccounts(instruction.accounts)) {
    const pubkey = resolveAccount(account, ctx)
    ctx.resolved.set(account.name, pubkey)
    keys.push({
      pubkey,
      isSigner: account.signer === true,
      isWritable: account.writable === true,
    })
  }

  return new TransactionInstruction({
    programId: ctx.programId,
    keys,
    data: coder.encode(name, ctx.args),
  })
}

/* -------------------------------------------------------------------------- */
/* initialize_pool                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What the authority fixes at deployment — the TypeScript twin of `PoolParams`
 * in `instructions/pool.rs`.
 *
 * Amounts are `bigint`, never `number`: `min_stake` is a `u64` counted in an
 * asset with decimals, so a stake past 2^53 is an ordinary balance rather than
 * an edge case. The conversion to `BN` happens once, at this edge.
 */
export interface PoolParams {
  aggregator: PublicKey
  cellExposureBps: number
  premiumRewardsBps: number
  minSensorsPerCell: number
  minStake: bigint
  unstakeDelayDays: number
  waitingPeriodDays: number
  dryDayThresholdMmX100: number
  secondsPerDay: number
}

export interface InitializePoolInput {
  /** Sets parameters and pays the rent; never a signer over the vaults. */
  authority: PublicKey
  /** `FR-055`: the settlement asset is a parameter, not a constant. */
  assetMint: PublicKey
  params: PoolParams
  /** SPL Token by default; a Token-2022 mint needs its own program here. */
  tokenProgram?: PublicKey
  programId?: PublicKey
}

export function initializePoolInstruction(input: InitializePoolInput): TransactionInstruction {
  return buildInstruction('initializePool', {
    programId: input.programId ?? PROGRAM_ID,
    accounts: {
      authority: input.authority,
      assetMint: input.assetMint,
      tokenProgram: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    },
    args: {
      params: {
        ...input.params,
        minStake: new BN(input.params.minStake.toString()),
      },
    },
  })
}

/* -------------------------------------------------------------------------- */
/* deposit_capital                                                            */
/* -------------------------------------------------------------------------- */

export interface DepositCapitalInput {
  depositor: PublicKey
  /** Must equal `pool.asset_mint`; the program checks it. */
  assetMint: PublicKey
  /** The depositor's own token account, with the depositor as its authority. */
  depositorTokens: PublicKey
  amount: bigint
  /** Defaults to the pool's capital vault, derived from the seeds. */
  vault?: PublicKey
  tokenProgram?: PublicKey
  programId?: PublicKey
}

/**
 * Puts capital in — `FR-032`, and the only way capital enters. The same call
 * seeds the pool and funds it later, so this builder has no sibling.
 */
export function depositCapitalInstruction(input: DepositCapitalInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  const pool = poolPda(programId).address
  return buildInstruction('depositCapital', {
    programId,
    accounts: {
      depositor: input.depositor,
      assetMint: input.assetMint,
      vault: input.vault ?? vaultPda(pool, programId).address,
      depositorTokens: input.depositorTokens,
      tokenProgram: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    },
    args: { amount: new BN(input.amount.toString()) },
  })
}
