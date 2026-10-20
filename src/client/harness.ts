/**
 * Type-only wiring between this plugin and the Harness client services.
 *
 * The declared packages ship the Cordis service augmentations for `locale`,
 * `remote`, `configForms`, and the Models page slot map. The `slots` service
 * layer is not part of the published slots types, so this module declares the
 * two methods the plugin calls, and registers this plugin's dictionary
 * namespace so `ctx.locale.register` keeps its typed shape.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Labels } from './locales.js'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'

/** This plugin's copy belongs to the shared locale namespace map. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.googleCloud': Labels
  }
}

/** The slot registry face the Models page extension needs. */
export interface SlotRegistrationOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: string | (() => string)
  inject?: () => object
}

/** The Cordis `slots` service as this plugin uses it. */
export interface SlotsService {
  /** Run a registration while the owning slot declaration lives. */
  inject(owner: string, callback: () => () => void): () => void
  /** Register one component; the returned disposer removes it. */
  register(options: SlotRegistrationOptions, component: (props: never) => unknown): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotsService
  }
}

/** Re-exported so consumers of the client entry can name the card props. */
export type ProviderCardProps = PropsRuntime<'settings.models.provider-card'>
