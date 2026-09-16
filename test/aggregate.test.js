import assert from 'node:assert/strict'
import test from 'node:test'

import { runAggregate } from '../lib/aggregate.js'
import { fakeProvider, searchResult } from './support.mjs'

// ── input validation (fails closed, with guidance) ──────────────────────────
test('runAggregate requires at least a groupBy or an interval', async () => {
  const { provider } = fakeProvider({ search: searchResult([]) })
  await assert.rejects(() => runAggregate(provider, { index: 'logs' }), /at least one of: groupBy/)
})

test('runAggregate rejects a malformed interval shape', async () => {
  const { provider } = fakeProvider({ search: searchResult([]) })
  await assert.rejects(() => runAggregate(provider, { index: 'logs', interval: 'five minutes' }), /fixed interval/)
})

test('runAggregate rejects a metric without a metricField and an unsupported metric', async () => {
  const { provider } = fakeProvider({ search: searchResult([]) })
  await assert.rejects(() => runAggregate(provider, { index: 'logs', groupBy: 'service', metric: 'avg' }), /metric requires metricField/)
  await assert.rejects(() => runAggregate(provider, { index: 'logs', groupBy: 'service', metric: 'median', metricField: 'duration' }), /Unsupported metric/)
})

// ── group-field resolution (semantic role or literal path) ──────────────────
test('runAggregate maps a semantic groupBy through the resolved profile', async () => {
  const { provider, calls } = fakeProvider({
    search: searchResult([], { aggregations: { group_by: { buckets: [{ key: 'payment', doc_count: 5 }] } } }),
  })
  const res = await runAggregate(provider, { index: 'logs', groupBy: 'service' })
  assert.equal(res.groupBy, 'service.name')
  assert.equal(calls.search[0].body.aggs.group_by.terms.field, 'service.name')
})

test('runAggregate uses a literal field path verbatim', async () => {
  const { provider, calls } = fakeProvider({ search: searchResult([], { aggregations: { group_by: { buckets: [] } } }) })
  await runAggregate(provider, { index: 'logs', groupBy: 'http.response.status_code' })
  assert.equal(calls.search[0].body.aggs.group_by.terms.field, 'http.response.status_code')
})

// ── request shape: buckets only, no hits ────────────────────────────────────
test('runAggregate sends size:0 with no _source so only buckets come back', async () => {
  const { provider, calls } = fakeProvider({ search: searchResult([], { aggregations: { group_by: { buckets: [] } } }) })
  await runAggregate(provider, { index: 'logs', groupBy: 'level' })
  const body = calls.search[0].body
  assert.equal(body.size, 0)
  assert.equal(body._source, false)
})

// ── bucket projection ───────────────────────────────────────────────────────
test('runAggregate projects group buckets and reports other-doc overflow', async () => {
  const { provider } = fakeProvider({
    search: searchResult([], {
      aggregations: { group_by: { buckets: [{ key: 'payment', doc_count: 5 }, { key: 'auth', doc_count: 3 }], sum_other_doc_count: 42 } },
    }),
  })
  const res = await runAggregate(provider, { index: 'logs', groupBy: 'service' })
  assert.deepEqual(res.groups, [{ key: 'payment', count: 5 }, { key: 'auth', count: 3 }])
  assert.equal(res.groupsOtherDocCount, 42)
})

test('runAggregate prefers key_as_string and attaches a sub-metric value', async () => {
  const { provider, calls } = fakeProvider({
    search: searchResult([], {
      aggregations: { group_by: { buckets: [{ key: 1, key_as_string: 'payment', doc_count: 5, metric: { value: 12.5 } }] } },
    }),
  })
  const res = await runAggregate(provider, { index: 'logs', groupBy: 'service', metric: 'avg', metricField: 'duration' })
  assert.equal(res.groups[0].key, 'payment')
  assert.equal(res.groups[0].metric, 12.5)
  assert.deepEqual(res.metric, { metric: 'avg', field: 'duration' })
  assert.deepEqual(calls.search[0].body.aggs.group_by.aggs.metric, { avg: { field: 'duration' } })
})

test('runAggregate builds a date histogram when given an interval', async () => {
  const { provider, calls } = fakeProvider({
    search: searchResult([], { aggregations: { over_time: { buckets: [{ key_as_string: '2024-01-15T10:00:00Z', doc_count: 7 }] } } }),
  })
  const res = await runAggregate(provider, { index: 'logs', interval: '5m' })
  assert.equal(res.interval, '5m')
  assert.equal(calls.search[0].body.aggs.over_time.date_histogram.fixed_interval, '5m')
  assert.equal(calls.search[0].body.aggs.over_time.date_histogram.field, '@timestamp')
  assert.equal(res.histogram[0].count, 7)
})

test('runAggregate caps group buckets to the limit and discloses the overflow', async () => {
  const buckets = Array.from({ length: 30 }, (_, i) => ({ key: `svc${i}`, doc_count: 30 - i }))
  const { provider, calls } = fakeProvider({ search: searchResult([], { aggregations: { group_by: { buckets } } }) })
  const res = await runAggregate(provider, { index: 'logs', groupBy: 'service', limit: 10 })
  assert.equal(res.groups.length, 10)
  assert.equal(calls.search[0].body.aggs.group_by.terms.size, 10)
  assert.match(res.budgetNote, /group/) // 20 groups not shown
})

test('runAggregate applies a text filter alongside the time range', async () => {
  const { provider, calls } = fakeProvider({ search: searchResult([], { aggregations: { group_by: { buckets: [] } } }) })
  await runAggregate(provider, { index: 'logs', groupBy: 'service', filter: 'timeout', from: 'now-2h' })
  const filter = calls.search[0].body.query.bool.filter
  assert.equal(filter[0].range['@timestamp'].gte, 'now-2h')
  assert.equal(filter[1].simple_query_string.query, 'timeout')
})
