// First, and a bare import so no import sorter moves anything above it:
// web3.js expects a global `Buffer` while it is evaluated. Nothing here
// imports web3.js or Anchor except through `register.ts`.
import './buffer-global.ts'
import {
  askFaucet,
  cellIdOf,
  cellOf,
  chainAt,
  explorerUrl,
  keypairOf,
  needsFaucet,
  operatorKeyFile,
  planFor,
  programIdOf,
  readNetwork,
  readStanding,
  registrationTransaction,
  sendAndConfirm,
} from './register.ts'
import { useEffect, useState } from 'react'
import { INK, MONO, Prose, RULE } from '../components/Bits.tsx'
import {
  indexedDbOperatorVault,
  memoryOperatorVault,
  newOperator,
  type OperatorRecord,
  type OperatorVault,
} from './vault.ts'

/**
 * Registering this phone — `T038a`. Loaded only when the registry does not
 * know the phone's key: the chunk carries Anchor, web3.js and `h3-js`, and a
 * phone that is already a sensor never downloads them.
 *
 * Three things, in the order a person meets them: where the phone is (the
 * cell, computed here — `FR-058`), whose wallet it belongs to (the operator
 * key, made here and offered for download), and one button that registers and
 * stakes. Devnet SOL and the mock asset come from the faucet when the wallet
 * has none; they are labelled as what they are (`FR-056`).
 */

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'
// `||`, not `??`: an unset repository variable reaches the Pages build as ''.
const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com'
const PROGRAM = programIdOf(import.meta.env.VITE_PUMPKING_PROGRAM_ID)

/* -------------------------------------------------------------------------- */
/* View                                                                       */
/* -------------------------------------------------------------------------- */

export type Place =
  | { kind: 'none' }
  | { kind: 'locating' }
  | { kind: 'cell'; cell: string; from: 'phone' | 'typed' }
  | { kind: 'problem'; message: string }

export type Progress =
  | { kind: 'idle' }
  | { kind: 'working'; step: string }
  | { kind: 'done'; signature: string | null; url: string | null }
  | { kind: 'failed'; message: string }

export type RegisterViewProps = {
  operator: string | null
  place: Place
  lat: string
  lng: string
  progress: Progress
  onLocate: () => void
  onLat: (text: string) => void
  onLng: (text: string) => void
  onTyped: () => void
  onDownload: () => void
  onRegister: () => void
}

export const button = (enabled: boolean) =>
  ({
    marginTop: 12,
    width: '100%',
    padding: '12px 0',
    fontSize: 16,
    fontWeight: 700,
    color: enabled ? '#FBFAF7' : INK,
    background: enabled ? INK : 'transparent',
    border: `2px solid ${INK}`,
    borderRadius: 0,
    cursor: enabled ? 'pointer' : 'default',
  }) as const

const quiet = {
  marginTop: 8,
  padding: '8px 0',
  width: '100%',
  fontSize: 15,
  color: INK,
  background: 'transparent',
  border: `1px solid ${RULE}`,
  borderRadius: 0,
  cursor: 'pointer',
} as const

const field = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 6,
  padding: '10px',
  fontSize: 17,
  fontFamily: MONO,
  color: INK,
  background: 'transparent',
  border: `2px solid ${INK}`,
  borderRadius: 0,
} as const

export const heading = { margin: '18px 0 6px', fontSize: 15, fontWeight: 700, color: INK } as const

export function placeText(place: Place): string {
  switch (place.kind) {
    case 'none':
      return 'The cell is worked out on this phone from its position. The coordinates are not sent anywhere.'
    case 'locating':
      return 'Asking the phone where it is…'
    case 'cell':
      return place.from === 'phone'
        ? `This phone stands in cell ${place.cell}. The coordinates stayed on the phone.`
        : `Those coordinates fall in cell ${place.cell}.`
    case 'problem':
      return place.message
  }
}

export function progressText(progress: Progress): string | null {
  switch (progress.kind) {
    case 'idle':
      return null
    case 'working':
      return progress.step
    case 'done':
      return 'Registered and staked on chain. The service here picks the key up within a few minutes; this page checks by itself.'
    case 'failed':
      return progress.message
  }
}

