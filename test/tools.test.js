import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../index.js'
import { UNTRUSTED_NOTE } from '../lib/constants.js'
import {
  createPluginContext,
  execution,
  installFetch,
  jsonResponse,
  logMappingProperties,
  osCatRow,
  osHealth,
  osMapping,
  osRoot,
  osSearch,
  toolByName,
  twoSourceConfig,
  twoSourceCredentials,
} from './support.mjs'

// Register the real plugin against a mock ctx, then drive tools end-to-end over
// a mocked cluster. This exercises the whole stack: tool → runtime → auth'd http
// → OpenSearch adapter → domain engine → render.
function setup(cfg = twoSourceConfig(), credentials = twoSourceCredentials()) {
  const { ctx, tools } = createPluginContext({ credentials, config: cfg })
  plugin.apply(ctx, cfg)
  return { tools }
}

// A tiny path router standing in for an OpenSearch cluster.
function mockCluster(routes) {
  return installFetch((url, init) => {
    const path = new URL(url).pathname
    for (const [match, body] of routes) {
      if (match.test(path)) return jsonResponse(typeof body === 'function' ? body(init) : body)
    }
    throw new Error(`test: unexpected request ${init.method} ${path}`)
  })
}

const LOG_SOURCE = { '@timestamp': '2024-01-15T10:00:00Z', message: 'checkout timed out', 'log.level': 'error', 'service.name': 'checkout', 'trace.id': 't1' }

// ── searchops_sources: no cluster call, never a secret ──────────────────────
test('searchops_sources lists sources without any credential value', async () => {
  const { tools } = setup()
  const out = await toolByName(tools, 'searchops_sources').execute({}, execution())
  assert.match(out, /name="prod"/)
  assert.match(out, /\(default\)/)
  assert.match(out, /credentials=configured/)
  assert.match(out, /auth=bearer/) // staging
  assert.ok(!out.includes('prod-secret-password'))
  assert.ok(!out.includes('staging-secret-token'))
})

// ── searchops_status: ping + cluster health ─────────────────────────────────
test('searchops_status reports reachability and health', async () => {
  const { tools } = setup()
  const mock = mockCluster([[/^\/$/, osRoot({ clusterName: 'prod-cluster', version: '2.11.0' })], [/_cluster\/health/, osHealth({ status: 'yellow', unassignedShards: 2 })]])
  try {
    const out = await toolByName(tools, 'searchops_status').execute({ source: 'prod' }, execution())
    assert.match(out, /reachable=yes/)
    assert.match(out, /distribution=opensearch/)
    assert.match(out, /health=yellow/)
    assert.match(out, /unassigned=2/)
    assert.match(out, /2 unassigned shard/)
  } finally {
    mock.restore()
  }
})

// ── searchops_indices: paged listing ────────────────────────────────────────
test('searchops_indices lists indices and discloses paging', async () => {
  const { tools } = setup()
  const rows = [osCatRow('logs-1', { docs: '100', bytes: '2048' }), osCatRow('logs-2', { docs: '50' })]
  const mock = mockCluster([[_catIndices(), rows]])
  try {
    const out = await toolByName(tools, 'searchops_indices').execute({ pattern: 'logs-*', limit: 1, page: 1, source: 'prod' }, execution())
    assert.match(out, /"logs-1"/)
    assert.match(out, /docs=100/)
    assert.match(out, /page 1/i)
  } finally {
    mock.restore()
  }
})
function _catIndices() { return /_cat\/indices/ }

// ── searchops_mapping: flattened field list ─────────────────────────────────
test('searchops_mapping renders flattened field paths and types', async () => {
  const { tools } = setup()
  const mock = mockCluster([[/_mapping$/, osMapping('logs', logMappingProperties())]])
  try {
    const out = await toolByName(tools, 'searchops_mapping').execute({ index: 'logs', source: 'prod' }, execution())
    assert.match(out, /@timestamp: date/)
    assert.match(out, /service\.name: keyword/)
    assert.match(out, /trace\.id: keyword/)
  } finally {
    mock.restore()
  }
})

