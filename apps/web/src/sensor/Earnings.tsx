// First, and a bare import so no import sorter moves anything above it:
// web3.js expects a global `Buffer` while it is evaluated. Nothing here
// imports web3.js or Anchor except through `register.ts` and `earnings.ts`.
import './buffer-global.ts'
import { useCallback, useEffect, useState } from 'react'
import { Block, FactRows, INK, MONO, Prose, RULE } from '../components/Bits.tsx'
import { ASSET, formatExact } from '../data/money.ts'
import type { EarnedDay } from './activity.ts'
import {
  type Earnings as ChainEarnings,
  type Claimable,
  type ClaimRefusal,
  claimRefusal,
  claimTransaction,
  dayStart,
  readEarnings,
} from './earnings.ts'
import { button, heading, openOperatorVault, useOperator } from './Register.tsx'
import { chainAt, explorerUrl, keypairOf, programIdOf, sendAndConfirm } from './register.ts'
import type { OperatorVault } from './vault.ts'

/**
 * What the operator has and is owed — `T040`, `FR-036`, `FR-050`, `FR-053`,
 * `FR-056`.
 *
 * The stake that gives this phone its vote, what waits to be claimed in its
 * cell (and in the one it left, `FR-059`), and a button per cell that claims
 * it. Read from the chain, here, because a claim empties the balance the moment
 * it lands; the history of what each day paid comes from the aggregator's
 * mirror of the program's own event, passed in.
 *
 * Every sum carries the asset's name — `mock USDC` — because it is a devnet
 * test token, and a sum without the name reads as money (`FR-056`).
 *
 * Its own lazy chunk beside `Register.tsx` and `Move.tsx`: it needs web3.js and
 * Anchor, which a phone that is not yet a sensor never downloads.
 */

// `||`, not `??`: an unset repository variable reaches the Pages build as ''.
const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com'
const PROGRAM = programIdOf(import.meta.env.VITE_PUMPKING_PROGRAM_ID)

/* -------------------------------------------------------------------------- */
/* View                                                                       */
/* -------------------------------------------------------------------------- */

export const REFUSAL_TEXT: Record<Exclude<ClaimRefusal, 'nothing'>, string> = {
  unregistered: 'The chain has no sensor with this key.',
  foreign: 'This sensor is paid to a wallet that is not on this phone. Its owner claims.',
  excluded:
    'This sensor was excluded for repeated outliers. What it had not claimed went back to the pool with the stake.',
  'no-sol': 'The operator wallet has too little devnet SOL for the fee. Send it some, then claim.',
}

export type ClaimState =
  | { kind: 'idle' }
  | { kind: 'working'; cell: string }
  | { kind: 'done'; cell: string; amount: bigint; url: string }
  | { kind: 'failed'; cell: string; message: string }

export type EarningsViewProps = {
  earnings: ChainEarnings
  /** Why each cell's claim cannot go, by cell; absent when it can. */
  refusals: ReadonlyMap<string, ClaimRefusal>
  earned: { total: string; days: EarnedDay[] }
  claim: ClaimState
  onClaim: (claimable: Claimable) => void
}

const sum = (amount: bigint | string, decimals: number) =>
  `${formatExact(amount, decimals)} ${ASSET}`

const date = (at: Date) =>
  at.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * The day a reward was earned, as the history lists it. A compressed pool
 * (`FR-049`) fits many pool days into one calendar day, and a list of the same
 * date over and over says nothing — so a day shorter than a calendar one is
 * named by its number and start, to the minute.
 */
export function earnedDayLabel(day: EarnedDay, secondsPerDay: number): string {
  if (day.startsAt === null) return `day ${day.dayIndex}`
  const at = new Date(day.startsAt)
  if (secondsPerDay >= 86_400) return date(at)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `day ${day.dayIndex}, ${date(at)} ${time}`
}

