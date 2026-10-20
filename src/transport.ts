/**
 * HTTP(S) transport with optional proxy tunneling.
 *
 * The harness Host is a Node process, and Node's global `fetch` does not route
 * through a proxy on its own, so this module owns the connection: direct or
 * through an `http://`, `https://`, or `socks5(h)://` proxy, then a plain
 * HTTP/1.1 exchange over the resulting socket. Speaking HTTP directly keeps
 * the streamed response a Node readable, which is what the SSE reader wants.
 */
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { llmError } from './errors.js'

/** Longest a socket connect or a proxy handshake may take. */
const CONNECT_TIMEOUT_MS = 20000
/** Longest CONNECT response head this module buffers. */
const MAX_PROXY_HEAD_BYTES = 16384

/** Connection facts for one endpoint URL. */
export interface Endpoint {
  /** Scheme of the target; decides whether the socket is wrapped in TLS. */
  scheme: 'http' | 'https'
  host: string
  port: number
  /** Endpoint path without a trailing slash, prepended to every request path. */
  prefix: string
  /** The endpoint's own path and query, used by GET calls that list models. */
  pathWithQuery: string
}

/** One resolved proxy. */
export interface ProxyConfig {
  kind: 'http' | 'https' | 'socks5'
  host: string
  port: number
  auth?: { username: string; password: string }
}

/** One outbound HTTP request. */
export interface RequestInit {
  method: 'GET' | 'POST'
  path: string
  headers: Record<string, string>
  body?: string
}

/** One response head plus the still-open body stream. */
export interface RequestResult {
  status: number
  stream: http.IncomingMessage
}

/** Split an endpoint URL into connection facts and the request path. */
export function parseEndpoint(endpoint: string): Endpoint {
  const url = new URL(endpoint)
  const scheme = url.protocol === 'http:' ? 'http' : 'https'
  return {
    scheme,
    host: url.hostname,
    port: Number(url.port) || (scheme === 'https' ? 443 : 80),
    prefix: url.pathname.replace(/\/+$/, ''),
    pathWithQuery: `${url.pathname}${url.search}`,
  }
}

