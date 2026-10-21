/**
 * The Gemini-on-Vertex adapter.
 *
 * One provider route, one HTTP exchange per call: the request is projected into
 * Vertex's `contents`/`tools` vocabulary, the SSE answer is turned back into
 * harness `StreamChunk`s, and the assistant's native parts (including every
 * `thoughtSignature`) ride the finish chunk as `replayState` so the next turn
 * can echo them verbatim.
 */
import type {
  FinishReason,
  GenerateOptions,
  LlmAdapter,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId,
  StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'

/** The image argument and result types the adapter surface names. */
type ImageRef = Parameters<LlmAdapter['imageRequestTarget']>[2]
type ImageTarget = ReturnType<LlmAdapter['imageRequestTarget']>
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelCatalog } from './catalog.js'
import type { ModelEntry, ProviderSettings } from './config.js'
import { canonicalModelId, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, endpointOf } from './config.js'
import { llmError } from './errors.js'
import { buildTools, projectMessages } from './projection.js'
import type { GeminiPart } from './projection.js'
import { parseEndpoint, performRequest, readAll } from './transport.js'

/** Where the shape of the last rejected request is written, for diagnosis. */
const REJECTION_REPORT = join(tmpdir(), 'dsh-google-cloud-rejection.json')

/**
 * Record the shape (roles and part kinds, never text) of the request Vertex
 * refused, so a 400 can be explained from the log without another attempt.
 */
function recordRejectedRequest(report: {
  status: number
  detail: string
  model: string
  droppedTrailing: number
  contents: { role: string; parts: string[] }[]
}): void {
  try {
    writeFileSync(REJECTION_REPORT, JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2))
  } catch {
    // Diagnostics must never mask the provider failure.
  }
}

/** Name prefixed to every diagnostic this module raises. */
export const MODULE = 'llm-google-cloud'

/** Every selectable thinking level, least to greatest. */
const REASONING_EFFORTS = [
  { id: 'off', name: 'Off', description: 'Lowest server-side thinking level, without thought summaries.' },
  { id: 'low', name: 'Low', description: 'Short thinking with a thought summary.' },
  { id: 'medium', name: 'Medium', description: 'Balanced thinking with a thought summary.' },
  { id: 'high', name: 'High', description: 'Deep thinking with a thought summary.' },
] as const

type EffortId = (typeof REASONING_EFFORTS)[number]['id']

/** Brand one effort id for the service vocabulary. */
const effortOf = (id: string): ReasoningEffortId => id as ReasoningEffortId

/** Gemini 2.5 models take a token budget; later models take a named level. */
function usesThinkingBudget(model: string): boolean {
  return /^gemini-2[.-]5/i.test(model)
}

/** Gemini 3.0–3.6 Flash/Flash-Lite models accept MINIMAL as their lowest thinking level. */
function supportsMinimalThinkingLevel(model: string): boolean {
  return /^gemini-3(?:|-0|\.[156])-flash/i.test(model)
}

/** Translate one effort id into the request's thinking configuration. */
function thinkingConfig(model: string, effort: string | undefined): Record<string, unknown> {
  const includeThoughts = effort !== undefined && effort !== 'off'
  if (usesThinkingBudget(model)) {
    if (effort === undefined || effort === 'off') {
      // Gemini 2.5 Pro cannot turn off thinking (min budget 128); -1 uses dynamic budget.
      const budget = /^gemini-2[.-]5-pro/i.test(model) ? -1 : 0
      return { thinkingBudget: budget, includeThoughts: false }
    }
    const maxBudget = /^gemini-2[.-]5-pro/i.test(model) ? 32768 : 24576
    const budget = effort === 'low' ? 1024 : effort === 'medium' ? 8192 : maxBudget
    return { thinkingBudget: budget, includeThoughts }
  }
  const offLevel = supportsMinimalThinkingLevel(model) ? 'MINIMAL' : 'LOW'
  const level = effort === 'medium' ? 'MEDIUM' : effort === 'high' ? 'HIGH' : effort === 'low' ? 'LOW' : offLevel
  return { thinkingLevel: level, includeThoughts }
}

/** Map a provider HTTP status onto the harness failure vocabulary. */
function failureCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'INVALID_REQUEST'
}

