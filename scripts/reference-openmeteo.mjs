// Regenerates fixtures/reference-openmeteo.json — the public reference over the
// cells and days of fixtures/sc003-gauges.json, which DISPUTE_TOLERANCE_X100 is
// measured on. Run from the repo root: node scripts/reference-openmeteo.mjs
//
// Source: Open-Meteo's historical forecast API (public, no key, CC BY 4.0) — the
// archive of the same forecast endpoint the worker asks live, so the fixture
// measures the source the product uses rather than a cousin of it. One request
// for all cell centres.
//
// Alignment: a CoCoRaHS value is the 24 hours to the observer's morning reading,
// about 07:00 Mountain Daylight Time (13:00 UTC), filed under that morning's
// date. So gauge day D is compared with the hourly sums ending in
// (D-1 13:00Z, D 13:00Z]. Open-Meteo labels an hourly sum by the end of its hour.
// The UTC calendar day agrees worse (20.7 % of days in a different class, against
// 15.2 %), which is the check that this is the right window.
//
// Values in hundredths of a millimetre; null where any of the 24 hours is missing.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const req = createRequire(new URL('../packages/shared/package.json', import.meta.url))
const { cellToLatLng } = req('h3-js')

const gauges = JSON.parse(
  readFileSync(new URL('../fixtures/sc003-gauges.json', import.meta.url), 'utf8'),
)
const firstDay = Date.parse(`${gauges.query.sdate}T00:00:00Z`)
const days = Math.round((Date.parse(`${gauges.query.edate}T00:00:00Z`) - firstDay) / 86_400_000) + 1
const DAY_END_HOUR_UTC = 13

const centres = gauges.cells.map(({ cell }) => cellToLatLng(cell))
const query = {
  hourly: 'precipitation',
  start_date: new Date(firstDay - 86_400_000).toISOString().slice(0, 10),
  end_date: gauges.query.edate,
  timezone: 'UTC',
}
const params = new URLSearchParams({
  latitude: centres.map(([lat]) => lat.toFixed(5)).join(','),
  longitude: centres.map(([, lng]) => lng.toFixed(5)).join(','),
  ...query,
})
const response = await fetch(`https://historical-forecast-api.open-meteo.com/v1/forecast?${params}`)
if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}: ${await response.text()}`)
const body = await response.json()
const locations = Array.isArray(body) ? body : [body]
if (locations.length !== gauges.cells.length) throw new Error('one location per cell expected')

const cells = gauges.cells.map(({ cell }, at) => {
  const { time, precipitation } = locations[at].hourly
  const byEnd = new Map(time.map((label, i) => [Date.parse(`${label}:00Z`), precipitation[i]]))
  const values = []
  for (let day = 0; day < days; day += 1) {
    const end = firstDay + day * 86_400_000 + DAY_END_HOUR_UTC * 3_600_000
    let total = 0
    for (let hour = 0; hour < 24 && total !== null; hour += 1) {
      const mm = byEnd.get(end - hour * 3_600_000)
      total = mm === undefined || mm === null ? null : total + Math.round(mm * 100)
    }
    values.push(total)
  }
  return { cell, values }
})

const doc = {
  source: 'Open-Meteo historical forecast API (best_match), CC BY 4.0, https://open-meteo.com/',
  query,
  dayWindow: `24 hours ending ${DAY_END_HOUR_UTC}:00 UTC on the gauge date`,
  unit: 'mm x100 per day, null = an hour missing',
}
const head = JSON.stringify(doc, null, 2).replace(/\n}$/, '')
const lines = cells.map((c) => `    { "cell": "${c.cell}", "values": ${JSON.stringify(c.values)} }`)
writeFileSync(
  new URL('../fixtures/reference-openmeteo.json', import.meta.url),
  `${head},\n  "cells": [\n${lines.join(',\n')}\n  ]\n}\n`,
)
console.log(`${cells.length} cells, ${days} days`)
