import { BN, BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import { PUMPKING_IDL } from './idl/idl.ts'
import {
  cellPda,
  policyPda,
  poolPda,
  reputationPda,
  rewardsPda,
  sensorPda,
  stakeVaultPda,
  vaultPda,
} from './pda.ts'
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

/**
 * Anchor camel-cases the **names** in the IDL it generates for TypeScript but
 * leaves the **path** of a seed as the Rust identifier that wrote it: a field
 * listed as `cellId` is pointed at by `params.cell_id`. So a path segment is
 * matched in both forms, and a path that already arrives camel-cased — which
 * is what Anchor's own runtime converter produces — keeps working unchanged.
 *
 * The domain is narrow enough for this to be exact rather than a guess:
 * segments are Rust identifiers, `[a-z0-9_]+`.
 */
function camelSegment(segment: string): string {
  return segment.replace(/_+([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
}

/** Whether an IDL name is the one a path segment is pointing at. */
function names(candidate: string, segment: string): boolean {
  return candidate === segment || candidate === camelSegment(segment)
}

/** A property under either spelling, without confusing a real `0` for absence. */
function pick(source: Readonly<Record<string, unknown>>, segment: string): unknown {
  if (segment in source) {
    return source[segment]
  }
  const camel = camelSegment(segment)
  return camel in source ? source[camel] : undefined
}

/**
 * The declared type of one field of a `defined` struct — the step a dotted
 * argument path takes, e.g. `params.cell_id`.
 *
 * A seed is bytes, and the width of those bytes comes from the type rather
 * than from the runtime value: a `BN` holding 7 could be a `u8` or a `u64`,
 * and picking the wrong one derives an address that exists but is not the
 * account the program will look at.
 */
function structFieldType(where: string, type: IdlType, step: string): IdlType {
  const name = typeof type === 'object' && 'defined' in type ? type.defined.name : undefined
  const definition = name === undefined ? undefined : idl.types?.find((one) => one.name === name)
  const body = definition?.type
  const fields: readonly unknown[] =
    body !== undefined && body.kind === 'struct' ? (body.fields ?? []) : []

  for (const field of fields) {
    if (
      typeof field === 'object' &&
      field !== null &&
      'name' in field &&
      typeof field.name === 'string' &&
      names(field.name, step) &&
      'type' in field
    ) {
      return field.type as IdlType
    }
  }
  throw new Error(`seed \`${where}\` reads field \`${step}\`, which ${name ?? 'the type'} has not`)
}

/**
 * The value and width of an argument seed, following a dotted path into a
 * struct argument when the program declares one — Anchor writes
 * `params.cell_id` whenever the seed comes out of a parameter object.
 */
function argSeedValue(account: string, path: string, ctx: Resolution): Uint8Array {
  const [root, ...rest] = path.split('.')
  const argument =
    root === undefined
      ? undefined
      : ctx.instruction.args.find((candidate) => names(candidate.name, root))
  if (root === undefined || argument === undefined) {
    throw new Error(`\`${account}\` is seeded by argument \`${path}\`, which is unknown`)
  }

  const where = `${account}.${path}`
  let type: IdlType = argument.type
  let value: unknown = pick(ctx.args, root)

  for (const step of rest) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`seed \`${where}\` reads \`${step}\` of something that is not a struct`)
    }
    type = structFieldType(where, type, step)
    value = pick(value as Record<string, unknown>, step)
  }

  return argSeedBytes(where, type, value)
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
      const address = ctx.resolved.get(seed.path) ?? ctx.resolved.get(camelSegment(seed.path))
      if (address === undefined) {
        throw new Error(`\`${account}\` is seeded by account \`${seed.path}\`, which is unknown`)
      }
      return address.toBytes()
    }
    case 'arg':
      return argSeedValue(account, seed.path, ctx)
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
  /** `FR-021`: charged on top of the expected loss. */
  riskLoadingBps: number
  /** `FR-021`: the rate below which cover is not sold at any history. */
  minRateBps: number
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

/* -------------------------------------------------------------------------- */
/* issue_policy                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The terms of one policy — the TypeScript twin of `PolicyParams` in
 * `instructions/policy.rs`.
 *
 * Days are indices, not dates (`FR-049`), so they stay plain numbers; every
 * amount is a `u64` and stays `bigint`.
 */
export interface PolicyTerms {
  /** Distinguishes several policies of one buyer; part of the seeds. */
  nonce: bigint
  cellId: bigint
  /** `FR-046`: consecutive dry days that trigger the event. */
  spellDaysThreshold: number
  payout: bigint
  /**
   * The most the buyer will pay. `FR-021` sets the price out of the cell's own
   * record; this only refuses the sale above a bound. A quote and the
   * transaction that follows it are two different prices whenever a day is
   * recorded in between, and this is what stands between them.
   */
  maxPremium: bigint
  windowStartDay: number
  windowEndDay: number
}

export interface IssuePolicyInput {
  /** `FR-025`, `FR-067`: buyer, owner and payer are one account. */
  owner: PublicKey
  /** Must equal `pool.asset_mint`; the program checks it. */
  assetMint: PublicKey
  /** The buyer's own token account, with the buyer as its authority. */
  ownerTokens: PublicKey
  terms: PolicyTerms
  /** Defaults to the pool's capital vault, derived from the seeds. */
  vault?: PublicKey
  tokenProgram?: PublicKey
  programId?: PublicKey
}

/**
 * Buys cover — `FR-018`. The cell and the policy addresses come out of the
 * terms, because the program seeds them from the same two numbers.
 */
export function issuePolicyInstruction(input: IssuePolicyInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  const pool = poolPda(programId).address
  const { terms } = input
  return buildInstruction('issuePolicy', {
    programId,
    accounts: {
      owner: input.owner,
      assetMint: input.assetMint,
      vault: input.vault ?? vaultPda(pool, programId).address,
      ownerTokens: input.ownerTokens,
      tokenProgram: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    },
    args: {
      params: {
        nonce: new BN(terms.nonce.toString()),
        cellId: new BN(terms.cellId.toString()),
        spellDaysThreshold: terms.spellDaysThreshold,
        payout: new BN(terms.payout.toString()),
        maxPremium: new BN(terms.maxPremium.toString()),
        windowStartDay: terms.windowStartDay,
        windowEndDay: terms.windowEndDay,
      },
    },
  })
}

/**
 * The instruction an encoded payload carries, read back through the same IDL
 * that wrote it, or null when the discriminator names nothing.
 *
 * The round trip is not a nicety. `BorshInstructionCoder` encodes a field the
 * arguments do not carry as `0` — silently, without throwing — so a builder
 * whose argument names have drifted from the IDL produces a valid transaction
 * that means something else. Every builder in this file is tested by decoding
 * what it produced, and the trace (`FR-037`) reads transactions the same way.
 */
export type DecodedInstruction = { name: string; data: Record<string, unknown> }

export function decodeInstruction(data: Uint8Array): DecodedInstruction | null {
  const decoded = coder.decode(Buffer.from(data))
  return decoded === null ? null : (decoded as unknown as DecodedInstruction)
}

/* -------------------------------------------------------------------------- */
/* submit_day_record                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Classification of one day, as the on-chain log stores it. The same three
 * values as `DayState` in `@pumpking/shared`, restated here only so the client
 * package does not depend on the shared one for a wire constant.
 */
export const DayState = {
  NoCoverage: 0,
  Dry: 1,
  Wet: 2,
} as const

export type DayClassification = (typeof DayState)[keyof typeof DayState]

/**
 * One day of one cell — the TypeScript twin of `DayRecordParams` in
 * `instructions/day.rs`.
 *
 * `rainfallX100` is `null` for a day without coverage and a number otherwise,
 * and the program refuses any other pairing. Null and not zero: zero is a real,
 * dry reading of the sky, and silence is not.
 */
export interface DayRecord {
  cellId: bigint
  /** Day index on the pool's clock — `FR-049`, never a date. */
  dayIndex: number
  state: DayClassification
  /** Bit per sensor slot whose readings entered the day's medians. */
  contributors: number
  /** Merkle root of the cell values the day was summed from — `FR-037`. */
  readingsRoot: Uint8Array
  rainfallX100: number | null
  coveredIntervals: number
  totalIntervals: number
}

export interface SubmitDayRecordInput {
  /** `FR-015`: must be `pool.aggregator`; the program checks the key. */
  aggregator: PublicKey
  record: DayRecord
  programId?: PublicKey
}

/**
 * Writes one day — `FR-015`. The cell account is derived from `cellId` and
 * opened by the first day the network publishes for it, so there is no
 * separate registration call to make first.
 */
export function submitDayRecordInstruction(input: SubmitDayRecordInput): TransactionInstruction {
  const { record } = input
  if (record.readingsRoot.length !== 32) {
    throw new Error(`the readings root must be 32 bytes, got ${record.readingsRoot.length}`)
  }
  return buildInstruction('submitDayRecord', {
    programId: input.programId ?? PROGRAM_ID,
    accounts: { aggregator: input.aggregator },
    args: {
      params: {
        cellId: new BN(record.cellId.toString()),
        dayIndex: record.dayIndex,
        state: record.state,
        contributors: record.contributors,
        readingsRoot: Array.from(record.readingsRoot),
        rainfallX100: record.rainfallX100,
        coveredIntervals: record.coveredIntervals,
        totalIntervals: record.totalIntervals,
      },
    },
  })
}

/* -------------------------------------------------------------------------- */
/* settle_policy                                                              */
/* -------------------------------------------------------------------------- */

export interface SettlePolicyInput {
  /**
   * Whoever is sending the transaction — `FR-030`. The program checks this
   * key against nothing, so the worker, the owner, a neighbour or a bot are
   * all the same caller as far as the payout is concerned.
   */
  caller: PublicKey
  /** Fixed at issue; the policy address is derived from it and the nonce. */
  owner: PublicKey
  nonce: bigint
  cellId: bigint
  /** Must equal `pool.asset_mint`; the program checks it. */
  assetMint: PublicKey
  /**
   * A token account the **owner** holds the authority over — `FR-066`. The
   * caller picks which of the owner's accounts the money lands in, never
   * whose.
   */
  ownerTokens: PublicKey
  /** Defaults to the pool's capital vault, derived from the seeds. */
  vault?: PublicKey
  tokenProgram?: PublicKey
  programId?: PublicKey
}

/**
 * Pays a policy the index has triggered — `FR-026`.
 *
 * The instruction takes no arguments at all: everything it decides on is
 * already in the two accounts it reads. That is why this builder needs the
 * policy's seeds rather than its terms — there is nothing else to pass.
 */
export function settlePolicyInstruction(input: SettlePolicyInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  const pool = poolPda(programId).address
  return buildInstruction('settlePolicy', {
    programId,
    accounts: {
      caller: input.caller,
      policy: policyPda(input.owner, input.nonce, programId).address,
      cell: cellPda(input.cellId, programId).address,
      assetMint: input.assetMint,
      vault: input.vault ?? vaultPda(pool, programId).address,
      ownerTokens: input.ownerTokens,
      tokenProgram: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    },
  })
}

/* -------------------------------------------------------------------------- */
/* close_policy                                                               */
/* -------------------------------------------------------------------------- */

export interface ClosePolicyInput {
  /** Anybody — `FR-028` closes capacity, not money. */
  caller: PublicKey
  owner: PublicKey
  nonce: bigint
  cellId: bigint
  programId?: PublicKey
}

/**
 * Closes a policy whose window ended without the event — `FR-028`.
 *
 * No vault, no mint, no token program: nothing moves. What the call releases
 * is the reservation the payout held against the pool's free liquidity, and
 * the absence of those accounts is the shape of that fact.
 */
export function closePolicyInstruction(input: ClosePolicyInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  return buildInstruction('closePolicy', {
    programId,
    accounts: {
      caller: input.caller,
      policy: policyPda(input.owner, input.nonce, programId).address,
      cell: cellPda(input.cellId, programId).address,
    },
  })
}

/* -------------------------------------------------------------------------- */
/* claim_unclaimed_payout                                                     */
/* -------------------------------------------------------------------------- */

export interface ClaimUnclaimedPayoutInput {
  /** Anybody: the destination is bound to the owner either way — `FR-066`. */
  caller: PublicKey
  owner: PublicKey
  nonce: bigint
  cellId: bigint
  assetMint: PublicKey
  /** A token account the owner holds the authority over. */
  ownerTokens: PublicKey
  vault?: PublicKey
  tokenProgram?: PublicKey
  programId?: PublicKey
}

/**
 * Delivers a payout settlement could not — `FR-029`. Reachable only for a
 * policy whose owner's token account was frozen when the event landed; the
 * money waited in the vault, reserved, the whole time.
 */
export function claimUnclaimedPayoutInstruction(
  input: ClaimUnclaimedPayoutInput,
): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  const pool = poolPda(programId).address
  return buildInstruction('claimUnclaimedPayout', {
    programId,
    accounts: {
      caller: input.caller,
      policy: policyPda(input.owner, input.nonce, programId).address,
      cell: cellPda(input.cellId, programId).address,
      assetMint: input.assetMint,
      vault: input.vault ?? vaultPda(pool, programId).address,
      ownerTokens: input.ownerTokens,
      tokenProgram: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    },
  })
}