export type PlaceFieldsProps = {
  place: Place
  lat: string
  lng: string
  working: boolean
  onLocate: () => void
  onLat: (text: string) => void
  onLng: (text: string) => void
  onTyped: () => void
}

/** Where the phone is: its own position, or coordinates typed in — `FR-058`. */
export function PlaceFields(props: PlaceFieldsProps) {
  const { working } = props
  return (
    <>
      <Prose>{placeText(props.place)}</Prose>
      <button type="button" style={quiet} onClick={props.onLocate} disabled={working}>
        Use this phone’s location
      </button>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <label style={{ flex: 1, fontSize: 14, color: INK }}>
          Latitude
          <input
            type="text"
            inputMode="decimal"
            value={props.lat}
            onChange={(event) => props.onLat(event.target.value)}
            style={field}
          />
        </label>
        <label style={{ flex: 1, fontSize: 14, color: INK }}>
          Longitude
          <input
            type="text"
            inputMode="decimal"
            value={props.lng}
            onChange={(event) => props.onLng(event.target.value)}
            style={field}
          />
        </label>
      </div>
      <button type="button" style={quiet} onClick={props.onTyped} disabled={working}>
        Use these coordinates
      </button>
    </>
  )
}

export function RegisterView(props: RegisterViewProps) {
  const { operator, place, progress } = props
  const working = progress.kind === 'working'
  const canRegister =
    operator !== null && place.kind === 'cell' && !working && progress.kind !== 'done'
  const status = progressText(progress)

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
      <p style={{ margin: 0, fontSize: 17, fontWeight: 700, color: INK }}>Register this phone</p>

      <p style={heading}>1. Where it is</p>
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

      <p style={heading}>2. Whose it is</p>
      <Prose>
        The operator wallet pays for the registration, holds the stake and is paid the rewards. It
        was made on this phone; keep a copy, or a cleared browser loses the stake.
      </Prose>
      <div
        style={{
          marginTop: 8,
          fontFamily: MONO,
          fontSize: 13,
          color: INK,
          wordBreak: 'break-all',
        }}
      >
        {operator ?? '…'}
      </div>
      <button type="button" style={quiet} onClick={props.onDownload} disabled={operator === null}>
        Save the operator key
      </button>

      <p style={heading}>3. Register and stake</p>
      <Prose>
        Devnet only. If the wallet is empty, the faucet sends devnet SOL and the pool’s mock asset
        first — test tokens, not money.
      </Prose>
      <button
        type="button"
        disabled={!canRegister}
        style={button(canRegister)}
        onClick={props.onRegister}
      >
        {working ? 'Working…' : 'Register and stake'}
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

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type RegisterProps = {
  sensorSecret: Uint8Array
  /** Called once the chain has the sensor; the parent asks the registry again. */
  onRegistered: () => void
  apiUrl?: string
  fetchFn?: Fetch
  vault?: OperatorVault
}

/** Degrees as typed — comma or point, nothing else. */
function degrees(text: string): number {
  const trimmed = text.trim().replace(',', '.')
  return /^-?\d{1,3}(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

/** The phone's place and the two ways of giving it, as `PlaceFields` shows them. */
export function usePlace() {
  const [place, setPlace] = useState<Place>({ kind: 'none' })
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')

  const locate = () => {
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setPlace({
        kind: 'problem',
        message: 'This browser cannot tell where it is. Type the coordinates instead.',
      })
      return
    }
    setPlace({ kind: 'locating' })
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setPlace({
          kind: 'cell',
          cell: cellOf(position.coords.latitude, position.coords.longitude),
          from: 'phone',
        }),
      () =>
        setPlace({
          kind: 'problem',
          message: 'The phone did not give its position. Type the coordinates instead.',
        }),
      { enableHighAccuracy: true, timeout: 20_000 },
    )
  }

  const typed = () => {
    try {
      setPlace({ kind: 'cell', cell: cellOf(degrees(lat), degrees(lng)), from: 'typed' })
    } catch {
      setPlace({
        kind: 'problem',
        message: 'Latitude is −90 to 90 and longitude −180 to 180, in degrees.',
      })
    }
  }

  return { place, lat, lng, setLat, setLng, locate, typed }
}

/** The operator key this phone keeps, made the first time it is asked for. */
export function useOperator(vault: OperatorVault): OperatorRecord | null {
  const [operator, setOperator] = useState<OperatorRecord | null>(null)
  // Made the first time this opens, so its address can be shown — and funded
  // by hand — before anything is sent.
  useEffect(() => {
    let live = true
    void (async () => {
      const loaded = await vault.load().catch(() => null)
      const record = loaded ?? newOperator()
      if (loaded === null) await vault.save(record)
      if (live) setOperator(record)
    })()
    return () => {
      live = false
    }
  }, [vault])
  return operator
}

export function openOperatorVault(): OperatorVault {
  return typeof indexedDB === 'undefined' ? memoryOperatorVault() : indexedDbOperatorVault()
}

const Register = (props: RegisterProps) => {
  const [vault] = useState<OperatorVault>(() => props.vault ?? openOperatorVault())
  const apiUrl = props.apiUrl ?? API_URL
  const fetchFn = props.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const operator = useOperator(vault)
  const { place, lat, lng, setLat, setLng, locate, typed } = usePlace()
  const [progress, setProgress] = useState<Progress>({ kind: 'idle' })


  const download = () => {
    if (operator === null) return
    const blob = new Blob([operatorKeyFile(operator.secretKey)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `pumpking-operator-${keypairOf(operator.secretKey).publicKey.toBase58().slice(0, 8)}.json`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const register = async () => {
    if (operator === null || place.kind !== 'cell') return
    const chain = chainAt(RPC_URL)
    const owner = keypairOf(operator.secretKey)
    const sensor = keypairOf(props.sensorSecret)
    const cellId = cellIdOf(place.cell)
    try {
      setProgress({ kind: 'working', step: 'Reading the pool…' })
      const network = await readNetwork(chain, PROGRAM)
      if (network === null) {
        setProgress({ kind: 'failed', message: 'There is no pool on this network yet.' })
        return
      }
      const look = () =>
        readStanding(chain, network, owner.publicKey, sensor.publicKey, cellId, PROGRAM)
      let standing = await look()
      const plan = planFor(standing, network, owner.publicKey)
      if (plan.kind === 'done') {
        setProgress({ kind: 'done', signature: null, url: null })
        props.onRegistered()
        return
      }
      if (plan.kind === 'foreign') {
        setProgress({ kind: 'failed', message: 'This key is registered under another wallet.' })
        return
      }
      if (plan.kind === 'cell-full') {
        setProgress({
          kind: 'failed',
          message: 'That cell already has as many sensors as it can hold.',
        })
        return
      }

      if (needsFaucet(standing, plan)) {
        setProgress({ kind: 'working', step: 'Asking the faucet for devnet SOL and test tokens…' })
        const answer = await askFaucet(apiUrl, owner.publicKey.toBase58(), fetchFn)
        if (answer.kind === 'refused') {
          setProgress({ kind: 'failed', message: answer.message })
          return
        }
        standing = await look()
        if (needsFaucet(standing, plan)) {
          setProgress({
            kind: 'failed',
            message:
              'The wallet still holds too little to register. Send it devnet SOL and the pool’s asset, then try again.',
          })
          return
        }
      }

      setProgress({ kind: 'working', step: 'Signing with both keys and sending…' })
      const tx = registrationTransaction({
        operator: owner.publicKey,
        sensorKey: sensor.publicKey,
        cellId,
        network,
        plan,
        programId: PROGRAM,
      })
      const signature = await sendAndConfirm(
        chain,
        tx,
        plan.kind === 'register' ? [owner, sensor] : [owner],
      )
      setProgress({ kind: 'done', signature, url: explorerUrl(signature, RPC_URL) })
      props.onRegistered()
    } catch (cause) {
      setProgress({
        kind: 'failed',
        message: cause instanceof Error ? cause.message : 'The registration did not go through.',
      })
    }
  }

  return (
    <RegisterView
      operator={operator === null ? null : keypairOf(operator.secretKey).publicKey.toBase58()}
      place={place}
      lat={lat}
      lng={lng}
      progress={progress}
      onLocate={locate}
      onLat={setLat}
      onLng={setLng}
      onTyped={typed}
      onDownload={download}
      onRegister={() => void register()}
    />
  )
}

export default Register
