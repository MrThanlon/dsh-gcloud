/**
 * Card state: the staged draft over the Host settings section, the credential
 * probe, and the ordered writes that persist both.
 *
 * The form holds only the redacted Host section, so every save is a path-op
 * mutation fenced by the revision read before editing; the API key never enters
 * the settings document and is written through the credentials remote instead.
 */
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { labelsOf, LOCALE_NS, type Labels } from './locales.js'

/** Settings namespace the Host plugin exposes; equal to its Loader entry id. */
export const NS = 'llm-google-cloud'
/** Credential reference used when the Host section names none. */
const DEFAULT_API_KEY_REF = 'GOOGLE_CLOUD_API_KEY'
const DEFAULT_CONTEXT_WINDOW = 1048576
const DEFAULT_MAX_TOKENS = 65536

/** One model row as the Host section stores it. */
export interface SectionModel {
  id?: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/** The Host section this card edits. */
export interface ProviderSection {
  provider?: string
  displayName?: string
  projectId?: string
  location?: string
  baseURL?: string
  proxy?: string
  apiKeyEnv?: string
  models?: readonly SectionModel[]
  streamIdleTimeoutMs?: number
}

/** Editable text fields, keyed by the draft member they write. */
export type DraftField = 'projectId' | 'location' | 'proxy' | 'modelsText'

/** What the component renders. */
export interface CardView {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  saving: boolean
  expanded: boolean
  dirty: boolean
  invalid: 'project' | 'models' | null
  failure: string | null
  notice: 'saved' | null
  projectId: string
  location: string
  proxy: string
  modelsText: string
  modelCount: number
  provider: string
  apiKeyEnv: string
  keyDraft: string
  keyConfigured: boolean
  keyWritable: boolean
  labels: Labels
}

/** The inject face registered into the Models page card. */
export interface CardFace {
  useCard: <R>(selector: (value: CardView) => R) => R
  expand: () => void
  collapse: () => void
  edit: (field: DraftField, value: string) => void
  editKey: (value: string) => void
  save: () => void
  reset: () => void
}

/** The observable the slot turns into `useCard`. */
export interface CardStore {
  getSnapshot(): CardView
  subscribe(listener: () => void): () => void
}

/** Credential answers this card needs. */
interface CredentialsRemote {
  describe(refs: readonly string[]): Promise<{
    ok: boolean
    value?: Record<string, { configured?: boolean; writable?: boolean } | undefined>
  }>
  set(ref: string, value: string): Promise<unknown>
}

/** The transport faces this plugin injects. */
export interface CardContext {
  configForms: { get<T>(entryId: string): ConfigForm<T> }
  locale: { bind(namespace: string): (key: string) => string; subscribe(listener: () => void): () => void }
  remote: {
    credentials: CredentialsRemote
    $on(event: string, listener: (payload: unknown) => void): () => void
  }
}

/** Normalize one model row exactly the way the Host adapter does. */
function normalizeModel(row: SectionModel | undefined): Required<SectionModel> | undefined {
  const id = typeof row?.id === 'string' ? row.id.trim() : ''
  if (id === '') return undefined
  const contextWindow =
    Number.isInteger(row?.contextWindow) && (row?.contextWindow as number) > 0
      ? (row?.contextWindow as number)
      : DEFAULT_CONTEXT_WINDOW
  const maxTokens =
    Number.isInteger(row?.maxTokens) && (row?.maxTokens as number) > 0 ? (row?.maxTokens as number) : DEFAULT_MAX_TOKENS
  const name = typeof row?.name === 'string' && row.name.trim() !== '' ? row.name.trim() : id
  return { id, name, contextWindow, maxTokens }
}

/** Render the catalog as editable lines. */
export function formatModels(models: readonly SectionModel[] | undefined): string {
  return (models ?? [])
    .map((model) => normalizeModel(model))
    .filter((model): model is Required<SectionModel> => model !== undefined)
    .map((model) => `${model.id} | ${model.name} | ${model.contextWindow} | ${model.maxTokens}`)
    .join('\n')
}

/** Parse the editable catalog; undefined means the draft is invalid. */
export function parseModels(text: string): Required<SectionModel>[] | undefined {
  const rows: Required<SectionModel>[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const columns = line.split('|').map((column) => column.trim())
    const id = columns[0] ?? ''
    if (id === '' || /\s/.test(id)) return undefined
    const row: SectionModel = { id }
    if ((columns[1] ?? '') !== '') row.name = columns[1]
    for (const [index, key] of [
      [2, 'contextWindow'],
      [3, 'maxTokens'],
    ] as const) {
      const column = columns[index]
      if (column === undefined || column === '') continue
      const value = Number(column)
      if (!Number.isInteger(value) || value <= 0) return undefined
      row[key] = value
    }
    const normalized = normalizeModel(row)
    if (normalized === undefined) return undefined
    rows.push(normalized)
  }
  return rows.length === 0 ? undefined : rows
}

/** The Host section's editable values. */
interface Saved {
  projectId: string
  location: string
  proxy: string
  modelsText: string
  models: Required<SectionModel>[]
  provider: string
  apiKeyEnv: string
}

/** Read the saved section into the card's editable shape. */
function savedOf(section: ProviderSection | undefined): Saved {
  const models = (section?.models ?? [])
    .map((model) => normalizeModel(model))
    .filter((model): model is Required<SectionModel> => model !== undefined)
  return {
    projectId: typeof section?.projectId === 'string' ? section.projectId : '',
    location: typeof section?.location === 'string' && section.location !== '' ? section.location : 'global',
    proxy: typeof section?.proxy === 'string' ? section.proxy : '',
    modelsText: formatModels(models),
    models,
    provider: typeof section?.provider === 'string' && section.provider !== '' ? section.provider : 'google-cloud',
    apiKeyEnv:
      typeof section?.apiKeyEnv === 'string' && section.apiKeyEnv !== '' ? section.apiKeyEnv : DEFAULT_API_KEY_REF,
  }
}

/** The staged draft. */
interface Draft {
  projectId: string
  location: string
  proxy: string
  modelsText: string
}

/** Build one `set` operation. */
const setOp = (path: string[], value: unknown): SettingsPathOpView => ({ op: 'set', path, value: value as never })

/** Card state over one settings form. */
export class CardController {
  private readonly ctx: CardContext
  private readonly scope: ConfigForm<ProviderSection>
  private readonly t: (key: string) => string
  private readonly store: CardStore
  private readonly offs: (() => void)[] = []
  private saved: Saved
  private draft: Draft
  private keyDraft = ''
  private touched = false
  private expanded = false
  private saving = false
  private failure: string | null = null
  private notice: 'saved' | null = null
  private credential = { ref: '', configured: false, writable: true }
  private value: CardView

