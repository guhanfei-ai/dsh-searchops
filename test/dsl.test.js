import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boolQuery,
  dateHistogramAgg,
  fieldEquals,
  levelFilter,
  metricAgg,
  rangeFilter,
  simpleText,
  termFilter,
  termsAgg,
  termsFilter,
} from '../lib/dsl.js'

// ── boolQuery ───────────────────────────────────────────────────────────────
test('boolQuery drops empty clauses and falls back to match_all', () => {
  assert.deepEqual(boolQuery({}), { match_all: {} })
  assert.deepEqual(boolQuery({ must: [], filter: [] }), { match_all: {} })
  assert.deepEqual(boolQuery({ filter: [null, {}, { term: { a: 1 } }] }), { bool: { filter: [{ term: { a: 1 } }] } })
})

test('boolQuery maps mustNot to must_not and only sets minimum_should_match with a should', () => {
  const q = boolQuery({ must: [{ match: { a: 1 } }], should: [{ term: { b: 2 } }], mustNot: [{ term: { c: 3 } }], minimumShouldMatch: 1 })
  assert.deepEqual(q.bool.must, [{ match: { a: 1 } }])
  assert.deepEqual(q.bool.should, [{ term: { b: 2 } }])
  assert.deepEqual(q.bool.must_not, [{ term: { c: 3 } }])
  assert.equal(q.bool.minimum_should_match, 1)
  // Without a should clause, minimum_should_match is not emitted.
  assert.equal(boolQuery({ must: [{ match: { a: 1 } }], minimumShouldMatch: 1 }).bool.minimum_should_match, undefined)
})

// ── rangeFilter / termFilter / termsFilter ──────────────────────────────────
test('rangeFilter builds bounded ranges and omits empty values', () => {
  assert.deepEqual(rangeFilter('@timestamp', { gte: 'now-1h', lte: 'now' }), { range: { '@timestamp': { gte: 'now-1h', lte: 'now' } } })
  assert.deepEqual(rangeFilter('@timestamp', { gt: 5, lte: 10, format: 'epoch_millis' }), { range: { '@timestamp': { gt: 5, lte: 10, format: 'epoch_millis' } } })
  assert.equal(rangeFilter('@timestamp', {}), null)
  assert.equal(rangeFilter('', { gte: 'now' }), null)
  assert.equal(rangeFilter('@timestamp', { gte: '', lte: null }), null)
})

test('termFilter returns null on empty field or value', () => {
  assert.deepEqual(termFilter('service.name', 'checkout'), { term: { 'service.name': 'checkout' } })
  assert.equal(termFilter('', 'x'), null)
  assert.equal(termFilter('f', ''), null)
  assert.equal(termFilter('f', null), null)
})

test('termsFilter drops empty values and returns null when nothing remains', () => {
  assert.deepEqual(termsFilter('level', ['error', 'fatal']), { terms: { level: ['error', 'fatal'] } })
  assert.deepEqual(termsFilter('level', ['error', '', null]), { terms: { level: ['error'] } })
  assert.equal(termsFilter('level', []), null)
  assert.equal(termsFilter('', ['error']), null)
})

// ── simpleText ──────────────────────────────────────────────────────────────
test('simpleText builds a lenient simple_query_string across fields', () => {
  assert.deepEqual(simpleText(['message', 'service.name'], 'timeout'), {
    simple_query_string: { query: 'timeout', fields: ['message', 'service.name'], default_operator: 'and' },
  })
  assert.equal(simpleText(['message'], ''), null)
  assert.equal(simpleText([], 'timeout'), null)
  // A single string field is normalized to a list.
  assert.deepEqual(simpleText('message', 'x').simple_query_string.fields, ['message'])
})

// ── fieldEquals: works across keyword/text/.keyword without probing mapping ─
test('fieldEquals covers term, .keyword term and match_phrase', () => {
  const q = fieldEquals('service.name', 'checkout')
  assert.deepEqual(q.bool.should, [
    { term: { 'service.name': 'checkout' } },
    { term: { 'service.name.keyword': 'checkout' } },
    { match_phrase: { 'service.name': 'checkout' } },
  ])
  assert.equal(q.bool.minimum_should_match, 1)
  assert.equal(fieldEquals('', 'x'), null)
  assert.equal(fieldEquals('f', '  '), null)
})

// ── levelFilter ─────────────────────────────────────────────────────────────
test('levelFilter matches case variants as a cheap terms query', () => {
  const q = levelFilter('log.level', 'error')
  // raw 'error', lower 'error', upper 'ERROR' collapse to a 2-value set.
  assert.deepEqual([...q.terms['log.level']].sort(), ['ERROR', 'error'])
  assert.ok(q.terms['log.level'].includes('error'))
  assert.ok(q.terms['log.level'].includes('ERROR'))
  assert.equal(levelFilter('log.level', ''), null)
  assert.equal(levelFilter('', 'error'), null)
})

test('levelFilter folds in extra variants without duplicates', () => {
  const q = levelFilter('level', 'Error', { variants: ['err', 'ERROR'] })
  const values = q.terms.level
  assert.equal(new Set(values).size, values.length) // no duplicates
  assert.ok(values.includes('err'))
})

// ── aggregations ────────────────────────────────────────────────────────────
test('termsAgg builds a sized terms aggregation with optional order', () => {
  assert.deepEqual(termsAgg('service.name', { size: 10 }), { terms: { field: 'service.name', size: 10 } })
  assert.deepEqual(termsAgg('service.name', { size: 5, order: { _count: 'desc' } }), { terms: { field: 'service.name', size: 5, order: { _count: 'desc' } } })
  assert.equal(termsAgg(''), null)
})

test('dateHistogramAgg builds a fixed_interval histogram', () => {
  assert.deepEqual(dateHistogramAgg('@timestamp', { interval: '5m' }), { date_histogram: { field: '@timestamp', fixed_interval: '5m', min_doc_count: 0 } })
  assert.equal(dateHistogramAgg('@timestamp', { interval: '' }), null)
  assert.equal(dateHistogramAgg('', { interval: '5m' }), null)
  assert.equal(dateHistogramAgg('@timestamp', { interval: '1h', timeZone: 'UTC' }).date_histogram.time_zone, 'UTC')
})

test('metricAgg accepts only the supported metric names', () => {
  assert.deepEqual(metricAgg('avg', 'duration'), { avg: { field: 'duration' } })
  assert.deepEqual(metricAgg('cardinality', 'trace.id'), { cardinality: { field: 'trace.id' } })
  assert.equal(metricAgg('median', 'duration'), null)
  assert.equal(metricAgg('avg', ''), null)
})
