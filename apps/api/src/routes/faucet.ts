import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import {
  associatedTokenAddress,
  type Connection,
  createAssociatedTokenAccountIdempotentInstruction,
  decodeMintDecimals,
  decodePool,
  type Keypair,
  mintToCheckedInstruction,
  PROGRAM_ID,
  PublicKey,
  poolPda,
  sendAndConfirmTransaction,
  systemTransferInstruction,
  Transaction,
} from '@pumpking/anchor-client'
import type { FaucetStore } from '@pumpking/db'
import { decodeBase58 } from '@pumpking/shared'
import { type Context, Hono } from 'hono'
import { apiError } from '../errors.ts'

/**
 * `POST /v1/faucet/:pubkey` — devnet SOL and the mock asset for an operator
 * registering a phone (`T038a`).
 *
 * Registering costs rent and staking costs `pool.min_stake` of the pool's
 * asset. On devnet neither is worth anything, and neither is easy to come by:
 * the public airdrop answers 429 more often than not, and the asset is a mock
 * nobody sells. So this hands one wallet, once, exactly enough of both to
 * register and stake one sensor — and nothing else. The registration itself is
 * still the operator's own transaction, signed on the phone; a wallet that
 * already holds SOL and the asset never needs to come here (`FR-007`).
 *
 * **The faucet's key is the mint authority, and nothing more** (`FR-057`). It
 * is not the pool authority and holds no role in the program, so minting from
 * it moves no policy and proves nothing about the pool's solvency (`SC-006`).
 * It is also not the deployer's wallet, which keeps the upgrade authority and
 * never comes near a web server.
 *
 * **Absent unless configured**, like the feeder: without `FAUCET_KEYPAIR` every
 * path answers 404. A deployment that gives nothing away does not pretend to.
 *
 * **Limits.** One grant per wallet, ever — the ledger row is taken before the
 * transaction is sent, so two requests racing for one key cannot both be paid.
 * A few per caller and a ceiling for everyone per day, so a script cannot
 * drain the faucet's SOL by asking for fresh keys.
 */

const ADDRESS_BYTES = 32
const DAY_MS = 86_400_000
/** An unsettled grant older than this belongs to a process that died sending it. */
const STALE_MS = 120_000

/** `FR-056`: what a grant is, in units nobody can mistake for money. */
export type FaucetGrantWire = {
  /** The asset is a mock, and SOL on devnet is not SOL. */
  mock: true
  signature: string
  /** Decimal strings: `u64` does not survive a JSON number. */
  lamports: string
  /** Base units of the pool's asset — `pool.min_stake`. */
  tokens: string
  /** Where the tokens went: the wallet's associated account for the asset. */
  tokenAccount: string
}

export type FaucetGrant = Omit<FaucetGrantWire, 'mock'>

/** A refusal the faucet knows the reason for — there is nothing to retry. */
export class FaucetRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FaucetRefusal'
  }
}

export interface FaucetChain {
  /** One transaction to `wallet`; resolves once the cluster confirms it. */
  grant(wallet: PublicKey): Promise<FaucetGrant>
}

/**
 * The grant on a real cluster: SOL, the wallet's token account, the minimum
 * stake minted into it — one transaction, so a wallet never ends up with half.
 *
 * The mint, the amount and the token program are read from the chain at every
 * grant rather than configured: the pool says which asset it stakes in and how
 * much a sensor needs, and the mint account says which program owns it.
 */
