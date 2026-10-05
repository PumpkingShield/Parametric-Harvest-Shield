import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MoveView, type MoveViewProps, moveProgressText, refusalText } from './Move.tsx'
import type { Place } from './Register.tsx'

/** What the person moving a phone is told — rendered to a string, no DOM. */

const FROM = '871e701b3ffffff'
const TO = '871e701b2ffffff'

function view(overrides: Partial<MoveViewProps>): string {
  const noop = () => undefined
  return renderToStaticMarkup(
    <MoveView
      from={FROM}
      place={{ kind: 'none' }}
      lat=""
      lng=""
      progress={{ kind: 'idle' }}
      onLocate={noop}
      onLat={noop}
      onLng={noop}
      onTyped={noop}
      onMove={noop}
      {...overrides}
    />,
  )
}

/** The move button's `disabled`, read off the markup. */
function moveDisabled(html: string): boolean {
  const button = html.match(/<button[^>]*>(?:Move [^<]*|Working…)<\/button>/)?.[0]
  if (button === undefined) throw new Error('no move button')
  return button.includes('disabled')
}

describe('MoveView', () => {
  it('names the cell the sensor is registered in, and moves nowhere before it knows the new one', () => {
    const html = view({})
    expect(html).toContain(FROM)
    expect(moveDisabled(html)).toBe(true)
  })

  it('moves to another cell, and says which', () => {
    const place: Place = { kind: 'cell', cell: TO, from: 'phone' }
    const html = view({ place })
    expect(moveDisabled(html)).toBe(false)
    expect(html).toContain(`Move it to ${TO}`)
  })

  it('does not move a phone that is still where it is registered', () => {
    const place: Place = { kind: 'cell', cell: FROM, from: 'phone' }
    const html = view({ place })
    expect(moveDisabled(html)).toBe(true)
    expect(html).toContain('registered in already')
  })

  it('says, once moved, when readings start to count and what happens until then — FR-059', () => {
    const text = moveProgressText({ kind: 'done', signature: 's', url: null }, TO) ?? ''
    expect(text).toContain(TO)
    expect(text).toContain('next whole interval')
    expect(text).toContain('do not count')
  })
})

describe('refusalText', () => {
  it('has words for every reason a move is not sent, and none for a move', () => {
    expect(refusalText({ kind: 'move', previousCellId: 1n, claim: 0n })).toBeNull()
    for (const kind of [
      'unregistered',
      'foreign',
      'excluded',
      'same-cell',
      'cell-full',
      'no-sol',
    ] as const) {
      expect(refusalText({ kind })).toMatch(/\w/)
    }
    expect(refusalText({ kind: 'too-soon', day: 45 })).toContain('45')
  })
})
