/**
 * Failure construction for the Google Cloud adapter.
 *
 * The `llm` service classifies adapter failures by the own `code` and
 * `failure` data properties its normalizer reads, not by `instanceof`: a plain
 * `Error` carrying both keeps its retry classification even though this bundle
 * ships its own object graph.
 */

/** Code for a credential the transport cannot send. */
export const INVALID_CREDENTIAL = 'INVALID_CREDENTIAL'

/** Characters an HTTP header value carries verbatim and every provider key uses. */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** Serializable facts the service keeps beside a live failure. */
export interface FailureFacts {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
}

/** A failure the harness normalizer can classify without importing this module. */
export interface LlmFailureError extends Error {
  code: string
  failure: Readonly<FailureFacts>
}

/** Build one classified failure. */
export function llmError(message: string, code: string, extra?: Omit<FailureFacts, 'message' | 'code'>): LlmFailureError {
  const error = new Error(message) as LlmFailureError
  error.name = 'LlmError'
  error.code = code
  error.failure = Object.freeze({ message, code, ...(extra ?? {}) })
  return error
}

/** Accept one supplied key, or refuse it before the socket layer sees it. */
export function assertUsableKey(raw: unknown, module: string, ref: string): string {
  const value = String(raw).trim()
  if (value === '') {
    throw llmError(
      `${module}: the API key resolved from ${ref} is blank; save it again in the Models provider card`,
      INVALID_CREDENTIAL,
    )
  }
  if (!LEGAL_API_KEY.test(value)) {
    throw llmError(
      `${module}: the API key resolved from ${ref} contains characters no HTTP header can carry; store the raw key alone`,
      INVALID_CREDENTIAL,
    )
  }
  return value
}