/* -------------------------------------------------------------------------- */
/* register_sensor                                                            */
/* -------------------------------------------------------------------------- */

export interface RegisterSensorInput {
  /** Pays for the accounts; the sensor's vote, rewards and stake are theirs. */
  operator: PublicKey
  /**
   * The key the sensor signs readings with. It co-signs the transaction:
   * without that, anyone could register somebody else's device.
   */
  sensorKey: PublicKey
  /** H3 index on the network's grid level (`FR-060`); the program checks it. */
  cellId: bigint
  programId?: PublicKey
}

/** Puts a sensor on the network — `FR-007`, open to anyone. */
export function registerSensorInstruction(input: RegisterSensorInput): TransactionInstruction {
  return buildInstruction('registerSensor', {
    programId: input.programId ?? PROGRAM_ID,
    accounts: { operator: input.operator, sensorKey: input.sensorKey },
    args: { cellId: new BN(input.cellId.toString()) },
  })
}

/* -------------------------------------------------------------------------- */
/* stake_sensor                                                               */
/* -------------------------------------------------------------------------- */

export interface StakeSensorInput {
  /** Must be the sensor's operator; the program checks it. */
  operator: PublicKey
  sensorKey: PublicKey
  /** Must equal `pool.asset_mint`. */
  assetMint: PublicKey
  /** The operator's own token account. */
  operatorTokens: PublicKey
  amount: bigint
  /** Defaults to the pool's stake vault — never the capital vault (`FR-051`). */
  stakeVault?: PublicKey
  tokenProgram?: PublicKey
  programId?: PublicKey
}

