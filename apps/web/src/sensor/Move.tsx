// First, and a bare import so no import sorter moves anything above it:
// web3.js expects a global `Buffer` while it is evaluated. Nothing here
// imports web3.js or Anchor except through `register.ts`.
import './buffer-global.ts'
import {
  cellIdOf,
  chainAt,
  explorerUrl,
  keypairOf,
  MOVE_SPACING_DAYS,
  type MovePlan,
  movePlanFor,
  moveTransaction,
  programIdOf,
  readMoveStanding,
  readNetwork,
  sendAndConfirm,
} from './register.ts'
import { useState } from 'react'
import { INK, Prose, RULE } from '../components/Bits.tsx'
import {
  button,
  heading,
  openOperatorVault,
  type Place,
  PlaceFields,
  type Progress,
  usePlace,
  useOperator,
} from './Register.tsx'
import type { OperatorVault } from './vault.ts'

/**
 * Moving this phone's sensor to the cell it now stands in — `T039`, `FR-059`.
 *
 * An explicit act, signed by the operator and the sensor key as a
 * registration is: a reading never moves a sensor by naming another cell. The
 * stake stays where it is and so does the record — the slot the sensor leaves
 * keeps counting towards an exclusion while the window reaches back to it, and
 * what it earned is still the operator's, claimed in the same transaction when
 * the program asks for it.
 *
 * Its own lazy chunk beside `Register.tsx`, sharing `register.ts`: a phone that
 * never moves never downloads it.
 */

// `||`, not `??`: an unset repository variable reaches the Pages build as ''.
const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com'
const PROGRAM = programIdOf(import.meta.env.VITE_PUMPKING_PROGRAM_ID)

/* -------------------------------------------------------------------------- */
/* View                                                                       */
/* -------------------------------------------------------------------------- */

/** Why a move cannot be sent, in words; null when it can. */
export function refusalText(plan: MovePlan): string | null {
  switch (plan.kind) {
    case 'move':
      return null
    case 'unregistered':
      return 'The chain has no sensor with this key.'
    case 'foreign':
      return 'This sensor belongs to a wallet that is not on this phone. Its owner moves it.'
    case 'excluded':
      return 'This sensor was excluded for repeated outliers. It answers for that record where it is; reinstate it first.'
    case 'same-cell':
      return 'The phone is still in the cell it is registered in. Nothing to move.'
    case 'cell-full':
      return 'That cell already has as many sensors as it can hold.'
    case 'too-soon':
      return `A sensor moves at most once in ${MOVE_SPACING_DAYS} days, so that the record it leaves behind still counts. It can move again on pool day ${plan.day}.`
    case 'no-sol':
      return 'The operator wallet has too little devnet SOL to open the new cell. Send it some, then try again.'
  }
}

export function moveProgressText(progress: Progress, to: string | null): string | null {
  switch (progress.kind) {
    case 'idle':
      return null
    case 'working':
      return progress.step
    case 'done':
      return `Moved on chain${to === null ? '' : ` to cell ${to}`}. Readings count there from the next whole interval; the one the move fell in counts nowhere. Until the service here picks the move up — a few minutes — readings go under the old cell and do not count. This page checks by itself.`
    case 'failed':
      return progress.message
  }
}

export type MoveViewProps = {
  /** The cell the registry has the sensor in. */
  from: string
  place: Place
  lat: string
  lng: string
  progress: Progress
  onLocate: () => void
  onLat: (text: string) => void
  onLng: (text: string) => void
  onTyped: () => void
  onMove: () => void
}

