import { lazy, Suspense, useEffect, useState } from 'react'
import { Block, FactRows, Headline, INK, MONO, Prose, RULE } from '../components/Bits.tsx'
import DayStrip from '../components/DayStrip.tsx'
import {
  type Activity,
  type CellSensors,
  fetchActivity,
  fetchCellSensors,
  peerStatus,
  type Read,
  readingSquares,
  shortKey,
  verdictCounts,
} from './activity.ts'

/**
 * The operator screen — `T040`, `FR-036`, `FR-050`.
 *
 * What the network made of this phone's readings, what the operator holds and
 * is owed, and who else measures the cell. Two sources, by what each number
 * is: the aggregator's judgement comes from the API (it is the aggregator's
 * word, and it lives in its database); the money comes from the chain, in the
 * `Earnings` chunk, beside the button that claims it.
 *
 * Shown only for a phone the registry knows. Before that there is nothing of
 * its own to show, and a preview on invented numbers is what this screen used
 * to be.
 */

const Earnings = lazy(() => import('./Earnings.tsx'))

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/* -------------------------------------------------------------------------- */
/* View                                                                       */
/* -------------------------------------------------------------------------- */

export function readingRows(activity: Activity): [string, string][] {
  const counts = verdictCounts(activity.readings)
  const rows: [string, string][] = [
    ['Sent', String(activity.readings.length)],
    ['Counted in the median', String(counts.counted)],
    ['Judged an outlier', String(counts.outlier)],
  ]
  const unvoted = counts['not-counted'] + counts['no-median']
  if (unvoted > 0) rows.push(['Stored, not counted', String(unvoted)])
  if (counts.late > 0) rows.push(['Late', String(counts.late)])
  if (counts.pending > 0) rows.push(['Waiting for the day to close', String(counts.pending)])
  return rows
}

export function ReadingsView({ activity }: { activity: Activity }) {
  const counted = verdictCounts(activity.readings).counted
  return (
    <>
      <Headline
        figure={String(counted)}
        caption={`reading${counted === 1 ? '' : 's'} counted in the median in the last 24 hours`}
      />
      <FactRows rows={readingRows(activity)} />
      <Block>
        <p style={{ margin: '0 0 12px', fontSize: 17, color: INK }}>
          The last 24 hours, one square per reading
        </p>
        {activity.readings.length === 0 ? (
          <Prose>No readings from this phone in the last 24 hours.</Prose>
        ) : (
          <DayStrip
            id="sensor-readings"
            cells={readingSquares(activity.readings)}
            hint="Tap a reading to see what happened to it. A day’s readings are judged when the day closes."
          />
        )}
      </Block>
    </>
  )
}

export function PeersView({ cell, pubkey }: { cell: CellSensors; pubkey: string }) {
  return (
    <Block>
      <p style={{ margin: '0 0 12px', fontSize: 17, color: INK }}>
        {`The sensors in cell ${cell.cellId}`}
      </p>
      <Prose>
        {`Judged intervals and outliers over the last ${cell.windowDays} days — the record an exclusion is decided on. Only staked sensors vote; to move a cell’s value, one would have to stake most of its independent votes.`}
      </Prose>
      <div
        style={{
          marginTop: 10,
          borderTop: `1px solid ${RULE}`,
          fontFamily: MONO,
          fontSize: 13,
          color: INK,
        }}
      >
        {cell.sensors.map((peer) => {
          const you = peer.pubkey === pubkey
          return (
            <div
              key={peer.pubkey}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 8,
                padding: '12px 0',
                borderBottom: `1px solid ${RULE}`,
                lineHeight: 1.5,
              }}
            >
              <span>{`#${peer.slot} ${shortKey(peer.pubkey)}`}</span>
              <span style={{ textAlign: 'right' }}>
                {`${peer.judged - peer.outliers}/${peer.judged}`}
              </span>
              <span style={{ gridColumn: '1 / -1', fontWeight: you ? 700 : 400 }}>
                {peerStatus(peer)}
                {you ? '   ← this phone' : ''}
              </span>
            </div>
          )
        })}
      </div>
    </Block>
  )
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export type OperatorProps = {
  apiUrl: string
  fetchFn: Fetch
  pubkey: string
  /** The cell the registry has this phone in, hex. */
  cellId: string
  sensorSecret: Uint8Array
}

const Operator = (props: OperatorProps) => {
  const { apiUrl, fetchFn, pubkey, cellId } = props
  const [activity, setActivity] = useState<Read<Activity> | null>(null)
  const [cell, setCell] = useState<Read<CellSensors> | null>(null)

  useEffect(() => {
    let live = true
    void fetchActivity(apiUrl, pubkey, fetchFn).then((read) => {
      if (live) setActivity(read)
    })
    void fetchCellSensors(apiUrl, cellId, fetchFn).then((read) => {
      if (live) setCell(read)
    })
    return () => {
      live = false
    }
  }, [apiUrl, fetchFn, pubkey, cellId])

  return (
    <div style={{ margin: '36px 0 0', paddingTop: 14, borderTop: `2px solid ${INK}` }}>
      <p style={{ margin: '0 0 18px', fontSize: 17, fontWeight: 700, color: INK }}>
        What the network made of it
      </p>
      {activity === null ? (
        <Prose>Asking the service about this phone’s readings…</Prose>
      ) : activity.kind === 'failed' ? (
        <Prose>{activity.message}</Prose>
      ) : (
        <>
          <ReadingsView activity={activity.value} />
          <Suspense
            fallback={
              <Block>
                <Prose>Loading the stake and earnings…</Prose>
              </Block>
            }
          >
            <Earnings sensorSecret={props.sensorSecret} earned={activity.value.earned} />
          </Suspense>
        </>
      )}
      {cell === null || cell.kind === 'failed' ? null : (
        <PeersView cell={cell.value} pubkey={pubkey} />
      )}
    </div>
  )
}

export default Operator
