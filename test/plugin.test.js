import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../index.js'
import { createPluginContext, twoSourceConfig } from './support.mjs'

const TOOL_NAMES = [
  'searchops_sources',
  'searchops_status',
  'searchops_indices',
  'searchops_mapping',
  'searchops_query',
  'searchops_logs',
  'searchops_aggregate',
  'searchops_context',
  'searchops_investigate',
]

const INTERNAL_KEYS = [
  'validateConfig', 'effectiveSources', 'resolveSource', 'resolveSourceProfile', 'resolveFieldProfile',
  'parseTimeRange', 'normalizeMessage', 'fingerprint', 'groupPatterns', 'buildSearchBody', 'clampSize',
  'clampFrom', 'runLogs', 'runAggregate', 'runContext', 'runInvestigate', 'renderInvestigation',
  'createProvider', 'createRuntime', 'normalizeBaseUrl', 'validateIndexPattern', 'redactSecrets',
  'translateHttpFailure', 'translateNetworkFailure', 'formatTotal', 'formatLogLine',
]

// ── host-facing metadata ────────────────────────────────────────────────────
test('the plugin exports the metadata the harness consumes', () => {
  assert.equal(plugin.name, 'searchops')
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt', 'credentials'])
  assert.equal(plugin.SETTINGS_NAMESPACE, 'searchops')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
})

// ── apply(): registration + system prompt ───────────────────────────────────
test('apply registers exactly the nine searchops_* tools in a stable order', () => {
  const { ctx, tools } = createPluginContext({ config: twoSourceConfig() })
  plugin.apply(ctx, twoSourceConfig())
  assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES)
})

test('apply registers a single read-only guidance section for the system prompt', () => {
  const { ctx, sections } = createPluginContext({ config: twoSourceConfig() })
  plugin.apply(ctx, twoSourceConfig())
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:searchops')
  assert.equal(typeof sections[0].order, 'number')
  assert.match(sections[0].text, /READ-ONLY/)
  assert.match(sections[0].text, /UNTRUSTED DATA/)
  assert.match(sections[0].text, /searchops_investigate/)
})

test('no tool is a raw HTTP escape hatch and all share the searchops_ prefix', () => {
  const { ctx, tools } = createPluginContext({ config: twoSourceConfig() })
  plugin.apply(ctx, twoSourceConfig())
  assert.ok(!tools.some((t) => /http|request|curl|raw/i.test(t.name)), 'no generic HTTP tool')
  for (const t of tools) assert.ok(t.name.startsWith('searchops_'), `${t.name} must be namespaced`)
})

// ── apply() validates config before wiring anything ─────────────────────────
test('apply rejects a config with a literal secret and registers nothing', () => {
  const { ctx, tools, sections } = createPluginContext({})
  assert.throws(() => plugin.apply(ctx, { sources: [{ name: 'prod', password: 'hunter2' }] }), /literal "password"/)
  assert.equal(tools.length, 0)
  assert.equal(sections.length, 0)
})

test('apply rejects an unsupported provider', () => {
  const { ctx } = createPluginContext({})
  assert.throws(() => plugin.apply(ctx, { sources: [{ name: 'x', provider: 'solr' }] }), /Unsupported provider/)
})

// ── Config schema: secure defaults ──────────────────────────────────────────
test('the Config schema defaults to no sources and insecure HTTP off', () => {
  const resolved = plugin.Config({})
  assert.deepEqual(resolved.sources, [])
  assert.deepEqual(resolved.profiles, [])
  assert.equal(resolved.allowInsecureHttp, false) // secure by default
})

test('the Config schema preserves valid operator input', () => {
  const resolved = plugin.Config({ sources: [{ name: 'prod', url: 'https://search.example.com', auth: 'bearer' }], defaultSource: 'prod' })
  assert.equal(resolved.sources[0].name, 'prod')
  assert.equal(resolved.defaultSource, 'prod')
})

// ── internals: a frozen surface for host introspection/tests ────────────────
test('internals is frozen and exposes every security-critical primitive', () => {
  assert.equal(Object.isFrozen(plugin.internals), true)
  assert.deepEqual(Object.keys(plugin.internals).sort(), [...INTERNAL_KEYS].sort())
  for (const key of INTERNAL_KEYS) {
    assert.equal(typeof plugin.internals[key], 'function', `internals.${key} must be a function`)
  }
})
