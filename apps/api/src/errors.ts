import type { Context } from 'hono'
import type { ZodError } from 'zod'

/**
 * The one shape every refusal of this API takes — `T065`, `PLAN.md` "API-контракти".
 *
 *   { "error": { "code": "INVALID_INPUT", "message": "...", "details": {} } }
 *
 * `message` is for a person and may change; `code` is for a program and may
 * not. `details` is always there, empty when there is nothing to add, so a
 * client reads one shape rather than probing for keys.
 *
 * **The code is derived from the status, never passed next to it.** Two
 * arguments that must agree are two arguments that one day will not, and a 404
 * saying `INVALID_INPUT` is worse than either on its own.
 *
 * **`CONFLICT` is the one code the Arena rule does not list.** Two answers here
 * are 409s — a counter already used by a different reading (`FR-003`) and a
 * scenario run already in flight — and neither is invalid input: the request
 * is well-formed and would have been accepted a moment earlier. Filing them
 * under `INVALID_INPUT` would make the code and the status disagree, which is
 * the one thing the derivation above exists to prevent.
 */
const CODE_OF_STATUS = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
} as const

export type ErrorStatus = keyof typeof CODE_OF_STATUS
export type ErrorCode = (typeof CODE_OF_STATUS)[ErrorStatus]

/** `FR-041`: which field, and what was wrong with it. */
export type FieldError = { field: string; message: string }

export type ErrorBody = {
  error: { code: ErrorCode; message: string; details: Record<string, unknown> }
}

/** An `ErrorBody` whose details carry `fields` — what a validation refusal reads as. */
export type FieldsBody = {
  error: { code: ErrorCode; message: string; details: { fields: FieldError[] } }
}

export function errorBody(
  status: ErrorStatus,
  message: string,
  details: Record<string, unknown> = {},
): ErrorBody {
  return { error: { code: CODE_OF_STATUS[status], message, details } }
}

export function apiError(
  context: Context,
  status: ErrorStatus,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return context.json(errorBody(status, message, details), status)
}

/**
 * Zod's issues as `details.fields`. `root` names the thing when the issue is
 * about the whole of it — `(body)`, `(query)` — rather than one field.
 */
export function fieldErrors(error: ZodError, root: string): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || root,
    message: issue.message,
  }))
}
