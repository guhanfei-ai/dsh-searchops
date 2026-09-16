import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defaultSourceId,
  effectiveSources,
  normalizeProfiles,
  resolveSource,
  resolveSourceProfile,
  sanitizeUrlForDisplay,
  validateConfig,
} from '../lib/config.js'

// ── normalizeProfiles: object-map, single inline, and array shapes ──────────
test('normalizeProfiles accepts an object-map of named profiles', () => {
  const out = normalizeProfiles({ ecs: { messageField: 'message' }, custom: { timestampField: 'ts' } })
  assert.deepEqual(out.ecs, { messageField: 'message' })
  assert.deepEqual(out.custom, { timestampField: 'ts' })
})

test('normalizeProfiles treats a single inline profile object as the default', () => {
  const out = normalizeProfiles({ messageField: 'msg', timestampField: 'ts' })
  assert.deepEqual(out, { default: { messageField: 'msg', timestampField: 'ts' } })
})

test('normalizeProfiles accepts the array form and keys by name (default when absent)', () => {
  assert.deepEqual(normalizeProfiles([{ name: 'ecs', messageField: 'message' }]), { ecs: { messageField: 'message' } })
  assert.deepEqual(normalizeProfiles([{ messageField: 'message' }]), { default: { messageField: 'message' } })
})

test('normalizeProfiles ignores unknown and non-string field values', () => {
  const out = normalizeProfiles({ ecs: { messageField: 'message', bogusField: 'x', timestampField: 42 } })
  assert.deepEqual(out.ecs, { messageField: 'message' })
})

// ── validateConfig: config parsing + the no-secrets-in-config rule ──────────
test('validateConfig accepts a well-formed config and returns it unchanged', () => {
  const cfg = { sources: [{ name: 'prod', url: 'https://search.example.com', auth: 'basic' }], profiles: [], defaultSource: 'prod' }
  assert.equal(validateConfig(cfg), cfg)
})

test('validateConfig rejects literal secrets so they can never reach Git', () => {
  assert.throws(() => validateConfig({ sources: [{ name: 'prod', password: 'hunter2' }] }), /must not contain a literal "password"/)
  assert.throws(() => validateConfig({ sources: [{ name: 'prod', token: 'abc' }] }), /must not contain a literal "token"/)
  assert.throws(() => validateConfig({ sources: [{ name: 'prod', apiKey: 'abc' }] }), /must not contain a literal/)
})

test('validateConfig rejects an unsupported provider and names the roadmap item', () => {
  assert.throws(() => validateConfig({ sources: [{ name: 'x', provider: 'elasticsearch' }] }), /Unsupported provider.*roadmap, not implemented/s)
  assert.throws(() => validateConfig({ sources: [{ name: 'x', provider: 'solr' }] }), /Unsupported provider/)
})

test('validateConfig rejects an unsupported auth mode', () => {
  assert.throws(() => validateConfig({ sources: [{ name: 'x', auth: 'digest' }] }), /Unsupported auth/)
})

test('validateConfig rejects duplicate source names case-insensitively', () => {
  assert.throws(() => validateConfig({ sources: [{ name: 'prod' }, { name: 'PROD' }] }), /Duplicate search source name/)
})

test('validateConfig rejects a malformed id and credential ref', () => {
  assert.throws(() => validateConfig({ sources: [{ name: 'x', id: 'bad id!' }] }), /system-generated and read-only/)
  assert.throws(() => validateConfig({ sources: [{ name: 'x', passwordRef: 'has space' }] }), /Invalid credential reference/)
})

test('validateConfig enforces the maximum source count', () => {
  const sources = Array.from({ length: 51 }, (_, i) => ({ name: `s${i}` }))
  assert.throws(() => validateConfig({ sources }), /Too many search sources/)
})

test('validateConfig accepts the object-map source shape', () => {
  assert.doesNotThrow(() => validateConfig({ sources: { prod: { url: 'https://x' }, staging: { url: 'https://y' } } }))
})

// ── effectiveSources: canonicalization + credential-ref derivation ──────────
test('effectiveSources fills defaults and derives credential refs from the id', () => {
  const list = effectiveSources({ sources: [{ name: 'prod', url: 'https://search.example.com' }] })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'prod')
  assert.equal(list[0].provider, 'opensearch')
  assert.equal(list[0].auth, 'basic')
  assert.equal(list[0].usernameRef, 'SEARCHOPS_USERNAME_prod')
  assert.equal(list[0].passwordRef, 'SEARCHOPS_PASSWORD_prod')
  assert.equal(list[0].tokenRef, 'SEARCHOPS_TOKEN_prod')
})

