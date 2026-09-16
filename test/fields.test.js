import assert from 'node:assert/strict'
import test from 'node:test'

import {
  flattenMappingProperties,
  getByPath,
  profileSourceFields,
  resolveFieldProfile,
  resolveProfileConfig,
  resolveSourceFields,
} from '../lib/fields.js'
import { fakeProvider } from './support.mjs'

// ── getByPath: literal flattened key first, then nested traversal ───────────
test('getByPath reads a literal dotted key when present', () => {
  assert.equal(getByPath({ 'service.name': 'checkout' }, 'service.name'), 'checkout')
})

test('getByPath traverses nested objects', () => {
  assert.equal(getByPath({ service: { name: 'checkout' } }, 'service.name'), 'checkout')
  assert.equal(getByPath({ trace: { id: 'abc' } }, 'trace.id'), 'abc')
})

test('getByPath prefers the literal key over nested traversal', () => {
  const doc = { 'service.name': 'literal', service: { name: 'nested' } }
  assert.equal(getByPath(doc, 'service.name'), 'literal')
})

test('getByPath returns undefined for missing paths and bad input', () => {
  assert.equal(getByPath({ a: 1 }, 'b'), undefined)
  assert.equal(getByPath({ a: 1 }, 'a.b'), undefined)
  assert.equal(getByPath(null, 'a'), undefined)
  assert.equal(getByPath({ a: 1 }, ''), undefined)
})

// ── resolveProfileConfig ────────────────────────────────────────────────────
test('resolveProfileConfig picks the named profile, else default, else empty', () => {
  const profiles = { default: { messageField: 'msg' }, ecs: { messageField: 'message' } }
  assert.deepEqual(resolveProfileConfig(profiles, 'ecs'), { messageField: 'message' })
  assert.deepEqual(resolveProfileConfig(profiles, 'missing'), { messageField: 'msg' })
  assert.deepEqual(resolveProfileConfig(profiles, ''), { messageField: 'msg' })
  assert.deepEqual(resolveProfileConfig(null, 'x'), {})
})

// ── resolveFieldProfile: explicit > detected > convention ───────────────────
test('resolveFieldProfile uses explicit profile fields and marks them not-detected', () => {
  const fields = resolveFieldProfile({ profile: { timestampField: 'ts', messageField: 'msg' } })
  assert.equal(fields.timestampField, 'ts')
  assert.equal(fields.messageField, 'msg')
  assert.equal(fields.detected.timestamp, false)
  assert.equal(fields.detected.message, false)
})

test('resolveFieldProfile detects roles from available fields when unconfigured', () => {
  const fields = resolveFieldProfile({ availableFields: ['ts', 'msg', 'app', 'severity', 'request_id'] })
  // None of these are the top-priority candidate, so detection falls to convention
  // for timestamp/message, but request_id is a traceId candidate and should be found.
  assert.equal(fields.traceIdField, 'request_id')
  assert.equal(fields.detected.traceId, true)
})

test('resolveFieldProfile detects the canonical ECS field names', () => {
  const fields = resolveFieldProfile({ availableFields: ['@timestamp', 'message', 'service.name', 'log.level', 'trace.id'] })
  assert.equal(fields.timestampField, '@timestamp')
  assert.equal(fields.messageField, 'message')
  assert.equal(fields.serviceField, 'service.name')
  assert.equal(fields.levelField, 'log.level')
  assert.equal(fields.traceIdField, 'trace.id')
})

test('resolveFieldProfile detection is case-insensitive as a fallback', () => {
  const fields = resolveFieldProfile({ availableFields: ['@Timestamp', 'Message'] })
  assert.equal(fields.timestampField, '@Timestamp')
  assert.equal(fields.messageField, 'Message')
})

test('resolveFieldProfile falls back to the common convention with no available fields', () => {
  const fields = resolveFieldProfile({})
  assert.equal(fields.timestampField, '@timestamp')
  assert.equal(fields.messageField, 'message')
  assert.equal(fields.serviceField, 'service.name')
  assert.equal(fields.levelField, 'log.level')
  assert.equal(fields.traceIdField, 'trace.id')
  // Every role is a guess in this case.
  assert.deepEqual(fields.detected, { timestamp: true, message: true, service: true, level: true, traceId: true })
})

test('resolveFieldProfile lets an explicit profile override detection', () => {
  const fields = resolveFieldProfile({
    profile: { messageField: 'log_line' },
    availableFields: ['@timestamp', 'message', 'log_line'],
  })
  assert.equal(fields.messageField, 'log_line')
  assert.equal(fields.detected.message, false)
  // The unconfigured timestamp is still detected from the mapping.
  assert.equal(fields.timestampField, '@timestamp')
  assert.equal(fields.detected.timestamp, true)
})

