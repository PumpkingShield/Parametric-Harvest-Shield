import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  type Place,
  placeText,
  type Progress,
  progressText,
  RegisterView,
  type RegisterViewProps,
} from './Register.tsx'
import type { LookUp } from './publish.ts'
import { ThisPhoneView } from './ThisPhone.tsx'

/** What the person registering a phone is told — rendered to a string, no DOM. */

const OPERATOR = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T'
const CELL = '871e701b3ffffff'

function view(overrides: Partial<RegisterViewProps>): string {
  const noop = () => undefined
  return renderToStaticMarkup(
    <RegisterView
      operator={OPERATOR}
      place={{ kind: 'none' }}
      lat=""
      lng=""
      progress={{ kind: 'idle' }}
      onLocate={noop}
      onLat={noop}
      onLng={noop}
      onTyped={noop}
      onDownload={noop}
      onRegister={noop}
      {...overrides}
    />,
  )
}

/** The register button's `disabled`, read off the markup. */
function registerDisabled(html: string): boolean {
  const button = html.match(/<button[^>]*>(?:Register and stake|Working…)<\/button>/)?.[0]
  if (button === undefined) throw new Error('no register button')
  return button.includes('disabled')
}

describe('RegisterView', () => {
  it('says the coordinates stay on the phone before it asks for them', () => {
    expect(view({})).toContain(placeText({ kind: 'none' }))
    expect(placeText({ kind: 'none' })).toMatch(/not sent anywhere/)
  })

  it('cannot register before it knows the cell', () => {
    expect(registerDisabled(view({}))).toBe(true)
    const place: Place = { kind: 'cell', cell: CELL, from: 'phone' }
    expect(registerDisabled(view({ place }))).toBe(false)
  })

  it('shows the operator wallet, so it can be funded by hand', () => {
    expect(view({})).toContain(OPERATOR)
    expect(view({})).toContain('Save the operator key')
  })

  it('labels the faucet’s money as test tokens (FR-056)', () => {
    expect(view({})).toMatch(/test tokens, not money/)
  })

  it('holds the button while it works, and after it is done', () => {
    const place: Place = { kind: 'cell', cell: CELL, from: 'typed' }
    expect(registerDisabled(view({ place, progress: { kind: 'working', step: 'x' } }))).toBe(true)
    const done: Progress = { kind: 'done', signature: 's', url: 'https://explorer.solana.com/tx/s' }
    const html = view({ place, progress: done })
    expect(registerDisabled(html)).toBe(true)
    expect(html).toContain('href="https://explorer.solana.com/tx/s"')
  })

  it('says the service catches up by itself after the chain has it', () => {
    expect(progressText({ kind: 'done', signature: null, url: null })).toMatch(/checks by itself/)
  })

  it('passes a failure on in its own words', () => {
    expect(
      view({ progress: { kind: 'failed', message: 'There is no pool on this network yet.' } }),
    ).toContain('There is no pool on this network yet.')
  })
})

describe('ThisPhoneView with a registration', () => {
  it('shows the registration under the registry’s answer', () => {
    const noop = () => undefined
    const unknown: LookUp = { kind: 'unknown' }
    const html = renderToStaticMarkup(
      <ThisPhoneView
        pubkey="key"
        lookUp={unknown}
        pending={null}
        text=""
        busy={false}
        outcome={null}
        onCreate={noop}
        onText={noop}
        onSend={noop}
        onResend={noop}
        onLookUp={noop}
        registration={<p>REGISTRATION</p>}
      />,
    )
    expect(html.indexOf('not in the registry')).toBeLessThan(html.indexOf('REGISTRATION'))
  })
})
