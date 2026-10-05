import { Buffer } from 'buffer'

/**
 * `Buffer` for the browser — `T038a`.
 *
 * web3.js and Anchor's coders reach for the global `Buffer` that Node has and a
 * browser does not. Imported first by `register.ts`, so it runs before either
 * library is evaluated: ES modules evaluate in import order, and a polyfill
 * placed after the import that needs it is a `ReferenceError` on the phone and
 * nothing at all under Node, where the tests run.
 *
 * Only the registration chunk loads this. Publishing a reading needs no
 * `Buffer`, and the policy screen (`SC-013`) never sees it.
 */
globalThis.Buffer ??= Buffer
