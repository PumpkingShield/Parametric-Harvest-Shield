import { describe, expect, it } from 'vitest'
import { ApiError, fetchDays, fetchPolicy, parseDays, parsePolicy } from './policy.ts'

const POLICY = {
  policy: 'BPFLoaderUpgradeab1e11111111111111111111111',
  owner: 'Vote111111111111111111111111111111111111111',
  nonce: '1',
  cellId: '871e701b3ffffff',
  spellDaysThreshold: 21,
  payout: '120000000',
  premium: '9000000',
  windowStartDay: 0,
  windowEndDay: 60,
  windowDays: 61,
  state: 'active',
  spell: 18,
  recordedDays: 29,
}

const DAYS = {
  cellId: '871e701b3ffffff',
  from: 0,
  to: 60,
  days: [
    {
      dayIndex: 0,
      state: 2,
      rainfallX100: 640,
      coveredHours: 24,
      merkleRoot: 'root',
      txSignature: 'tx',
    },
  ],
}

describe('parsePolicy', () => {
  it('reads the answer the route gives', () => {
    expect(parsePolicy(POLICY)).toEqual(POLICY)
  })

  it('refuses an answer missing a field the screen draws', () => {
    const { spell: _spell, ...without } = POLICY
    expect(() => parsePolicy(without)).toThrow(/not a policy/)
  })

  it('refuses a payout that arrived as a number', () => {
    // `u64` does not survive a JSON number, so the route sends decimal strings.
    // A number here means somebody changed the wire and rounded a payout.
    expect(() => parsePolicy({ ...POLICY, payout: 120_000_000 })).toThrow(/not a policy/)
  })

  it('refuses anything that is not an object', () => {
    expect(() => parsePolicy(null)).toThrow(/not a policy/)
    expect(() => parsePolicy('active')).toThrow(/not a policy/)
  })
})

describe('parseDays', () => {
  it('reads the envelope and returns the rows', () => {
    expect(parseDays(DAYS)).toEqual(DAYS.days)
  })

  it('accepts a cell nobody has measured yet', () => {
    // A cell with no recorded days is a 200 with an empty list, not a 404.
    expect(parseDays({ ...DAYS, days: [] })).toEqual([])
  })

  it('keeps null apart from zero', () => {
    const noCoverage = {
      dayIndex: 4,
      state: 0,
      rainfallX100: null,
      coveredHours: 3,
      merkleRoot: null,
      txSignature: null,
    }
    expect(parseDays({ ...DAYS, days: [noCoverage] })).toEqual([noCoverage])
  })

  it('refuses a row that is not a day', () => {
    expect(() => parseDays({ ...DAYS, days: [{ dayIndex: 4 }] })).toThrow(/not a day journal/)
  })

  it('refuses an envelope with no days at all', () => {
    expect(() => parseDays({ cellId: 'x', from: 0, to: 1 })).toThrow(/not a day journal/)
  })
})

/** A `fetch` that answers once, so the client is tested without a server. */
function answering(status: number, body: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
}

describe('fetchPolicy', () => {
  it('asks the address it was given', async () => {
    const asked: string[] = []
    const spy: typeof fetch = (input) => {
      asked.push(String(input))
      return answering(200, POLICY)(input)
    }

    expect(await fetchPolicy('https://api.app', POLICY.policy, { fetch: spy })).toEqual(POLICY)
    expect(asked).toEqual([`https://api.app/v1/policies/${POLICY.policy}`])
  })

  it('trims a trailing slash off the base rather than sending a double one', async () => {
    const asked: string[] = []
    const spy: typeof fetch = (input) => {
      asked.push(String(input))
      return answering(200, POLICY)(input)
    }

    await fetchPolicy('https://api.app/', POLICY.policy, { fetch: spy })
    expect(asked).toEqual([`https://api.app/v1/policies/${POLICY.policy}`])
  })

  it('carries the route’s own message and status', async () => {
    const failed = fetchPolicy('https://api.app', POLICY.policy, {
      fetch: answering(404, { error: 'no policy at that address' }),
    })

    await expect(failed).rejects.toThrow('no policy at that address')
    await expect(failed).rejects.toMatchObject({ status: 404 })
  })

  it('says something when the answer is not JSON at all', async () => {
    const spy: typeof fetch = () =>
      Promise.resolve(new Response('<html>502</html>', { status: 502 }))
    // A proxy in front of a sleeping service answers HTML, and a screen that
    // showed "Unexpected token <" would send the reader looking in the wrong
    // place.
    await expect(fetchPolicy('https://api.app', POLICY.policy, { fetch: spy })).rejects.toThrow(
      ApiError,
    )
  })
})

describe('fetchDays', () => {
  it('asks for the window, both ends inclusive', async () => {
    const asked: string[] = []
    const spy: typeof fetch = (input) => {
      asked.push(String(input))
      return answering(200, DAYS)(input)
    }

    expect(await fetchDays('https://api.app', '871e701b3ffffff', 0, 60, { fetch: spy })).toEqual(
      DAYS.days,
    )
    expect(asked).toEqual(['https://api.app/v1/cells/871e701b3ffffff/days?from=0&to=60'])
  })
})
