// @ts-nocheck
/**
 * Offline client-half test: the built browser bundle registers exactly one
 * Models-page provider card, renders collapsed with a summary, expands to the
 * field set, saves through the shared settings form, and writes the API key
 * through the credentials remote instead of the settings document.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'vitest'

test('client smoke test', async () => {

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let definition
const windowStub = { __ModuleLoader__: { load(value) { definition = value } } }
new Function('window', source)(windowStub)
assert.equal(definition.id, 'dsh-google-cloud-llm')

const pluginRequire = createRequire(import.meta.url)
const moduleExports = definition.factory((request) => pluginRequire(request))
assert.deepEqual(
  moduleExports.inject.slice().sort(),
  ['configForms', 'locale', 'remote', 'remote.credentials', 'slots'].sort(),
)

// --- fake Host faces -------------------------------------------------------
const listeners = new Set()
const writes = []
const credentialWrites = []
let snapshot = {
  status: 'ready',
  value: {
    provider: 'google-cloud',
    projectId: '',
    location: 'global',
    apiKeyEnv: 'GOOGLE_CLOUD_API_KEY',
    models: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon', contextWindow: 1048576, maxTokens: 65536 }],
  },
  revision: 7,
  writable: true,
}
const scope = {
  getSnapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  async mutate(operations) {
    writes.push(operations)
    const value = structuredClone(snapshot.value)
    for (const operation of operations) {
      const path = operation.path
      if (path.length === 1) {
        if (operation.op === 'set') value[path[0]] = operation.value
        else delete value[path[0]]
      } else if (path.length === 2) {
        value[path[0]] = { ...(value[path[0]] ?? {}) }
        if (operation.op === 'set') value[path[0]][path[1]] = operation.value
        else delete value[path[0]][path[1]]
      } else if (path.length === 3) {
        value[path[0]] = { ...(value[path[0]] ?? {}) }
        value[path[0]][path[1]] = { ...(value[path[0]][path[1]] ?? {}) }
        if (operation.op === 'set') value[path[0]][path[1]][path[2]] = operation.value
        else delete value[path[0]][path[1]][path[2]]
      }
    }
    snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
    for (const listener of [...listeners]) listener()
    return true
  },
  async set(field, next) {
    return this.mutate([{ op: 'set', path: [field], value: next }])
  },
  async unset(field) {
    return this.mutate([{ op: 'unset', path: [field] }])
  },
}

const effects = []
const registrations = []
const injectedOwners = []
const ctx = {
  effect(fn, label) {
    const off = fn()
    effects.push({ label, off })
    return off
  },
  locale: {
    register(namespace) {
      return () => {}
    },
    bind() {
      return (key) => key
    },
    subscribe() {
      return () => {}
    },
  },
  slots: {
    inject(owner, callback) {
      injectedOwners.push(owner)
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  remote: {
    $on() {
      return () => {}
    },
    credentials: {
      async describe(refs) {
        return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: true, writable: true }])) }
      },
      async set(ref, value) {
        credentialWrites.push([ref, value])
      },
    },
  },
  configForms: {
    get(namespace) {
      assert.equal(namespace, 'llm-google-cloud')
      return scope
    },
  },
}

moduleExports.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 5))

// --- registration ----------------------------------------------------------
assert.deepEqual(injectedOwners, ['settings.models.provider-card'])
assert.equal(registrations.length, 1)
const card = registrations[0]
assert.equal(card.options.name, 'settings.models.provider-card')
assert.equal(card.options.key, 'llm-google-cloud')
assert.ok(effects.length >= 2)
const component = card.component
const face = card.options.inject()
const props = { ...face, useCard: (selector) => selector(face.hooks.card.getSnapshot()) }

// --- walk the returned React tree -----------------------------------------
const walk = (node, visit) => {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}
const field = (tree, id) => {
  let found
  walk(tree, (node) => {
    if (node.props?.id === id) found = node
  })
  return found
}
const button = (tree, kind) => {
  let found
  walk(tree, (node) => {
    if (node.type === 'button' && node.props?.['data-kind'] === kind && found === undefined) found = node
  })
  return found
}
const text = (node) => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(text).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return text(node.props?.children)
}

// --- collapsed posture -----------------------------------------------------
let tree = component(props)
assert.equal(tree.type, 'div')
assert.equal(field(tree, 'gcx-project'), undefined, 'the form starts collapsed')
const summary = text(tree)
assert.match(summary, /projectId: unconfigured/)
assert.equal(button(tree, 'quiet').props.onClick !== undefined, true)

// --- expand ----------------------------------------------------------------
button(tree, 'quiet').props.onClick()
tree = component(props)
assert.equal(field(tree, 'gcx-project').props['data-invalid'], true)
assert.equal(field(tree, 'gcx-key').props.type, 'password')
assert.equal(field(tree, 'gcx-proxy').props.value, '')
assert.equal(field(tree, 'gcx-models').type, 'textarea')
assert.equal(button(tree, 'primary').props.disabled, true, 'an invalid draft cannot be saved')

// --- save the project id (creates providers.google-cloud profile) ----------
field(tree, 'gcx-project').props.onChange({ target: { value: 'demo-project' } })
tree = component(props)
assert.equal(field(tree, 'gcx-project').props['data-invalid'], false)
assert.equal(button(tree, 'primary').props.disabled, false)
button(tree, 'primary').props.onClick()
await new Promise((resolve) => setTimeout(resolve, 5))
const profileCreate = writes.at(-1).find((op) => op.op === 'set' && op.path[0] === 'providers' && op.path[1] === 'google-cloud')
assert.ok(profileCreate, 'creates providers.google-cloud profile')
assert.equal(profileCreate.value.projectId, 'demo-project')
tree = component(props)
assert.equal(field(tree, 'gcx-project').props.value, 'demo-project')
assert.match(text(tree), /saved/)

// --- the key goes through the credentials remote --------------------------
field(tree, 'gcx-key').props.onChange({ target: { value: 'AIza-xyz' } })
tree = component(props)
const before = writes.length
button(tree, 'primary').props.onClick()
await new Promise((resolve) => setTimeout(resolve, 5))
assert.equal(writes.length, before, 'a key-only save writes no settings')
assert.deepEqual(credentialWrites.at(-1), ['GOOGLE_CLOUD_API_KEY', 'AIza-xyz'])

// --- proxy is persisted with the settings ---------------------------------
tree = component(props)
field(tree, 'gcx-proxy').props.onChange({ target: { value: 'socks5://127.0.0.1:1080' } })
tree = component(props)
button(tree, 'primary').props.onClick()
await new Promise((resolve) => setTimeout(resolve, 5))
const proxyWrite = writes.at(-1).find((operation) => operation.path.at(-1) === 'proxy')
assert.deepEqual(proxyWrite, { op: 'set', path: ['providers', 'google-cloud', 'proxy'], value: 'socks5://127.0.0.1:1080' })
tree = component(props)
assert.equal(field(tree, 'gcx-proxy').props.value, 'socks5://127.0.0.1:1080')

// --- baseURL is persisted with the settings -------------------------------
tree = component(props)
assert.equal(field(tree, 'gcx-baseurl').props.value, '')
field(tree, 'gcx-baseurl').props.onChange({ target: { value: 'https://my-custom-proxy.internal' } })
tree = component(props)
button(tree, 'primary').props.onClick()
await new Promise((resolve) => setTimeout(resolve, 5))
const baseurlWrite = writes.at(-1).find((operation) => operation.path.at(-1) === 'baseURL')
assert.deepEqual(baseurlWrite, { op: 'set', path: ['providers', 'google-cloud', 'baseURL'], value: 'https://my-custom-proxy.internal' })
tree = component(props)
assert.equal(field(tree, 'gcx-baseurl').props.value, 'https://my-custom-proxy.internal')

// --- add posture (configured: false) opens immediately without extra buttons
const addTree = component({ ...props, configured: false })
assert.notEqual(field(addTree, 'gcx-project'), undefined, 'add posture opens immediately')
assert.equal(button(addTree, 'primary'), undefined, 'uses native DSH save button in add posture')
assert.equal(button(addTree, 'quiet'), undefined, 'no extra expand button in add posture')

// --- invalid catalog lines block the save --------------------------------
field(tree, 'gcx-models').props.onChange({ target: { value: 'bad id | x' } })
tree = component(props)
assert.equal(field(tree, 'gcx-models').props['data-invalid'], true)
assert.equal(button(tree, 'primary').props.disabled, true)
field(tree, 'gcx-models').props.onChange({
  target: { value: 'gemini-4-argon | Gemini 4 Argon | 1048576 | 65536\ngemini-2.5-flash' },
})
tree = component(props)
assert.equal(button(tree, 'primary').props.disabled, false)

// --- collapse keeps a staged draft visible --------------------------------
field(tree, 'gcx-location').props.onChange({ target: { value: 'us-central1' } })
tree = component(props)
button(tree, 'quiet').props.onClick()
tree = component(props)
assert.notEqual(field(tree, 'gcx-location'), undefined, 'a dirty draft cannot collapse')

// --- reset discards it ----------------------------------------------------
button(tree, 'secondary').props.onClick()
await new Promise((resolve) => setTimeout(resolve, 5))
tree = component(props)
assert.equal(field(tree, 'gcx-location'), undefined, 'a clean form collapses again')
button(tree, 'quiet').props.onClick()
tree = component(props)
assert.equal(field(tree, 'gcx-location').props.value, 'global')

// --- native ProviderEditor button bridge ----------------------------------
let cancelClicked = 0
const cancelListeners = new Set()
const submitListeners = new Set()
const cancelBtn = {
  tagName: 'BUTTON',
  disabled: false,
  textContent: 'Cancel',
  addEventListener(type, fn) { if (type === 'click') cancelListeners.add(fn) },
  removeEventListener(type, fn) { if (type === 'click') cancelListeners.delete(fn) },
  click() {
    cancelClicked += 1
    for (const fn of [...cancelListeners]) fn({ preventDefault() {}, stopImmediatePropagation() {} })
  },
}
const submitBtn = {
  tagName: 'BUTTON',
  disabled: true,
  textContent: 'Apply',
  addEventListener(type, fn) { if (type === 'click') submitListeners.add(fn) },
  removeEventListener(type, fn) { if (type === 'click') submitListeners.delete(fn) },
  click() {
    for (const fn of [...submitListeners]) fn({ preventDefault() {}, stopImmediatePropagation() {} })
  },
}
let insertedBefore = null
const actionsDiv = {
  tagName: 'DIV',
  className: '_editorActions_abc',
  parentElement: null,
  querySelectorAll(sel) { return sel === 'button' ? [cancelBtn, submitBtn] : [] },
}
const editorDiv = {
  tagName: 'DIV',
  className: '_editor_abc',
  insertBefore(node, ref) {
    node.parentElement = editorDiv
    insertedBefore = [node, ref]
  },
  querySelectorAll(sel) {
    if (sel === 'div') return [actionsDiv]
    if (sel === 'button') return [cancelBtn, submitBtn]
    return []
  },
}
actionsDiv.parentElement = editorDiv
const bodyEl = { tagName: 'DIV', className: 'gcx-body', parentElement: null }
const cardEl = {
  tagName: 'DIV',
  className: 'gcx-card',
  parentElement: null,
  appendChild(node) { node.parentElement = cardEl },
}
bodyEl.parentElement = cardEl
const slotAnchor = {
  tagName: 'DIV',
  style: { display: 'contents' },
  getAttribute(name) { return name === 'data-slot' ? 'settings.models.provider-card' : null },
  contains(node) { return node === cardEl },
  parentElement: null,
}
const parentEl = {
  tagName: 'LI',
  getAttribute() { return null },
  children: [slotAnchor, editorDiv],
}
cardEl.parentElement = slotAnchor
slotAnchor.parentElement = parentEl
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
face.bindDom(cardEl)
face.bindBodyDom(bodyEl)
assert.deepEqual(insertedBefore, [bodyEl, actionsDiv], 'moves .gcx-body inside .editor right before .editorActions')
let rowTree = component({ ...props, configured: true })
assert.notEqual(field(rowTree, 'gcx-location'), undefined, 'row posture opens when native ProviderEditor is present')
assert.equal(submitBtn.disabled, true, 'native save button starts disabled when clean')
field(rowTree, 'gcx-location').props.onChange({ target: { value: 'europe-west1' } })
assert.equal(submitBtn.disabled, false, 'native save button enables when dirty and valid')
submitBtn.click()
await new Promise((resolve) => setTimeout(resolve, 10))
const locWrite = writes.at(-1).find((operation) => operation.path.at(-1) === 'location')
assert.deepEqual(locWrite, { op: 'set', path: ['providers', 'google-cloud', 'location'], value: 'europe-west1' })
assert.equal(cancelClicked, 1, 'native save button closes ProviderEditor via cancelBtn after saving')
face.bindBodyDom(null)
assert.equal(bodyEl.parentElement, cardEl, 'restores .gcx-body to .gcx-card before unmount')
face.bindDom(null)

// --- teardown -------------------------------------------------------------
for (const effect of effects) {
  if (typeof effect.off === 'function') effect.off()
}

console.log('client smoke test: OK')
})