test('effectiveSources slugifies a name into a stable id and ref-safe suffix', () => {
  const list = effectiveSources({ sources: [{ name: 'My Prod' }] })
  assert.equal(list[0].id, 'my-prod')
  assert.equal(list[0].passwordRef, 'SEARCHOPS_PASSWORD_myprod')
})

test('effectiveSources keeps an explicit credential ref over the derived one', () => {
  const list = effectiveSources({ sources: [{ name: 'prod', passwordRef: 'SHARED_PASSWORD' }] })
  assert.equal(list[0].passwordRef, 'SHARED_PASSWORD')
})

test('effectiveSources reads the object-map form and accepts baseUrl as an alias', () => {
  const list = effectiveSources({ sources: { prod: { baseUrl: 'https://x' }, staging: { url: 'https://y' } } })
  assert.equal(list.length, 2)
  assert.equal(list[0].url, 'https://x')
  assert.equal(list[1].url, 'https://y')
})

// ── defaultSourceId / resolveSource: source selection ───────────────────────
test('defaultSourceId honors an explicit default by name, else single-source auto-default', () => {
  const cfg = { sources: [{ name: 'prod' }, { name: 'staging' }], defaultSource: 'staging' }
  assert.equal(defaultSourceId(cfg, effectiveSources(cfg)), 'staging')
  const single = { sources: [{ name: 'prod' }] }
  assert.equal(defaultSourceId(single, effectiveSources(single)), 'prod')
  const multi = { sources: [{ name: 'a' }, { name: 'b' }] }
  assert.equal(defaultSourceId(multi, effectiveSources(multi)), null)
})

test('resolveSource selects by exact name, case-insensitive name, or id', () => {
  const cfg = { sources: [{ name: 'prod' }, { name: 'staging' }], defaultSource: 'prod' }
  assert.equal(resolveSource(cfg, 'staging').name, 'staging')
  assert.equal(resolveSource(cfg, 'STAGING').name, 'staging')
  assert.equal(resolveSource(cfg, 'prod').id, 'prod')
})

test('resolveSource falls back to the default when no argument is given', () => {
  const cfg = { sources: [{ name: 'prod' }, { name: 'staging' }], defaultSource: 'prod' }
  assert.equal(resolveSource(cfg).name, 'prod')
})

test('resolveSource throws a secret-free, helpful error for an unknown source', () => {
  const cfg = { sources: [{ name: 'prod' }, { name: 'staging' }] }
  assert.throws(() => resolveSource(cfg, 'nope'), /Unknown search source "nope".*"prod", "staging"/)
})

test('resolveSource distinguishes "none configured" from "ambiguous"', () => {
  assert.throws(() => resolveSource({ sources: [] }, ''), /No search sources are configured/)
  assert.throws(() => resolveSource({ sources: [{ name: 'a' }, { name: 'b' }] }, ''), /Multiple search sources are configured/)
})

// ── resolveSourceProfile / sanitizeUrlForDisplay ────────────────────────────
test('resolveSourceProfile binds the profile named by the source', () => {
  const cfg = { profiles: { ecs: { messageField: 'message', timestampField: '@timestamp' } }, sources: [{ name: 'prod', profile: 'ecs' }] }
  const profile = resolveSourceProfile(cfg, resolveSource(cfg, 'prod'))
  assert.equal(profile.messageField, 'message')
  assert.equal(profile.timestampField, '@timestamp')
})

test('resolveSourceProfile returns an empty profile when none is bound', () => {
  const cfg = { sources: [{ name: 'prod' }] }
  assert.deepEqual(resolveSourceProfile(cfg, resolveSource(cfg, 'prod')), {})
})

test('sanitizeUrlForDisplay drops userinfo and handles empty/invalid input', () => {
  assert.equal(sanitizeUrlForDisplay('https://user:pass@search.example.com/path'), 'https://search.example.com/path')
  assert.equal(sanitizeUrlForDisplay('https://search.example.com:9200/'), 'https://search.example.com:9200')
  assert.equal(sanitizeUrlForDisplay(''), '(not set)')
})