export function rpcFaucet(
  connection: Connection,
  faucet: Keypair,
  lamports: bigint,
  programId?: PublicKey,
): FaucetChain {
  const pool = poolPda(programId ?? PROGRAM_ID).address
  return {
    async grant(wallet) {
      const poolInfo = await connection.getAccountInfo(pool)
      if (poolInfo === null) throw new FaucetRefusal('there is no pool on this network yet')
      const { assetMint, minStake } = decodePool(Uint8Array.from(poolInfo.data))
      const mintInfo = await connection.getAccountInfo(assetMint)
      if (mintInfo === null) throw new FaucetRefusal('the pool’s asset has no mint on this network')

      const tokenProgram = mintInfo.owner
      const tokenAccount = associatedTokenAddress(wallet, assetMint, tokenProgram)
      const tokens = BigInt(minStake.toString())
      const tx = new Transaction().add(
        systemTransferInstruction({ from: faucet.publicKey, to: wallet, lamports }),
        createAssociatedTokenAccountIdempotentInstruction({
          payer: faucet.publicKey,
          associatedToken: tokenAccount,
          owner: wallet,
          mint: assetMint,
          tokenProgram,
        }),
        mintToCheckedInstruction({
          mint: assetMint,
          destination: tokenAccount,
          authority: faucet.publicKey,
          amount: tokens,
          decimals: decodeMintDecimals(Uint8Array.from(mintInfo.data)),
          tokenProgram,
        }),
      )
      const signature = await sendAndConfirmTransaction(connection, tx, [faucet], {
        commitment: 'confirmed',
      })
      return {
        signature,
        lamports: lamports.toString(),
        tokens: tokens.toString(),
        tokenAccount: tokenAccount.toBase58(),
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Who is asking                                                              */
/* -------------------------------------------------------------------------- */

const PRIVATE = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^f[cd]/i,
  /^fe80:/i,
]

function isPrivate(address: string): boolean {
  return PRIVATE.some((pattern) => pattern.test(address))
}

/**
 * The caller's address, as far as the platform's proxies can vouch for it.
 *
 * `x-forwarded-for` is read **from the end**: whatever a client writes into the
 * header stays to the left of what the edge appends, so counting back cannot be
 * steered by the client. A private tail (the platform's internal hops) is
 * stepped over first; then `hops` more entries — on Render the client is
 * followed by one public proxy whose address wanders, so `hops` is 1 there.
 * With `hops` 0 the header is not trusted at all and the socket is the answer.
 */
export function callerAddress(
  forwardedFor: string | undefined,
  socket: string | undefined,
  hops: number,
): string {
  if (hops > 0 && forwardedFor !== undefined) {
    const chain = forwardedFor
      .split(',')
      .map((one) => one.trim())
      .filter((one) => isIP(one) !== 0)
    while (chain.length > 0 && isPrivate(chain[chain.length - 1] ?? '')) chain.pop()
    const client = chain[chain.length - 1 - hops]
    if (client !== undefined) return client
  }
  return socket ?? 'unknown'
}

function hashAddress(address: string): string {
  return createHash('sha256').update(address).digest('hex')
}

/* -------------------------------------------------------------------------- */
/* The route                                                                  */
/* -------------------------------------------------------------------------- */

export type FaucetRouteOptions = {
  /** Null when `FAUCET_KEYPAIR` is not set: the route is not there. */
  chain: FaucetChain | null
  store: FaucetStore
  /** Grants per caller per 24 hours. */
  perAddress: number
  /** Grants for everyone per 24 hours. */
  daily: number
  /** Proxies between the caller and this process — see `callerAddress`. */
  proxyHops: number
  /** The socket's peer; `index.ts` reads it from the connection. */
  socketAddress?: (context: Context) => string | undefined
  now?: () => Date
  /** Told why a grant failed; the caller is told only that it did. */
  onError?: (cause: unknown) => void
}

export function createFaucetRoute(options: FaucetRouteOptions): Hono {
  const { chain, store } = options
  const now = options.now ?? (() => new Date())
  const app = new Hono()

  if (chain === null) {
    return app.all('*', (context) =>
      apiError(context, 404, 'there is no faucet on this deployment'),
    )
  }

  return app.post('/:pubkey', async (context) => {
    const pubkey = context.req.param('pubkey')
    const bytes = decodeBase58(pubkey, ADDRESS_BYTES)
    if (bytes === null) {
      return apiError(context, 400, 'invalid wallet', {
        fields: [
          { field: 'pubkey', message: `must be a base58-encoded ${ADDRESS_BYTES}-byte address` },
        ],
      })
    }

    const at = now()
    const address = hashAddress(
      callerAddress(
        context.req.header('x-forwarded-for'),
        options.socketAddress?.(context),
        options.proxyHops,
      ),
    )
    const counts = await store.countsSince(new Date(at.getTime() - DAY_MS), address)
    if (counts.fromAddress >= options.perAddress) {
      return apiError(context, 429, 'this connection has had its faucet grants for today')
    }
    if (counts.total >= options.daily) {
      return apiError(
        context,
        429,
        'the faucet has given out its daily allowance; a wallet with devnet SOL and the asset can register without it',
      )
    }

    const claim = await store.claim(pubkey, address, at, new Date(at.getTime() - STALE_MS))
    if (!claim.claimed) {
      return apiError(context, 409, 'this wallet has already had its grant', {
        signature: claim.signature,
      })
    }

    let grant: FaucetGrant
    try {
      grant = await chain.grant(new PublicKey(bytes))
    } catch (cause) {
      await store.release(pubkey)
      if (cause instanceof FaucetRefusal) return apiError(context, 409, cause.message)
      options.onError?.(cause)
      return apiError(context, 503, 'the faucet’s transaction was not confirmed; try again')
    }
    await store.settle(pubkey, grant.signature)

    const wire: FaucetGrantWire = { mock: true, ...grant }
    return context.json(wire, 201)
  })
}
