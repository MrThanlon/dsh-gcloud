// @ts-nocheck
/**
 * Offline host-half test: the transport (direct, HTTP CONNECT proxy, SOCKS5
 * proxy), the request shape, the stream-chunk state machine, thought-signature
 * replay, model discovery and failure codes. Everything talks to local
 * servers, so no network and no real credential are involved.
 */
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { connect as netConnect, createServer as createTcpServer } from 'node:net'
import { describe, test } from 'vitest'
import { Config, apply } from '../lib/index.js'

const KEY = 'AIza-test-key'
const SSE_TEXT = [
  'data: {"candidates":[{"content":{"parts":[{"text":"Hel","thoughtSignature":"sig-a"}]}}]}\n\n',
  'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
  'data: {"candidates":[{"content":{"parts":[{"text":"thinking","thought":true}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":3,"totalTokenCount":15}}\n\n',
].join('')

/** One local provider endpoint that records the requests it received. */
async function startTarget({ sse = SSE_TEXT, models } = {}) {
  const seen = { requests: [] }
  const server = createHttpServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.requests.push({ method: request.method, url: request.url, headers: request.headers, body })
      if (request.method === 'GET' && request.url.includes('/publishers/google/models')) {
        if (models === 'denied') {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 401, message: 'API keys are not supported by this API' } }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            publisherModels: models ?? [
              { name: 'publishers/google/models/gemini-4-argon', displayName: 'Gemini 4 Argon', supportedActions: ['generateContent'] },
              { name: 'publishers/google/models/gemini-9-demo', displayName: 'Gemini 9 Demo', supportedActions: ['generateContent'] },
              { name: 'publishers/google/models/gemini-1-embedding', displayName: 'Embedding', supportedActions: ['predict'] },
            ],
          }),
        )
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sse)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** One HTTP CONNECT proxy that records the CONNECT it tunneled. */
async function startHttpProxy({ requireAuth = false } = {}) {
  const seen = {}
  const server = createTcpServer((socket) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onData)
      const head = buffer.slice(0, end)
      const lines = head.split('\r\n')
      seen.connect = lines[0]
      seen.authorization = lines.find((line) => line.toLowerCase().startsWith('proxy-authorization:'))
      if (requireAuth && seen.authorization === undefined) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
        return
      }
      const authority = (lines[0] ?? '').split(' ')[1] ?? ''
      const [host, port] = authority.split(':')
      const upstream = netConnect(Number(port), host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const rest = buffer.slice(end + 4)
        if (rest !== '') upstream.write(rest)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
    }
    socket.on('data', onData)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, seen, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** One SOCKS5 proxy that records the credentials and target it tunneled. */
