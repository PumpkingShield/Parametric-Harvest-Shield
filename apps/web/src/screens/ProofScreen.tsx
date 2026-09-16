import { Block, Headline, INK, MONO, Prose, RULE, SyntheticNote } from '../components/Bits.tsx'
import DayStrip from '../components/DayStrip.tsx'
import { CELL_ID, PAID_BRACKET, PAID_WINDOW } from '../data/rainfall.ts'

/** Screen 3 — the one a sceptic opens: why this policy paid, step by step. */

const STEPS: ReadonlyArray<string> = [
  '4 sensors reported 0.0 mm for hour 23 on 14 July',
  'the median of those 4 readings is 0.0 mm',
  '0.0 mm does not exceed 2.0 mm, so 14 July is a dry day',
  '14 July is the 21st dry day in a row, and the policy needs 21',
  '120 USDC was sent to the farmer’s wallet',
]

const PROOF: ReadonlyArray<[string, string]> = [
  ['transaction', '4kzPq8mVn2sT…9dRwLx'],
  ['cell', CELL_ID],
  ['day', '61 of 90'],
]

const ProofScreen = () => (
  <div>
    <Headline
      figure="Paid 120 USDC"
      caption="14 July 2026, 41 seconds after the 21st dry day closed"
    />

    <DayStrip
      id="paid"
      cells={PAID_WINDOW.cells}
      bracket={PAID_BRACKET}
      hint="Tap any day of the closed window to see its reading."
    />

    <Block>
      <div style={{ borderTop: `1px solid ${RULE}` }}>
        {STEPS.map((step, index) => (
          <div
            key={step}
            style={{
              display: 'grid',
              gridTemplateColumns: '28px 1fr',
              gap: 10,
              padding: '14px 0',
              borderBottom: `1px solid ${RULE}`,
            }}
          >
            <span
              style={{
                fontSize: 17,
                fontWeight: 700,
                color: INK,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {index + 1}
            </span>
            <span style={{ fontSize: 17, lineHeight: 1.5, color: INK }}>{step}</span>
          </div>
        ))}
      </div>
    </Block>

    <Block>
      <Prose>
        A public weather service recorded 0.8 mm for this cell that day. Both readings are below the
        dry threshold, so the day is not disputed. The network’s own sensors decide the policy; the
        public service is only a cross-check.
      </Prose>
    </Block>

    <Block>
      <div style={{ borderTop: `1px solid ${RULE}`, fontFamily: MONO, fontSize: 13, color: INK }}>
        {PROOF.map(([label, value]) => (
          <div
            key={label}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              padding: '12px 0',
              borderBottom: `1px solid ${RULE}`,
            }}
          >
            <span>{label}</span>
            <span style={{ textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
          </div>
        ))}
      </div>
    </Block>

    <SyntheticNote />
  </div>
)

export default ProofScreen