/** Adds to a sensor's stake — `FR-050`. */
export function stakeSensorInstruction(input: StakeSensorInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  const pool = poolPda(programId).address
  return buildInstruction('stakeSensor', {
    programId,
    accounts: {
      operator: input.operator,
      // Seeded by a field of the account itself, which the IDL cannot follow.
      sensor: sensorPda(input.sensorKey, programId).address,
      assetMint: input.assetMint,
      stakeVault: input.stakeVault ?? stakeVaultPda(pool, programId).address,
      operatorTokens: input.operatorTokens,
      tokenProgram: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    },
    args: { amount: new BN(input.amount.toString()) },
  })
}

/* -------------------------------------------------------------------------- */
/* request_unstake                                                            */
/* -------------------------------------------------------------------------- */

export interface RequestUnstakeInput {
  /** Must be the sensor's operator; the program checks it. */
  operator: PublicKey
  sensorKey: PublicKey
  /** Taken from the voting stake at once; it stops voting the same slot. */
  amount: bigint
  programId?: PublicKey
}

/**
 * Starts the thaw for part or all of a sensor's stake — `FR-053`. Asking again
 * adds to what is thawing and restarts the count from today.
 */
export function requestUnstakeInstruction(input: RequestUnstakeInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  return buildInstruction('requestUnstake', {
    programId,
    accounts: {
      operator: input.operator,
      // Seeded by a field of the account itself, which the IDL cannot follow.
      sensor: sensorPda(input.sensorKey, programId).address,
    },
    args: { amount: new BN(input.amount.toString()) },
  })
}