async function startSocks5Proxy({ requireAuth = false } = {}) {
  const seen = {}
  const server = createTcpServer((socket) => {
    let buffer = Buffer.alloc(0)
    let state = 'greeting'
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (state === 'greeting') {
        if (buffer.length < 2) return
        const count = buffer[1]
        if (buffer.length < 2 + count) return
        const methods = [...buffer.subarray(2, 2 + count)]
        buffer = buffer.subarray(2 + count)
        if (requireAuth) {
          if (!methods.includes(2)) {
            socket.end(Buffer.from([5, 0xff]))
            return
          }
          socket.write(Buffer.from([5, 2]))
          state = 'auth'
        } else {
          socket.write(Buffer.from([5, 0]))
          state = 'request'
        }
        return
      }
      if (state === 'auth') {
        if (buffer.length < 2) return
        const userLength = buffer[1]
        if (buffer.length < 2 + userLength + 1) return
        const passwordLength = buffer[2 + userLength]
        if (buffer.length < 2 + userLength + 1 + passwordLength) return
        const user = buffer.subarray(2, 2 + userLength).toString()
        const password = buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString()
        seen.auth = `${user}:${password}`
        buffer = buffer.subarray(3 + userLength + passwordLength)
        socket.write(Buffer.from([1, 0]))
        state = 'request'
        return
      }
      if (state === 'request') {
        if (buffer.length < 5) return
        const addressType = buffer[3]
        let host
        let rest
        if (addressType === 3) {
          const length = buffer[4]
          if (buffer.length < 5 + length + 2) return
          host = buffer.subarray(5, 5 + length).toString()
          rest = buffer.subarray(5 + length)
        } else if (addressType === 1) {
          if (buffer.length < 10) return
          host = [...buffer.subarray(4, 8)].join('.')
          rest = buffer.subarray(8)
        } else {
          socket.destroy()
          return
        }
        const port = rest.readUInt16BE(0)
        buffer = rest.subarray(2)
        state = 'tunnel'
        socket.removeListener('data', onData)
        seen.target = `${host}:${port}`
        const upstream = netConnect(port, host, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          if (buffer.length > 0) upstream.write(buffer)
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
        upstream.on('error', () => socket.destroy())
      }
    }
    socket.on('data', onData)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, seen, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** Register the adapter with a fake credential service. */
function mount(settings, { key = KEY, attachments } = {}) {
  let adapter
  const config = Config(settings)
  apply(
    {
      llm: {
        registerAdapter(providers, next) {
          adapter = next
          return () => {}
        },
        registerConfigurableProviders() {
          return () => {}
        },
      },
      get(name) {
        if (name === 'credentials') return { resolve: async () => (key === null ? undefined : { value: key }) }
        if (name === 'attachments') return attachments
        return undefined
      },
    },
    config,
  )
  return adapter
}

/** Drain one stream into its chunk list. */
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

const userMessage = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]

describe('host smoke test', () => {
test('direct connection', async () => {
  const target = await startTarget()
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url })
  assert.deepEqual(adapter.providerInfo('google-cloud'), { id: 'google-cloud', name: 'Google Cloud' })
  const chunks = await collect(adapter, {
    provider: 'google-cloud',
    model: 'gemini-4-argon',
    messages: userMessage,
    system: 'be brief',
    tools: [
      {
        name: 'read',
        description: 'read a file',
        parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    maxTokens: 256,
    reasoningEffort: 'low',
  })
  const request = target.seen.requests.at(-1)
  assert.ok(request.url.endsWith(':streamGenerateContent?alt=sse'))
  assert.equal(request.headers['x-goog-api-key'], KEY)
  const body = JSON.parse(request.body)
  assert.equal(body.systemInstruction.parts[0].text, 'be brief')
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW', includeThoughts: true })
  assert.equal(body.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined)
  assert.equal(body.contents[0].role, 'user')
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'Hello')
  assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'thinking')
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 3 })
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })
  assert.equal(finish.replayState.response.parts[0].thoughtSignature, 'sig-a')
  await target.close()
})

test('HTTP proxy with credentials', async () => {
  const target = await startTarget()
  const proxy = await startHttpProxy({ requireAuth: true })
  const adapter = mount({
    projectId: 'demo-project',
    baseURL: target.url,
    proxy: `http://user:pass@127.0.0.1:${proxy.port}`,
  })
  const chunks = await collect(adapter, { provider: 'google-cloud', model: 'gemini-4-argon', messages: userMessage })
  assert.match(proxy.seen.connect, /^CONNECT 127\.0\.0\.1:\d+ HTTP\/1\.1$/)
  assert.equal(proxy.seen.authorization, `Proxy-Authorization: Basic ${Buffer.from('user:pass').toString('base64')}`)
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').length, 2)
  await proxy.close()
  await target.close()
})

test('SOCKS5 proxy with credentials', async () => {
  const target = await startTarget()
  const proxy = await startSocks5Proxy({ requireAuth: true })
  const adapter = mount({
    projectId: 'demo-project',
    baseURL: target.url,
    proxy: `socks5://user:pass@127.0.0.1:${proxy.port}`,
  })
  const chunks = await collect(adapter, { provider: 'google-cloud', model: 'gemini-4-argon', messages: userMessage })
  assert.equal(proxy.seen.auth, 'user:pass')
  assert.equal(proxy.seen.target, `127.0.0.1:${target.port}`)
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').length, 2)
  await proxy.close()
  await target.close()
})

