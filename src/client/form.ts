/**
 * Card state: the staged draft over the Host settings section, the credential
 * probe, the ordered writes that persist both, and the DOM bridge that wires
 * DSH's native ProviderEditor Cancel/Apply buttons to this controller.
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

/** Fallback catalog used when neither the profile nor the root section lists models yet. */
const DEFAULT_MODELS: readonly SectionModel[] = [
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', contextWindow: 1048576, maxTokens: 1048576, inputModalities: ['text', 'image'] },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', contextWindow: 1048576, maxTokens: 65536, inputModalities: ['text', 'image'] },
]

/** One model row as the Host section stores it. */
export interface SectionModel {
  id?: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
  input?: readonly string[]
}

/** One provider profile stored under `providers.<route>`. */
export interface ProfileSection {
  displayName?: string
  projectId?: string
  location?: string
  baseURL?: string
  proxy?: string
  apiKeyEnv?: string
  models?: readonly SectionModel[]
  streamIdleTimeoutMs?: number
}

/** The Host section this card edits. */
export interface ProviderSection extends ProfileSection {
  provider?: string
  providers?: Readonly<Record<string, ProfileSection | undefined>>
}

/** Editable text fields, keyed by the draft member they write. */
export type DraftField = 'projectId' | 'location' | 'baseURL' | 'proxy' | 'modelsText'

/** What the component renders. */
export interface CardView {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  saving: boolean
  expanded: boolean
  nativeEditorOpen: boolean
  configured: boolean
  dirty: boolean
  invalid: 'project' | 'models' | null
  failure: string | null
  notice: 'saved' | null
  projectId: string
  location: string
  baseURL: string
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
  bindDom: (element: HTMLElement | null) => void
  bindBodyDom: (element: HTMLElement | null) => void
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

/** One normalized model row. */
export type NormalizedSectionModel = Required<Pick<SectionModel, 'id' | 'name' | 'contextWindow' | 'maxTokens'>> & {
  inputModalities: readonly string[]
}

/** Normalize one model row exactly the way the Host adapter does. */
function normalizeModel(row: SectionModel | undefined): NormalizedSectionModel | undefined {
  const rawId = typeof row?.id === 'string' ? row.id.trim() : ''
  const id = rawId.replace(/^(gemini-[23])-([1-9])(?=-)/i, '$1.$2')
  if (id === '') return undefined
  const contextWindow =
    Number.isInteger(row?.contextWindow) && (row?.contextWindow as number) > 0
      ? (row?.contextWindow as number)
      : DEFAULT_CONTEXT_WINDOW
  const maxTokens =
    Number.isInteger(row?.maxTokens) && (row?.maxTokens as number) > 0 ? (row?.maxTokens as number) : DEFAULT_MAX_TOKENS
  const name = typeof row?.name === 'string' && row.name.trim() !== '' ? row.name.trim() : id
  const rawMods = row?.inputModalities ?? row?.input
  const inputModalities =
    Array.isArray(rawMods) && rawMods.length > 0
      ? rawMods.filter((m): m is string => typeof m === 'string')
      : ['text', 'image']
  return { id, name, contextWindow, maxTokens, inputModalities }
}

/** Render the catalog as editable lines. */
export function formatModels(models: readonly SectionModel[] | undefined): string {
  return (models ?? [])
    .map((model) => normalizeModel(model))
    .filter((model): model is NormalizedSectionModel => model !== undefined)
    .map((model) => `${model.id} | ${model.name} | ${model.contextWindow} | ${model.maxTokens}`)
    .join('\n')
}

/** Parse the editable catalog; undefined means the draft is invalid. */
export function parseModels(text: string): NormalizedSectionModel[] | undefined {
  const rows: NormalizedSectionModel[] = []
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
    if ((columns[4] ?? '') !== '') {
      const modalities = columns[4]
        .split(',')
        .map((col) => col.trim())
        .filter((col) => col === 'text' || col === 'image')
      if (modalities.length > 0) row.inputModalities = modalities
    }
    const normalized = normalizeModel(row)
    if (normalized === undefined) return undefined
    rows.push(normalized)
  }
  return rows.length === 0 ? undefined : rows
}

