/**
 * The policy read, started by `index.html` before the bundle arrives — `T074`.
 *
 * The first screen used to be four requests in a row: the page, the bundle,
 * the policy, the days. On Slow 4G that is 2.9 s, and `SC-013` gives it two.
 * The policy address is known from the URL before a line of React runs, so a
 * few lines of inline script in `index.html` ask for it while the bundle is
 * still on the wire, and this module hands that answer to the screen.
 *
 * **Matched by URL, taken once.** The script builds the same URL
 * `fetchPolicy` asks for; the screen takes the response only if the two are
 * equal, and only once, because a body can be read once. If they ever drift
 * apart the screen simply fetches for itself — a mismatch costs a round trip,
 * never a wrong policy. `prefetch.test.ts` runs the script from `index.html`
 * and holds the two URLs equal.
 *
 * **The abort signal does not reach it.** The request started before there was
 * a screen to cancel it, and the only thing an abort would save is one small
 * answer nobody reads.
 */

export type PrefetchSlot = { url: string; response: Promise<Response> }

declare global {
  interface Window {
    __pumpkingPrefetch?: PrefetchSlot | undefined
  }
}

/** The prefetched response for `url`, once; null when there is none. */
export function takePrefetched(url: string): Promise<Response> | null {
  if (typeof window === 'undefined') return null
  const slot = window.__pumpkingPrefetch
  if (slot === undefined || slot.url !== url) return null
  window.__pumpkingPrefetch = undefined
  return slot.response
}

/** A `fetch` that answers from the prefetch when it can, and goes out otherwise. */
export function prefetchingFetch(base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null
    return (url === null ? null : takePrefetched(url)) ?? base(input, init)
  }
}
