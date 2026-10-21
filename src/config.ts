/**
 * The plugin's Cordis `Config` and the plain snapshot the adapter reads.
 *
 * Every user-editable field is `.volatile()`: the settings service projects it
 * into the browser form and hands this plugin a reference whose `.get()` is the
 * current value, so a settings write reaches the next request without a reload.
 * The plain snapshot below also accepts ordinary values, which keeps the module
 * usable from tests and from a hand-written `cordis.patch.yml`.
 */
import z from '@deepseek-ai/schemastery'

/** Provider route this bundle registers; also the model picker's group id. */
export const DEFAULT_PROVIDER = 'google-cloud'
/** Provider label shown by model selectors and the Models page row. */
export const DEFAULT_DISPLAY_NAME = 'Google Cloud'
/** Credential reference the provider card derives from the route id. */
export const DEFAULT_API_KEY_REF = 'GOOGLE_CLOUD_API_KEY'
/** Gemini 4 Argon is published only in the global location. */
export const DEFAULT_LOCATION = 'global'
/** Capacity fallbacks for a model the catalog does not describe. */
export const DEFAULT_CONTEXT_WINDOW = 1048576
export const DEFAULT_MAX_TOKENS = 65536
/** Longest wait for the next server-sent event before a call fails with TIMEOUT. */
export const DEFAULT_IDLE_TIMEOUT_MS = 300000

/** Models offered until the profile declares its own catalog. */
export const MODEL_DEFAULTS = [
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', contextWindow: 1048576, maxTokens: 1048576 },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxTokens: 65536 },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', contextWindow: 1048576, maxTokens: 65536 },
] as const

/** Rewrite legacy hyphenated minor-version ids (e.g. `gemini-3-5-flash` → `gemini-3.5-flash`). */
export function canonicalModelId(id: string): string {
  const trimmed = id.trim()
  return trimmed.replace(/^(gemini-[23])-([1-9])(?=-)/i, '$1.$2')
}

/** One advertised model. */
export interface ModelEntry {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
}

const ModelSchema = z
  .object({
    id: z.string().required().description('Publisher model id sent to Vertex AI.'),
    name: z.string().description('Display name shown by model selectors.'),
    description: z.string().description('Optional one-line description kept for editing surfaces.'),
    contextWindow: z.number().step(1).min(1).description('Context window in tokens.'),
    maxTokens: z.number().step(1).min(1).description('Default output token cap.'),
    input: z.array(z.string()).description('Input modalities a generic provider editor may write; this route is text-only.'),
    inputModalities: z.array(z.string()).description('Input modalities a generic provider editor may write; this route is text-only.'),
  })
  .description('One model published by this route.')

export const Config = z.object({
  provider: z
    .string()
    .default(DEFAULT_PROVIDER)
    .description('Provider route name every request selects with GenerateOptions.provider.')
    .volatile(),
  displayName: z
    .string()
    .default(DEFAULT_DISPLAY_NAME)
    .description('Provider label shown by model selectors.')
    .volatile(),
  projectId: z
    .string()
    .default('')
    .description('Google Cloud project id or project number used in the Vertex AI request path.')
    .volatile(),
  location: z
    .string()
    .default(DEFAULT_LOCATION)
    .description('Location the published model is served from. Gemini 4 Argon is global-only.')
    .volatile(),
  baseURL: z
    .string()
    .default('')
    .description('Optional endpoint override; empty derives the host from the location.')
    .volatile(),
  proxy: z
    .string()
    .default('')
    .description('Proxy URL: http://, https://, socks5:// or socks5h://; empty connects directly, "auto" reads the environment.')
    .volatile(),
  apiKeyEnv: z
    .string()
    .role('credential-ref')
    .default(DEFAULT_API_KEY_REF)
    .description('Credential reference for the Express-mode API key.')
    .volatile(),
  models: z
    .array(ModelSchema)
    .default([...MODEL_DEFAULTS])
    .description('Model catalog this route advertises.')
    .volatile(),
  streamIdleTimeoutMs: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULT_IDLE_TIMEOUT_MS)
    .description('Longest wait without a server-sent event before the call fails with TIMEOUT.')
    .volatile(),
})