/* -------------------------------------------------------------------------- */
/* withdraw_stake                                                             */
/* -------------------------------------------------------------------------- */

export interface WithdrawStakeInput {
  /** Must be the sensor's operator; the program checks it. */
  operator: PublicKey
  sensorKey: PublicKey
  /** Must equal `pool.asset_mint`. */
  assetMint: PublicKey
  /** The operator's own token account — the only place the stake can go. */
  operatorTokens: PublicKey
  /** Defaults to the pool's stake vault — never the capital vault (`FR-051`). */
  stakeVault?: PublicKey
  tokenProgram?: PublicKey
  programId?: PublicKey
}

/**
 * Pays out everything whose thaw has ended — `FR-053`. Before the unlock day
 * the program refuses with `StakeStillThawing` and logs the days left.
 */
export function withdrawStakeInstruction(input: WithdrawStakeInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  const pool = poolPda(programId).address
  return buildInstruction('withdrawStake', {
    programId,
    accounts: {
      operator: input.operator,
      sensor: sensorPda(input.sensorKey, programId).address,
      assetMint: input.assetMint,
      stakeVault: input.stakeVault ?? stakeVaultPda(pool, programId).address,
      operatorTokens: input.operatorTokens,
      tokenProgram: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    },
    args: {},
  })
}