/** First non-empty value among some environment variables. */
function envValue(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Whether NO_PROXY excludes this host from the ambient proxy. */
function bypassesProxy(host: string): boolean {
  const raw = envValue(['NO_PROXY', 'no_proxy'])
  if (raw === undefined) return false
  const target = host.toLowerCase()
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .some((item) => {
      if (item === '') return false
      if (item === '*') return true
      const bare = item.replace(/^\./, '')
      return target === bare || target.endsWith(`.${bare}`)
    })
}

/** Resolve the configured proxy for one target host, or undefined for a direct connection. */
export function parseProxy(raw: string, targetHost: string, module: string): ProxyConfig | undefined {
  let text = String(raw ?? '').trim()
  if (text === '' || text === 'direct' || text === 'none') return undefined
  if (text === 'auto') {
    text = envValue(['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) ?? ''
    if (text === '') return undefined
    if (bypassesProxy(targetHost)) return undefined
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw llmError(`${module}: the proxy setting "${text}" is not a URL`, 'INVALID_CONFIG')
  }
  const protocol = url.protocol.toLowerCase()
  const kind =
    protocol === 'socks5:' || protocol === 'socks5h:' || protocol === 'socks:'
      ? 'socks5'
      : protocol === 'https:'
        ? 'https'
        : protocol === 'http:'
          ? 'http'
          : undefined
  if (kind === undefined) {
    throw llmError(`${module}: unsupported proxy scheme "${protocol}"; use http, https, socks5 or socks5h`, 'INVALID_CONFIG')
  }
  const auth =
    url.username === '' && url.password === ''
      ? undefined
      : { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
  return {
    kind,
    host: url.hostname,
    port: Number(url.port) || (kind === 'https' ? 443 : kind === 'http' ? 80 : 1080),
    auth,
  }
}

/** Buffered exact-length reads over one socket, used by the proxy handshakes. */
class SocketReader {
  private readonly socket: net.Socket
  private buffer = Buffer.alloc(0)
  private waiter: { length: number; resolve: (value: Buffer) => void; reject: (error: Error) => void } | undefined
  private failure: Error | undefined

  constructor(socket: net.Socket) {
    this.socket = socket
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.flush()
  }

  private readonly onError = (error: Error): void => {
    this.failure = error
    this.flush()
  }

  private readonly onClose = (): void => {
    if (this.failure === undefined) this.failure = new Error('the proxy closed the connection')
    this.flush()
  }

  read(length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiter = { length, resolve, reject }
      this.flush()
    })
  }

  private flush(): void {
    const waiter = this.waiter
    if (waiter === undefined) return
    if (this.failure !== undefined) {
      this.waiter = undefined
      waiter.reject(this.failure)
      return
    }
    if (this.buffer.length < waiter.length) return
    this.waiter = undefined
    const out = this.buffer.subarray(0, waiter.length)
    this.buffer = this.buffer.subarray(waiter.length)
    waiter.resolve(out)
  }

  /** Stop reading and hand bytes that belong to the next protocol layer back to the socket. */
  release(): void {
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('error', this.onError)
    this.socket.removeListener('close', this.onClose)
    const rest = this.buffer
    this.buffer = Buffer.alloc(0)
    if (rest.length > 0) this.socket.unshift(rest)
  }

  /** Drop the reader without handing buffered bytes back (a failed handshake). */
  fail(): void {
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('error', this.onError)
    this.socket.removeListener('close', this.onClose)
  }
}

/** Open one TCP connection, honouring a cancellation signal and the connect timeout. */
function connectSocket(host: string, port: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    const onError = (error: Error): void => fail(error)
    const onAbort = (): void => fail(new Error('aborted'))
    const cleanup = (): void => {
      socket.setTimeout(0)
      socket.removeListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error(`connecting to ${host}:${port} timed out`)))
    socket.once('error', onError)
    if (signal !== undefined) {
      if (signal.aborted) {
        fail(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    socket.once('connect', () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    })
  })
}

/** Wrap one connected socket in TLS for the named server. */
function secureSocket(socket: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] })
    const onError = (error: Error): void => reject(error)
    secured.once('error', onError)
    secured.once('secureConnect', () => {
      secured.removeListener('error', onError)
      resolve(secured)
    })
  })
}

/** Establish an HTTP CONNECT tunnel through an http:// or https:// proxy. */
async function httpConnect(socket: net.Socket, target: Endpoint, auth?: ProxyConfig['auth']): Promise<void> {
  const authority = `${target.host}:${target.port}`
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
  if (auth !== undefined) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  const reader = new SocketReader(socket)
  let head = ''
  try {
    while (!head.includes('\r\n\r\n')) {
      head += (await reader.read(1)).toString('latin1')
      if (head.length > MAX_PROXY_HEAD_BYTES) throw new Error('the proxy did not answer CONNECT')
    }
    reader.release()
  } catch (error) {
    reader.fail()
    throw error
  }
  const statusLine = head.split('\r\n')[0] ?? ''
  const status = Number(statusLine.split(' ')[1])
  if (status !== 200) throw new Error(`the proxy refused CONNECT (${statusLine})`)
}