export function stakeRows(earnings: ChainEarnings): [string, string][] {
  const { sensor, network, pool } = earnings
  if (sensor === null) return []
  const rows: [string, string][] = [['Stake', sum(sensor.stake, network.decimals)]]
  if (sensor.unstaking > 0n) {
    rows.push([
      sensor.unlockAtDay === null
        ? 'Leaving the stake'
        : `Leaving the stake, back on ${date(dayStart(pool, sensor.unlockAtDay))}`,
      sum(sensor.unstaking, network.decimals),
    ])
  }
  return rows
}

export function stakeText(earnings: ChainEarnings): string {
  const { sensor, network } = earnings
  if (sensor === null) return ''
  if (!sensor.active) {
    return 'This sensor was excluded for repeated outliers: the stake went to the pool, and its readings are stored and not counted.'
  }
  return sensor.stake >= network.minStake
    ? `Readings count toward the median because this stake is posted — the pool asks for ${sum(network.minStake, network.decimals)}. Readings that keep disagreeing with the cell’s median cost the stake.`
    : `The stake is below the pool’s ${sum(network.minStake, network.decimals)}: readings are stored and not counted until it is topped up.`
}

export function claimText(claim: ClaimState, decimals: number): string | null {
  switch (claim.kind) {
    case 'idle':
      return null
    case 'working':
      return `Claiming from cell ${claim.cell}…`
    case 'done':
      return `Claimed ${sum(claim.amount, decimals)} from cell ${claim.cell} to the operator wallet.`
    case 'failed':
      return claim.message
  }
}