/** Turn one provider error body into a short diagnostic. */
export function providerErrorText(status: number, text: string): string {
  if (text === '') return `HTTP ${status}`
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    if (typeof message === 'string' && message !== '') {
      return message.length > 1200 ? `${message.slice(0, 1200)}…` : message
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text
}

/** Everything the adapter needs from its owning plugin. */
export interface AdapterHost {
  /** Resolve the API key behind one credential reference, or undefined when absent. */
  resolveCredential(ref: string): Promise<string | undefined>
}

/** The Gemini-on-Vertex adapter for this bundle's provider route. */
export class GoogleCloudAdapter implements LlmAdapter {
  private readonly host: AdapterHost
  private readonly read: () => ProviderSettings
  private readonly catalog: ModelCatalog

  /**
   * @param host - credential lookup owned by the plugin.
   * @param read - current provider settings, re-read on every request.
   */
  constructor(host: AdapterHost, read: () => ProviderSettings) {
    this.host = host
    this.read = read
    this.catalog = new ModelCatalog(read, () => this.host.resolveCredential(read().apiKeyEnv), MODULE)
  }

  /** @inheritdoc */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.read().displayName }
  }

  /** @inheritdoc */
  providerRetryPolicy(): undefined {
    return undefined
  }

  /** @inheritdoc */
  imageRequestPricing(): undefined {
    return undefined
  }

  /** @inheritdoc */
  imageRequestTarget(_provider: string, _model: string, image: ImageRef): ImageTarget {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /** @inheritdoc */
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.catalog.list()
    return models.map((model) => ({ provider, id: model.id, name: model.name, inputModalities: ['text'] }))
  }

  /** @inheritdoc */
  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    let entry = this.catalog.known(model)
    if (entry === undefined && this.read().projectId !== '') {
      // A resumed session may name a model that only the provider's own list
      // knows about; ask it once before refusing the id.
      if (signal?.aborted === true) throw llmError(`${MODULE}: the request was cancelled`, 'ABORTED')
      await this.catalog.list()
      entry = this.catalog.known(model)
    }
    if (entry === undefined) {
      throw llmError(
        `${MODULE}: "${model}" is not in this route's model catalog; add it in the Models provider card`,
        'UNKNOWN_MODEL',
      )
    }
    return {
      provider,
      id: entry.id,
      name: entry.name,
      context: { contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: entry.maxTokens ?? DEFAULT_MAX_TOKENS,
      inputModalities: ['text'],
      reasoning: {
        efforts: REASONING_EFFORTS.map((effort) => ({ ...effort, id: effortOf(effort.id) })),
        defaultEffort: effortOf('off'),
      },
    }
  }

  /** @inheritdoc */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /** @inheritdoc */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const settings = this.read()
    if (settings.projectId === '') {
      throw llmError(`${MODULE}: a Google Cloud project id is required; save it in the Models provider card`, 'MISSING_CREDENTIAL')
    }
    const rawKey = await this.host.resolveCredential(settings.apiKeyEnv)
    if (rawKey === undefined || rawKey === '') {
      throw llmError(
        `${MODULE}: no API key for "${settings.apiKeyEnv}"; save it in the Models provider card, or export ${settings.apiKeyEnv} in the launching environment`,
        'MISSING_CREDENTIAL',
      )
    }
    const apiKey = rawKey

    const modelId = canonicalModelId(options.model)
    const projected = projectMessages(options, modelId)
    const contents = projected.contents
    // Vertex requires the request to end with a user turn. An interrupted turn
    // can leave a model turn whose tool results never arrived, which it refuses
    // with "Requests ending with a model turn are not supported"; those
    // unanswered trailing turns are dropped so the model re-plans from the last
    // answered turn instead of failing every later request.
    let droppedTrailing = 0
    while (contents.length > 0 && contents[contents.length - 1]?.role === 'model') {
      contents.pop()
      droppedTrailing += 1
    }
    const systemInstruction = projected.systemInstruction
    if (contents.length === 0) {
      throw llmError(`${MODULE}: the request carries no model-visible content`, 'INVALID_REQUEST')
    }

    const generationConfig: Record<string, unknown> = { thinkingConfig: thinkingConfig(modelId, options.reasoningEffort) }
    if (typeof options.temperature === 'number') generationConfig.temperature = options.temperature
    if (Number.isSafeInteger(options.maxTokens) && (options.maxTokens as number) > 0) {
      generationConfig.maxOutputTokens = options.maxTokens
    }
    if (Array.isArray(options.stop) && options.stop.length > 0) generationConfig.stopSequences = [...options.stop]

    const body: Record<string, unknown> = { contents, generationConfig }
    if (systemInstruction !== undefined) body.systemInstruction = systemInstruction
    const tools = buildTools(options.tools)
    if (tools !== undefined) body.tools = tools

    const endpoint = parseEndpoint(endpointOf(settings.baseURL, settings.location))
    const path = `${endpoint.prefix}/v1/projects/${encodeURIComponent(settings.projectId)}/locations/${encodeURIComponent(
      settings.location,
    )}/publishers/google/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`
    const payload = JSON.stringify(body)

    const controller = new AbortController()
    let timedOut = false
    const idle = Math.max(1000, settings.streamIdleTimeoutMs)
    let timer: NodeJS.Timeout | undefined
    const armIdle = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, idle)
      timer.unref?.()
    }
    const onAbort = (): void => controller.abort()
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    const settle = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    let response
    try {
      armIdle()
      response = await performRequest(
        endpoint,
        settings.proxy,
        MODULE,
        {
          method: 'POST',
          path,
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'x-goog-api-key': apiKey,
            'content-length': String(Buffer.byteLength(payload)),
          },
          body: payload,
        },
        controller.signal,
      )
    } catch (error) {
      settle()
      if (timedOut) throw llmError(`${MODULE}: no response within ${idle} ms`, 'TIMEOUT')
      if (controller.signal.aborted) throw llmError(`${MODULE}: the request was cancelled`, 'ABORTED')
      if (error instanceof Error && (error as { code?: unknown }).code === 'TRANSPORT') throw error
      throw llmError(`${MODULE}: could not reach ${endpoint.host}: ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT')
    }

    if (response.status < 200 || response.status >= 300) {
      const detail = providerErrorText(response.status, await readAll(response.stream, 4000))
      recordRejectedRequest({
        status: response.status,
        detail,
        model: modelId,
        droppedTrailing,
        contents: contents.map((content) => ({
          role: content.role,
          parts: content.parts.map((part) =>
            part.functionCall !== undefined
              ? `call:${part.functionCall.name}`
              : part.functionResponse !== undefined
                ? `response:${part.functionResponse.name}`
                : typeof part.text === 'string'
                  ? 'text'
                  : 'other',
          ),
        })),
      })
      settle()
      throw llmError(`${MODULE}: ${response.status} ${detail}`, failureCode(response.status), { status: response.status })
    }

    const stream = response.stream
    let buffer = ''
    let blockIndex = 0
    let openKind: 'text' | 'reasoning' | undefined
    let openIndex = -1
    let openText = ''
    let sawVisible = false
    let sawToolCall = false
    let finishReason: string | undefined
    let usage: Record<string, unknown> | undefined
    const parts: GeminiPart[] = []
    let callSeq = 0

    const nextId = (): ToolCallId => {
      callSeq += 1
      const uuid = globalThis.crypto?.randomUUID?.()
      return (typeof uuid === 'string' ? `call_${uuid}` : `call_${callSeq}_${Date.now().toString(36)}`) as ToolCallId
    }

    const closeOpen = function* (): Generator<StreamChunk, void, undefined> {
      if (openKind === undefined) return
      const block = openKind === 'text' ? { type: 'text' as const, text: openText } : { type: 'reasoning' as const, text: openText }
      yield { type: 'block-end', index: openIndex, block }
      openKind = undefined
      openIndex = -1
      openText = ''
    }

    const ensureOpen = function* (kind: 'text' | 'reasoning'): Generator<StreamChunk, void, undefined> {
      if (openKind === kind) return
      yield* closeOpen()
      openKind = kind
      openIndex = blockIndex
      blockIndex += 1
      yield { type: 'block-start', index: openIndex, blockType: kind }
    }

    try {
      try {
        for await (const chunk of stream) {
          armIdle()
          buffer += (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)).replace(/\r\n/g, '\n')
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n')
            if (data === '' || data === '[DONE]') continue
            let event: unknown
            try {
              event = JSON.parse(data)
            } catch {
              continue
            }
            const record = event !== null && typeof event === 'object' ? (event as Record<string, unknown>) : undefined
            if (record === undefined) continue
            const failure = record.error
            if (failure !== null && typeof failure === 'object') {
              const detail =
                typeof (failure as { message?: unknown }).message === 'string'
                  ? String((failure as { message: string }).message)
                  : JSON.stringify(failure)
              const status = Number((failure as { code?: unknown }).code)
              const code = status >= 100 && status <= 599 ? failureCode(status) : 'SERVER'
              throw llmError(`${MODULE}: ${detail}`, code, status >= 100 && status <= 599 ? { status } : undefined)
            }
            const feedback = record.promptFeedback as { blockReason?: unknown } | undefined
            if (feedback?.blockReason !== undefined && !Array.isArray(record.candidates)) {
              throw llmError(`${MODULE}: the prompt was blocked (${String(feedback.blockReason)})`, 'INVALID_REQUEST')
            }
            if (record.usageMetadata !== undefined && record.usageMetadata !== null) {
              usage = record.usageMetadata as Record<string, unknown>
            }
            const candidate = Array.isArray(record.candidates)
              ? (record.candidates[0] as { content?: { parts?: unknown }; finishReason?: unknown } | undefined)
              : undefined
            if (candidate === undefined) continue
            if (typeof candidate.finishReason === 'string') finishReason = candidate.finishReason
            const list = Array.isArray(candidate.content?.parts) ? candidate.content.parts : []
            for (const part of list) {
              if (part === null || typeof part !== 'object') continue
              const item = part as GeminiPart
              const signature = typeof item.thoughtSignature === 'string' ? item.thoughtSignature : undefined
              if (typeof item.text === 'string' && item.text !== '') {
                if (item.thought === true) {
                  yield* ensureOpen('reasoning')
                  openText += item.text
                  yield { type: 'reasoning-delta', index: openIndex, text: item.text }
                } else {
                  yield* ensureOpen('text')
                  openText += item.text
                  yield { type: 'text-delta', index: openIndex, text: item.text }
                  sawVisible = true
                }
                parts.push(signature === undefined ? { ...item } : { ...item, thoughtSignature: signature })
                continue
              }
              if (item.functionCall !== undefined && item.functionCall !== null) {
                yield* closeOpen()
                const name = typeof item.functionCall.name === 'string' ? item.functionCall.name : ''
                if (name === '') continue
                const args = JSON.stringify(item.functionCall.args ?? {})
                const id = nextId()
                const index = blockIndex
                blockIndex += 1
                sawVisible = true
                sawToolCall = true
                yield { type: 'block-start', index, blockType: 'tool-call' }
                yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
                yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
                parts.push(signature === undefined ? { ...item } : { ...item, thoughtSignature: signature })
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && typeof (error as { code?: unknown }).code === 'string' && 'failure' in error) throw error
        if (timedOut) throw llmError(`${MODULE}: no data for ${idle} ms`, 'TIMEOUT')
        if (controller.signal.aborted) throw llmError(`${MODULE}: the request was cancelled`, 'ABORTED')
        throw llmError(`${MODULE}: the stream failed: ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT')
      }
      yield* closeOpen()

      if (!sawVisible) {
        throw llmError(
          `${MODULE}: the model returned no content${finishReason === undefined ? '' : ` (finishReason ${finishReason})`}`,
          'EMPTY_RESPONSE',
        )
      }

      const promptTokens = Number(usage?.promptTokenCount) || 0
      const candidateTokens = Number(usage?.candidatesTokenCount) || 0
      const thoughtTokens = Number(usage?.thoughtsTokenCount) || 0
      const totalTokens = Number(usage?.totalTokenCount) || promptTokens + candidateTokens + thoughtTokens
      const cachedTokens = Number(usage?.cachedContentTokenCount) || 0
      if (usage !== undefined) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: promptTokens,
            outputTokens: candidateTokens + thoughtTokens,
            totalTokens,
            ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
            ...(thoughtTokens > 0 ? { reasoningTokens: thoughtTokens } : {}),
          },
        }
      }

      const reason: FinishReason =
        sawToolCall && (finishReason === undefined || finishReason === 'STOP' || finishReason === 'MALFORMED_FUNCTION_CALL')
          ? { kind: 'tool-calls' }
          : finishReason === 'MAX_TOKENS'
            ? { kind: 'max-tokens' }
            : { kind: 'stop' }

      yield {
        type: 'finish',
        reason,
        ...(parts.length > 0 ? { replayState: { response: { v: 1, model: modelId, parts } } } : {}),
      }
    } finally {
      settle()
      stream.destroy()
    }
  }
}

/** One model entry as the adapter resolves it. */
export type ResolvedModelEntry = ModelEntry