/* -------------------------------------------------------------------------- */
/* submit_day_reputation                                                      */
/* -------------------------------------------------------------------------- */

/** Sensor slots of a cell — `MAX_SENSORS_PER_CELL`, one per bit of the mask. */
export const SENSOR_SLOTS = 32

export interface DayReputation {
  cellId: bigint
  dayIndex: number
  /** Intervals each slot was judged in, indexed by slot; `SENSOR_SLOTS` long. */
  judged: readonly number[]
  /** Of those, the ones the slot was an outlier in. */
  outliers: readonly number[]
  /**
   * Each slot's share of the day's reward budget — `FR-062`, in
   * `REWARD_WEIGHT_UNIT` per interval (`dayWeights` in `@pumpking/shared`).
   * All zero on a day nobody earned, which returns the budget to capital.
   */
  weights: readonly number[]
}

export interface SubmitDayReputationInput {
  /** Must be `pool.aggregator`, as for the day it accompanies. */
  aggregator: PublicKey
  reputation: DayReputation
  programId?: PublicKey
}

/**
 * Writes a day of the cell's verdicts — `FR-011` — and pays the day's reward
 * budget by its weights — `FR-062`, `FR-064`. Goes in the same transaction as
 * `submitDayRecordInstruction`, after it, for every day: the program accepts
 * it only for the day the cell recorded last, and the first one opens the
 * cell's reward schedule.
 */
