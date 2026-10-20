// test/client-module.test.js — Load client.js in a stubbed ModuleLoader sandbox
// (no DOM/React test bench in this repo): the factory must evaluate cleanly with
// stub react modules, declare its slot-only inject, and keep the zh/en string
// tables key-aligned (a missing copy key would render as a raw key in the UI).
import assert from 'node:assert/strict'
import test from 'node:test'

function loadClientModule(cacheKey) {
  let loaded
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        assert.equal(entry.id, 'dsh-searchops')
        loaded = entry.factory((id) => {
          if (id === 'react') return {}
          if (id === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}) }
          throw new Error(`unexpected client require: ${id}`)
        })
      },
    },
  }
  // 每个用例独立缓存槽：ESM 默认按 URL 缓存，重复 import 不会再执行模块体。
  return import(`../client.js?test=${cacheKey}`)
    .then(() => {
      if (!loaded) throw new Error('client.js did not call window.__ModuleLoader__.load')
      return loaded
    })
    .finally(() => {
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
    })
}

test('client module loads via ModuleLoader, injects only slots and exports apply', async () => {
  const mod = await loadClientModule('module')
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(Object.isFrozen(mod.internals), true)
})

test('client zh/en string tables are key-aligned', async () => {
  const mod = await loadClientModule('strings')
  const { STRINGS } = mod.internals
  const zhKeys = Object.keys(STRINGS.zh).sort()
  const enKeys = Object.keys(STRINGS.en).sort()
  assert.deepEqual(zhKeys, enKeys)
})

// ── settings form pure functions ────────────────────────────────────────────
// Ref derivation must match the host's lib/util.js byte-for-byte, otherwise
// credentials written from the form would never be resolved by the runtime.
test('credential ref derivation matches the host-side format', async () => {
  const mod = await loadClientModule('refs')
  const { usernameRefForId, passwordRefForId, tokenRefForId, refSuffix } = mod.internals
  assert.equal(refSuffix('dcf5b148-9796-4569-821f-c01dcc59c287'), 'dcf5b14897964569821fc01dcc59c287')
  assert.equal(usernameRefForId('prod'), 'SEARCHOPS_USERNAME_prod')
  assert.equal(passwordRefForId('prod'), 'SEARCHOPS_PASSWORD_prod')
  assert.equal(tokenRefForId('my-cluster_1'), 'SEARCHOPS_TOKEN_mycluster_1') // hyphen stripped, underscore kept
  assert.equal(tokenRefForId('x'.repeat(200)).length, 'SEARCHOPS_TOKEN_'.length + 64)
})

test('validateFormSources enforces the same rules the host validates', async () => {
  const mod = await loadClientModule('validate')
  const { validateFormSources, STRINGS } = mod.internals
  const m = STRINGS.en
  const base = { name: 'prod', url: 'https://search.example.com:9200' }
  validateFormSources([base], m) // ok
  assert.throws(() => validateFormSources([{ name: '', url: 'https://x' }], m), /name/)
  assert.throws(() => validateFormSources([{ name: 'a', url: '' }], m), /URL/)
  assert.throws(() => validateFormSources([base, { ...base, name: 'PROD' }], m), /unique/i)
  assert.throws(() => validateFormSources([{ name: 'a', url: 'https://u:p@x.example.com' }], m), /HTTP/)
  assert.throws(() => validateFormSources([{ name: 'a', url: 'https://x.example.com?q=1' }], m), /HTTP/)
  assert.throws(() => validateFormSources([{ name: 'a', url: 'ftp://x.example.com' }], m), /HTTP/)
  assert.throws(() => validateFormSources(Array.from({ length: 51 }, (_, i) => ({ name: `s${i}`, url: 'https://x.example.com' })), m), /50/)
})

// Host-side effectiveSources synthesizes ids from names for hand-written
// configs; the form must do the same or no-id rows get dropped as unconfirmed.
test('normalizeStoredSource synthesizes name-derived ids like the host', async () => {
  const mod = await loadClientModule('ids')
  const { normalizeStoredSource, stableIdFromName } = mod.internals
  assert.equal(stableIdFromName('My Prod Cluster!'), 'my-prod-cluster')
  assert.equal(stableIdFromName(''), 'default')
  const noId = normalizeStoredSource({ name: 'local', url: 'http://localhost:9200', auth: 'none' })
  assert.equal(noId.id, 'local')
  assert.equal(noId.passwordRef, 'SEARCHOPS_PASSWORD_local')
  const withId = normalizeStoredSource({ id: 'dcf5b148-9796', name: 'x', auth: 'basic' })
  assert.equal(withId.id, 'dcf5b148-9796')
  assert.equal(withId.passwordRef, 'SEARCHOPS_PASSWORD_dcf5b1489796')
  assert.equal(normalizeStoredSource({ url: 'https://x' }), null) // no name → no id → dropped
})

test('buildCredentialWrites routes secrets to derived or stored refs and never into config rows', async () => {
  const mod = await loadClientModule('writes')
  const { buildCredentialWrites, configRowOf, normalizeStoredSource } = mod.internals
  const stored = new Map([
    ['b1', normalizeStoredSource({ id: 'b1', name: 'basic-src', url: 'https://x.example.com', auth: 'basic', passwordRef: 'SEARCHOPS_PASSWORD_SHARED' })],
  ])
  const drafts = [
    { id: 'b1', name: 'basic-src', auth: 'basic', secretDraft: '  hunter2  ' },
    { id: 't1', name: 'tok-src', auth: 'bearer', secretDraft: 'tok-123' },
    { id: 'n1', name: 'open', auth: 'none', secretDraft: '' },
    { id: 'b2', name: 'keep', auth: 'basic', secretDraft: '' },
  ]
  const writes = buildCredentialWrites(drafts, stored)
  assert.deepEqual(writes, [
    { ref: 'SEARCHOPS_PASSWORD_SHARED', value: 'hunter2' }, // explicit stored ref wins, value trimmed
    { ref: 'SEARCHOPS_TOKEN_t1', value: 'tok-123' }, // derived ref when none stored
  ])
  const row = configRowOf(drafts[0])
  assert.deepEqual(Object.keys(row).sort(), ['auth', 'id', 'name', 'profile', 'url', 'username'])
  assert.ok(!JSON.stringify(row).includes('hunter2'), 'secret values never enter config rows')
})
