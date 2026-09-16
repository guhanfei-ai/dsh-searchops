import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
} from '../lib/constants.js'
import {
  abortableDelay,
  byteLength,
  clampInteger,
  combineSignals,
  generateSourceId,
  isPlainObject,
  normalizeBaseUrl,
  normalizeSourceName,
  oneLine,
  passwordRefForId,
  readLimitedText,
  redactSecrets,
  requireBoundedInteger,
  safeErrorDetail,
  textOut,
  tokenRefForId,
  truncate,
  usernameRefForId,
  validateCredentialRef,
  validateIndexPattern,
} from '../lib/util.js'
import { jsonResponse } from './support.mjs'

// ── normalizeBaseUrl: the SSRF / credential-in-URL / plain-HTTP gate ─────────
test('normalizeBaseUrl strips trailing slashes and accepts HTTPS', () => {
  assert.equal(normalizeBaseUrl('https://search.example.com:9200/'), 'https://search.example.com:9200')
  assert.equal(normalizeBaseUrl('https://search.example.com///'), 'https://search.example.com')
})

test('normalizeBaseUrl rejects embedded credentials so secrets never sit in config', () => {
  assert.throws(() => normalizeBaseUrl('https://user:pass@search.example.com'), /must not contain embedded credentials/)
})

test('normalizeBaseUrl rejects query strings and fragments', () => {
  assert.throws(() => normalizeBaseUrl('https://search.example.com?target=internal'), /query string or fragment/)
  assert.throws(() => normalizeBaseUrl('https://search.example.com#frag'), /query string or fragment/)
})

test('normalizeBaseUrl rejects non-HTTP(S) schemes and empty/invalid input', () => {
  assert.throws(() => normalizeBaseUrl('ftp://search.example.com'), /must use https:\/\/ or http:\/\//)
  assert.throws(() => normalizeBaseUrl(''), /is not configured/)
  assert.throws(() => normalizeBaseUrl('not a url'), /absolute HTTP\(S\) URL/)
})

test('normalizeBaseUrl blocks plain HTTP to non-loopback hosts unless explicitly allowed', () => {
  assert.throws(() => normalizeBaseUrl('http://search.example.com'), /Plain HTTP is disabled for non-loopback/)
  // Explicit opt-in allows it.
  assert.equal(normalizeBaseUrl('http://search.example.com', true), 'http://search.example.com')
})

test('normalizeBaseUrl allows plain HTTP to loopback without the insecure flag', () => {
  assert.equal(normalizeBaseUrl('http://localhost:9200'), 'http://localhost:9200')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:9200/'), 'http://127.0.0.1:9200')
  assert.equal(normalizeBaseUrl('http://[::1]:9200'), 'http://[::1]:9200')
})

// ── credential reference derivation ─────────────────────────────────────────
test('credential refs are derived deterministically from the source id', () => {
  assert.equal(usernameRefForId('prod'), 'SEARCHOPS_USERNAME_prod')
  assert.equal(passwordRefForId('prod'), 'SEARCHOPS_PASSWORD_prod')
  assert.equal(tokenRefForId('prod'), 'SEARCHOPS_TOKEN_prod')
  // The same id always maps to the same ref (renaming never orphans secrets).
  assert.equal(passwordRefForId('prod'), passwordRefForId('prod'))
})

test('credential refs strip unsafe characters from a UUID-shaped id', () => {
  // A hyphenated UUID id collapses to ref-safe characters only.
  const ref = passwordRefForId('abc-def_123')
  assert.equal(ref, 'SEARCHOPS_PASSWORD_abcdef_123')
  assert.match(ref, /^[A-Za-z_][A-Za-z0-9_]*$/)
})

test('validateCredentialRef rejects malformed refs', () => {
  assert.equal(validateCredentialRef('SEARCHOPS_PASSWORD_prod'), 'SEARCHOPS_PASSWORD_prod')
  assert.throws(() => validateCredentialRef(''), /Invalid credential reference/)
  assert.throws(() => validateCredentialRef('1leading-digit'), /Invalid credential reference/)
  assert.throws(() => validateCredentialRef('has space'), /Invalid credential reference/)
})

test('generateSourceId returns unique, id-pattern-shaped values', () => {
  const a = generateSourceId()
  const b = generateSourceId()
  assert.notEqual(a, b)
  assert.ok(a.length >= 8 && a.length <= 64)
})

// ── source name ─────────────────────────────────────────────────────────────
test('normalizeSourceName trims and rejects empty or over-long names', () => {
  assert.equal(normalizeSourceName('  prod  '), 'prod')
  assert.throws(() => normalizeSourceName(''), /non-empty name/)
  assert.throws(() => normalizeSourceName('x'.repeat(101)), /must not exceed 100 characters/)
})

// ── signals / timeouts ──────────────────────────────────────────────────────
test('combineSignals produces a signal that aborts on timeout', async () => {
  const signal = combineSignals(undefined, 5)
  assert.equal(signal.aborted, false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(signal.aborted, true)
})

test('combineSignals links a parent signal so host cancellation propagates', () => {
  const parent = new AbortController()
  const signal = combineSignals(parent.signal, REQUEST_TIMEOUT_MS)
  assert.equal(signal.aborted, false)
  parent.abort()
  assert.equal(signal.aborted, true)
})

test('abortableDelay rejects immediately when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled by host'))
  await assert.rejects(() => abortableDelay(1000, controller.signal), /cancelled by host/)
})

test('abortableDelay resolves after the delay when not aborted', async () => {
  await abortableDelay(1, new AbortController().signal)
})

// ── bounded IO ──────────────────────────────────────────────────────────────
test('readLimitedText returns small bodies verbatim', async () => {
  const text = await readLimitedText(jsonResponse({ ok: true }))
  assert.deepEqual(JSON.parse(text), { ok: true })
})