// ── searchops_query: bounded raw DSL ────────────────────────────────────────
test('searchops_query returns matching docs and the untrusted-data notice', async () => {
  const { tools } = setup()
  const mock = mockCluster([[_search(), osSearch({ hits: [{ _id: '1', _index: 'logs', _source: LOG_SOURCE }], total: { value: 1, relation: 'eq' }, took: 4 })]])
  try {
    const out = await toolByName(tools, 'searchops_query').execute({ index: 'logs', source: 'prod' }, execution())
    assert.match(out, /total=1 returned=1/)
    assert.match(out, /checkout timed out/)
    assert.ok(out.includes(UNTRUSTED_NOTE))
  } finally {
    mock.restore()
  }
})

test('searchops_query clamps an over-large size and discloses it', async () => {
  const { tools } = setup()
  let sentSize
  const mock = mockCluster([[_search(), (init) => { sentSize = JSON.parse(init.body).size; return osSearch({ hits: [], total: { value: 0, relation: 'eq' } }) }]])
  try {
    const out = await toolByName(tools, 'searchops_query').execute({ index: 'logs', size: 100000, source: 'prod' }, execution())
    assert.equal(sentSize, 200) // MAX_QUERY_SIZE
    assert.match(out, /size clamped to 200/)
  } finally {
    mock.restore()
  }
})

test('searchops_query rejects deep pagination instead of hitting the cluster', async () => {
  const { tools } = setup()
  const mock = mockCluster([[_search(), osSearch({ hits: [] })]])
  try {
    await assert.rejects(
      () => toolByName(tools, 'searchops_query').execute({ index: 'logs', from: 20000, source: 'prod' }, execution()),
      /exceeds the 10000 offset limit/,
    )
    assert.equal(mock.calls.length, 0)
  } finally {
    mock.restore()
  }
})

test('searchops_query rejects an index pattern with path-injection characters', async () => {
  const { tools } = setup()
  const mock = mockCluster([[_search(), osSearch({ hits: [] })]])
  try {
    await assert.rejects(
      () => toolByName(tools, 'searchops_query').execute({ index: 'logs/_settings?x', source: 'prod' }, execution()),
      /invalid index name or pattern/i,
    )
    assert.equal(mock.calls.length, 0)
  } finally {
    mock.restore()
  }
})

test('searchops_query redacts credentials embedded in _source (no JSON.stringify bypass)', async () => {
  const { tools } = setup()
  const secretSource = {
    '@timestamp': '2024-01-15T10:00:00Z',
    message: 'request ok',
    password: 'hunter2-secret',
    note: 'calling with token=abcdef123456 now',
  }
  const mock = mockCluster([[_search(), osSearch({ hits: [{ _id: '1', _index: 'logs', _source: secretSource }], total: { value: 1, relation: 'eq' } })]])
  try {
    const out = await toolByName(tools, 'searchops_query').execute({ index: 'logs', source: 'prod' }, execution())
    assert.ok(!out.includes('hunter2-secret'), 'a structured password field must be redacted')
    assert.ok(!out.includes('abcdef123456'), 'an inline token must be redacted')
    assert.match(out, /\[redacted\]/)
    assert.match(out, /request ok/) // innocent content is preserved
  } finally {
    mock.restore()
  }
})

// ── searchops_logs: semantic query ──────────────────────────────────────────
test('searchops_logs resolves fields, renders lines and reports the range', async () => {
  const { tools } = setup()
  const mock = mockCluster([[/_mapping$/, osMapping('logs', logMappingProperties())], [_search(), osSearch({ hits: [{ _id: '1', _index: 'logs', _source: LOG_SOURCE }], total: { value: 1, relation: 'eq' }, took: 9 })]])
  try {
    const out = await toolByName(tools, 'searchops_logs').execute({ index: 'logs', level: 'error', source: 'prod' }, execution())
    assert.match(out, /range=now-1h\.\.now/)
    assert.match(out, /checkout timed out/)
    assert.match(out, /fields:/) // resolved-field note
    assert.ok(out.includes(UNTRUSTED_NOTE))
  } finally {
    mock.restore()
  }
})

// ── searchops_aggregate ─────────────────────────────────────────────────────
test('searchops_aggregate renders group buckets', async () => {
  const { tools } = setup()
  const mock = mockCluster([[/_mapping$/, osMapping('logs', logMappingProperties())], [_search(), osSearch({ hits: [], total: { value: 8, relation: 'eq' }, aggregations: { group_by: { buckets: [{ key: 'checkout', doc_count: 5 }, { key: 'payment', doc_count: 3 }] } } })]])
  try {
    const out = await toolByName(tools, 'searchops_aggregate').execute({ index: 'logs', groupBy: 'service', source: 'prod' }, execution())
    assert.match(out, /groups by "service\.name"/)
    assert.match(out, /checkout count=5/)
    assert.match(out, /payment count=3/)
  } finally {
    mock.restore()
  }
})