  /**
   * @param ctx - the client plugin context.
   */
  constructor(ctx: CardContext) {
    this.ctx = ctx
    this.t = (key) => ctx.locale.bind(LOCALE_NS)(key)
    this.scope = ctx.configForms.get<ProviderSection>(NS)
    this.saved = savedOf(this.scope.getSnapshot().value)
    this.draft = this.draftOf(this.saved)
    this.value = this.build()
    const listeners = new Set<() => void>()
    this.store = {
      getSnapshot: () => this.value,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    this.publishTo = () => {
      this.value = this.build()
      for (const listener of [...listeners]) listener()
    }
    this.offs.push(this.scope.subscribe(() => this.sync()))
    this.offs.push(ctx.locale.subscribe(() => this.publish()))
    this.offs.push(
      ctx.remote.$on('credentials/reference-updated', (payload) => {
        if (payload === this.credential.ref) void this.readCredential()
      }),
    )
    this.publish()
    void this.readCredential()
  }

  private publishTo: () => void

  /** Adopt saved values while the user has no unsaved edit. */
  private sync(): void {
    this.saved = savedOf(this.scope.getSnapshot().value)
    if (!this.touched) this.draft = this.draftOf(this.saved)
    this.publish()
  }

  /** Rebuild and broadcast the render snapshot. */
  private publish(): void {
    this.publishTo()
  }

  private draftOf(saved: Saved): Draft {
    return { projectId: saved.projectId, location: saved.location, proxy: saved.proxy, modelsText: saved.modelsText }
  }

  private build(): CardView {
    const snapshot = this.scope.getSnapshot()
    const models = parseModels(this.draft.modelsText)
    const dirty =
      this.draft.projectId !== this.saved.projectId ||
      this.draft.location !== this.saved.location ||
      this.draft.proxy !== this.saved.proxy ||
      this.draft.modelsText !== this.saved.modelsText ||
      this.keyDraft.trim() !== ''
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      saving: this.saving,
      expanded: this.expanded || dirty,
      dirty,
      invalid: this.draft.projectId.trim() === '' ? 'project' : models === undefined ? 'models' : null,
      failure: this.failure,
      notice: this.notice,
      projectId: this.draft.projectId,
      location: this.draft.location,
      proxy: this.draft.proxy,
      modelsText: this.draft.modelsText,
      modelCount: models === undefined ? this.saved.models.length : models.length,
      provider: this.saved.provider,
      apiKeyEnv: this.saved.apiKeyEnv,
      keyDraft: this.keyDraft,
      keyConfigured: this.credential.configured,
      keyWritable: this.credential.writable,
      labels: labelsOf(this.t),
    }
  }

