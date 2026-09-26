import type { ReadingRow, ReadingStore } from '@pumpking/db'
import {
  h3IndexFromCellId,
  type SignedReading,
  signedReadingSchema,
  verifyReadingSignature,
} from '@pumpking/shared'
import { Hono } from 'hono'
import { apiError, fieldErrors } from '../errors.ts'

/**
 * `POST /v1/readings` — the only door a measurement enters through.
 *
 * Four questions, in the order that makes the cheapest refusal first and the
 * most expensive one last:
 *
 * 1. **Is it a reading at all** (`FR-041`)? Zod, and the answer names the field.
 * 2. **Is the key registered** (`FR-002`)? A signature by a stranger proves who
 *    wrote it and nothing about whether it counts.
 * 3. **Is the signature valid** (`FR-002`)? Ed25519 over the canonical bytes.
 *    Last of the three because it is the only one that costs milliseconds, and
 *    a malformed body should not buy a curve operation.
 * 4. **Is the counter fresh** (`FR-003`)? The unique index answers, on write.
 *
 * A reading that fails 1–3 is **not stored**: `FR-002` says a bad signature or
 * an unknown key is refused and not kept as a measurement. A reading that
 * passes them is always stored, and the only thing arrival time decides is
 * whether it counts (`FR-004`).
 */

/** Where a reading lands, given when it was taken and when it arrived. */
export type Arrival = ReadingRow['status']

/**
 * `FR-004`: a reading that took too long to arrive is stored and left out of
 * the index.
 *
 * The window has to be at least the aggregation interval or every reading is
 * late; it is a published parameter rather than a constant for the same reason
 * the dry threshold is — the trace has to be able to say why a reading did not
 * count.
 *
 * A reading from the **future** is late too. Its hour has not closed, so there
 * is no interval to put it in, and a clock running fast is not a licence to
 * vote early. The tolerance is one-sided on purpose.
 */
export function classifyArrival(measuredAt: Date, receivedAt: Date, maxAgeMs: number): Arrival {
  const age = receivedAt.getTime() - measuredAt.getTime()
  return age >= 0 && age <= maxAgeMs ? 'accepted' : 'late'
}

/** An hour of grace on top of the hour being aggregated. */
export const DEFAULT_MAX_AGE_MS = 90 * 60 * 1000

export type ReadingsRouteOptions = {
  store: ReadingStore
  /** Injected so a scenario run (`FR-049`) and a test can move it. */
  now?: () => Date
  maxAgeMs?: number
}

export function createReadingsRoute(options: ReadingsRouteOptions): Hono {
  const { store } = options
  const now = options.now ?? (() => new Date())
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS

  return new Hono().post('/', async (context) => {
    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return apiError(context, 400, 'body must be JSON')
    }

    const parsed = signedReadingSchema.safeParse(body)
    if (!parsed.success) {
      return apiError(context, 400, 'invalid reading', {
        fields: fieldErrors(parsed.error, '(body)'),
      })
    }
    const reading: SignedReading = parsed.data

    const sensor = await store.sensorFor(reading.sensor)
    if (sensor === null) {
      // Deliberately the same answer as a bad signature would get, and
      // deliberately not "no such sensor": whether a key is registered is not
      // a question an unauthenticated caller gets to enumerate.
      return apiError(context, 401, 'unknown sensor or invalid signature')
    }

    // `FR-058`: the cell comes from the registration. The reading carries it
    // so the signature commits to which cell the vote was cast in, so a
    // disagreement is a signature over the wrong claim rather than a
    // correction to apply.
    if (sensor.cellId !== reading.cellId) {
      return apiError(context, 400, 'reading names a cell the sensor is not registered in', {
        fields: [{ field: 'cellId', message: `must be ${h3IndexFromCellId(sensor.cellId)}` }],
      })
    }
    if (sensor.kind !== reading.kind) {
      return apiError(context, 400, 'reading names a kind the sensor is not registered for', {
        fields: [{ field: 'kind', message: `must be ${sensor.kind}` }],
      })
    }

    if (!(await verifyReadingSignature(reading))) {
      return apiError(context, 401, 'unknown sensor or invalid signature')
    }

    const receivedAt = now()
    const status = classifyArrival(reading.measuredAt, receivedAt, maxAgeMs)

    const outcome = await store.save({
      sensorPubkey: reading.sensor,
      cellId: sensor.cellId,
      kind: sensor.kind,
      measuredAt: reading.measuredAt,
      valueX100: reading.valueX100,
      counter: reading.counter,
      signature: reading.signature,
      status,
    })

    if (outcome.stored) {
      return context.json({ status, counter: Number(reading.counter) }, 201)
    }

    // `FR-003`. The same signature over the same counter is the retry of a
    // sensor that never saw our answer — SC-009 puts these on a 3G link, and
    // an error there would have the sensor retry forever. A *different*
    // signature under a used counter is the replay the counter exists to stop.
    if (outcome.existingSignature === reading.signature) {
      return context.json({ status: outcome.status, counter: Number(reading.counter) }, 200)
    }
    return apiError(context, 409, 'counter already used by a different reading', {
      fields: [{ field: 'counter', message: 'must be greater than any counter already sent' }],
    })
  })
}