export function MoveView(props: MoveViewProps) {
  const { from, place, progress } = props
  const working = progress.kind === 'working'
  const to = place.kind === 'cell' ? place.cell : null
  const canMove = to !== null && to !== from && !working && progress.kind !== 'done'
  const status = moveProgressText(progress, to)

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
      <p style={{ margin: 0, fontSize: 17, fontWeight: 700, color: INK }}>Move this sensor</p>
      <Prose>
        {`Registered in cell ${from}. A phone that has been carried elsewhere keeps signing for that cell until it is moved here — the stake and the record go with it.`}
      </Prose>

      <p style={heading}>Where it is now</p>
      <PlaceFields
        place={place}
        lat={props.lat}
        lng={props.lng}
        working={working}
        onLocate={props.onLocate}
        onLat={props.onLat}
        onLng={props.onLng}
        onTyped={props.onTyped}
      />
      {to !== null && to === from ? (
        <div style={{ marginTop: 8 }}>
          <Prose>That is the cell it is registered in already.</Prose>
        </div>
      ) : null}

      <button type="button" disabled={!canMove} style={button(canMove)} onClick={props.onMove}>
        {working ? 'Working…' : to === null || to === from ? 'Move the sensor' : `Move it to ${to}`}
      </button>
      {status === null ? null : (
        <div role="status" style={{ marginTop: 12 }}>
          <Prose>{status}</Prose>
          {progress.kind === 'done' && progress.url !== null ? (
            <a
              href={progress.url}
              target="_blank"
              rel="noreferrer"
              style={{ display: 'inline-block', marginTop: 6, color: INK, fontSize: 15 }}
            >
              See the transaction
            </a>
          ) : null}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export type MoveProps = {
  sensorSecret: Uint8Array
  /** The cell the registry has the sensor in, hex. */
  from: string
  /** Called with the new cell once the chain has the move. */
  onMoved: (cell: string) => void
  vault?: OperatorVault
}

const Move = (props: MoveProps) => {
  const [vault] = useState<OperatorVault>(() => props.vault ?? openOperatorVault())
  const operator = useOperator(vault)
  const { place, lat, lng, setLat, setLng, locate, typed } = usePlace()
  const [progress, setProgress] = useState<Progress>({ kind: 'idle' })

  const move = async () => {
    if (operator === null || place.kind !== 'cell') return
    const chain = chainAt(RPC_URL)
    const owner = keypairOf(operator.secretKey)
    const sensor = keypairOf(props.sensorSecret)
    const cellId = cellIdOf(place.cell)
    try {
      setProgress({ kind: 'working', step: 'Reading the sensor on chain…' })
      const [network, standing] = await Promise.all([
        readNetwork(chain, PROGRAM),
        readMoveStanding(chain, owner.publicKey, sensor.publicKey, cellId, new Date(), PROGRAM),
      ])
      if (network === null || standing === null) {
        setProgress({ kind: 'failed', message: 'There is no pool on this network yet.' })
        return
      }
      const plan = movePlanFor(standing, cellId, owner.publicKey)
      if (plan.kind !== 'move') {
        setProgress({ kind: 'failed', message: refusalText(plan) ?? 'The move cannot be sent.' })
        return
      }

      setProgress({
        kind: 'working',
        step:
          plan.claim > 0n
            ? 'Claiming what the cell left last time earned, and moving — both keys sign…'
            : 'Signing with both keys and sending…',
      })
      const tx = moveTransaction({
        operator: owner.publicKey,
        sensorKey: sensor.publicKey,
        cellId,
        network,
        plan,
        programId: PROGRAM,
      })
      const signature = await sendAndConfirm(chain, tx, [owner, sensor])
      setProgress({ kind: 'done', signature, url: explorerUrl(signature, RPC_URL) })
      props.onMoved(place.cell)
    } catch (cause) {
      setProgress({
        kind: 'failed',
        message: cause instanceof Error ? cause.message : 'The move did not go through.',
      })
    }
  }

  return (
    <MoveView
      from={props.from}
      place={place}
      lat={lat}
      lng={lng}
      progress={progress}
      onLocate={locate}
      onLat={setLat}
      onLng={setLng}
      onTyped={typed}
      onMove={() => void move()}
    />
  )
}

export default Move
