import type { SignedReadingWire } from '@pumpking/shared/reading-bytes'
import { sensorPublicKey } from '@pumpking/shared/signature'
import { useCallback, useEffect, useState } from 'react'
import { Block, INK, MONO, Prose, RULE } from '../components/Bits.tsx'
import {
  type LookUp,
  lookUpSensor,
  type Registration,
  type Sent,
  sendReading,
  signNext,
} from './publish.ts'
import { formatMillimetres, parseMillimetres } from './value.ts'
import {
  indexedDbVault,
  memoryVault,
  newRecord,
  type SensorRecord,
  type SensorVault,
} from './vault.ts'

/**
 * The phone as a sensor — `T038`, `FR-005`, `SC-009`.
 *
 * A key made on the phone, a number the operator reads off a rain gauge, a
 * signature, a request. The phone is a sensor on equal terms with a hardware
 * one: the same key type, the same 80 signed bytes, the same door
 * (`POST /v1/readings`) and the same registry deciding whether it counts.
 *
 * Registering the key on chain is not here (`T038a`): `register_sensor` needs
 * an operator who pays and stakes. Until then the screen says plainly that the
 * key is not registered and what that means for its readings.
 *
 * `SC-009` is measured on this component: `sensor:tap` is marked at the
 * click's own timestamp, `sensor:answer` when the service has answered, and
 * `sensor:publish` is the measure between them.
 */

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

/** What the last send came to, for the line under the button. */
export type Outcome =
  | { kind: 'invalid'; message: string }
  | { kind: 'sent'; sent: Sent; valueX100: number; elapsedMs: number }

/* -------------------------------------------------------------------------- */
/* View                                                                       */
/* -------------------------------------------------------------------------- */

const PROBLEM_TEXT: Record<NonNullable<Registration['problem']>, string> = {
  unregistered:
    'This service knows the key, but the chain has not confirmed it. Readings are stored and not counted.',
  excluded: 'This sensor was excluded for repeated outliers. Readings are stored and not counted.',
  understaked:
    'The stake is below the pool minimum. Readings are stored and not counted until it is topped up.',
  'no-pool': 'There is no pool on this network yet. Readings are stored and not counted.',
}

export function registrationText(lookUp: LookUp): string {
  switch (lookUp.kind) {
    case 'unknown':
      return 'This key is not in the registry yet. The service refuses its readings until an operator registers it with a stake.'
    case 'unreachable':
      return lookUp.message
    case 'registered': {
      const { registration } = lookUp
      const where = `Registered in cell ${registration.cellId}.`
      return registration.problem === null
        ? `${where} A reading that arrives within 90 minutes of its hour counts toward the median.`
        : `${where} ${PROBLEM_TEXT[registration.problem]}`
    }
  }
}

export function outcomeText(outcome: Outcome): string {
  if (outcome.kind === 'invalid') return outcome.message
  const { sent, valueX100, elapsedMs } = outcome
  const seconds = (elapsedMs / 1000).toFixed(1)
  switch (sent.kind) {
    case 'stored':
      return sent.status === 'accepted'
        ? `Published in ${seconds} s: ${formatMillimetres(valueX100)} mm, signed by this phone and accepted.`
        : `Stored as late: it reached the service more than 90 minutes after it was measured, so it does not count.`
    case 'refused':
      return `Refused: ${sent.message}`
    case 'retry':
      return sent.message
  }
}

export type ThisPhoneViewProps = {
  pubkey: string | null
  lookUp: LookUp | null
  pending: SignedReadingWire | null
  text: string
  busy: boolean
  outcome: Outcome | null
  onCreate: () => void
  onText: (text: string) => void
  onSend: (event: { timeStamp: number }) => void
  onResend: (event: { timeStamp: number }) => void
  onLookUp: () => void
}