test('readLimitedText rejects a body that advertises an oversized content-length', async () => {
  const res = new Response('x', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } })
  await assert.rejects(() => readLimitedText(res, 1024), /too large/)
})

test('readLimitedText enforces the byte cap while streaming', async () => {
  // A body larger than the cap with no content-length header must still be cut.
  const res = new Response('a'.repeat(5000))
  await assert.rejects(() => readLimitedText(res, 1024), /exceeds the 1024-byte limit/)
})

test('readLimitedText accepts a body exactly at the cap', async () => {
  const res = new Response('abcd')
  assert.equal(await readLimitedText(res, 4), 'abcd')
})

test('byteLength counts UTF-8 bytes, not code units', () => {
  assert.equal(byteLength('abc'), 3)
  assert.equal(byteLength('€'), 3)
  assert.equal(byteLength(''), 0)
})

// ── secret redaction (credential safety) ────────────────────────────────────
test('redactSecrets strips bearer tokens, basic credentials and api keys', () => {
  assert.equal(redactSecrets('Authorization: Bearer abc.def.ghi'), 'Authorization: [redacted]')
  assert.match(redactSecrets('Basic dXNlcjpwYXNzd29yZA=='), /\[redacted\]/)
  assert.match(redactSecrets('apikey=SUPERSECRETVALUE123'), /\[redacted\]/)
  assert.match(redactSecrets('token: "abcdef123456"'), /\[redacted\]/)
  assert.match(redactSecrets('sk-abcdefghij1234567890'), /\[redacted\]/)
})

test('redactSecrets leaves ordinary log prose intact', () => {
  const line = 'Connection refused to database after 30000ms for user request'
  assert.equal(redactSecrets(line), line)
})

test('redactSecrets survives null/undefined input', () => {
  assert.equal(redactSecrets(null), '')
  assert.equal(redactSecrets(undefined), '')
})

// ── text hygiene (untrusted data can never forge rows) ──────────────────────
test('oneLine collapses newlines/tabs and truncates', () => {
  assert.equal(oneLine('a\nb\tc'), 'a b c')
  assert.equal(oneLine('abcdef', 3), 'abc')
  assert.equal(oneLine(null), '')
})

test('truncate adds an ellipsis only when over the limit', () => {
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcdef', 4), 'abc…')
})

test('safeErrorDetail prefers error.reason/type from OpenSearch bodies', () => {
  assert.equal(safeErrorDetail(JSON.stringify({ error: { type: 'index_not_found_exception', reason: 'no such index [logs]' } })), 'index_not_found_exception: no such index [logs]')
  assert.equal(safeErrorDetail(JSON.stringify({ message: 'bad request' })), 'bad request')
  assert.equal(safeErrorDetail('plain text failure'), 'plain text failure')
  assert.equal(safeErrorDetail(''), 'no error details')
})

test('safeErrorDetail is single-lined and bounded', () => {
  const detail = safeErrorDetail(JSON.stringify({ error: { reason: 'line1\nline2\nline3' } }))
  assert.ok(!detail.includes('\n'))
})

// ── numeric bounding ────────────────────────────────────────────────────────
test('requireBoundedInteger returns the fallback for empty input and rejects out-of-range', () => {
  assert.equal(requireBoundedInteger(undefined, 'size', 1, 10, 5), 5)
  assert.equal(requireBoundedInteger('', 'size', 1, 10, 5), 5)
  assert.equal(requireBoundedInteger(7, 'size', 1, 10, 5), 7)
  assert.throws(() => requireBoundedInteger(11, 'size', 1, 10, 5), /size must be an integer between 1 and 10/)
  assert.throws(() => requireBoundedInteger(1.5, 'size', 1, 10, 5), /size must be an integer/)
})

test('clampInteger degrades gracefully instead of throwing', () => {
  assert.equal(clampInteger(undefined, 1, 10, 5), 5)
  assert.equal(clampInteger(999, 1, 10, 5), 10)
  assert.equal(clampInteger(-3, 1, 10, 5), 1)
  assert.equal(clampInteger('7.9', 1, 10, 5), 7)
  assert.equal(clampInteger('nope', 1, 10, 5), 5)
})

// ── index/pattern validation (path-injection guard) ─────────────────────────
test('validateIndexPattern accepts safe names, wildcards and comma lists', () => {
  assert.equal(validateIndexPattern('logs-2024.01'), 'logs-2024.01')
  assert.equal(validateIndexPattern('logs-*'), 'logs-*')
  assert.equal(validateIndexPattern('a,b , c'), 'a,b,c')
})

test('validateIndexPattern rejects path/query injection characters', () => {
  assert.throws(() => validateIndexPattern('logs/_search?x=1'), /invalid index name or pattern/)
  assert.throws(() => validateIndexPattern('../etc/passwd'), /invalid index name or pattern/)
  assert.throws(() => validateIndexPattern('logs with space'), /invalid index name or pattern/)
})

test('validateIndexPattern enforces required, length and comma-count limits', () => {
  assert.throws(() => validateIndexPattern(''), /index is required/)
  assert.equal(validateIndexPattern('', { required: false }), '')
  assert.throws(() => validateIndexPattern('a'.repeat(257)), /must not exceed 256 characters/)
  assert.throws(() => validateIndexPattern(Array.from({ length: 21 }, (_, i) => `i${i}`).join(',')), /too many comma-separated patterns/)
})

test('isPlainObject distinguishes objects from arrays and null', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject('x'), false)
})

test('textOut wraps a value in a single text content block', () => {
  assert.deepEqual(textOut('hello'), [{ type: 'text', text: 'hello' }])
  assert.deepEqual(textOut(42), [{ type: 'text', text: '42' }])
})
