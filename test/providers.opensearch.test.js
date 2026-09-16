import assert from 'node:assert/strict'
import test from 'node:test'

import { createProvider, isSupportedProvider } from '../lib/providers/index.js'
import { createOpenSearchProvider, normalizeSearchResponse, normalizeTotal } from '../lib/providers/opensearch.js'
import { logMappingProperties, osCatRow, osHealth, osMapping, osRoot, osSearch } from './support.mjs'

// A fake `http` seam: the runtime hands the adapter a function that already
// returns parsed JSON, so we record (method, path, init) and return canned data.
function fakeHttp(responder) {
  const calls = []
  const http = async (method, path, init, opts) => {
    calls.push({ method, path, init, opts })
    return responder(method, path, init, opts)
  }
  return { http, calls }
}

// ── registry / provider neutrality ──────────────────────────────────────────
test('isSupportedProvider accepts opensearch (any case) and rejects the rest', () => {
  assert.equal(isSupportedProvider('opensearch'), true)
  assert.equal(isSupportedProvider('OpenSearch'), true)
  assert.equal(isSupportedProvider('elasticsearch'), false)
  assert.equal(isSupportedProvider('solr'), false)
})

test('createProvider builds the opensearch adapter and refuses fakes', () => {
  const { http } = fakeHttp(() => ({}))
  const provider = createProvider('opensearch', { http })
  assert.equal(provider.name, 'opensearch')
  for (const method of ['ping', 'clusterHealth', 'listIndices', 'getMapping', 'search']) {
    assert.equal(typeof provider[method], 'function')
  }
  // elasticsearch is a documented roadmap item, NOT a fake adapter.
  assert.throws(() => createProvider('elasticsearch', { http }), /planned but not implemented in v0\.1/)
  assert.throws(() => createProvider('solr', { http }), /Unsupported search provider/)
})

test('createOpenSearchProvider requires an http function', () => {
  assert.throws(() => createOpenSearchProvider({}), /requires an http function/)
})

// ── ping ────────────────────────────────────────────────────────────────────
test('ping issues GET / and normalizes the cluster root payload', async () => {
  const { http, calls } = fakeHttp(() => osRoot({ clusterName: 'c1', version: '2.11.0' }))
  const info = await createOpenSearchProvider({ http }).ping()
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].path, '/')
  assert.equal(info.clusterName, 'c1')
  assert.equal(info.version, '2.11.0')
  assert.equal(info.distribution, 'opensearch')
})

test('ping rejects a source that does not answer like OpenSearch', async () => {
  const { http } = fakeHttp(() => null)
  await assert.rejects(() => createOpenSearchProvider({ http }).ping(), /did not answer like OpenSearch/)
})

// ── clusterHealth ───────────────────────────────────────────────────────────
test('clusterHealth issues GET /_cluster/health and normalizes counts', async () => {
  const { http, calls } = fakeHttp(() => osHealth({ status: 'yellow', numberOfNodes: 2, unassignedShards: 3 }))
  const health = await createOpenSearchProvider({ http }).clusterHealth()
  assert.equal(calls[0].path, '/_cluster/health')
  assert.equal(health.status, 'yellow')
  assert.equal(health.numberOfNodes, 2)
  assert.equal(health.unassignedShards, 3)
})

test('clusterHealth rejects a payload without a status field', async () => {
  const { http } = fakeHttp(() => ({ foo: 'bar' }))
  await assert.rejects(() => createOpenSearchProvider({ http }).clusterHealth(), /did not return the expected payload/)
})

// ── listIndices ─────────────────────────────────────────────────────────────
test('listIndices builds the _cat/indices path with a pattern and json format', async () => {
  const rows = [osCatRow('logs-1', { docs: '100', bytes: '2048' }), osCatRow('logs-2', { docs: '50' })]
  const { http, calls } = fakeHttp(() => rows)
  const res = await createOpenSearchProvider({ http }).listIndices({ pattern: 'logs-*', limit: 50 })
  assert.match(calls[0].path, /^\/_cat\/indices\/logs-\*\?/)
  assert.match(calls[0].path, /format=json/)
  assert.equal(res.total, 2)
  assert.equal(res.indices[0].index, 'logs-1')
  assert.equal(res.indices[0].docsCount, 100)
  assert.equal(res.indices[0].storeSize, 2048)
})

test('listIndices omits the path segment when no pattern is given', async () => {
  const { http, calls } = fakeHttp(() => [])
  const res = await createOpenSearchProvider({ http }).listIndices({})
  assert.match(calls[0].path, /^\/_cat\/indices\?/)
  assert.deepEqual(res.indices, [])
  assert.equal(res.total, 0)
})

