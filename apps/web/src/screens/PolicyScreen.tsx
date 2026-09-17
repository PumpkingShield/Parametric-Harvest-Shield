import { DayState } from '@pumpking/shared/day'
import { useEffect, useState } from 'react'
import { type Day, fetchDays, fetchPolicy, type Policy } from '../api/policy.ts'
import {
  Block,
  FactRows,
  Headline,
  INK,
  MONO,
  Prose,
  RULE,
  SyntheticNote,
} from '../components/Bits.tsx'
import DayStrip from '../components/DayStrip.tsx'
import { basisRisk, policyFacts, policyWindow, runCaption } from '../data/policy.ts'
import { longestDryRun } from '../data/rainfall.ts'

/**
 * Screen 1 — the owner's open policy, on the live journal.
 *
 * Two reads, and the split is the API's: the policy comes from the chain
 * (`GET /v1/policies/:pubkey`), its days come from Postgres
 * (`GET /v1/cells/:cellId/days`), because the on-chain ring holds 128 days and
 * this window has to stay drawable after it has rolled out of it.
 *
 * **The address is a parameter, not a fixture.** `?policy=<pubkey>`, falling
 * back to `VITE_POLICY_PUBKEY` so a deployed demo opens on the policy the show
 * is about. With neither, the screen says which one it wants rather than
 * drawing numbers nobody bought.
 *
 * **The drawing is a separate export.** `PolicyView` takes the two answers and
 * nothing else, so what the screen puts in front of an owner can be rendered in
 * a test — which is what holds the `FR-040` disclosure on the page.
 */

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

/**
 * Decimals of the pool's asset mint. Not on the wire — the mint is a pool
 * parameter (`FR-055`) and the policy route does not read it — so it is
 * configured beside the API it belongs to.
 */
const ASSET_DECIMALS = Number(import.meta.env.VITE_ASSET_DECIMALS ?? '6')

function policyAddress(): string | null {
  const asked = new URLSearchParams(window.location.search).get('policy')
  return asked ?? import.meta.env.VITE_POLICY_PUBKEY ?? null
}

type Loaded = { policy: Policy; rows: Day[] }

const Note = ({ children }: { children: string }) => (
  <div style={{ paddingTop: 8 }}>
    <Prose>{children}</Prose>
  </div>
)

/**
 * `FR-040` — the index is not the damage, and the two part in both directions.
 *
 * Rendered from `basisRisk`, case by case, rather than written here: the words
 * name this policy's own threshold, cell and payout, and `policy.test.ts` holds
 * the two cases at opposite corners — paid with the crop fine, unpaid with the
 * crop lost. `PolicyScreen.test.tsx` holds them on the screen.
 */
const BasisRisk = ({ policy, decimals }: { policy: Policy; decimals: number }) => {
  const risk = basisRisk(policy, decimals)

  return (
    <Block>
      <Prose>{risk.trigger}</Prose>
      <div style={{ marginTop: 14, borderTop: `1px solid ${RULE}` }}>
        {risk.cases.map((entry) => (
          <div key={entry.index} style={{ padding: '12px 0', borderBottom: `1px solid ${RULE}` }}>
            <Prose>{`${entry.index}, ${entry.field} — ${entry.money}.`}</Prose>
          </div>
        ))}
      </div>
      <div style={{ paddingTop: 14 }}>
        <Prose>{risk.trade}</Prose>
      </div>
    </Block>
  )
}

/** The two answers, drawn. Everything here is a pure function of its props. */
export const PolicyView = ({
  policy,
  rows,
  decimals,
}: {
  policy: Policy
  rows: Day[]
  decimals: number
}) => {
  const { cells, days } = policyWindow(policy, rows)
  const uncovered = rows.filter((row) => row.state === DayState.NoCoverage).length

  return (
    <div>
      <Headline figure={String(policy.spell)} caption={runCaption(policy)} />

      <DayStrip
        id="policy"
        cells={cells}
        bracket={longestDryRun(days)}
        hint="Tap any day to see its rainfall and how many intervals carried a value."
      />

      <Block>
        <FactRows rows={policyFacts(policy, decimals)} />
      </Block>

      <BasisRisk policy={policy} decimals={decimals} />

      {uncovered > 0 ? (
        <Block>
          <Prose>
            {`${uncovered} ${uncovered === 1 ? 'day' : 'days'} in this window had too few sensors reporting to get a value. A day with no value is not a dry day — it ends the run.`}
          </Prose>
        </Block>
      ) : null}

      <p
        style={{
          margin: '28px 0 0',
          paddingTop: 14,
          borderTop: `1px solid ${RULE}`,
          fontFamily: MONO,
          fontSize: 13,
          lineHeight: 1.6,
          color: INK,
          wordBreak: 'break-word',
        }}
      >
        Cell {policy.cellId} · owner {policy.owner}
      </p>

      <SyntheticNote />
    </div>
  )
}

const PolicyScreen = () => {
  const [address] = useState(policyAddress)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (address === null) return
    const abort = new AbortController()

    const load = async () => {
      const policy = await fetchPolicy(API_URL, address, { signal: abort.signal })
      const rows = await fetchDays(
        API_URL,
        policy.cellId,
        policy.windowStartDay,
        policy.windowEndDay,
        { signal: abort.signal },
      )
      setLoaded({ policy, rows })
    }

    load().catch((cause: unknown) => {
      if (abort.signal.aborted) return
      setFailure(cause instanceof Error ? cause.message : String(cause))
    })

    return () => abort.abort()
  }, [address])

  if (address === null) {
    return <Note>No policy asked for. Open this page with ?policy=&lt;address&gt;.</Note>
  }
  if (failure !== null) {
    return <Note>{`Could not load the policy: ${failure}`}</Note>
  }
  if (loaded === null) {
    return <Note>Loading the policy and its days…</Note>
  }

  return <PolicyView policy={loaded.policy} rows={loaded.rows} decimals={ASSET_DECIMALS} />
}

export default PolicyScreen
