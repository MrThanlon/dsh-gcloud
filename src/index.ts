/**
 * Host half: register the `google-cloud` route and its configuration directory
 * entry. The browser half reads and writes the same namespace through the
 * Host settings service, so no restart is needed after a save.
 */
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

/** Mount the adapter for this bundle's one provider route. */
export function apply(ctx: Context, config: RawConfig): void {
  const read = (): ProviderSettings => readConfig(config)
  const llm = (ctx as unknown as { llm: LlmRegistry }).llm

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