/** The Host section's editable values. */
interface Saved {
  configured: boolean
  projectId: string
  location: string
  baseURL: string
  proxy: string
  modelsText: string
  models: NormalizedSectionModel[]
  provider: string
  apiKeyEnv: string
}

/** Read the saved section into the card's editable shape. */
function savedOf(section: ProviderSection | undefined): Saved {
  const provider = typeof section?.provider === 'string' && section.provider !== '' ? section.provider : 'google-cloud'
  const profile = section?.providers?.[provider] ?? section?.providers?.['google-cloud']
  const configured = profile !== undefined && profile !== null && typeof profile === 'object'
  const source: ProfileSection | undefined = configured ? profile : section
  const rawModels = source?.models ?? section?.models ?? DEFAULT_MODELS
  const parsedModels = (rawModels.length > 0 ? rawModels : DEFAULT_MODELS)
    .map((model) => normalizeModel(model))
    .filter((model): model is NormalizedSectionModel => model !== undefined)
  const models =
    parsedModels.length > 0
      ? parsedModels
      : DEFAULT_MODELS.map((model) => normalizeModel(model)).filter(
          (model): model is NormalizedSectionModel => model !== undefined,
        )
  return {
    configured,
    projectId: typeof source?.projectId === 'string' ? source.projectId : '',
    location: typeof source?.location === 'string' && source.location !== '' ? source.location : 'global',
    baseURL: typeof source?.baseURL === 'string' ? source.baseURL : '',
    proxy: typeof source?.proxy === 'string' ? source.proxy : '',
    modelsText: formatModels(models),
    models,
    provider,
    apiKeyEnv:
      typeof source?.apiKeyEnv === 'string' && source.apiKeyEnv !== '' ? source.apiKeyEnv : DEFAULT_API_KEY_REF,
  }
}

/** The staged draft. */
interface Draft {
  projectId: string
  location: string
  baseURL: string
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
  private readonly boundBindDom: (element: HTMLElement | null) => void
  private readonly boundBindBodyDom: (element: HTMLElement | null) => void
  private saved: Saved
  private draft: Draft
  private keyDraft = ''
  private touched = false
  private expanded = false
  private nativeEditorOpen = false
  private saving = false
  private closingAfterSave = false
  private failure: string | null = null
  private notice: 'saved' | null = null
  private credential = { ref: '', configured: false, writable: true }
  private value: CardView
  private hostEl: HTMLElement | null = null
  private bodyEl: HTMLElement | null = null
  private parentObserver: MutationObserver | null = null
  private buttonObserver: MutationObserver | null = null
  private detachButtons: (() => void) | null = null