test('SOCKS5 without authentication', async () => {
  const target = await startTarget()
  const proxy = await startSocks5Proxy()
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url, proxy: `socks5h://127.0.0.1:${proxy.port}` })
  await collect(adapter, { provider: 'google-cloud', model: 'gemini-4-argon', messages: userMessage })
  assert.equal(proxy.seen.auth, undefined)
  assert.equal(proxy.seen.target, `127.0.0.1:${target.port}`)
  await proxy.close()
  await target.close()
})

test('a refusing proxy is a TRANSPORT failure', async () => {
  const proxy = await startHttpProxy({ requireAuth: true })
  const adapter = mount({ projectId: 'demo-project', baseURL: 'http://127.0.0.1:9', proxy: `http://127.0.0.1:${proxy.port}` })
  await assert.rejects(
    () => collect(adapter, { provider: 'google-cloud', model: 'gemini-4-argon', messages: userMessage }),
    (error) => error.code === 'TRANSPORT' && /proxy refused CONNECT/.test(error.message),
  )
  await proxy.close()
})

test('model discovery', async () => {
  const target = await startTarget({
    models: [
      { name: 'publishers/google/models/gemini-4-argon', displayName: 'Gemini 4 Argon', supportedActions: ['generateContent'] },
      { name: 'publishers/google/models/gemini-9-demo', displayName: 'Gemini 9 Demo', supportedActions: ['generateContent'] },
      { name: 'publishers/google/models/gemini-1-embedding', displayName: 'Embedding', supportedActions: ['predict'] },
      { name: 'publishers/google/models/gemini-3.8-flash-lite-tts', displayName: 'TTS', supportedActions: ['generateContent'] },
      { name: 'publishers/google/models/gemini-omni-1.1-flash-preview', displayName: 'Omni', supportedActions: ['generateContent'] },
      { name: 'publishers/google/models/gemini-nano-banana-2.1', displayName: 'Nano Banana', supportedActions: ['generateContent'] },
    ],
  })
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url })
  const models = await adapter.listModels('google-cloud')
  assert.deepEqual(
    models.map((model) => model.id),
    [
      'gemini-4-argon',
      'gemini-9-demo',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
  )
  const resolved = await adapter.resolveModel('google-cloud', 'gemini-9-demo')
  assert.equal(resolved.context.contextWindow, 1048576)
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  assert.ok(models.every((model) => model.inputModalities?.includes('image') && model.inputModalities?.includes('text')))
  // Legacy hyphenated minor-version ids resolve and stream against canonical dot ids
  const legacyResolved = await adapter.resolveModel('google-cloud', 'gemini-3-5-flash')
  assert.equal(legacyResolved.id, 'gemini-3.5-flash')
  assert.deepEqual(legacyResolved.inputModalities, ['text', 'image'])
  await collect(adapter, { provider: 'google-cloud', model: 'gemini-3-5-flash', messages: userMessage, reasoningEffort: 'off' })
  const legacyReq = target.seen.requests.at(-1)
  assert.ok(legacyReq.url.includes('/models/gemini-3.5-flash:streamGenerateContent'))
  assert.deepEqual(JSON.parse(legacyReq.body).generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL', includeThoughts: false })
  await target.close()
})

test('discovery falls back to the configured catalog', async () => {
  const target = await startTarget({ models: 'denied' })
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url })
  const models = await adapter.listModels('google-cloud')
  assert.equal(models.length, 12)
  await target.close()
})

test('exact-model failure', async () => {
  const target = await startTarget({ models: 'denied' })
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url })
  await assert.rejects(
    () => adapter.resolveModel('google-cloud', 'not-a-model'),
    (error) => error.code === 'UNKNOWN_MODEL',
  )
  await target.close()
})