// ── profileSourceFields ─────────────────────────────────────────────────────
test('profileSourceFields dedupes and orders the profile fields', () => {
  const list = profileSourceFields({ timestampField: '@timestamp', messageField: 'message', serviceField: 'message', levelField: '', traceIdField: 'trace.id' })
  assert.deepEqual(list, ['@timestamp', 'message', 'trace.id'])
})

test('profileSourceFields ignores a non-string or empty profile', () => {
  assert.deepEqual(profileSourceFields({}), [])
  assert.deepEqual(profileSourceFields(), [])
})

// ── flattenMappingProperties ────────────────────────────────────────────────
test('flattenMappingProperties flattens nested properties into dotted paths', () => {
  const fields = flattenMappingProperties({
    '@timestamp': { type: 'date' },
    service: { properties: { name: { type: 'keyword' } } },
    message: { type: 'text', fields: { keyword: { type: 'keyword' } } },
  })
  const paths = fields.map((f) => f.path)
  assert.ok(paths.includes('@timestamp'))
  assert.ok(paths.includes('service.name'))
  assert.ok(paths.includes('message'))
  assert.equal(fields.find((f) => f.path === '@timestamp').type, 'date')
  assert.equal(fields.find((f) => f.path === 'service.name').type, 'keyword')
})

test('flattenMappingProperties respects maxFields', () => {
  const props = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, { type: 'keyword' }]))
  const fields = flattenMappingProperties(props, { maxFields: 10 })
  assert.equal(fields.length, 10)
})

test('flattenMappingProperties tolerates empty or malformed input', () => {
  assert.deepEqual(flattenMappingProperties(null), [])
  assert.deepEqual(flattenMappingProperties({}), [])
  assert.deepEqual(flattenMappingProperties({ a: null }), [])
})

// ── resolveSourceFields: one mapping read, graceful degradation, short-circuit ─
test('resolveSourceFields detects the schema from the mapping when no profile is set', async () => {
  const { provider, calls } = fakeProvider({
    getMapping: { indices: [{ index: 'logs', fields: [{ path: 'timestamp' }, { path: 'msg' }, { path: 'app' }] }] },
  })
  const { fields, availableFields, mappingError } = await resolveSourceFields(provider, { index: 'logs' })
  assert.equal(calls.getMapping.length, 1) // detection reads the mapping exactly once
  assert.equal(mappingError, null)
  assert.equal(fields.timestampField, 'timestamp')
  assert.equal(fields.messageField, 'msg')
  assert.equal(fields.serviceField, 'app')
  assert.ok(availableFields instanceof Set)
  assert.ok(availableFields.has('msg'))
})

test('resolveSourceFields lets an explicit profile win over detection', async () => {
  const { provider } = fakeProvider({
    getMapping: { indices: [{ index: 'logs', fields: [{ path: '@timestamp' }, { path: 'message' }] }] },
  })
  const { fields } = await resolveSourceFields(provider, { index: 'logs', profile: { messageField: 'body' } })
  assert.equal(fields.messageField, 'body') // configured wins
  assert.equal(fields.detected.message, false)
  assert.equal(fields.timestampField, '@timestamp') // unconfigured role is still detected
  assert.equal(fields.detected.timestamp, true)
})

test('resolveSourceFields degrades to convention and reports why when the mapping fails', async () => {
  const { provider, calls } = fakeProvider({ getMapping: new Error('mapping unavailable: 403 permission denied') })
  const { fields, availableFields, mappingError } = await resolveSourceFields(provider, { index: 'logs' })
  assert.equal(calls.getMapping.length, 1)
  assert.match(mappingError, /mapping unavailable/)
  assert.equal(fields.timestampField, '@timestamp')
  assert.equal(fields.messageField, 'message')
  assert.ok(availableFields instanceof Set)
  assert.equal(availableFields.size, 0) // empty, never null — so a caller never re-queries
})

test('resolveSourceFields skips the mapping round-trip when the caller already resolved the schema', async () => {
  const { provider, calls } = fakeProvider({ getMapping: { indices: [] } })
  const { fields } = await resolveSourceFields(provider, { index: 'logs', availableFields: new Set(['ts', 'msg']) })
  assert.equal(calls.getMapping.length, 0) // investigate threads its single read down
  assert.equal(fields.messageField, 'msg')
})