const button = (enabled: boolean) =>
  ({
    marginTop: 14,
    width: '100%',
    padding: '14px 0',
    fontSize: 17,
    fontWeight: 700,
    color: enabled ? '#FBFAF7' : INK,
    background: enabled ? INK : 'transparent',
    border: `2px solid ${INK}`,
    borderRadius: 0,
    cursor: enabled ? 'pointer' : 'default',
  }) as const

export function ThisPhoneView(props: ThisPhoneViewProps) {
  const { pubkey, lookUp, pending, text, busy, outcome } = props

  if (pubkey === null) {
    return (
      <Block top={0}>
        <p style={{ margin: '0 0 12px', fontSize: 17, fontWeight: 700, color: INK }}>
          This phone as a sensor
        </p>
        <Prose>
          A phone signs readings with its own key, the same kind a hardware sensor has. The key is
          made here and never leaves this phone.
        </Prose>
        <button type="button" style={button(true)} onClick={props.onCreate}>
          Make this phone a sensor
        </button>
      </Block>
    )
  }

  const canSend = lookUp?.kind === 'registered' && !busy

  return (
    <Block top={0}>
      <p style={{ margin: '0 0 12px', fontSize: 17, fontWeight: 700, color: INK }}>
        This phone as a sensor
      </p>
      <div
        style={{
          padding: '12px 0',
          borderTop: `1px solid ${RULE}`,
          borderBottom: `1px solid ${RULE}`,
          fontFamily: MONO,
          fontSize: 13,
          color: INK,
          wordBreak: 'break-all',
        }}
      >
        {pubkey}
      </div>
      <div style={{ marginTop: 12 }}>
        <Prose>
          {lookUp === null ? 'Asking the registry about this key…' : registrationText(lookUp)}
        </Prose>
        {lookUp?.kind === 'unreachable' ? (
          <button type="button" style={button(true)} onClick={props.onLookUp}>
            Ask again
          </button>
        ) : null}
      </div>

      <label style={{ display: 'block', marginTop: 20, fontSize: 17, color: INK }}>
        Rain in the past hour, mm
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(event) => props.onText(event.target.value)}
          style={{
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
            marginTop: 8,
            padding: '12px',
            fontSize: 22,
            fontFamily: MONO,
            color: INK,
            background: 'transparent',
            border: `2px solid ${INK}`,
            borderRadius: 0,
          }}
        />
      </label>
      <button
        type="button"
        disabled={!canSend}
        style={button(canSend)}
        onClick={(event) => props.onSend({ timeStamp: event.timeStamp })}
      >
        {busy ? 'Signing and sending…' : 'Sign and send'}
      </button>

      {outcome === null ? null : (
        <div role="status" style={{ marginTop: 14 }}>
          <Prose>{outcomeText(outcome)}</Prose>
        </div>
      )}
      {pending === null || busy ? null : (
        <div style={{ marginTop: 14 }}>
          <Prose>
            {`A reading of ${formatMillimetres(pending.valueX100)} mm from ${new Date(
              pending.measuredAt,
            ).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })} has no answer yet. Sending it again cannot count it twice.`}
          </Prose>
          <button
            type="button"
            style={button(true)}
            onClick={(event) => props.onResend({ timeStamp: event.timeStamp })}
          >
            Send it again
          </button>
        </div>
      )}
    </Block>
  )
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

