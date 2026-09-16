import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Bracket, SquareState, StripCell } from '../data/rainfall.ts'

/**
 * The one visual idea of the product: a run of days, left to right.
 *
 * The index a policy settles on **is** a run of days, so the interface shows
 * the thing itself rather than a chart of it. Three states carry colour and
 * nothing else on the page does: dry is ochre, wet is green, a day nobody
 * measured is an empty dashed square. The last one matters most — silence is
 * not drought, and the square has to look unlike both of the others.
 */

const SIZE = 22
const GAP = 3
const STEP = SIZE + GAP

const INK = '#141310'
const RULE = '#E2DED4'
const DRY = '#C8892B'
const WET = '#2F6B45'

/** strips animate on their first mount only, never again for the session */
const alreadyAnimated = new Set<string>()

function squareStyle(state: SquareState): CSSProperties {
  const base: CSSProperties = {
    width: SIZE,
    height: SIZE,
    padding: 0,
    margin: 0,
    boxSizing: 'border-box',
    display: 'block',
    cursor: 'pointer',
    background: 'transparent',
  }
  switch (state) {
    case 'dry':
      return { ...base, background: DRY, border: `1px solid ${DRY}` }
    case 'wet':
      return { ...base, background: WET, border: `1px solid ${WET}` }
    case 'filled':
      return { ...base, background: INK, border: `1px solid ${INK}` }
    case 'none':
      return { ...base, border: `1px dashed ${INK}` }
    default:
      return { ...base, border: `1px solid ${RULE}` }
  }
}

interface Props {
  /** distinguishes one strip from another for the first-mount animation */
  id: string
  cells: ReadonlyArray<StripCell>
  bracket?: Bracket | undefined
  hint: string
}

const DayStrip = ({ id, cells, bracket, hint }: Props) => {
  const measureRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(12)
  const [selected, setSelected] = useState<number | null>(null)
  const [animate] = useState(() => !alreadyAnimated.has(id))

  useEffect(() => {
    alreadyAnimated.add(id)
  }, [id])

  useLayoutEffect(() => {
    const el = measureRef.current
    if (!el) return
    const update = () => {
      const width = el.clientWidth
      setCols(Math.max(1, Math.floor((width + GAP) / STEP)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const rowCount = Math.max(1, Math.ceil(cells.length / cols))
  const rows: number[] = Array.from({ length: rowCount }, (_unused, index) => index)
  const detail = selected === null ? hint : (cells[selected]?.detail ?? hint)

  return (
    <div>
      <div ref={measureRef} style={{ width: '100%' }}>
        {rows.map((row) => {
          const rowStart = row * cols
          const rowCells = cells.slice(rowStart, rowStart + cols)
          if (rowCells.length === 0) return null

          const rowEnd = rowStart + rowCells.length - 1
          const segStart = bracket ? Math.max(bracket.start, rowStart) : 0
          const segEnd = bracket ? Math.min(bracket.end, rowEnd) : -1
          const hasSegment = bracket !== undefined && segStart <= segEnd
          const isFinalSegment = hasSegment && bracket !== undefined && bracket.end <= rowEnd
          const segLeft = (segStart - rowStart) * STEP
          const segWidth = (segEnd - segStart + 1) * STEP - GAP
          const opensHere = bracket !== undefined && bracket.start >= rowStart
          const closesHere = bracket !== undefined && bracket.end <= rowEnd

          return (
            <div key={row} style={{ marginBottom: 10 }}>
              <div style={{ position: 'relative', height: 18 }}>
                {rowCells.map((cell, offset) =>
                  cell.topLabel === undefined ? null : (
                    <span
                      key={cell.detail}
                      style={{
                        position: 'absolute',
                        left: offset * STEP,
                        top: 0,
                        fontSize: 13,
                        fontWeight: 600,
                        color: INK,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {cell.topLabel}
                    </span>
                  ),
                )}
              </div>

              <div style={{ display: 'flex', gap: GAP }}>
                {rowCells.map((cell, offset) => {
                  const index = rowStart + offset
                  const isSelected = selected === index
                  return (
                    <button
                      key={cell.detail}
                      type="button"
                      aria-label={cell.detail}
                      onClick={() => setSelected(isSelected ? null : index)}
                      className={animate ? 'pk-square-in' : undefined}
                      style={{
                        ...squareStyle(cell.state),
                        outline: isSelected ? `2px solid ${INK}` : 'none',
                        outlineOffset: 2,
                        animationDelay: animate ? `${index * 20}ms` : undefined,
                      }}
                    />
                  )
                })}
              </div>

              {hasSegment ? (
                <div
                  style={{ position: 'relative', height: isFinalSegment ? 34 : 12, marginTop: 4 }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: segLeft,
                      width: segWidth,
                      top: 0,
                      height: 7,
                      borderTop: `2px solid ${INK}`,
                      borderLeft: opensHere ? `2px solid ${INK}` : 'none',
                      borderRight: closesHere ? `2px solid ${INK}` : 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  {isFinalSegment && bracket !== undefined ? (
                    <span
                      style={{
                        position: 'absolute',
                        left: Math.max(0, segLeft),
                        top: 12,
                        fontSize: 16,
                        fontWeight: 700,
                        color: INK,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {bracket.label}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <p
        style={{
          margin: '10px 0 0',
          paddingTop: 10,
          borderTop: `1px solid ${RULE}`,
          fontSize: 17,
          lineHeight: 1.5,
          color: INK,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {detail}
      </p>
    </div>
  )
}

export default DayStrip