export function submitDayReputationInstruction(
  input: SubmitDayReputationInput,
): TransactionInstruction {
  const { reputation } = input
  for (const [name, counts] of [
    ['judged', reputation.judged],
    ['outliers', reputation.outliers],
  ] as const) {
    if (counts.length !== SENSOR_SLOTS) {
      throw new RangeError(`${name} must have ${SENSOR_SLOTS} slots, got ${counts.length}`)
    }
    for (const count of counts) {
      if (!Number.isInteger(count) || count < 0 || count > 65_535) {
        throw new RangeError(`${name} holds ${count}, which is not a u16`)
      }
    }
  }
  if (reputation.weights.length !== SENSOR_SLOTS) {
    throw new RangeError(
      `weights must have ${SENSOR_SLOTS} slots, got ${reputation.weights.length}`,
    )
  }
  for (const weight of reputation.weights) {
    if (!Number.isInteger(weight) || weight < 0 || weight > 0xffff_ffff) {
      throw new RangeError(`weights holds ${weight}, which is not a u32`)
    }
  }
  return buildInstruction('submitDayReputation', {
    programId: input.programId ?? PROGRAM_ID,
    accounts: { aggregator: input.aggregator },
    args: {
      params: {
        cellId: new BN(reputation.cellId.toString()),
        dayIndex: reputation.dayIndex,
        judged: [...reputation.judged],
        outliers: [...reputation.outliers],
        weights: [...reputation.weights],
      },
    },
  })
}

/* -------------------------------------------------------------------------- */
/* exclude_sensor                                                             */
/* -------------------------------------------------------------------------- */

export interface ExcludeSensorInput {
  /** Anyone; signs and pays the fee, gains nothing. */
  caller: PublicKey
  sensorKey: PublicKey
  /** The sensor's cell — `Sensor.cell_id`; its ring and schedule are seeded by it. */
  cellId: bigint
  /**
   * `Sensor.previous_cell_id` — the cell it left on its last move (`FR-059`),
   * equal to `cellId` for a sensor that never moved. The program fixes both
   * accounts by seeds: a wrong one is refused, not read as no record.
   */
  previousCellId: bigint
  /** Must equal `pool.asset_mint`. */
  assetMint: PublicKey
  stakeVault?: PublicKey
  /** Defaults to the pool's capital vault, where the burnt stake goes. */
  vault?: PublicKey
  tokenProgram?: PublicKey
  programId?: PublicKey
}

/**
 * Excludes a sensor whose record over the window breaches the outlier share
 * and burns its stake into capital — `FR-012`, `FR-052`. Permissionless.
 */
export function excludeSensorInstruction(input: ExcludeSensorInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  const pool = poolPda(programId).address
  return buildInstruction('excludeSensor', {
    programId,
    accounts: {
      caller: input.caller,
      // Both seeded by fields of the sensor account, which the IDL cannot follow.
      sensor: sensorPda(input.sensorKey, programId).address,
      reputation: reputationPda(input.cellId, programId).address,
      previousReputation: reputationPda(input.previousCellId, programId).address,
      // Unclaimed rewards are forfeited with the stake, in both cells.
      rewards: rewardsPda(input.cellId, programId).address,
      previousRewards: rewardsPda(input.previousCellId, programId).address,
      assetMint: input.assetMint,
      stakeVault: input.stakeVault ?? stakeVaultPda(pool, programId).address,
      vault: input.vault ?? vaultPda(pool, programId).address,
      tokenProgram: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    },
    args: {},
  })
}

/* -------------------------------------------------------------------------- */
/* reinstate_sensor                                                           */
/* -------------------------------------------------------------------------- */

export interface ReinstateSensorInput {
  /** Must be the sensor's operator; the program checks it. */
  operator: PublicKey
  sensorKey: PublicKey
  cellId: bigint
  programId?: PublicKey
}

