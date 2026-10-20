/**
 * Browser half: mount the provider card into the Models page row DSH renders
 * for this provider. The plugin adds no settings entry of its own.
 */
import type { Context } from '@deepseek-ai/cordis'
import './harness.js'
import { ProviderCard } from './card.js'
import type { CardContext } from './form.js'
import { CardController } from './form.js'
import { en, LOCALE_NS, zh } from './locales.js'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/** Settings namespace the card edits; equal to the Host Loader entry id. */
const NS = 'llm-google-cloud'

/**
 * Mount the card for the lifetime of this client plugin.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  const card = new CardController(ctx as unknown as CardContext)

  ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'google-cloud: dictionaries')
  ctx.effect(
    () => () => {
      card.dispose()
    },
    'google-cloud: card state',
  )
  ctx.effect(
    () =>
      ctx.slots.inject('settings.models.provider-card', () =>
        ctx.slots.register(
          {
            name: 'settings.models.provider-card',
            key: NS,
            inject: () => card.inject(),
          },
          ProviderCard,
        ),
      ),
    'google-cloud: provider card',
  )
}
