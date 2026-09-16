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
import { CELL_ID, POLICY_BRACKET, POLICY_WINDOW } from '../data/rainfall.ts'

/** Screen 1 — what the farmer opens: the run, then the terms, then the catch. */
const PolicyScreen = () => (
  <div>
    <Headline figure="18" caption="dry days in a row — 3 more and you are paid" />

    <DayStrip
      id="policy"
      cells={POLICY_WINDOW.cells}
      bracket={POLICY_BRACKET}
      hint="Tap any day to see its rainfall and how many sensors reported."
    />

    <Block>
      <FactRows
        rows={[
          ['Pays out', '120 USDC'],
          ['When', '21 dry days in a row'],
          ['Cover period', '1 Aug – 30 Sep 2026'],
          ['Premium paid', '9 USDC'],
        ]}
      />
    </Block>

    <Block>
      <Prose>
        This policy pays on measured rainfall in your cell, not on what happened to your field. It
        can pay when your crop is fine, and it can stay silent when your crop is lost. That is the
        trade for having no inspector and no claim form.
      </Prose>
    </Block>

    <Block>
      <Prose>
        5 and 6 August had no coverage — only 1 sensor reported. Those two days ended a 4-day dry
        run.
      </Prose>
    </Block>

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
      Cell {CELL_ID} · 5 sensors registered, 4 voting
    </p>

    <SyntheticNote />
  </div>
)

export default PolicyScreen
