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
import { SENSOR_HOURS } from '../data/rainfall.ts'

/** Screen 2 — the operator's side. A neighbour with a phone is a sensor too. */

interface PeerRow {
  id: string
  key: string
  ratio: string
  status: string
  you?: boolean
}

const PEERS: ReadonlyArray<PeerRow> = [
  { id: 'PHS-01', key: '8kQv…3nRa', ratio: '24/24', status: 'voting' },
  { id: 'PHS-02', key: 'Dm7t…9wUc', ratio: '22/24', status: 'voting' },
  { id: 'PHS-03', key: 'Rj4p…1xKe', ratio: '24/24', status: 'voting' },
  { id: 'PHS-04', key: 'Wc9s…6bLn', ratio: '23/24', status: 'voting', you: true },
  {
    id: 'PHS-05',
    key: 'Yh2d…8vTq',
    ratio: ' 0/24',
    status: 'no stake — readings stored, not counted',
  },
]

const SensorScreen = () => (
  <div>
    <Headline figure="23" caption="readings accepted today" />

    <FactRows
      rows={[
        ['Sent today', '24'],
        ['Accepted into the median', '23'],
        ['Rejected as an outlier', '1'],
        ['Earned this month', '0.42 USDC'],
      ]}
    />

    <Block>
      <p style={{ margin: '0 0 12px', fontSize: 17, color: INK }}>
        Today’s readings, one square per hour
      </p>
      <DayStrip
        id="sensor-hours"
        cells={SENSOR_HOURS}
        hint="Tap an hour to see what was sent and what happened to it."
      />
    </Block>

    <Block>
      <Prose>
        Stake 25 USDC. Your readings count toward the median because this stake is posted. It is
        returned 14 days after you ask for it back. Readings that disagree with your neighbours
        repeatedly cost you the stake.
      </Prose>
    </Block>

    <Block>
      <p style={{ margin: '0 0 12px', fontSize: 17, color: INK }}>The other sensors in this cell</p>
      <div style={{ borderTop: `1px solid ${RULE}`, fontFamily: MONO, fontSize: 13, color: INK }}>
        {PEERS.map((peer) => (
          <div
            key={peer.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '58px 1fr 52px',
              gap: 8,
              padding: '12px 0',
              borderBottom: `1px solid ${RULE}`,
              lineHeight: 1.5,
            }}
          >
            <span>{peer.id}</span>
            <span>{peer.key}</span>
            <span style={{ textAlign: 'right', whiteSpace: 'pre' }}>{peer.ratio}</span>
            <span style={{ gridColumn: '1 / -1', fontWeight: peer.you ? 700 : 400 }}>
              {peer.status}
              {peer.you ? '   ← you' : ''}
            </span>
          </div>
        ))}
      </div>
    </Block>

    <SyntheticNote />
  </div>
)

export default SensorScreen