/** A value the settings service may hand over as a live reference. */
type Volatile<T> = T | { get(): T }

/** Shape the loader validates, before this module snapshots it. */
export interface RawConfig {
  provider?: Volatile<string>
  displayName?: Volatile<string>
  projectId?: Volatile<string>
  location?: Volatile<string>
  baseURL?: Volatile<string>
  proxy?: Volatile<string>
  apiKeyEnv?: Volatile<string>
  models?: Volatile<readonly Partial<ModelEntry>[]>
  streamIdleTimeoutMs?: Volatile<number>
}

/** Plain values the adapter reads on every request. */
export interface ProviderSettings {
  provider: string
  displayName: string
  projectId: string
  location: string
  baseURL: string
  proxy: string
  apiKeyEnv: string
  models: ModelEntry[]
  streamIdleTimeoutMs: number
}

/** Read one field, which may be a reference object. */
function readField<T>(field: Volatile<T> | undefined, fallback: T): T {
  if (field === undefined || field === null) return fallback
  if (typeof (field as { get?: () => T }).get === 'function') {
    const value = (field as { get(): T }).get()
    return value === undefined || value === null ? fallback : value
  }
  return field as T
}

/** Keep only well-formed catalog rows so one bad row cannot break the route. */
export function normalizeModels(models: readonly Partial<ModelEntry>[] | undefined): ModelEntry[] {
  const rows: ModelEntry[] = []
  const seen = new Set<string>()
  for (const entry of models ?? []) {
    const id = typeof entry.id === 'string' ? canonicalModelId(entry.id) : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const contextWindow =
      Number.isSafeInteger(entry.contextWindow) && (entry.contextWindow as number) > 0
        ? (entry.contextWindow as number)
        : DEFAULT_CONTEXT_WINDOW
    const maxTokens =
      Number.isSafeInteger(entry.maxTokens) && (entry.maxTokens as number) > 0
        ? (entry.maxTokens as number)
        : DEFAULT_MAX_TOKENS
    rows.push({
      id,
      name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id,
      contextWindow,
      maxTokens,
    })
  }
  return rows.length > 0 ? rows : MODEL_DEFAULTS.map((model) => ({ ...model }))
}

/** Snapshot the raw configuration into the values the adapter reads. */
export function readConfig(config: RawConfig | undefined): ProviderSettings {
  const source = config ?? {}
  return {
    provider: String(readField(source.provider, DEFAULT_PROVIDER)).trim() || DEFAULT_PROVIDER,
    displayName: String(readField(source.displayName, DEFAULT_DISPLAY_NAME)).trim() || DEFAULT_DISPLAY_NAME,
    projectId: String(readField(source.projectId, '')).trim(),
    location: String(readField(source.location, DEFAULT_LOCATION)).trim() || DEFAULT_LOCATION,
    baseURL: String(readField(source.baseURL, '')).trim(),
    proxy: String(readField(source.proxy, '')).trim(),
    apiKeyEnv: String(readField(source.apiKeyEnv, DEFAULT_API_KEY_REF)).trim() || DEFAULT_API_KEY_REF,
    models: normalizeModels(readField(source.models, MODEL_DEFAULTS as unknown as readonly Partial<ModelEntry>[])),
    streamIdleTimeoutMs:
      Number(readField(source.streamIdleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS)) || DEFAULT_IDLE_TIMEOUT_MS,
  }
}

/** The endpoint base for one location; an explicit override wins. */
export function endpointOf(baseURL: string, location: string): string {
  const override = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL
  if (override !== '') return override
  if (location === 'global') return 'https://aiplatform.googleapis.com'
  if (location === 'us' || location === 'eu') return `https://aiplatform.${location}.rep.googleapis.com`
  return `https://${location}-aiplatform.googleapis.com`
}