function openVault(): SensorVault {
  // A browser with IndexedDB switched off still gets a working page; the key
  // then lasts as long as the tab, and that is better than no sensor at all.
  return typeof indexedDB === 'undefined' ? memoryVault() : indexedDbVault()
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const browserFetch: Fetch = (input, init) => fetch(input, init)

export type ThisPhoneProps = {
  /** Injected by a test; the page opens IndexedDB. */
  vault?: SensorVault
  apiUrl?: string
  fetchFn?: Fetch
}

const ThisPhone = (props: ThisPhoneProps) => {
  // Held, not recomputed: a vault or a fetch made anew on each render would be
  // a new dependency of every effect below, and the effects would never rest.
  const [vault] = useState<SensorVault>(() => props.vault ?? openVault())
  const apiUrl = props.apiUrl ?? API_URL
  const fetchFn = props.fetchFn ?? browserFetch
  const [record, setRecord] = useState<SensorRecord | null | undefined>(undefined)
  const [pubkey, setPubkey] = useState<string | null>(null)
  const [lookUp, setLookUp] = useState<LookUp | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  useEffect(() => {
    let live = true
    vault
      .load()
      .then((loaded) => {
        if (live) setRecord(loaded)
      })
      .catch(() => {
        if (live) setRecord(null)
      })
    return () => {
      live = false
    }
  }, [vault])

  const ask = useCallback(
    async (key: string) => {
      setLookUp(null)
      setLookUp(await lookUpSensor(apiUrl, key, fetchFn))
    },
    [apiUrl, fetchFn],
  )

  // Keyed on the secret alone: a saved counter is a new `record`, and asking
  // the registry again after every reading would be a request nobody needs.
  const secretKey = record?.secretKey
  useEffect(() => {
    if (secretKey === undefined) return
    let live = true
    void sensorPublicKey(secretKey).then((key) => {
      if (!live) return
      setPubkey(key)
      void ask(key)
    })
    return () => {
      live = false
    }
  }, [secretKey, ask])

  const create = async () => {
    const fresh = newRecord()
    await vault.save(fresh)
    setRecord(fresh)
  }

  /** Sends `body`, already saved as pending under `saved`, and settles it. */
  const deliver = async (
    saved: SensorRecord,
    body: SignedReadingWire,
    tapAt: number,
  ): Promise<void> => {
    const sent = await sendReading(apiUrl, body, fetchFn)
    const answeredAt = performance.now()
    performance.mark('sensor:answer', { startTime: answeredAt })
    performance.measure('sensor:publish', { start: tapAt, end: answeredAt })
    const elapsedMs = answeredAt - tapAt

    // Only an answer that says what happened ends the pending reading. A
    // retryable one keeps it, so the next try is this body and not a new one.
    const settled = sent.kind === 'retry' ? saved : { ...saved, pending: null }
    if (settled !== saved) await vault.save(settled)
    setRecord(settled)
    setOutcome({ kind: 'sent', sent, valueX100: body.valueX100, elapsedMs })
  }

  const send = async ({ timeStamp }: { timeStamp: number }) => {
    performance.clearMarks()
    performance.clearMeasures()
    performance.mark('sensor:tap', { startTime: timeStamp })
    if (record === null || record === undefined || lookUp?.kind !== 'registered') return

    const parsed = parseMillimetres(text)
    if (!parsed.ok) {
      setOutcome({ kind: 'invalid', message: parsed.message })
      return
    }
    setBusy(true)
    try {
      const { body, record: next } = await signNext(
        record,
        lookUp.registration.cellId,
        parsed.valueX100,
        new Date(),
      )
      // Before the request: a counter is spent the moment a signature exists.
      await vault.save(next)
      setRecord(next)
      await deliver(next, body, timeStamp)
    } finally {
      setBusy(false)
    }
  }

  const resend = async ({ timeStamp }: { timeStamp: number }) => {
    if (record === null || record === undefined || record.pending === null) return
    performance.clearMarks()
    performance.clearMeasures()
    performance.mark('sensor:tap', { startTime: timeStamp })
    setBusy(true)
    try {
      await deliver(record, record.pending, timeStamp)
    } finally {
      setBusy(false)
    }
  }

  if (record === undefined) {
    return (
      <Block top={0}>
        <Prose>Opening this phone’s sensor key…</Prose>
      </Block>
    )
  }

  return (
    <ThisPhoneView
      pubkey={record === null ? null : pubkey}
      lookUp={lookUp}
      pending={record?.pending ?? null}
      text={text}
      busy={busy}
      outcome={outcome}
      onCreate={() => void create()}
      onText={setText}
      onSend={(event) => void send(event)}
      onResend={(event) => void resend(event)}
      onLookUp={() => {
        if (pubkey !== null) void ask(pubkey)
      }}
    />
  )
}

export default ThisPhone
