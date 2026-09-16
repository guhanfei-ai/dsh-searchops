import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_QUERY_SIZE,
  HARD_MAX_SIZE,
  MAX_QUERY_SIZE,
  MAX_TRACK_TOTAL_HITS,
} from '../lib/constants.js'
import {
  buildSearchBody,
  clampFrom,
  clampSize,
  computeTruncated,
  normalizeSourceFilter,
  normalizeTrackTotalHits,
  runSearch,
  validateQueryDsl,
} from '../lib/search.js'
import { fakeProvider, hit, searchResult } from './support.mjs'

// ── clampSize: the "size = 10000000" guard ──────────────────────────────────
test('clampSize applies the default when size is omitted', () => {
  assert.deepEqual(clampSize(undefined), { size: DEFAULT_QUERY_SIZE, clamped: false })
  assert.deepEqual(clampSize(''), { size: DEFAULT_QUERY_SIZE, clamped: false })
})

test('clampSize passes through a reasonable size', () => {
  assert.deepEqual(clampSize(50), { size: 50, clamped: false })
  assert.deepEqual(clampSize('30'), { size: 30, clamped: false })
})

test('clampSize clamps an absurd size down to the cap and flags it', () => {
  assert.deepEqual(clampSize(10_000_000), { size: MAX_QUERY_SIZE, clamped: true })
  assert.deepEqual(clampSize(999), { size: MAX_QUERY_SIZE, clamped: true })
})

test('clampSize never exceeds the absolute hard ceiling even with a larger max', () => {
  const res = clampSize(100_000, { def: 20, max: 999_999 })
  assert.equal(res.size, HARD_MAX_SIZE)
  assert.equal(res.clamped, true)
})

test('clampSize falls back to the default for non-finite or sub-1 input', () => {
  assert.deepEqual(clampSize(0), { size: DEFAULT_QUERY_SIZE, clamped: false })
  assert.deepEqual(clampSize(-5), { size: DEFAULT_QUERY_SIZE, clamped: false })
  assert.deepEqual(clampSize('abc'), { size: DEFAULT_QUERY_SIZE, clamped: false })
})

// ── clampFrom: deep-pagination guard ────────────────────────────────────────
test('clampFrom defaults to 0 and rejects deep pagination', () => {
  assert.deepEqual(clampFrom(undefined), { from: 0 })
  assert.deepEqual(clampFrom(100), { from: 100 })
  assert.deepEqual(clampFrom(-1), { from: 0 })
  assert.throws(() => clampFrom(20_000), /exceeds the 10000 offset limit/)
})

// ── track_total_hits cap ────────────────────────────────────────────────────
test('normalizeTrackTotalHits passes booleans and caps numbers', () => {
  assert.equal(normalizeTrackTotalHits(true), true)
  assert.equal(normalizeTrackTotalHits(false), false)
  assert.equal(normalizeTrackTotalHits(undefined), MAX_TRACK_TOTAL_HITS)
  assert.equal(normalizeTrackTotalHits(500), 500)
  assert.equal(normalizeTrackTotalHits(1_000_000_000), MAX_TRACK_TOTAL_HITS)
})

// ── _source filter normalization ────────────────────────────────────────────
test('normalizeSourceFilter handles booleans, strings, arrays and include/exclude', () => {
  assert.equal(normalizeSourceFilter(undefined), undefined)
  assert.equal(normalizeSourceFilter(false), false)
  assert.deepEqual(normalizeSourceFilter('message'), ['message'])
  assert.deepEqual(normalizeSourceFilter(['a', 'b', '', null]), ['a', 'b'])
  assert.deepEqual(normalizeSourceFilter({ includes: ['a'], excludes: ['b'] }), { includes: ['a'], excludes: ['b'] })
  assert.equal(normalizeSourceFilter({}), undefined)
})

// ── query DSL validation ────────────────────────────────────────────────────
test('validateQueryDsl defaults empty input to match_all', () => {
  assert.deepEqual(validateQueryDsl(undefined), { match_all: {} })
  assert.deepEqual(validateQueryDsl({}), { match_all: {} })
})

