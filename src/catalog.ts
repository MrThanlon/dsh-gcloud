/**
 * The advertised model catalog.
 *
 * The provider's own `publishers.google.models.list` answers with the Gemini
 * chat models this project can reach; when that call fails — an Express API key
 * is not guaranteed to be allowed to list models — the profile's `models` list
 * stands in. Either answer is cached briefly so a picker refresh does not
 * interrogate the endpoint on every render.
 */
import type { ModelEntry, ProviderSettings } from './config.js'
import { canonicalModelId, DEFAULT_CONTEXT_WINDOW, DEFAULT_INPUT_MODALITIES, DEFAULT_MAX_TOKENS, endpointOf } from './config.js'
import { parseEndpoint, performRequest, readAll } from './transport.js'

/** How long one discovery answer stands (1 day). */
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000
/** Longest one discovery call may take before the configured list applies. */
const DISCOVERY_TIMEOUT_MS = 6000
/** Largest listing body this module parses. */
const DISCOVERY_BODY_LIMIT = 4 * 1024 * 1024

/** Model families published by `publishers/google` that cannot serve a chat call. */
const NON_CHAT_MODEL =
  /(?:^gemini-(?:omni|live|embedding|nano-banana)(?:-|$)|-(?:image|tts|live|transcribe|translate|embedding|robotics|vision|custom|omni|audio)(?:-|$))/i

/** One cached discovery answer. */
interface CatalogAnswer {
  models: ModelEntry[]
  source: 'api' | 'config'
  diagnostic?: string
  at: number
}

/** Publisher-model listing endpoints, most specific first. */
function publisherModelUrls(settings: ProviderSettings): string[] {
  const base = endpointOf(settings.baseURL, settings.location)
  const path = `projects/${encodeURIComponent(settings.projectId)}/locations/${encodeURIComponent(settings.location)}/publishers/google/models?pageSize=200`
  return [`${base}/v1/${path}`, `${base}/v1beta1/${path}`]
}

/** Turn one publisher-model resource into a catalog entry, or reject it. */
export function discoveredModel(row: unknown, configured: readonly ModelEntry[]): ModelEntry | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const record = row as { name?: unknown; displayName?: unknown; supportedActions?: unknown }
  const name = typeof record.name === 'string' ? record.name : ''
  const marker = name.lastIndexOf('/models/')
  const id = marker === -1 ? '' : canonicalModelId(name.slice(marker + '/models/'.length))
  if (id === '' || !/^gemini-/i.test(id)) return undefined
  if (NON_CHAT_MODEL.test(id)) return undefined
  const actions = Array.isArray(record.supportedActions) ? record.supportedActions : undefined
  if (actions !== undefined && actions.length > 0 && !actions.includes('generateContent')) return undefined
  const known = configured.find((model) => model.id === id)
  if (known !== undefined) return { ...known, inputModalities: known.inputModalities ?? [...DEFAULT_INPUT_MODALITIES] }
  const display = typeof record.displayName === 'string' && record.displayName.trim() !== '' ? record.displayName.trim() : id
  return { id, name: display, contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, inputModalities: [...DEFAULT_INPUT_MODALITIES] }
}

/** Discovery plus exact-model lookup over the configured catalog. */
export class ModelCatalog {
  private readonly read: () => ProviderSettings
  private readonly resolveKey: () => Promise<string | undefined>
  private readonly module: string
  private readonly cache = new Map<string, CatalogAnswer>()
  private pending: { key: string; run: Promise<CatalogAnswer> } | undefined

  /**
   * @param read - current provider settings.
   * @param resolveKey - credential lookup; a rejection is a discovery diagnostic, not a failure.
   * @param module - package name prefixed to failures.
   */
  constructor(read: () => ProviderSettings, resolveKey: () => Promise<string | undefined>, module: string) {
    this.read = read
    this.resolveKey = resolveKey
    this.module = module
  }

  /** The catalog the profile declares. */
  configured(): ModelEntry[] {
    return this.read().models
  }

  /** Resolve one exact model id against the configured and discovered catalogs. */
  known(id: string): ModelEntry | undefined {
    const target = canonicalModelId(id)
    const configured = this.configured().find((model) => model.id === target)
    if (configured !== undefined) return configured
    for (const answer of this.cache.values()) {
      const hit = answer.models.find((model) => model.id === target)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  /** The model list this route advertises right now. */
  async list(): Promise<ModelEntry[]> {
    const settings = this.read()
    if (settings.projectId === '') return settings.models
    const key = `${settings.projectId}|${settings.location}|${settings.baseURL}|${settings.proxy}|${settings.models.map((model) => model.id).join(',')}`
    const cached = this.cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.models
    if (this.pending?.key === key) return (await this.pending.run).models
    const run = this.discover(settings, key)
    this.pending = { key, run }
    try {
      return (await run).models
    } finally {
      if (this.pending?.run === run) this.pending = undefined
    }
  }

  /** Ask the endpoint for its publisher models, falling back to the profile. */
  private async discover(settings: ProviderSettings, key: string): Promise<CatalogAnswer> {
    let apiKey: string | undefined
    try {
      apiKey = await this.resolveKey()
    } catch {
      return this.fallback(settings, key, 'missing credential')
    }
    if (apiKey === undefined) return this.fallback(settings, key, 'missing credential')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
    timer.unref?.()
    let failure = 'unreachable'
    try {
      for (const url of publisherModelUrls(settings)) {
        const endpoint = parseEndpoint(url)
        let response
        try {
          response = await performRequest(
            endpoint,
            settings.proxy,
            this.module,
            { method: 'GET', path: endpoint.pathWithQuery, headers: { accept: 'application/json', 'x-goog-api-key': apiKey } },
            controller.signal,
          )
        } catch {
          failure = 'unreachable'
          continue
        }
        if (response.status < 200 || response.status >= 300) {
          response.stream.destroy()
          failure = `HTTP ${response.status}`
          continue
        }
        let payload: unknown
        try {
          payload = JSON.parse(await readAll(response.stream, DISCOVERY_BODY_LIMIT))
        } catch {
          payload = undefined
        }
        const record = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined
        const rows = Array.isArray(record?.publisherModels)
          ? record.publisherModels
          : Array.isArray(record?.models)
            ? record.models
            : undefined
        if (rows === undefined) {
          failure = 'unexpected payload'
          continue
        }
        const discovered: ModelEntry[] = []
        const seen = new Set<string>()
        for (const row of rows) {
          const model = discoveredModel(row, settings.models)
          if (model === undefined || seen.has(model.id)) continue
          seen.add(model.id)
          discovered.push(model)
        }
        if (discovered.length === 0) {
          failure = 'no chat models listed'
          continue
        }
        const answer: CatalogAnswer = {
          models: [...discovered, ...settings.models.filter((model) => !seen.has(model.id))],
          source: 'api',
          at: Date.now(),
        }
        this.cache.set(key, answer)
        return answer
      }
      return this.fallback(settings, key, failure)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Cache and return the configured catalog with its discovery diagnostic. */
  private fallback(settings: ProviderSettings, key: string, diagnostic: string): CatalogAnswer {
    const answer: CatalogAnswer = { models: settings.models, source: 'config', diagnostic, at: Date.now() }
    this.cache.set(key, answer)
    return answer
  }
}
