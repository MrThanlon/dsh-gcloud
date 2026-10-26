/**
 * Host half: register the `google-cloud` route and its configuration directory
 * entry. The browser half reads and writes the same namespace through the
 * Host settings service, so no restart is needed after a save.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { GoogleCloudAdapter, MODULE } from './adapter.js'
import type { AdapterHost } from './adapter.js'
import { Config, readConfig } from './config.js'
import type { RawConfig, ProviderSettings } from './config.js'
import { assertUsableKey } from './errors.js'

export { Config }
export type { RawConfig, ProviderSettings }
/** Exposed for the offline projection test: history → one Gemini request. */
export { projectMessages } from './projection.js'

/** Loader entry id; it is also the settings namespace the browser half writes. */
export const ENTRY_ID = 'llm-google-cloud'

/** Host plugin name, matching the package name. */
export const name = 'llm-google-cloud'

/** The `llm` service must exist before this plugin activates. */
export const inject = ['llm']

/** One credential lookup backed by the harness credential seam. */
interface CredentialService {
  resolve(ref: string): Promise<{ value?: unknown } | undefined>
}

/** Immutable binary attachment service methods this adapter can use. */
interface AttachmentsService {
  imageHostPath?(ref: unknown): string | undefined
  readImage?(ref: unknown, signal?: AbortSignal): Promise<{ data?: Uint8Array | Buffer; mediaType?: string }>
  readImageRequest?(
    ref: unknown,
    target: unknown,
    signal?: AbortSignal,
  ): Promise<{ data?: Uint8Array | Buffer; mediaType?: string }>
}

/** The `llm` registry, typed at this module's boundary. */
interface LlmRegistry {
  registerAdapter(providers: readonly string[], adapter: GoogleCloudAdapter): unknown
  registerConfigurableProviders(
    entries: readonly {
      provider: string
      displayName: string
      settingsNs: string
      settingsPath: readonly string[]
    }[],
  ): unknown
}

/** Read a local disk file and return its base64 payload. */
function readDiskImageBase64(path: string, mimeType: string): { data: string; mimeType: string } | undefined {
  try {
    if (existsSync(path)) {
      const buf = readFileSync(path)
      return { data: buf.toString('base64'), mimeType }
    }
  } catch {
    // Ignore read error
  }
  return undefined
}

/** Fallback content-addressed storage lookup for a standard DSH sha256 attachment. */
function findCasAttachmentBase64(attachmentId: unknown, mediaType: unknown): { data: string; mimeType: string } | undefined {
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
  const hash = attachmentId.startsWith('sha256:') ? attachmentId.slice(7) : attachmentId
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return undefined
  const mime = typeof mediaType === 'string' && mediaType !== '' ? mediaType : 'image/png'

  const candidates: string[] = []
  const dshHome = process.env.DSH_HOME
  if (dshHome && dshHome !== '') {
    candidates.push(join(dshHome, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash))
  }
  const userHome = homedir()
  if (userHome && userHome !== '') {
    candidates.push(join(userHome, '.dsh', 'attachments', 'v1', 'objects', hash.slice(0, 2), hash))
  }

  for (const candidate of candidates) {
    const hit = readDiskImageBase64(candidate, mime)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Mount the adapter for this bundle's one provider route. */
export function apply(ctx: Context, config: RawConfig): void {
  const read = (): ProviderSettings => readConfig(config)
  const llm = (ctx as unknown as { llm: LlmRegistry }).llm

  let dynamicAttachments: AttachmentsService | undefined
  const ctxWithInject = ctx as unknown as {
    inject?(services: string[], callback: (inner: Context) => void): unknown
  }
  if (typeof ctxWithInject.inject === 'function') {
    ctxWithInject.inject(['attachments'], (inner: Context) => {
      const resolved = (inner as unknown as { get?(name: string): unknown }).get?.('attachments')
      if (resolved !== undefined && typeof resolved === 'object') {
        dynamicAttachments = resolved as AttachmentsService
      }
    })
  }

  const host: AdapterHost = {
    async resolveCredential(ref: string): Promise<string | undefined> {
      const credentials = (ctx as unknown as { get(name: string): unknown }).get('credentials') as
        | CredentialService
        | undefined
      if (credentials !== undefined) {
        const hit = await credentials.resolve(ref)
        if (hit !== undefined && typeof hit.value === 'string') return assertUsableKey(hit.value, MODULE, ref)
      }
      const ambient = process.env[ref]
      if (typeof ambient === 'string' && ambient.length > 0) return assertUsableKey(ambient, MODULE, ref)
      return undefined
    },

    async readImageAttachment(ref: unknown, signal?: AbortSignal): Promise<{ data: string; mimeType: string } | undefined> {
      if (ref === null || typeof ref !== 'object') return undefined
      const record = ref as {
        attachmentId?: unknown
        mediaType?: unknown
        path?: unknown
        readonlyPath?: unknown
      }
      const expectedMime = typeof record.mediaType === 'string' ? record.mediaType : 'image/png'

      const attachments =
        dynamicAttachments ??
        ((ctx as unknown as { get?(name: string): unknown }).get?.('attachments') as AttachmentsService | undefined)

      if (attachments !== undefined) {
        // 1. Try attachments.readImageRequest
        if (typeof attachments.readImageRequest === 'function') {
          try {
            const res = await attachments.readImageRequest(ref, { width: 2048, height: 2048, maxBytes: 4194304 }, signal)
            if (res?.data) {
              const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data)
              return { data: buf.toString('base64'), mimeType: res.mediaType ?? expectedMime }
            }
          } catch {
            // Fall through
          }
        }

        // 2. Try attachments.readImage
        if (typeof attachments.readImage === 'function') {
          try {
            const res = await attachments.readImage(ref, signal)
            if (res?.data) {
              const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data)
              return { data: buf.toString('base64'), mimeType: res.mediaType ?? expectedMime }
            }
          } catch {
            // Fall through
          }
        }

        // 3. Try attachments.imageHostPath
        if (typeof attachments.imageHostPath === 'function') {
          try {
            const hostPath = attachments.imageHostPath(ref)
            if (typeof hostPath === 'string' && hostPath !== '') {
              const hit = readDiskImageBase64(hostPath, expectedMime)
              if (hit !== undefined) return hit
            }
          } catch {
            // Fall through
          }
        }
      }

      // 4. Try direct file paths on the reference if present
      if (typeof record.path === 'string' && record.path !== '') {
        const hit = readDiskImageBase64(record.path, expectedMime)
        if (hit !== undefined) return hit
      }
      if (typeof record.readonlyPath === 'string' && record.readonlyPath !== '') {
        const hit = readDiskImageBase64(record.readonlyPath, expectedMime)
        if (hit !== undefined) return hit
      }

      // 5. Try direct content-addressed storage fallback
      const casHit = findCasAttachmentBase64(record.attachmentId, record.mediaType)
      if (casHit !== undefined) return casHit

      return undefined
    },
  }

  const adapter = new GoogleCloudAdapter(host, read)
  llm.registerAdapter([read().provider], adapter)
  // The directory entry is what puts this route on a configuration surface's
  // provider list; `settingsPath: []` makes the whole row its profile.
  const entryId = (ctx as unknown as { fiber?: { entry?: { options?: { id?: string } } } }).fiber?.entry?.options?.id
  llm.registerConfigurableProviders([
    {
      provider: read().provider,
      displayName: read().displayName,
      settingsNs: entryId ?? ENTRY_ID,
      settingsPath: [],
    },
  ])
}
