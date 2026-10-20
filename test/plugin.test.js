import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../index.js'
import { createPluginContext, execution, toolByName, twoSourceConfig } from './support.mjs'

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
  'validateConfig', 'unwrapVolatile', 'effectiveSources', 'resolveSource', 'resolveSourceProfile', 'resolveFieldProfile',
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

// ── settings integration: both host generations ─────────────────────────────
// 0.1.7 removed settings.register/scope (see the _tacp notes); a 0.2.0 host
// skips plugins whose callback throws there, so apply() must branch on the
// method's presence instead of assuming it.
test('pre-0.1.7 host (settings.register present) registers the searchops namespace', async () => {
  const registered = {}
  const settings = {
    register(ns, schema, opts) {
      registered.ns = ns
      registered.schema = schema
      registered.opts = opts
      let value = structuredClone(opts.base)
      return {
        get: () => value,
        set(next) { value = next },
      }
    },
  }
  const { ctx, tools } = createPluginContext({ settings })
  const config = twoSourceConfig()
  plugin.apply(ctx, config)
  assert.equal(registered.ns, 'searchops')
  assert.equal(typeof registered.schema, 'function')
  assert.equal(registered.opts.validate, plugin.internals.validateConfig)
  assert.deepEqual(registered.opts.base, { profiles: [], allowInsecureHttp: false, ...config })
  assert.equal(tools.length, 9)
  // the scope's live value (not the entry snapshot) feeds the runtime
  const tool = toolByName(tools, 'searchops_sources')
  const before = await tool.execute({}, execution())
  assert.match(before, /name="prod"/)
})

test('0.1.7+ host (register removed) works via describe() instead of throwing', async () => {
  const liveValue = {
    sources: [{ id: 'l1', name: 'live', provider: 'opensearch', auth: 'none', url: 'http://127.0.0.1:9200' }],
    profiles: [],
    defaultSource: 'live',
    allowInsecureHttp: true,
  }
  const settings = {
    describe: () => [{ ns: 'searchops', value: liveValue }],
  }
  const { ctx, tools } = createPluginContext({ settings })
  plugin.apply(ctx, twoSourceConfig()) // entry config differs from the live value
  assert.equal(tools.length, 9)
  const tool = toolByName(tools, 'searchops_sources')
  const out = await tool.execute({}, execution())
  assert.match(out, /name="live"/)
  assert.doesNotMatch(out, /name="prod"/)
})

test('0.1.7+ host falls back to the entry config when the namespace is not in describe()', async () => {
  const settings = { describe: () => [] }
  const { ctx, tools } = createPluginContext({ settings })
  const config = twoSourceConfig()
  plugin.apply(ctx, config)
  const tool = toolByName(tools, 'searchops_sources')
  const out = await tool.execute({}, execution())
  assert.match(out, /name="prod"/)
})

// ── Config schema: secure defaults ──────────────────────────────────────────
test('the Config schema defaults to no sources and insecure HTTP off', () => {
  const { unwrapVolatile } = plugin.internals
  const resolved = unwrapVolatile(plugin.Config({}))
  assert.deepEqual(resolved.sources, [])
  assert.deepEqual(resolved.profiles, [])
  assert.equal(resolved.allowInsecureHttp, false) // secure by default
})

// 0.1.7+ hosts wrap .volatile() fields in Volatile refs; apply() must unwrap
// them before validation so every consumer sees plain values.
test('unwrapVolatile strips Volatile refs recursively and passes plain values through', () => {
  const { unwrapVolatile } = plugin.internals
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
  const volatileRef = (value) => ({ [VOLATILE_WRITE]: () => {}, get: () => value })
  const wrapped = {
    sources: volatileRef([{ id: 's1', name: 'prod', url: 'https://x.example.com' }]),
    defaultSource: volatileRef('prod'),
    allowInsecureHttp: volatileRef(false),
    profiles: [],
  }
  const unwrapped = unwrapVolatile(wrapped)
  assert.deepEqual(unwrapped.sources, [{ id: 's1', name: 'prod', url: 'https://x.example.com' }])
  assert.equal(unwrapped.defaultSource, 'prod')
  assert.equal(unwrapped.allowInsecureHttp, false)
  const plain = { sources: [], profiles: [], defaultSource: '', allowInsecureHttp: false }
  assert.deepEqual(unwrapVolatile(plain), plain)
  // apply() accepts a volatile-wrapped config the same as a plain one
  const { ctx, tools } = createPluginContext({})
  plugin.apply(ctx, wrapped)
  assert.equal(tools.length, 9)
})

test('the Config schema preserves valid operator input', () => {
  // volatile 字段解析后是 Volatile 引用；消费方（apply）一律先 unwrap。
  const { unwrapVolatile } = plugin.internals
  const resolved = unwrapVolatile(plugin.Config({ sources: [{ name: 'prod', url: 'https://search.example.com', auth: 'bearer' }], defaultSource: 'prod' }))
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
