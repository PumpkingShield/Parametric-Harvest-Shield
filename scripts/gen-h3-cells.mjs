// Regenerates fixtures/h3-cells.json from h3-js — the cases both the program
// (programs/pumpking/src/h3.rs) and @pumpking/shared (cell.ts) must agree on.
// Run from the repo root: node scripts/gen-h3-cells.mjs
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const req = createRequire(new URL('../packages/shared/package.json', import.meta.url))
const h = req('h3-js')
const out = []
const add = (id, why) => { const hex = id.toString(16); out.push({ id: id.toString(), hex, valid: h.isValidCell(hex), res: h.isValidCell(hex) ? h.getResolution(hex) : null, why }) }
const B = (hex) => BigInt('0x' + hex)
// valid cells: the demo cell and its neighbours, other resolutions, pentagons
for (const c of ['871e701b3ffffff', '871e70186ffffff', '871e70194ffffff', '871e70195ffffff', '871e701b0ffffff']) add(B(c), 'network cell, res 7')
for (const r of [0, 1, 5, 8, 9, 15]) add(B(h.latLngToCell(50.45, 30.52, r)), `Kyiv, res ${r}`)
for (const p of h.getPentagons(7).slice(0, 4)) add(B(p), 'pentagon, res 7')
add(B(h.getPentagons(0)[0]), 'pentagon, res 0')
// a pentagon child whose first non-zero digit is 1: the deleted K axis
const pent = B(h.getPentagons(7)[0])
const digitShift = (r) => BigInt((15 - r) * 3)
const setDigit = (id, r, d) => (id & ~(7n << digitShift(r))) | (BigInt(d) << digitShift(r))
let k = pent; for (let r = 1; r <= 7; r++) k = setDigit(k, r, 0); k = setDigit(k, 7, 1); add(k, 'pentagon deleted subsequence')
const base = B('871e701b3ffffff')
add(base | (1n << 63n), 'high bit set')
add((base & ~(0xfn << 59n)) | (2n << 59n), 'mode 2 (directed edge)')
add(base | (1n << 56n), 'reserved bits set')
add(setDigit(base, 3, 7), 'digit 7 inside the resolution')
add(setDigit(base, 9, 0), 'digit after the resolution is not 7')
add((base & ~(0x7fn << 45n)) | (122n << 45n), 'base cell 122')
add((base & ~(0x7fn << 45n)) | (127n << 45n), 'base cell 127')
add(0n, 'zero')
const bad = out.filter((c) => c.why.includes('bit') || c.why.includes('mode') || c.why.includes('digit') || c.why.includes('base cell') || c.why === 'zero' || c.why.includes('deleted'))
if (bad.some((c) => c.valid)) throw new Error('an invalid case is valid in h3-js: ' + JSON.stringify(bad.filter((c) => c.valid)))
const doc = { note: 'Generated from h3-js ' + req('h3-js/package.json').version + ' by isValidCell/getResolution. Both the program (programs/pumpking/src/h3.rs) and @pumpking/shared (cell.ts) run it, so the chain and the library cannot disagree about what a cell is.', cases: out }
writeFileSync(new URL('../fixtures/h3-cells.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n')
console.log(out.length, 'cases,', out.filter((c) => c.valid).length, 'valid')