/**
 * Brings an excluded sensor back with a clean slate and no stake — `FR-012`.
 * It votes again only once staked to the minimum anew.
 */
export function reinstateSensorInstruction(input: ReinstateSensorInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  return buildInstruction('reinstateSensor', {
    programId,
    accounts: {
      operator: input.operator,
      sensor: sensorPda(input.sensorKey, programId).address,
      reputation: reputationPda(input.cellId, programId).address,
    },
    args: {},
  })
}

/* -------------------------------------------------------------------------- */
/* claim_reward                                                               */
/* -------------------------------------------------------------------------- */

export interface ClaimRewardInput {
  /** Anybody: the destination is bound to the operator either way. */
  caller: PublicKey
  sensorKey: PublicKey
  /**
   * The cell to claim from: the sensor's own, or the one it left on its last
   * move (`FR-059`) — earnings stay in the schedule of the cell that paid
   * them. Every slot the sensor holds there is paid at once.
   */
  cellId: bigint
  /** Must equal `pool.asset_mint`. */
  assetMint: PublicKey
  /** A token account the sensor's operator holds the authority over. */
  operatorTokens: PublicKey
  /** Defaults to the pool's capital vault, where rewards wait (`FR-061`). */
  vault?: PublicKey
  tokenProgram?: PublicKey
  programId?: PublicKey
}

/**
 * Sends everything a sensor has earned in one cell to its operator — `FR-036`.
 * An excluded sensor is refused with `SensorExcluded`, a cell it holds no slot
 * in with `NotTheSensorsCell`, and one with nothing earned with
 * `NothingToClaim`.
 */
export function claimRewardInstruction(input: ClaimRewardInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  const pool = poolPda(programId).address
  return buildInstruction('claimReward', {
    programId,
    accounts: {
      caller: input.caller,
      // Seeded by a field of the sensor account, which the IDL cannot follow.
      sensor: sensorPda(input.sensorKey, programId).address,
      assetMint: input.assetMint,
      vault: input.vault ?? vaultPda(pool, programId).address,
      operatorTokens: input.operatorTokens,
      tokenProgram: input.tokenProgram ?? TOKEN_PROGRAM_ID,
    },
    args: { cellId: new BN(input.cellId.toString()) },
  })
}

/* -------------------------------------------------------------------------- */
/* move_sensor                                                                */
/* -------------------------------------------------------------------------- */

export interface MoveSensorInput {
  /** Must be the sensor's operator; pays for the new cell if it is the first there. */
  operator: PublicKey
  /** Co-signs, as at registration: it is what names the cell in every reading. */
  sensorKey: PublicKey
  /** Where the sensor goes — an H3 cell on the network's grid level. */
  cellId: bigint
  /**
   * `Sensor.previous_cell_id` before this move — the cell left on the last
   * one, or the sensor's own cell if it never moved. The program checks that
   * slot holds nothing unclaimed before the pointer moves past it.
   */
  previousCellId: bigint
  programId?: PublicKey
}

/**
 * Moves a sensor to another cell — `FR-059`. A fresh slot there; the old one
 * stays the sensor's for its record and its earnings. Stake and operator do
 * not change. A second move waits `OUTLIER_WINDOW_DAYS + 1` days
 * (`MovedTooRecently`) and for the slot before to be claimed
 * (`PreviousSlotUnclaimed`).
 */
export function moveSensorInstruction(input: MoveSensorInput): TransactionInstruction {
  const programId = input.programId ?? PROGRAM_ID
  return buildInstruction('moveSensor', {
    programId,
    accounts: {
      operator: input.operator,
      sensorKey: input.sensorKey,
      // Seeded by a field of the sensor account, which the IDL cannot follow.
      previousRewards: rewardsPda(input.previousCellId, programId).address,
    },
    args: { cellId: new BN(input.cellId.toString()) },
  })
}