test('listIndices caps to the limit and reports truncation', async () => {
  const rows = [osCatRow('a'), osCatRow('b'), osCatRow('c')]
  const { http } = fakeHttp(() => rows)
  const res = await createOpenSearchProvider({ http }).listIndices({ limit: 2 })
  assert.equal(res.indices.length, 2)
  assert.equal(res.total, 3)
  assert.equal(res.truncated, true)
})

test('listIndices parses red/empty shard counts as null rather than NaN', async () => {
  const { http } = fakeHttp(() => [osCatRow('red-index', { health: 'red', docs: '', bytes: '' })])
  const res = await createOpenSearchProvider({ http }).listIndices({})
  assert.equal(res.indices[0].docsCount, null)
  assert.equal(res.indices[0].storeSize, null)
})

test('listIndices rejects a non-list payload', async () => {
  const { http } = fakeHttp(() => ({ unexpected: true }))
  await assert.rejects(() => createOpenSearchProvider({ http }).listIndices({}), /did not return a list of indices/)
})

// ── getMapping ──────────────────────────────────────────────────────────────
test('getMapping flattens nested properties into dotted field paths', async () => {
  const { http, calls } = fakeHttp(() => osMapping('logs', logMappingProperties()))
  const res = await createOpenSearchProvider({ http }).getMapping({ index: 'logs', maxFields: 400 })
  assert.equal(calls[0].path, '/logs/_mapping')
  assert.equal(res.indices[0].index, 'logs')
  const paths = res.indices[0].fields.map((f) => f.path)
  assert.ok(paths.includes('service.name'))
  assert.ok(paths.includes('trace.id'))
  assert.ok(paths.includes('@timestamp'))
})

test('getMapping truncates at maxFields and flags it', async () => {
  const props = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, { type: 'keyword' }]))
  const { http } = fakeHttp(() => osMapping('logs', props))
  const res = await createOpenSearchProvider({ http }).getMapping({ index: 'logs', maxFields: 10 })
  assert.equal(res.indices[0].fieldCount, 10)
  assert.equal(res.indices[0].truncated, true)
  assert.equal(res.truncated, true)
})

test('getMapping requires an index', async () => {
  const { http } = fakeHttp(() => ({}))
  await assert.rejects(() => createOpenSearchProvider({ http }).getMapping({}), /requires an index/)
})

// ── search ──────────────────────────────────────────────────────────────────
test('search POSTs the DSL body to /{index}/_search and normalizes hits', async () => {
  const { http, calls } = fakeHttp(() => osSearch({ hits: [{ _id: '1', _index: 'logs', _source: { message: 'hi' } }], total: { value: 1, relation: 'eq' }, took: 7 }))
  const res = await createOpenSearchProvider({ http }).search({ index: 'logs', body: { size: 10, query: { match_all: {} } } })
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].path, '/logs/_search')
  assert.deepEqual(calls[0].init, { body: { size: 10, query: { match_all: {} } } })
  assert.equal(res.hits[0].id, '1')
  assert.equal(res.hits[0].source.message, 'hi')
  assert.equal(res.took, 7)
})

test('search requires an index', async () => {
  const { http } = fakeHttp(() => ({}))
  await assert.rejects(() => createOpenSearchProvider({ http }).search({ body: {} }), /requires an index/)
})

// ── response normalization (malformed-response safety) ──────────────────────
test('normalizeSearchResponse rejects a payload with no hits object', () => {
  assert.throws(() => normalizeSearchResponse({}), /did not return the expected payload/)
  assert.throws(() => normalizeSearchResponse({ hits: [] }), /did not return the expected payload/)
  assert.throws(() => normalizeSearchResponse(null), /did not return the expected payload/)
})

test('normalizeSearchResponse keeps sort values and defaults missing fields', () => {
  const res = normalizeSearchResponse({ hits: { total: 2, hits: [{ _id: 'a', _source: { m: 1 }, sort: [5] }, { _source: null }] } })
  assert.equal(res.hits[0].sort[0], 5)
  assert.equal(res.hits[1].id, '')
  assert.deepEqual(res.hits[1].source, {})
})

test('normalizeTotal handles the numeric and object forms', () => {
  assert.deepEqual(normalizeTotal(5), { value: 5, relation: 'eq' })
  assert.deepEqual(normalizeTotal(10000), { value: 10000, relation: 'gte' })
  assert.deepEqual(normalizeTotal({ value: 3, relation: 'eq' }), { value: 3, relation: 'eq' })
  assert.deepEqual(normalizeTotal(null), { value: 0, relation: 'eq' })
})