test('validateQueryDsl accepts an object or a JSON string of one', () => {
  assert.deepEqual(validateQueryDsl({ term: { a: 1 } }), { term: { a: 1 } })
  assert.deepEqual(validateQueryDsl('{"term":{"a":1}}'), { term: { a: 1 } })
})

test('validateQueryDsl rejects malformed JSON, non-objects and oversized bodies', () => {
  assert.throws(() => validateQueryDsl('{not json}'), /must be a JSON object/)
  assert.throws(() => validateQueryDsl('[1,2,3]'), /must parse to a JSON object/)
  assert.throws(() => validateQueryDsl(42), /must be a JSON object/)
  const huge = { term: { a: 'x'.repeat(40 * 1024) } }
  assert.throws(() => validateQueryDsl(huge), /too large/)
})

// ── buildSearchBody ─────────────────────────────────────────────────────────
test('buildSearchBody assembles size, query, track_total_hits and omits empty parts', () => {
  const body = buildSearchBody({ query: { term: { a: 1 } }, size: 20 })
  assert.equal(body.size, 20)
  assert.deepEqual(body.query, { term: { a: 1 } })
  assert.equal(body.track_total_hits, MAX_TRACK_TOTAL_HITS)
  assert.equal(body.from, undefined)
  assert.equal(body.sort, undefined)
  assert.equal(body.aggs, undefined)
})

test('buildSearchBody includes from, sort, _source and aggs when provided', () => {
  const body = buildSearchBody({
    query: {},
    size: 0,
    from: 10,
    sort: [{ '@timestamp': { order: 'desc' } }],
    sourceFilter: ['message'],
    aggs: { group_by: { terms: { field: 'service.name', size: 10 } } },
  })
  assert.equal(body.from, 10)
  assert.deepEqual(body.sort, [{ '@timestamp': { order: 'desc' } }])
  assert.deepEqual(body._source, ['message'])
  assert.ok(body.aggs.group_by)
})

test('buildSearchBody ignores an empty aggs object and empty sort array', () => {
  const body = buildSearchBody({ query: {}, size: 5, aggs: {}, sort: [] })
  assert.equal(body.aggs, undefined)
  assert.equal(body.sort, undefined)
})

// ── runSearch: envelope + truncation disclosure ─────────────────────────────
test('runSearch validates the index pattern before calling the provider', async () => {
  const { provider, calls } = fakeProvider({})
  await assert.rejects(() => runSearch(provider, { index: 'bad index', body: {} }), /invalid index name or pattern/)
  assert.equal(calls.search.length, 0)
})

test('runSearch normalizes the result envelope and reports truncation on a capped count', async () => {
  const { provider } = fakeProvider({ search: searchResult([hit('1', 'logs', {})], { total: { value: 10000, relation: 'gte' } }) })
  const res = await runSearch(provider, { index: 'logs', body: buildSearchBody({ query: {}, size: 1 }) })
  assert.equal(res.returned, 1)
  assert.equal(res.requested, 1)
  assert.deepEqual(res.total, { value: 10000, relation: 'gte' })
  assert.equal(res.truncated, true)
})

test('runSearch reports truncated when fewer hits came back than were requested', async () => {
  const { provider } = fakeProvider({ search: searchResult([hit('1', 'logs', {})], { total: { value: 5, relation: 'eq' } }) })
  const res = await runSearch(provider, { index: 'logs', body: buildSearchBody({ query: {}, size: 5 }) })
  assert.equal(res.returned, 1)
  assert.equal(res.requested, 5)
  assert.equal(res.truncated, true)
})

test('runSearch is not truncated when everything requested came back', async () => {
  const { provider } = fakeProvider({ search: searchResult([hit('1', 'logs', {})], { total: { value: 1, relation: 'eq' } }) })
  const res = await runSearch(provider, { index: 'logs', body: buildSearchBody({ query: {}, size: 1 }) })
  assert.equal(res.truncated, false)
})