export function EarningsView(props: EarningsViewProps) {
  const { earnings, refusals, earned, claim } = props
  const { decimals } = earnings.network
  const working = claim.kind === 'working'
  const status = claimText(claim, decimals)

  return (
    <Block>
      <p style={{ margin: '0 0 12px', fontSize: 17, fontWeight: 700, color: INK }}>
        Stake and earnings
      </p>
      <FactRows rows={stakeRows(earnings)} />
      <div style={{ marginTop: 12 }}>
        <Prose>{stakeText(earnings)}</Prose>
      </div>

      <p style={heading}>Ready to claim</p>
      <FactRows
        rows={earnings.claimable.map((one, index) => [
          index === 0 ? `Cell ${one.cell}` : `Cell ${one.cell}, left on the last move`,
          sum(one.amount, decimals),
        ])}
      />
      {earnings.claimable.map((one) => {
        const refusal = refusals.get(one.cell)
        if (refusal === 'nothing') return null
        const enabled = refusal === undefined && !working
        return (
          <div key={one.cell}>
            <button
              type="button"
              disabled={!enabled}
              style={button(enabled)}
              onClick={() => props.onClaim(one)}
            >
              {working && claim.cell === one.cell
                ? 'Claiming…'
                : `Claim ${sum(one.amount, decimals)} from ${one.cell}`}
            </button>
            {refusal === undefined ? null : (
              <div style={{ marginTop: 8 }}>
                <Prose>{REFUSAL_TEXT[refusal]}</Prose>
              </div>
            )}
          </div>
        )
      })}
      {status === null ? null : (
        <div role="status" style={{ marginTop: 12 }}>
          <Prose>{status}</Prose>
          {claim.kind === 'done' ? (
            <a
              href={claim.url}
              target="_blank"
              rel="noreferrer"
              style={{ display: 'inline-block', marginTop: 6, color: INK, fontSize: 15 }}
            >
              See the transaction
            </a>
          ) : null}
        </div>
      )}

      <p style={heading}>Earned, by day</p>
      <Prose>
        {earned.days.length === 0
          ? 'Nothing earned in the last 30 days. A cell pays only from the premiums of its own policies, and only for intervals this sensor’s reading was counted in.'
          : `${sum(earned.total, decimals)} in all. A day’s share of the cell’s premiums, divided among the sensors counted in its intervals.`}
      </Prose>
      {earned.days.length === 0 ? null : (
        <div
          style={{
            marginTop: 10,
            borderTop: `1px solid ${RULE}`,
            fontFamily: MONO,
            fontSize: 13,
            color: INK,
          }}
        >
          {earned.days.map((day) => (
            <div
              key={`${day.cellId}:${day.dayIndex}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 0',
                borderBottom: `1px solid ${RULE}`,
              }}
            >
              <span>
                {earnedDayLabel(day, earnings.pool.secondsPerDay)}
                {earnings.claimable.length > 1 ? ` · ${day.cellId}` : ''}
              </span>
              <span style={{ textAlign: 'right' }}>{sum(day.amount, decimals)}</span>
            </div>
          ))}
        </div>
      )}
    </Block>
  )
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export type EarningsProps = {
  sensorSecret: Uint8Array
  earned: { total: string; days: EarnedDay[] }
  vault?: OperatorVault
}

type Loaded =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'read'; earnings: ChainEarnings; lamports: bigint }

const Earnings = (props: EarningsProps) => {
  const [vault] = useState<OperatorVault>(() => props.vault ?? openOperatorVault())
  const operator = useOperator(vault)
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [claim, setClaim] = useState<ClaimState>({ kind: 'idle' })
  const { sensorSecret } = props

  const load = useCallback(async () => {
    if (operator === null) return
    const chain = chainAt(RPC_URL)
    try {
      const owner = keypairOf(operator.secretKey).publicKey
      const [earnings, lamports] = await Promise.all([
        readEarnings(chain, keypairOf(sensorSecret).publicKey, PROGRAM),
        chain.getBalance(owner),
      ])
      setLoaded(
        earnings === null
          ? { kind: 'failed', message: 'There is no pool on this network yet.' }
          : { kind: 'read', earnings, lamports: BigInt(lamports) },
      )
    } catch (cause) {
      setLoaded({
        kind: 'failed',
        message: cause instanceof Error ? cause.message : 'The chain did not answer.',
      })
    }
  }, [operator, sensorSecret])

  useEffect(() => {
    void load()
  }, [load])

  if (loaded.kind === 'loading' || operator === null) {
    return (
      <Block>
        <Prose>Reading the stake and earnings on chain…</Prose>
      </Block>
    )
  }
  if (loaded.kind === 'failed') {
    return (
      <Block>
        <Prose>{loaded.message}</Prose>
      </Block>
    )
  }

  const owner = keypairOf(operator.secretKey)
  const { earnings } = loaded
  const refusals = new Map<string, ClaimRefusal>()
  for (const one of earnings.claimable) {
    const refusal = claimRefusal(earnings, one, owner.publicKey, loaded.lamports)
    if (refusal !== null) refusals.set(one.cell, refusal)
  }

  const send = async (one: Claimable) => {
    setClaim({ kind: 'working', cell: one.cell })
    try {
      const tx = claimTransaction({
        operator: owner.publicKey,
        sensorKey: keypairOf(sensorSecret).publicKey,
        cellId: one.cellId,
        network: earnings.network,
        programId: PROGRAM,
      })
      const signature = await sendAndConfirm(chainAt(RPC_URL), tx, [owner])
      setClaim({
        kind: 'done',
        cell: one.cell,
        amount: one.amount,
        url: explorerUrl(signature, RPC_URL),
      })
      // From the chain again, not from arithmetic on what was shown: the
      // balance may have grown by a day between the read and the claim.
      await load()
    } catch (cause) {
      setClaim({
        kind: 'failed',
        cell: one.cell,
        message: cause instanceof Error ? cause.message : 'The claim did not go through.',
      })
    }
  }

  return (
    <EarningsView
      earnings={earnings}
      refusals={refusals}
      earned={props.earned}
      claim={claim}
      onClaim={(one) => void send(one)}
    />
  )
}

export default Earnings