test('tool-call turn, then its replay', async () => {
  const target = await startTarget({
    sse: 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"a.txt"}},"thoughtSignature":"sig-tool"}]},"finishReason":"STOP"}]}\n\n',
  })
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url })
  const chunks = await collect(adapter, { provider: 'google-cloud', model: 'gemini-4-argon', messages: userMessage })
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
  const block = chunks.find((chunk) => chunk.type === 'block-end').block
  assert.deepEqual(JSON.parse(block.arguments), { path: 'a.txt' })
  assert.equal(finish.replayState.response.parts[0].thoughtSignature, 'sig-tool')

  await collect(adapter, {
    provider: 'google-cloud',
    model: 'gemini-4-argon',
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: [
      ...userMessage,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: block.id, name: 'read', arguments: block.arguments }],
        source: { kind: 'model', provider: 'google-cloud', model: 'gemini-4-argon', replayState: finish.replayState },
      },
      { role: 'tool', toolCallId: block.id, source: { kind: 'tool', callId: block.id }, content: [{ type: 'text', text: '{"ok":true}' }] },
    ],
  })
  const replay = JSON.parse(target.seen.requests.at(-1).body)
  const modelTurn = replay.contents.find((content) => content.role === 'model')
  assert.equal(modelTurn.parts[0].functionCall.name, 'read')
  assert.equal(modelTurn.parts[0].thoughtSignature, 'sig-tool')
  const toolTurn = replay.contents.find((content) => content.parts.some((part) => part.functionResponse))
  assert.equal(toolTurn.parts[0].functionResponse.response.result, '{"ok":true}')
  await target.close()
})

test('a tool result carrying JSON Schema $ref stays text', async () => {
  const target = await startTarget()
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url })
  const schema = JSON.stringify({
    $defs: { loaderExpression: { type: 'object', properties: { __jsExpr: { type: 'string' } } } },
    $ref: '#/$defs/loaderExpression',
  })
  const callId = 'call-schema'
  await collect(adapter, {
    provider: 'google-cloud',
    model: 'gemini-4-argon',
    tools: [{ name: 'inspect', description: 'read a schema', parameters: { type: 'object', properties: {} } }],
    messages: [
      ...userMessage,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{}' }],
        source: {
          kind: 'model',
          provider: 'google-cloud',
          model: 'gemini-4-argon',
          replayState: {
            response: {
              v: 1,
              model: 'gemini-4-argon',
              parts: [{ functionCall: { name: 'inspect', args: {} }, thoughtSignature: 'sig-x' }],
            },
          },
        },
      },
      { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: schema }] },
    ],
  })
  const body = JSON.parse(target.seen.requests.at(-1).body)
  const part = body.contents.flatMap((content) => content.parts).find((item) => item.functionResponse !== undefined)
  assert.equal(typeof part.functionResponse.response.result, 'string', 'the schema travels as text')
  assert.match(part.functionResponse.response.result, /#\/\$defs\/loaderExpression/)
  // Gemini reads a `$ref` member of a function response as a part reference.
  const hasRefKey = (value) => {
    if (value === null || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(hasRefKey)
    return Object.entries(value).some(([key, item]) => key === '$ref' || hasRefKey(item))
  }
  assert.equal(hasRefKey(part.functionResponse), false)
  await target.close()
})

test('degraded foreign tool history', async () => {
  const target = await startTarget()
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url })
  await collect(adapter, {
    provider: 'google-cloud',
    model: 'gemini-4-argon',
    messages: [
      ...userMessage,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }],
        source: { kind: 'model', provider: 'other', model: 'other-model' },
      },
      { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: '{"ok":true}' }] },
    ],
  })
  const body = JSON.parse(target.seen.requests.at(-1).body)
  assert.ok(body.contents.some((content) => content.parts.some((part) => typeof part.text === 'string' && part.text.startsWith('[Tool call read('))))
  assert.ok(body.contents.some((content) => content.parts.some((part) => typeof part.text === 'string' && part.text.startsWith('[Tool result'))))
  await target.close()
})

test('missing configuration and credentials', async () => {
  const bare = mount({})
  await assert.rejects(
    () => collect(bare, { provider: 'google-cloud', model: 'gemini-4-argon', messages: userMessage }),
    (error) => error.code === 'MISSING_CREDENTIAL',
  )
  const noKey = mount({ projectId: 'demo-project' }, { key: null })
  await assert.rejects(
    () => collect(noKey, { provider: 'google-cloud', model: 'gemini-4-argon', messages: userMessage }),
    (error) => error.code === 'MISSING_CREDENTIAL' && error.failure.code === 'MISSING_CREDENTIAL',
  )
})