  /** Ask the credentials remote whether the referenced key is configured. */
  private async readCredential(): Promise<void> {
    const ref = this.saved.apiKeyEnv
    if (ref !== this.credential.ref) {
      this.credential = { ref, configured: false, writable: true }
      this.publish()
    }
    try {
      const response = await this.ctx.remote.credentials.describe([ref])
      if (!response?.ok) return
      const view = response.value?.[ref]
      const next = {
        ref,
        configured: view?.configured === true,
        writable: view === undefined || view.writable !== false,
      }
      if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
      this.credential = next
      this.publish()
    } catch {
      // A failed probe leaves the previous answer in place.
    }
  }

  /** Stage one field edit. */
  edit(field: DraftField, value: string): void {
    this.draft = { ...this.draft, [field]: value }
    this.touched = true
    this.notice = null
    this.publish()
  }

  /** Stage the API key. */
  editKey(value: string): void {
    this.keyDraft = value
    this.touched = true
    this.notice = null
    this.publish()
  }

  /** Discard the draft. */
  reset(): void {
    this.touched = false
    this.keyDraft = ''
    this.failure = null
    this.notice = null
    this.draft = this.draftOf(this.saved)
    this.publish()
  }

  /** Expand the form. */
  expand(): void {
    this.expanded = true
    this.publish()
  }

  /** Collapse the form unless a draft is staged. */
  collapse(): void {
    this.expanded = false
    this.publish()
  }

  /** Persist the staged draft; the key stage runs before the settings stage. */
  async save(): Promise<void> {
    if (this.saving || !this.scope.getSnapshot().writable) return
    const saved = this.saved
    const draft = this.draft
    const models = parseModels(draft.modelsText)
    if (draft.projectId.trim() === '' || models === undefined) {
      this.publish()
      return
    }
    const operations: SettingsPathOpView[] = []
    if (draft.projectId.trim() !== saved.projectId) operations.push(setOp(['projectId'], draft.projectId.trim()))
    if (draft.location.trim() !== saved.location) {
      operations.push(
        draft.location.trim() === '' ? { op: 'unset', path: ['location'] } : setOp(['location'], draft.location.trim()),
      )
    }
    if (draft.proxy.trim() !== saved.proxy) {
      operations.push(draft.proxy.trim() === '' ? { op: 'unset', path: ['proxy'] } : setOp(['proxy'], draft.proxy.trim()))
    }
    if (JSON.stringify(models) !== JSON.stringify(saved.models)) operations.push(setOp(['models'], models))

    const key = this.keyDraft.trim()
    this.saving = true
    this.failure = null
    this.notice = null
    this.publish()
    try {
      if (key !== '') {
        await this.ctx.remote.credentials.set(saved.apiKeyEnv, key)
        this.keyDraft = ''
      }
      if (operations.length > 0) {
        const accepted = await this.scope.mutate(operations)
        if (!accepted) this.failure = 'rejected'
      }
      if (this.failure === null) {
        this.touched = false
        this.notice = 'saved'
      }
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error)
    } finally {
      this.saving = false
      this.saved = savedOf(this.scope.getSnapshot().value)
      this.draft = this.draftOf(this.saved)
      await this.readCredential()
      this.publish()
    }
  }

  /** The business face the slot registration injects into the card component. */
  inject(): CardFace & { hooks: { card: CardStore } } {
    return {
      hooks: { card: this.store },
      useCard: (selector) => selector(this.store.getSnapshot()),
      expand: () => this.expand(),
      collapse: () => this.collapse(),
      edit: (field, value) => this.edit(field, value),
      editKey: (value) => this.editKey(value),
      save: () => void this.save(),
      reset: () => this.reset(),
    }
  }

  /** Release the subscriptions this controller owns. */
  dispose(): void {
    for (const off of this.offs) off()
    this.offs.length = 0
  }
}