/** Establish a SOCKS5 (RFC 1928) tunnel, optionally with username/password authentication. */
async function socks5Connect(socket: net.Socket, target: Endpoint, auth?: ProxyConfig['auth']): Promise<void> {
  const reader = new SocketReader(socket)
  try {
    socket.write(auth === undefined ? Buffer.from([0x05, 0x01, 0x00]) : Buffer.from([0x05, 0x02, 0x00, 0x02]))
    const greeting = await reader.read(2)
    if (greeting[0] !== 0x05) throw new Error('the SOCKS5 proxy answered with an unknown version')
    if (greeting[1] === 0x02) {
      if (auth === undefined) throw new Error('the SOCKS5 proxy requires a username and password')
      const user = Buffer.from(auth.username, 'utf8')
      const password = Buffer.from(auth.password, 'utf8')
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([password.length]), password]))
      const result = await reader.read(2)
      if (result[1] !== 0x00) throw new Error('the SOCKS5 proxy rejected the username and password')
    } else if (greeting[1] !== 0x00) {
      throw new Error(`the SOCKS5 proxy selected an unsupported authentication method (${greeting[1]})`)
    }
    const host = Buffer.from(target.host, 'utf8')
    const port = Buffer.from([Math.floor(target.port / 256) & 0xff, target.port & 0xff])
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]))
    const reply = await reader.read(4)
    if (reply[0] !== 0x05) throw new Error('the SOCKS5 proxy answered with an unknown version')
    if (reply[1] !== 0x00) throw new Error(`the SOCKS5 proxy refused the connection (code ${reply[1]})`)
    if (reply[3] === 0x01) await reader.read(4 + 2)
    else if (reply[3] === 0x04) await reader.read(16 + 2)
    else if (reply[3] === 0x03) await reader.read((await reader.read(1))[0] + 2)
    else throw new Error('the SOCKS5 proxy answered with an unknown address type')
    reader.release()
  } catch (error) {
    reader.fail()
    throw error
  }
}

/** One connected, TLS-ready socket for one endpoint, directly or through the configured proxy. */
async function openTunnel(endpoint: Endpoint, proxySetting: string, module: string, signal?: AbortSignal): Promise<net.Socket> {
  const proxy = parseProxy(proxySetting, endpoint.host, module)
  const wrap = async (socket: net.Socket): Promise<net.Socket> =>
    endpoint.scheme === 'https' ? secureSocket(socket, endpoint.host) : socket
  if (proxy === undefined) return wrap(await connectSocket(endpoint.host, endpoint.port, signal))
  const socket = await connectSocket(proxy.host, proxy.port, signal)
  try {
    const tunnelled = proxy.kind === 'https' ? await secureSocket(socket, proxy.host) : socket
    if (proxy.kind === 'socks5') await socks5Connect(tunnelled, endpoint, proxy.auth)
    else await httpConnect(tunnelled, endpoint, proxy.auth)
    return await wrap(tunnelled)
  } catch (error) {
    socket.destroy()
    throw llmError(
      `${module}: the ${proxy.kind} proxy ${proxy.host}:${proxy.port} failed: ${error instanceof Error ? error.message : String(error)}`,
      'TRANSPORT',
    )
  }
}

/** An HTTP agent that always hands back the one socket already tunneled. */
class SocketAgent extends http.Agent {
  private readonly socket: net.Socket

  constructor(socket: net.Socket) {
    super({ keepAlive: false })
    this.socket = socket
  }

  override createConnection(): net.Socket {
    return this.socket
  }
}

/** Send one request over the (optionally proxied) connection and resolve with its response head. */
export async function performRequest(
  endpoint: Endpoint,
  proxySetting: string,
  module: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<RequestResult> {
  const socket = await openTunnel(endpoint, proxySetting, module, signal)
  return new Promise<RequestResult>((resolve, reject) => {
    const outgoing = http.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        method: init.method,
        path: init.path,
        headers: { host: endpoint.host, connection: 'close', ...init.headers },
        agent: new SocketAgent(socket),
      },
      (response) => {
        resolve({ status: response.statusCode ?? 0, stream: response })
      },
    )
    const onAbort = (): void => {
      outgoing.destroy(new Error('aborted'))
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const detach = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    outgoing.on('error', (error) => {
      detach()
      reject(error)
    })
    outgoing.on('close', detach)
    if (init.body !== undefined) outgoing.write(init.body)
    outgoing.end()
  })
}

/** Read a bounded response body as text. */
export async function readAll(stream: http.IncomingMessage, limit: number): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    if (text.length > limit) {
      stream.destroy()
      break
    }
  }
  return text
}