test('a trailing unanswered model turn is dropped', async () => {
  const target = await startTarget()
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url })
  await collect(adapter, {
    provider: 'google-cloud',
    model: 'gemini-4-argon',
    messages: [
      ...userMessage,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'dangling', name: 'read', arguments: '{}' }],
        source: {
          kind: 'model',
          provider: 'google-cloud',
          model: 'gemini-4-argon',
          replayState: {
            response: {
              v: 1,
              model: 'gemini-4-argon',
              parts: [{ functionCall: { name: 'read', args: {} }, thoughtSignature: 'sig-d' }],
            },
          },
        },
      },
    ],
  })
  const body = JSON.parse(target.seen.requests.at(-1).body)
  assert.equal(body.contents.at(-1).role, 'user', 'the request must not end with a model turn')
  assert.equal(
    body.contents.flatMap((content) => content.parts).some((part) => part.functionCall !== undefined),
    false,
    'an unanswered function call is not sent',
  )
  await target.close()
})

test('text following a functionResponse is moved to the front of the turn', async () => {
  const target = await startTarget()
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url })
  const parts = [
    { functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: 'sig-1' },
    { functionCall: { name: 'read', args: { path: 'b' } }, thoughtSignature: 'sig-2' },
  ]
  await collect(adapter, {
    provider: 'google-cloud',
    model: 'gemini-4-argon',
    messages: [
      ...userMessage,
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'c2', name: 'read', arguments: '{"path":"b"}' },
        ],
        source: { kind: 'model', provider: 'google-cloud', model: 'gemini-4-argon', replayState: { response: { v: 1, model: 'gemini-4-argon', parts } } },
      },
      { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'content of a' }] },
      { role: 'tool', toolCallId: 'c2', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'text', text: 'content of b' }] },
      { role: 'user', content: [{ type: 'text', text: 'now summarize' }] },
    ],
  })
  const last = JSON.parse(target.seen.requests.at(-1).body).contents.at(-1)
  assert.equal(last.role, 'user')
  assert.deepEqual(
    last.parts.map((part) => (part.functionResponse !== undefined ? 'response' : 'text')),
    ['text', 'response', 'response'],
    'plain text must not follow a functionResponse inside one user turn',
  )
  await target.close()
})

test('image input projection', async () => {
  const target = await startTarget()
  const adapter = mount({ projectId: 'demo-project', baseURL: target.url })
  await collect(adapter, {
    provider: 'google-cloud',
    model: 'gemini-4-argon',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this picture?' },
          { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
        ],
      },
    ],
  })
  const requestBody = JSON.parse(target.seen.requests.at(-1).body)
  const userContent = requestBody.contents.find((content) => content.role === 'user')
  assert.equal(userContent.parts.length, 2)
  assert.equal(userContent.parts[0].text, 'what is in this picture?')
  assert.deepEqual(userContent.parts[1], {
    inlineData: {
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    },
  })
  await target.close()
})

test('image attachment resolved via attachments service', async () => {
  const target = await startTarget()
  const fakeImageData = Buffer.from('FAKE_JPEG_IMAGE_BYTES')
  const adapter = mount(
    { projectId: 'demo-project', baseURL: target.url },
    {
      attachments: {
        async readImageRequest(ref) {
          return {
            data: fakeImageData,
            mediaType: ref.mediaType,
          }
        },
      },
    },
  )
  await collect(adapter, {
    provider: 'google-cloud',
    model: 'gemini-4-argon',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
              mediaType: 'image/jpeg',
              bytes: fakeImageData.length,
              width: 100,
              height: 100,
            },
          },
        ],
      },
    ],
  })
  const requestBody = JSON.parse(target.seen.requests.at(-1).body)
  const userContent = requestBody.contents.find((content) => content.role === 'user')
  assert.equal(userContent.parts.length, 2)
  assert.equal(userContent.parts[0].text, 'describe this')
  assert.deepEqual(userContent.parts[1], {
    inlineData: {
      mimeType: 'image/jpeg',
      data: fakeImageData.toString('base64'),
    },
  })
  await target.close()
})
})

console.log('host smoke test: OK')
