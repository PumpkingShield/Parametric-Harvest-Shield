import type { ReactNode } from 'react'

/**
 * The whole visual vocabulary of the M0 prototype.
 *
 * Flat, square, one column, very high contrast: this is read on a cheap phone
 * outdoors. Colour carries exactly one meaning — the state of a day — and it
 * lives in `DayStrip`, not here. Nothing in this file is coloured.
 */

export const INK = '#141310'
export const RULE = '#E2DED4'
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

export const Headline = ({ figure, caption }: { figure: string; caption: string }) => (
  <div style={{ paddingBottom: 26 }}>
    <div
      style={{
        fontSize: figure.length > 8 ? 48 : 68,
        lineHeight: 1,
        fontWeight: 800,
        letterSpacing: '-0.03em',
        fontVariantNumeric: 'tabular-nums',
        color: INK,
      }}
    >
      {figure}
    </div>
    <div style={{ marginTop: 12, fontSize: 18, lineHeight: 1.45, fontWeight: 400, color: INK }}>
      {caption}
    </div>
  </div>
)

export const FactRows = ({ rows }: { rows: ReadonlyArray<[string, string]> }) => (
  <div style={{ borderTop: `1px solid ${RULE}` }}>
    {rows.map(([label, value]) => (
      <div
        key={label}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 16,
          padding: '14px 0',
          borderBottom: `1px solid ${RULE}`,
        }}
      >
        <span style={{ fontSize: 17, color: INK }}>{label}</span>
        <span
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: INK,
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </span>
      </div>
    ))}
  </div>
)

export const Prose = ({ children }: { children: ReactNode }) => (
  <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6, color: INK }}>{children}</p>
)

export const Block = ({ children, top = 28 }: { children: ReactNode; top?: number }) => (
  <div style={{ marginTop: top }}>{children}</div>
)

/**
 * Said on every screen, in the same words — `FR-039`, `FR-056`. Plain small
 * print and not a warning box: it is a statement of fact, not an alert.
 */
export const SyntheticNote = () => (
  <p
    style={{
      margin: '36px 0 0',
      paddingTop: 14,
      borderTop: `1px solid ${RULE}`,
      fontSize: 13,
      lineHeight: 1.5,
      color: INK,
    }}
  >
    All numbers on this screen are synthetic. No real money moves.
  </p>
)
