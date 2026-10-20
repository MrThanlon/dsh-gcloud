/**
 * Harness message and tool vocabulary → one Gemini `contents` request.
 *
 * The projection keeps native assistant `parts` when this adapter produced the
 * turn (they carry the `thoughtSignature` Gemini requires to echo a function
 * call), and degrades a foreign tool call to text, because an unsigned
 * `functionCall` is refused.
 */
import type { GenerateOptions, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'

/** One Gemini content block. */
export interface GeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args?: unknown }
  functionResponse?: { name: string; response: unknown }
}

/** One Gemini conversation turn. */
interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/** Provider schema keys Vertex AI refuses inside function declarations. */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  '$comment',
  'additionalProperties',
  'patternProperties',
  'unevaluatedProperties',
  'dependentSchemas',
  'examples',
  'default',
  'oneOf',
])

/** Rewrite one JSON schema into the OpenAPI subset Vertex AI accepts. */
export function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
    if (key === 'const') {
      out.enum = [value]
      continue
    }
    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((item): item is string => typeof item === 'string')
      const primary = types.find((item) => item !== 'null')
      if (primary !== undefined) out.type = primary
      if (types.includes('null')) out.nullable = true
      continue
    }
    out[key] = sanitizeSchema(value)
  }
  return out
}

/** Build the `tools` array for one request, or undefined when no tool is active. */
export function buildTools(tools: readonly ToolSchema[] | undefined): { functionDeclarations: unknown[] }[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  const declarations: unknown[] = []
  for (const tool of tools) {
    if (typeof tool.name !== 'string' || tool.name === '') continue
    const parameters =
      tool.parameters !== null && typeof tool.parameters === 'object'
        ? sanitizeSchema(tool.parameters)
        : { type: 'object', properties: {} }
    declarations.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: { ...(parameters as Record<string, unknown>), type: 'object' },
    })
  }
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined
}

/** Collect the visible text of one content block list. */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as { type?: unknown; text?: unknown }
    if ((record.type === 'text' || record.type === 'reasoning') && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('')
}

/** Largest tool result this adapter sends back in one part. */
const MAX_FUNCTION_RESPONSE_CHARS = 512 * 1024

/**
 * Project one tool result for a `functionResponse` part.
 *
 * Gemini reads a `$ref` member inside `functionResponse.response` as a
 * reference to a named response part, so a tool that returns a JSON Schema
 * (any `$defs`/`$ref` document) would fail the whole turn with
 * `The referenced name "#/$defs/…" … does not match to a display_name`. The
 * result therefore travels as one text value, and a bare JSON pointer is
 * escaped so it cannot be read as a reference either.
 */
export function functionResponseResult(text: string): string {
  const body =
    text.length > MAX_FUNCTION_RESPONSE_CHARS ? `${text.slice(0, MAX_FUNCTION_RESPONSE_CHARS)}\n…[truncated]` : text
  return body.startsWith('#/') ? ` ${body}` : body
}

/** Accept the replay envelope this adapter wrote, for the same provider and model. */
export function replayParts(replayState: unknown, model: string): GeminiPart[] | undefined {
  if (replayState === null || typeof replayState !== 'object') return undefined
  const response = (replayState as { response?: unknown }).response
  if (response === null || typeof response !== 'object') return undefined
  const envelope = response as { v?: unknown; model?: unknown; parts?: unknown }
  if (envelope.v !== 1 || envelope.model !== model) return undefined
  if (!Array.isArray(envelope.parts) || envelope.parts.length === 0) return undefined
  return envelope.parts as GeminiPart[]
}

/** One request's message projection, built once per stream. */
export function projectMessages(
  options: GenerateOptions,
  model: string,
): { contents: GeminiContent[]; systemInstruction?: { parts: { text: string }[] } } {
  const contents: GeminiContent[] = []
  const systemTexts: string[] = []
  const toolNames = new Map<string, string>()
  const degraded = new Set<string>()

  const push = (role: 'user' | 'model', parts: GeminiPart[]): void => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last !== undefined && last.role === role) {
      last.parts.push(...parts)
      return
    }
    contents.push({ role, parts })
  }

  for (const message of options.messages as readonly RequestMessage[]) {
    const record = message as unknown as {
      role?: unknown
      content?: unknown
      source?: { provider?: unknown; model?: unknown; replayState?: unknown }
      toolCallId?: unknown
    }
    if (record === null || typeof record !== 'object') continue
    const content = Array.isArray(record.content) ? record.content : []
    switch (record.role) {
      case 'system':
      case 'developer': {
        const text = textOf(content)
        if (text.trim() !== '') systemTexts.push(text)
        break
      }
      case 'user': {
        const parts: GeminiPart[] = []
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue
          const item = block as { type?: unknown; text?: unknown; attachment?: { name?: unknown } }
          if (item.type === 'text' && typeof item.text === 'string' && item.text !== '') parts.push({ text: item.text })
          else if (item.type === 'image') parts.push({ text: '[image attachment omitted by this route]' })
          else if (item.type === 'file' && item.attachment !== undefined) parts.push({ text: `[file ${String(item.attachment.name)}]` })
        }
        push('user', parts)
        break
      }
      case 'assistant': {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue
          const item = block as { type?: unknown; id?: unknown; name?: unknown }
          if (item.type === 'tool-call' && typeof item.id === 'string' && typeof item.name === 'string') {
            toolNames.set(item.id, item.name)
          }
        }
        const restored = replayParts(record.source?.replayState, model)
        if (restored !== undefined) {
          push(
            'model',
            restored.map((part) => ({ ...part })),
          )
          break
        }
        const parts: GeminiPart[] = []
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue
          const item = block as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown }
          if (item.type === 'text' && typeof item.text === 'string' && item.text !== '') {
            parts.push({ text: item.text })
          } else if (item.type === 'tool-call' && typeof item.id === 'string') {
            degraded.add(item.id)
            const args = typeof item.arguments === 'string' && item.arguments !== '' ? item.arguments : '{}'
            parts.push({ text: `[Tool call ${String(item.name)}(${args})]` })
          }
        }
        push('model', parts)
        break
      }
      case 'tool': {
        const id = typeof record.toolCallId === 'string' ? record.toolCallId : ''
        const name = toolNames.get(id)
        const text = textOf(content)
        // A result whose call is not in this projection (a foreign turn, or a
        // call whose block was dropped) travels as text: a functionResponse
        // without its matching functionCall would be refused.
        if (degraded.has(id) || name === undefined) {
          push('user', [{ text: `[Tool result${name === undefined ? '' : ` ${name}`}] ${text}` }])
        } else {
          push('user', [{ functionResponse: { name, response: { result: functionResponseResult(text) } } }])
        }
        break
      }
      default:
        break
    }
  }

  const systemText = [options.system, ...systemTexts]
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .join('\n\n')
  return {
    contents,
    ...(systemText === '' ? {} : { systemInstruction: { parts: [{ text: systemText }] } }),
  }
}