// ── searchops_context ───────────────────────────────────────────────────────
test('searchops_context renders a trace correlation', async () => {
  const { tools } = setup()
  const mock = mockCluster([[/_mapping$/, osMapping('logs', logMappingProperties())], [_search(), osSearch({ hits: [{ _id: '1', _index: 'logs', _source: LOG_SOURCE }], total: { value: 1, relation: 'eq' }, took: 2 })]])
  try {
    const out = await toolByName(tools, 'searchops_context').execute({ index: 'logs', traceId: 't1', source: 'prod' }, execution())
    assert.match(out, /context for trace="t1"/)
    assert.match(out, /1 event\(s\)/)
  } finally {
    mock.restore()
  }
})

// ── searchops_investigate: the full evidence report ─────────────────────────
test('searchops_investigate renders a structured evidence report', async () => {
  const { tools } = setup()
  const errorHits = [
    { _id: '1', _index: 'logs', _source: { ...LOG_SOURCE, message: 'Connection refused to db-1' } },
    { _id: '2', _index: 'logs', _source: { ...LOG_SOURCE, message: 'Connection refused to db-1', 'trace.id': 't2' } },
  ]
  const mock = mockCluster([
    [/_mapping$/, osMapping('logs', logMappingProperties())],
    [_search(), osSearch({ hits: errorHits, total: { value: 2, relation: 'eq' }, took: 12 })],
  ])
  try {
    const out = await toolByName(tools, 'searchops_investigate').execute({ index: 'logs', source: 'prod' }, execution())
    assert.match(out, /# Investigation of "logs"/)
    assert.match(out, /## Recurring patterns/)
    assert.match(out, /Connection refused to db-1/)
    assert.match(out, /## Suggested next steps/)
    assert.match(out, /Evidence only — the plugin does not infer root cause/)
  } finally {
    mock.restore()
  }
})

// ── source selection is enforced by every tool ──────────────────────────────
test('a tool rejects an unknown source name without calling the cluster', async () => {
  const { tools } = setup()
  const mock = mockCluster([[_search(), osSearch({ hits: [] })]])
  try {
    await assert.rejects(
      () => toolByName(tools, 'searchops_logs').execute({ index: 'logs', source: 'nope' }, execution()),
      /Unknown search source "nope"/,
    )
    assert.equal(mock.calls.length, 0)
  } finally {
    mock.restore()
  }
})

// ── presentCall metadata (UI card contract) ─────────────────────────────────
test('presentCall yields a generic card with a read/search kind for every tool', () => {
  const { tools } = setup()
  const expectations = {
    searchops_sources: [{}, 'read'],
    searchops_status: [{}, 'read'],
    searchops_indices: [{}, 'read'],
    searchops_mapping: [{ index: 'logs' }, 'read'],
    searchops_query: [{ index: 'logs' }, 'search'],
    searchops_logs: [{ index: 'logs' }, 'search'],
    searchops_aggregate: [{ index: 'logs' }, 'read'],
    searchops_context: [{ index: 'logs' }, 'search'],
    searchops_investigate: [{ index: 'logs' }, 'search'],
  }
  for (const [name, [args, kind]] of Object.entries(expectations)) {
    const call = toolByName(tools, name).presentCall(args)
    assert.equal(call.card, 'generic', `${name} card`)
    assert.equal(call.kind, kind, `${name} kind`)
    assert.equal(typeof call.title, 'string')
    assert.ok(call.title.length > 0)
  }
})

test('every tool declares a finite timeout and is concurrency-safe (read-only)', () => {
  const { tools } = setup()
  for (const tool of tools) {
    assert.equal(typeof tool.timeoutMs, 'number')
    assert.ok(tool.timeoutMs > 0)
    assert.equal(tool.isConcurrencySafe({ index: 'logs' }), true, `${tool.name} should be concurrency-safe`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.description, 'string')
  }
})

function _search() { return /_search$/ }
