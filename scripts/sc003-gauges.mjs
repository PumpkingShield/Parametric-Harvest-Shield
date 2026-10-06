// Regenerates fixtures/sc003-gauges.json — the real gauges SC-003 is measured on.
// Run from the repo root: node scripts/sc003-gauges.mjs
//
// Source: CoCoRaHS daily precipitation through RCC-ACIS (public, no key). CoCoRaHS
// is a volunteer network of cheap manual rain gauges — the closest public analogue
// of an operator with a sensor — and the Front Range of Colorado is where it is
// densest. Every gauge is placed in its H3 cell at the network's resolution (7,
// the same as cellFromLatLng); only cells with at least three gauges are kept,
// the quorum a cell needs for a value (FR-010).
//
// Parsing, in hundredths of a millimetre like every value in the system:
//   "0.12"  inches → round(hundredths of an inch × 25.4)
//   "T"     trace  → 0 (below what a gauge resolves)
//   "M"     missing, "S" (reported later as part of an accumulation),
//   "…A"    a multi-day accumulation → null: not one day's rain, so not a vote
// Station names and coordinates are not written: the cell and the CoCoRaHS id
// are enough to reproduce the grouping, and a volunteer's yard is nobody's data.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'

const req = createRequire(new URL('../packages/shared/package.json', import.meta.url))
const { latLngToCell } = req('h3-js')

const RESOLUTION = 7
const QUORUM = 3
const query = {
  bbox: '-105.30,39.55,-104.70,40.70',
  sdate: '2025-04-01',
  edate: '2025-09-30',
  elems: 'pcpn',
  meta: 'll,sids',
}

function parse(raw) {
  if (raw === 'M' || raw === 'S' || raw === 'T') return raw === 'T' ? 0 : null
  const match = /^(\d+\.\d{2})([A-Z]?)$/.exec(raw)
  if (match === null) throw new Error(`unexpected ACIS value: ${raw}`)
  if (match[2] !== '') return null
  const hundredthsOfInch = Number(match[1].replace('.', ''))
  return Math.round((hundredthsOfInch * 254) / 10)
}

const url = `https://data.rcc-acis.org/MultiStnData?params=${encodeURIComponent(JSON.stringify(query))}`
const response = await fetch(url)
if (!response.ok) throw new Error(`ACIS answered ${response.status}`)
const body = await response.json()

const byCell = new Map()
for (const station of body.data) {
  // ACIS id type 10 is the CoCoRaHS station number.
  const id = station.meta.sids?.find((sid) => sid.endsWith(' 10'))?.split(' ')[0]
  if (id === undefined) continue
  const [lng, lat] = station.meta.ll
  const cell = latLngToCell(lat, lng, RESOLUTION)
  const values = station.data.map(([raw]) => parse(raw))
  byCell.set(cell, [...(byCell.get(cell) ?? []), { id, values }])
}

const cells = [...byCell]
  .filter(([, gauges]) => gauges.length >= QUORUM)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([cell, gauges]) => ({ cell, gauges: gauges.sort((a, b) => (a.id < b.id ? -1 : 1)) }))

const doc = {
  source: 'CoCoRaHS daily precipitation via RCC-ACIS MultiStnData',
  query,
  resolution: RESOLUTION,
  quorum: QUORUM,
  unit: 'mm x100 per day, null = no single-day value',
  cells,
}
// One gauge per line keeps the file reviewable and the diff of a refetch readable.
const lines = cells.map(
  (c) =>
    `    { "cell": "${c.cell}", "gauges": [\n${c.gauges
      .map((g) => `      { "id": "${g.id}", "values": ${JSON.stringify(g.values)} }`)
      .join(',\n')}\n    ] }`,
)
const head = JSON.stringify({ ...doc, cells: undefined }, null, 2).replace(/\n}$/, '')
writeFileSync(
  new URL('../fixtures/sc003-gauges.json', import.meta.url),
  `${head},\n  "cells": [\n${lines.join(',\n')}\n  ]\n}\n`,
)
console.log(`${cells.length} cells, ${cells.reduce((n, c) => n + c.gauges.length, 0)} gauges`)
