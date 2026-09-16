import assert from 'node:assert/strict'
import test from 'node:test'

import { fingerprint, groupPatterns, normalizeMessage } from '../lib/patterns.js'
import { hit } from './support.mjs'

// ── normalizeMessage: deterministic, conservative fingerprinting ────────────
test('normalizeMessage replaces UUIDs, IPs, timestamps and long ids', () => {
  assert.equal(normalizeMessage('req 550e8400-e29b-41d4-a716-446655440000 failed'), 'req <uuid> failed')
  assert.equal(normalizeMessage('connection to 10.1.2.3 failed'), 'connection to <ip> failed')
  assert.equal(normalizeMessage('dial 10.1.2.3:6379 refused'), 'dial <ip>:<port> refused')
  assert.equal(normalizeMessage('at 2024-01-15T10:30:00.123Z boom'), 'at <ts> boom')
  assert.equal(normalizeMessage('pointer 0xdeadbeef bad'), 'pointer <hex> bad')
  assert.equal(normalizeMessage('trace 4f9c1a2b3d4e5f60 here'), 'trace <hex> here')
  assert.equal(normalizeMessage('order 1234567 not found'), 'order <num> not found')
})

test('normalizeMessage collapses different IPs/ports into the same fingerprint', () => {
  const a = normalizeMessage('connection to 10.1.2.3:6379 failed')
  const b = normalizeMessage('connection to 10.9.8.7:6380 failed')
  assert.equal(a, b)
  assert.equal(a, 'connection to <ip>:<port> failed')
})

test('normalizeMessage is NOT over-aggressive: it keeps meaningful words and short numbers', () => {
  // "Connection refused", "Redis timeout" and "NullPointer" must stay distinct.
  assert.equal(normalizeMessage('Connection refused'), 'Connection refused')
  assert.equal(normalizeMessage('Redis timeout'), 'Redis timeout')
  assert.equal(normalizeMessage('NullPointer'), 'NullPointer')
  // A number glued to a unit has no trailing word boundary, so it is preserved
  // ("30000ms" is meaningful, unlike a bare request id).
  assert.equal(normalizeMessage('timed out after 30000ms'), 'timed out after 30000ms')
  // Small numbers (< 5 digits) are kept: they are usually meaningful (status codes).
  assert.equal(normalizeMessage('returned HTTP 500'), 'returned HTTP 500')
})

test('normalizeMessage collapses whitespace, single-lines and caps length', () => {
  assert.equal(normalizeMessage('a\n\n  b'), 'a b')
  assert.ok(normalizeMessage('x'.repeat(5000)).length <= 160)
  assert.equal(normalizeMessage(''), '')
})

test('fingerprint groups case-insensitively but keeps first-seen casing in the label', () => {
  const a = fingerprint('Connection refused')
  const b = fingerprint('connection refused')
  assert.equal(a.key, b.key)
  assert.equal(a.label, 'Connection refused')
  assert.equal(a.key, 'connection refused')
})

// ── groupPatterns: the plugin does the counting, not the model ──────────────
const HITS = [
  hit('1', 'logs', { '@timestamp': '2024-01-15T10:00:00Z', message: 'Connection refused to 10.1.2.3:6379', 'service.name': 'payment', 'trace.id': 't1' }),
  hit('2', 'logs', { '@timestamp': '2024-01-15T10:00:05Z', message: 'Connection refused to 10.1.2.4:6379', 'service.name': 'payment', 'trace.id': 't2' }),
  hit('3', 'logs', { '@timestamp': '2024-01-15T10:00:10Z', message: 'Redis timeout after 30000ms', 'service.name': 'cache', 'trace.id': 't3' }),
  hit('4', 'logs', { '@timestamp': '2024-01-15T10:00:15Z', message: 'NullPointer at com.acme.Foo', 'service.name': 'payment', 'trace.id': 't4' }),
]

test('groupPatterns folds equivalent messages and sorts by count desc', () => {
  const res = groupPatterns(HITS, {})
  assert.equal(res.totalDocs, 4)
  assert.equal(res.patterns.length, 3)
  assert.equal(res.patterns[0].count, 2)
  assert.match(res.patterns[0].label, /Connection refused to <ip>:<port>/)
  assert.equal(res.patterns[1].count, 1)
  assert.equal(res.patterns[2].count, 1)
})

test('groupPatterns records first/last seen, a representative sample, trace ids and services', () => {
  const res = groupPatterns(HITS, {})
  const top = res.patterns[0]
  assert.equal(top.firstSeen, '2024-01-15T10:00:00Z')
  assert.equal(top.lastSeen, '2024-01-15T10:00:05Z')
  assert.deepEqual(top.traceIds, ['t1', 't2'])
  assert.deepEqual(top.services, ['payment'])
  assert.equal(top.sample.id, '1')
  assert.match(top.sample.message, /Connection refused to 10\.1\.2\.3:6379/)
})

test('groupPatterns honors a custom field profile', () => {
  const custom = [
    hit('1', 'logs', { ts: '2024-01-15T10:00:00Z', msg: 'boom', app: 'svc', rid: 'r1' }),
    hit('2', 'logs', { ts: '2024-01-15T10:00:01Z', msg: 'boom', app: 'svc', rid: 'r2' }),
  ]
  const res = groupPatterns(custom, { messageField: 'msg', timestampField: 'ts', serviceField: 'app', traceIdField: 'rid' })
  assert.equal(res.patterns[0].count, 2)
  assert.deepEqual(res.patterns[0].traceIds, ['r1', 'r2'])
  assert.deepEqual(res.patterns[0].services, ['svc'])
})

test('groupPatterns caps the pattern list and reports truncation', () => {
  const res = groupPatterns(HITS, {}, { maxPatterns: 2 })
  assert.equal(res.patterns.length, 2)
  assert.equal(res.totalPatterns, 3)
  assert.equal(res.truncated, true)
})

test('groupPatterns caps trace ids per pattern', () => {
  const many = Array.from({ length: 8 }, (_, i) => hit(String(i), 'logs', { message: 'same error', 'trace.id': `t${i}` }))
  const res = groupPatterns(many, {}, { maxTraceIds: 3 })
  assert.equal(res.patterns[0].traceIds.length, 3)
})

test('groupPatterns ignores empty messages and tolerates non-array input', () => {
  const withEmpty = [hit('1', 'logs', { message: '' }), hit('2', 'logs', { message: 'real' })]
  const res = groupPatterns(withEmpty, {})
  assert.equal(res.patterns.length, 1)
  assert.equal(res.patterns[0].label, 'real')
  assert.deepEqual(groupPatterns(null, {}).patterns, [])
})

test('groupPatterns redacts credentials in the fingerprint label and sample', () => {
  const hits = [hit('1', 'logs', {
    '@timestamp': '2024-01-15T10:00:00Z',
    message: 'auth failed Authorization: Bearer abc.def.ghi',
    'service.name': 'auth',
    'trace.id': 'trace-1',
  })]
  const res = groupPatterns(hits, {})
  const blob = JSON.stringify(res.patterns)
  assert.ok(!blob.includes('abc.def.ghi'), 'a bearer credential must not survive into pattern evidence')
  assert.match(blob, /\[redacted\]/)
  // Deterministic correlation is preserved: trace ids and services are not secrets.
  assert.deepEqual(res.patterns[0].traceIds, ['trace-1'])
  assert.deepEqual(res.patterns[0].services, ['auth'])
})