// ── truncation truth table ──────────────────────────────────────────────────
// `truncated` means "there is evidence that more matching documents existed but
// were left out of the returned result" — NOT "fewer rows came back than the
// size I asked for". A short result set that simply matched fewer documents is
// complete, not truncated. The decision is driven by the total value + relation.

test('runSearch is NOT truncated when it asked for 20 but only 3 matched (total eq 3)', async () => {
  const hits = [hit('1', 'logs', {}), hit('2', 'logs', {}), hit('3', 'logs', {})]
  const { provider } = fakeProvider({ search: searchResult(hits, { total: { value: 3, relation: 'eq' } }) })
  const res = await runSearch(provider, { index: 'logs', body: buildSearchBody({ query: {}, size: 20 }) })
  assert.equal(res.returned, 3)
  assert.equal(res.requested, 20)
  assert.equal(res.truncated, false)
})

test('runSearch IS truncated when 20 of 100 matches came back (total eq 100)', async () => {
  const hits = Array.from({ length: 20 }, (_, i) => hit(String(i), 'logs', {}))
  const { provider } = fakeProvider({ search: searchResult(hits, { total: { value: 100, relation: 'eq' } }) })
  const res = await runSearch(provider, { index: 'logs', body: buildSearchBody({ query: {}, size: 20 }) })
  assert.equal(res.returned, 20)
  assert.equal(res.truncated, true)
})

test('runSearch IS truncated when the count is a lower bound (total gte 10000)', async () => {
  const hits = Array.from({ length: 20 }, (_, i) => hit(String(i), 'logs', {}))
  const { provider } = fakeProvider({ search: searchResult(hits, { total: { value: 10000, relation: 'gte' } }) })
  const res = await runSearch(provider, { index: 'logs', body: buildSearchBody({ query: {}, size: 20 }) })
  assert.equal(res.truncated, true)
})

test('runSearch is NOT truncated when all 20 matches came back (total eq 20)', async () => {
  const hits = Array.from({ length: 20 }, (_, i) => hit(String(i), 'logs', {}))
  const { provider } = fakeProvider({ search: searchResult(hits, { total: { value: 20, relation: 'eq' } }) })
  const res = await runSearch(provider, { index: 'logs', body: buildSearchBody({ query: {}, size: 20 }) })
  assert.equal(res.truncated, false)
})

test('runSearch IS truncated when the count itself hit the tracking budget (total gte 20, returned 20)', async () => {
  const hits = Array.from({ length: 20 }, (_, i) => hit(String(i), 'logs', {}))
  const { provider } = fakeProvider({ search: searchResult(hits, { total: { value: 20, relation: 'gte' } }) })
  const res = await runSearch(provider, { index: 'logs', body: buildSearchBody({ query: {}, size: 20 }) })
  assert.equal(res.truncated, true)
})

test('runSearch forwards aggregations from the provider result', async () => {
  const aggs = { group_by: { buckets: [{ key: 'payment', doc_count: 3 }] } }
  const { provider } = fakeProvider({ search: searchResult([], { aggregations: aggs }) })
  const res = await runSearch(provider, { index: 'logs', body: buildSearchBody({ query: {}, size: 0, aggs }) })
  assert.deepEqual(res.aggregations, aggs)
})

// ── computeTruncated: pure truth table ──────────────────────────────────────
test('computeTruncated reports truncation from the total value and relation only', () => {
  // exact count ('eq'): truncated only when more matched than we returned
  assert.equal(computeTruncated({ value: 3, relation: 'eq' }, 3), false)
  assert.equal(computeTruncated({ value: 100, relation: 'eq' }, 20), true)
  assert.equal(computeTruncated({ value: 20, relation: 'eq' }, 20), false)
  // capped lower bound ('gte'): the true total may exceed the count, so a value
  // that only equals what we returned is still treated as truncated
  assert.equal(computeTruncated({ value: 10000, relation: 'gte' }, 20), true)
  assert.equal(computeTruncated({ value: 20, relation: 'gte' }, 20), true)
  // no usable total -> no evidence of truncation
  assert.equal(computeTruncated(undefined, 5), false)
  assert.equal(computeTruncated({ value: NaN, relation: 'eq' }, 5), false)
})
