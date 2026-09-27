import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchPolicy } from './policy.ts'
import { type PrefetchSlot, prefetchingFetch, takePrefetched } from './prefetch.ts'

/**
 * The inline script in `index.html` and `fetchPolicy` must build the same URL,
 * or the prefetch is a request nobody takes. The script is run here as the
 * browser runs it — the placeholders substituted the way Vite substitutes
 * them — and its URL is compared with the one `fetchPolicy` actually asks for.
 */

const HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const SCRIPT = (() => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(HTML)
  if (match?.[1] === undefined) throw new Error('index.html has no inline script')
  return match[1]
})()

const POLICY_ADDRESS = 'EdLCRmVgS8Jithe8qPEkvgjsQ811bK2UUUnjq68pa8z1'

type Sandbox = { window: { __pumpkingPrefetch?: PrefetchSlot }; fetched: string[]; links: string[] }

/** Runs the inline script with Vite's substitutions and a fake browser. */
function runScript(env: { api?: string; policy?: string }, search: string): Sandbox {
  let source = SCRIPT
  if (env.api !== undefined) source = source.replaceAll('%VITE_API_URL%', env.api)
  if (env.policy !== undefined) source = source.replaceAll('%VITE_POLICY_PUBKEY%', env.policy)

  const fetched: string[] = []
  const links: string[] = []
  const window: Sandbox['window'] = {}
  const link = { rel: '', href: '', crossOrigin: '' }
  runInNewContext(source, {
    window,
    location: { search },
    URL,
    URLSearchParams,
    fetch: (url: string) => {
      fetched.push(url)
      return Promise.resolve(new Response('{}'))
    },
    document: {
      createElement: () => link,
      head: { appendChild: (added: typeof link) => links.push(`${added.rel} ${added.href}`) },
    },
  })
  return { window, fetched, links }
}

/** The URL `fetchPolicy` asks for, captured rather than rebuilt. */
async function urlOf(api: string, address: string): Promise<string> {
  let asked = ''
  await fetchPolicy(api, address, {
    fetch: (input) => {
      asked = String(input)
      return Promise.reject(new Error('captured'))
    },
  }).catch(() => undefined)
  return asked
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('the prefetch in index.html', () => {
  it('asks for exactly the URL fetchPolicy asks for', async () => {
    const api = 'https://pumpking-api.onrender.com/'
    const ran = runScript({ api }, `?policy=${POLICY_ADDRESS}`)

    expect(ran.fetched).toEqual([await urlOf(api, POLICY_ADDRESS)])
    expect(ran.window.__pumpkingPrefetch?.url).toBe(ran.fetched[0])
    expect(ran.links).toEqual(['preconnect https://pumpking-api.onrender.com'])
  })

  it('falls back to the built-in policy, as the screen does', async () => {
    const api = 'https://pumpking-api.onrender.com'
    const ran = runScript({ api, policy: POLICY_ADDRESS }, '')
    expect(ran.fetched).toEqual([await urlOf(api, POLICY_ADDRESS)])
  })

  it('asks for nothing when no policy is named anywhere', () => {
    // Vite leaves an unset variable as its placeholder.
    const ran = runScript({}, '')
    expect(ran.fetched).toEqual([])
    expect(ran.window.__pumpkingPrefetch).toBeUndefined()
  })
})

describe('takePrefetched', () => {
  const install = (url: string) => {
    const response = Promise.resolve(new Response('{"from":"prefetch"}'))
    Reflect.set(globalThis, 'window', { __pumpkingPrefetch: { url, response } })
    return response
  }

  it('hands the answer over once — a body can be read once', () => {
    const response = install('https://api/v1/policies/a')
    expect(takePrefetched('https://api/v1/policies/a')).toBe(response)
    expect(takePrefetched('https://api/v1/policies/a')).toBeNull()
  })

  it('keeps it from a request for anything else', () => {
    install('https://api/v1/policies/a')
    expect(takePrefetched('https://api/v1/policies/b')).toBeNull()
  })

  it('goes out to the network when there is nothing to take', async () => {
    install('https://api/v1/policies/a')
    const out: string[] = []
    const fetchOnce = prefetchingFetch((input) => {
      out.push(String(input))
      return Promise.resolve(new Response('{"from":"network"}'))
    })

    expect(await (await fetchOnce('https://api/v1/policies/a')).json()).toEqual({
      from: 'prefetch',
    })
    expect(await (await fetchOnce('https://api/v1/policies/a')).json()).toEqual({ from: 'network' })
    expect(out).toEqual(['https://api/v1/policies/a'])
  })
})