  /**
   * @param ctx - the client plugin context.
   */
  constructor(ctx: CardContext) {
    this.ctx = ctx
    this.t = (key) => ctx.locale.bind(LOCALE_NS)(key)
    this.scope = ctx.configForms.get<ProviderSection>(NS)
    this.saved = savedOf(this.scope.getSnapshot().value)
    this.draft = this.draftOf(this.saved)
    this.boundBindDom = (element) => this.bindDom(element)
    this.boundBindBodyDom = (element) => this.bindBodyDom(element)
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
      this.syncNativeEditorButtons()
      for (const listener of [...listeners]) listener()
    }
    this.offs.push(this.scope.subscribe(() => this.sync()))
    this.offs.push(ctx.locale.subscribe(() => this.publish()))
    this.offs.push(
      ctx.remote.$on('credentials/reference-updated', (payload) => {
        const ref = Array.isArray(payload) ? payload[0] : payload
        if (ref === this.credential.ref || payload === this.credential.ref) void this.readCredential()
      }),
    )
    this.publish()
    void this.readCredential()
  }

  private publishTo: () => void

  /** Adopt saved values while the user has no unsaved edit, or reset when the profile is deleted. */
  private sync(): void {
    const wasConfigured = this.saved.configured
    this.saved = savedOf(this.scope.getSnapshot().value)
    if (!this.touched || (wasConfigured && !this.saved.configured)) {
      this.touched = false
      this.keyDraft = ''
      this.failure = null
      this.notice = null
      this.draft = this.draftOf(this.saved)
    }
    void this.readCredential()
    this.publish()
  }

  /** Rebuild and broadcast the render snapshot. */
  private publish(): void {
    this.publishTo()
  }

  private draftOf(saved: Saved): Draft {
    return {
      projectId: saved.projectId,
      location: saved.location,
      baseURL: saved.baseURL,
      proxy: saved.proxy,
      modelsText: saved.modelsText,
    }
  }

  private isDirty(): boolean {
    return (
      this.draft.projectId !== this.saved.projectId ||
      this.draft.location !== this.saved.location ||
      this.draft.baseURL !== this.saved.baseURL ||
      this.draft.proxy !== this.saved.proxy ||
      this.draft.modelsText !== this.saved.modelsText ||
      this.keyDraft.trim() !== ''
    )
  }

  private canSave(): boolean {
    const snapshot = this.scope.getSnapshot()
    if (!snapshot.writable || this.saving) return false
    const models = parseModels(this.draft.modelsText)
    if (this.draft.projectId.trim() === '' || models === undefined) return false
    if (!this.saved.configured) return true
    return this.isDirty()
  }

  private build(): CardView {
    const snapshot = this.scope.getSnapshot()
    const models = parseModels(this.draft.modelsText)
    const dirty = this.isDirty()
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      saving: this.saving,
      expanded: this.expanded || dirty,
      nativeEditorOpen: this.nativeEditorOpen,
      configured: this.saved.configured,
      dirty,
      invalid: this.draft.projectId.trim() === '' ? 'project' : models === undefined ? 'models' : null,
      failure: this.failure,
      notice: this.notice,
      projectId: this.draft.projectId,
      location: this.draft.location,
      baseURL: this.draft.baseURL,
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

  /** Resolve the section container (`_addPanel_` or `_rowCard_`) above the slot anchor wrapper. */
  private findContainer(): HTMLElement | null {
    let el = this.hostEl?.parentElement ?? null
    while (
      el !== null &&
      ((typeof el.getAttribute === 'function' && el.getAttribute('data-slot') !== null) ||
        el.style?.display === 'contents')
    ) {
      el = el.parentElement
    }
    return el
  }

  /** Locate DSH's sibling ProviderEditor and its Cancel / Apply buttons in the same container. */
  private findNativeEditor(): {
    editorEl: HTMLElement
    actionsEl: HTMLElement
    cancelBtn: HTMLButtonElement | null
    submitBtn: HTMLButtonElement | null
  } | null {
    const parent = this.findContainer()
    if (!parent) return null
    const children = Array.from(parent.children)
    const editorEl = children.find(
      (child): child is HTMLElement =>
        child !== this.hostEl &&
        !child.contains?.(this.hostEl) &&
        child.tagName === 'DIV' &&
        typeof child.className === 'string' &&
        child.className.includes('editor'),
    )
    if (!editorEl) return null
    const actionsEl =
      Array.from(editorEl.querySelectorAll('div')).find(
        (div) => typeof div.className === 'string' && div.className.includes('editorActions'),
      ) ?? editorEl
    const buttons = Array.from(actionsEl.querySelectorAll('button'))
    return {
      editorEl,
      actionsEl,
      cancelBtn: buttons[0] ?? null,
      submitBtn: buttons[1] ?? null,
    }
  }

  /** Move `.gcx-body` inside DSH's `.editor` container right before `.editorActions`. */
  private placeBodyInNativeEditor(
    found: { editorEl: HTMLElement; actionsEl: HTMLElement } | null,
  ): void {
    if (found === null || this.bodyEl === null) return
    if (this.bodyEl.parentElement === found.editorEl) return
    try {
      if (
        found.actionsEl !== found.editorEl &&
        found.actionsEl.parentElement === found.editorEl &&
        typeof found.editorEl.insertBefore === 'function'
      ) {
        found.editorEl.insertBefore(this.bodyEl, found.actionsEl)
      } else if (typeof found.editorEl.appendChild === 'function') {
        found.editorEl.appendChild(this.bodyEl)
      }
    } catch {
      // Ignore in non-DOM test environments
    }
  }

  /** Return `.gcx-body` to `.gcx-card` before React unmounts it. */
  private restoreBodyToHost(): void {
    if (this.bodyEl !== null && this.hostEl !== null && this.bodyEl.parentElement !== this.hostEl) {
      try {
        if (typeof this.hostEl.appendChild === 'function') {
          this.hostEl.appendChild(this.bodyEl)
        }
      } catch {
        this.bodyEl.remove?.()
      }
    }
  }

  /** Bind to the form body element so it can be placed inside DSH's `.editor` container. */
  bindBodyDom(element: HTMLElement | null): void {
    if (this.bodyEl === element) return
    if (element === null) {
      this.restoreBodyToHost()
      this.bodyEl = null
      return
    }
    this.bodyEl = element
    this.placeBodyInNativeEditor(this.findNativeEditor())
  }

  /** Bind to the mounted card element and observe its parent for DSH's native ProviderEditor. */
  bindDom(element: HTMLElement | null): void {
    if (this.hostEl === element) return
    this.teardownDom()
    this.hostEl = element
    if (element === null || typeof MutationObserver === 'undefined') return
    const container = this.findContainer()
    if (!container) return
    this.parentObserver = new MutationObserver(() => {
      this.syncNativeEditorPresence()
    })
    this.parentObserver.observe(container, { childList: true })
    this.syncNativeEditorPresence()
  }

  private teardownDom(): void {
    this.restoreBodyToHost()
    this.parentObserver?.disconnect()
    this.parentObserver = null
    this.buttonObserver?.disconnect()
    this.buttonObserver = null
    this.detachButtons?.()
    this.detachButtons = null
    this.hostEl = null
  }

  private syncNativeEditorPresence(): void {
    const found = this.findNativeEditor()
    const isOpen = found !== null
    this.buttonObserver?.disconnect()
    this.buttonObserver = null
    this.detachButtons?.()
    this.detachButtons = null

    if (found !== null) {
      this.placeBodyInNativeEditor(found)
      const { cancelBtn, submitBtn } = found
      const onCancelClick = (): void => {
        if (this.closingAfterSave) return
        this.reset()
      }
      const onSubmitClick = (event: MouseEvent): void => {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!this.canSave()) return
        void this.saveFromNativeButton()
      }
      cancelBtn?.addEventListener('click', onCancelClick)
      submitBtn?.addEventListener('click', onSubmitClick)
      this.detachButtons = () => {
        cancelBtn?.removeEventListener('click', onCancelClick)
        submitBtn?.removeEventListener('click', onSubmitClick)
      }
      if (submitBtn !== null && typeof MutationObserver !== 'undefined') {
        this.buttonObserver = new MutationObserver(() => {
          this.syncNativeEditorButtons()
        })
        this.buttonObserver.observe(submitBtn, { attributes: true, attributeFilter: ['disabled'] })
      }
      this.syncNativeEditorButtons()
    } else {
      this.restoreBodyToHost()
      if (this.nativeEditorOpen && !this.saving && !this.closingAfterSave) {
        // The user collapsed the row editor via the row's Edit toggle; discard unsaved edits.
        this.touched = false
        this.keyDraft = ''
        this.failure = null
        this.notice = null
        this.draft = this.draftOf(this.saved)
      }
    }

    if (this.nativeEditorOpen !== isOpen) {
      this.nativeEditorOpen = isOpen
      this.publish()
    }
  }

  private syncNativeEditorButtons(): void {
    const found = this.findNativeEditor()
    if (found === null) return
    const { cancelBtn, submitBtn } = found
    const targetDisabled = !this.canSave()
    if (submitBtn !== null && submitBtn.disabled !== targetDisabled) {
      submitBtn.disabled = targetDisabled
    }
    if (cancelBtn !== null && cancelBtn.disabled !== this.saving) {
      cancelBtn.disabled = this.saving
    }
  }

  private async saveFromNativeButton(): Promise<void> {
    const before = this.findNativeEditor()
    const submitBtn = before?.submitBtn ?? null
    const idleLabel = submitBtn?.textContent ?? null
    if (submitBtn !== null) submitBtn.textContent = labelsOf(this.t).saving
    const ok = await this.save()
    if (submitBtn !== null && idleLabel !== null) submitBtn.textContent = idleLabel
    if (ok) {
      const after = this.findNativeEditor()
      const cancelBtn = after?.cancelBtn ?? before?.cancelBtn ?? null
      if (cancelBtn !== null) {
        this.closingAfterSave = true
        try {
          cancelBtn.click()
        } finally {
          this.closingAfterSave = false
        }
      }
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
  async save(): Promise<boolean> {
    if (this.saving || !this.scope.getSnapshot().writable) return false
    const saved = this.saved
    const draft = this.draft
    const models = parseModels(draft.modelsText)
    if (draft.projectId.trim() === '' || models === undefined) {
      this.publish()
      return false
    }
    const operations: SettingsPathOpView[] = []
    const basePath = ['providers', saved.provider]
    if (!saved.configured) {
      const profile: ProfileSection = {
        projectId: draft.projectId.trim(),
        location: draft.location.trim() || 'global',
        ...(draft.baseURL.trim() === '' ? {} : { baseURL: draft.baseURL.trim() }),
        ...(draft.proxy.trim() === '' ? {} : { proxy: draft.proxy.trim() }),
        apiKeyEnv: saved.apiKeyEnv,
        models,
      }
      operations.push(setOp(basePath, profile))
      // Clean up legacy root-level fields if present in the stored section so
      // deleting the provider later leaves a clean namespace.
      const rawSection = this.scope.getSnapshot().value
      for (const legacyKey of ['projectId', 'location', 'baseURL', 'proxy', 'models', 'apiKeyEnv'] as const) {
        if (rawSection !== undefined && legacyKey in rawSection) {
          operations.push({ op: 'unset', path: [legacyKey] })
        }
      }
    } else {
      if (draft.projectId.trim() !== saved.projectId) {
        operations.push(setOp([...basePath, 'projectId'], draft.projectId.trim()))
      }
      if (draft.location.trim() !== saved.location) {
        operations.push(
          draft.location.trim() === ''
            ? { op: 'unset', path: [...basePath, 'location'] }
            : setOp([...basePath, 'location'], draft.location.trim()),
        )
      }
      if (draft.baseURL.trim() !== saved.baseURL) {
        operations.push(
          draft.baseURL.trim() === ''
            ? { op: 'unset', path: [...basePath, 'baseURL'] }
            : setOp([...basePath, 'baseURL'], draft.baseURL.trim()),
        )
      }
      if (draft.proxy.trim() !== saved.proxy) {
        operations.push(
          draft.proxy.trim() === ''
            ? { op: 'unset', path: [...basePath, 'proxy'] }
            : setOp([...basePath, 'proxy'], draft.proxy.trim()),
        )
      }
      if (JSON.stringify(models) !== JSON.stringify(saved.models)) {
        operations.push(setOp([...basePath, 'models'], models))
      }
    }

    const key = this.keyDraft.trim()
    this.saving = true
    this.failure = null
    this.notice = null
    this.publish()
    let succeeded = false
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
        succeeded = true
      }
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error)
    } finally {
      this.saving = false
      this.saved = savedOf(this.scope.getSnapshot().value)
      if (succeeded) this.draft = this.draftOf(this.saved)
      await this.readCredential()
      this.publish()
    }
    return succeeded
  }

  /** The business face the slot registration injects into the card component. */
  inject(): CardFace & { hooks: { card: CardStore } } {
    return {
      hooks: { card: this.store },
      useCard: (selector) => selector(this.store.getSnapshot()),
      bindDom: this.boundBindDom,
      bindBodyDom: this.boundBindBodyDom,
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
    this.teardownDom()
    for (const off of this.offs) off()
    this.offs.length = 0
  }
}
