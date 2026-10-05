import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LookUp, Registration } from './publish.ts'
import {
  outcomeText,
  registrationText,
  ThisPhoneView,
  type ThisPhoneViewProps,
} from './ThisPhone.tsx'

/**
 * What the person holding the phone is told. Rendered to a string, as
 * `PolicyScreen.test.tsx` does: no DOM, no new dependency. The words are taken
 * from `registrationText` and `outcomeText`, and asserted where they are shown.
 */

const KEY = '9cTTzqUnwkJqbTe1JyHm4qGZbFBh2jX2qNcP5Cx2zR7a'
const CELL = '871e701b3ffffff'

const registered = (problem: 'excluded' | null = null): LookUp => ({
  kind: 'registered',
  registration: {
    pubkey: KEY,
    cellId: CELL,
    previousCellId: null,
    movedAt: null,
    stake: '1000000',
    minStake: '1000000',
    voting: problem === null,
    problem,
  },
})

function view(overrides: Partial<ThisPhoneViewProps>): string {
  const noop = () => undefined
  return renderToStaticMarkup(
    <ThisPhoneView
      pubkey={KEY}
      lookUp={registered()}
      pending={null}
      text=""
      busy={false}
      outcome={null}
      onCreate={noop}
      onText={noop}
      onSend={noop}
      onResend={noop}
      onLookUp={noop}
      {...overrides}
    />,
  )
}

/** The `disabled` attribute of the Send button, read off the markup. */
function sendDisabled(markup: string): boolean {
  const button = /<button[^>]*>(Sign and send|Signing and sending…)<\/button>/.exec(markup)
  if (button === null) throw new Error('no send button')
  return button[0].includes('disabled')
}

describe('ThisPhoneView', () => {
  it('offers to make a key, and says it stays on the phone', () => {
    const markup = view({ pubkey: null, lookUp: null })
    expect(markup).toContain('Make this phone a sensor')
    expect(markup).toContain('never leaves this phone')
    expect(markup).not.toContain('Sign and send')
  })

  it('shows the key and does not send for a key the registry does not have', () => {
    const unknown: LookUp = { kind: 'unknown' }
    const markup = view({ lookUp: unknown })
    expect(markup).toContain(KEY)
    expect(markup).toContain(registrationText(unknown))
    expect(sendDisabled(markup)).toBe(true)
  })

  it('names the registered cell, and sends', () => {
    const markup = view({})
    expect(registrationText(registered())).toContain(CELL)
    expect(markup).toContain(registrationText(registered()))
    expect(sendDisabled(markup)).toBe(false)
  })

  it('says where a moved key came from, and from when it counts — FR-059', () => {
    const moved: LookUp = {
      kind: 'registered',
      registration: {
        ...((registered() as { registration: Registration }).registration),
        cellId: '871e701b2ffffff',
        previousCellId: CELL,
        movedAt: '2026-10-05T12:30:00.000Z',
      },
    }
    const text = registrationText(moved)
    expect(text).toContain('871e701b2ffffff')
    expect(text).toContain(`moved here from ${CELL}`)
    expect(text).toContain('first whole interval')
  })

  it('sends for a registered key that does not vote, and says its readings do not count', () => {
    const markup = view({ lookUp: registered('excluded') })
    expect(registrationText(registered('excluded'))).toContain('not counted')
    expect(markup).toContain(registrationText(registered('excluded')))
    expect(sendDisabled(markup)).toBe(false)
  })

  it('does not send twice at once', () => {
    expect(sendDisabled(view({ busy: true }))).toBe(true)
  })

  it('says how long publishing took, and what happened to the reading', () => {
    const outcome = {
      kind: 'sent',
      sent: { kind: 'stored', status: 'accepted' },
      valueX100: 250,
      elapsedMs: 1840,
    } as const
    expect(outcomeText(outcome)).toContain('Published in 1.8 s: 2.50 mm')
    expect(view({ outcome })).toContain(outcomeText(outcome))

    const late = { ...outcome, sent: { kind: 'stored', status: 'late' } } as const
    expect(outcomeText(late)).toContain('does not count')
  })

  it('offers the reading that got no answer, the same one, again', () => {
    const pending = {
      sensor: KEY,
      cellId: CELL,
      kind: 'precipitation_mm',
      valueX100: 375,
      measuredAt: '2026-10-03T12:00:00.000Z',
      counter: 4,
      signature: 'sig',
    } as const
    const markup = view({ pending })
    expect(markup).toContain('3.75 mm')
    expect(markup).toContain('Send it again')
    expect(view({ pending, busy: true })).not.toContain('Send it again')
  })
})
