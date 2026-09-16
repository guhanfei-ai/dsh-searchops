import assert from 'node:assert/strict'
import test from 'node:test'

import { translateHttpFailure, translateNetworkFailure } from '../lib/failures.js'

// ── translateHttpFailure: the agent must be able to react differently ───────
test('a 400/422 is reported as a malformed request with query guidance', () => {
  const msg = translateHttpFailure({ status: 400, method: 'POST', path: '/logs/_search', body: JSON.stringify({ error: { type: 'parsing_exception', reason: 'unexpected token' } }) })
  assert.match(msg, /Search API 400 POST \/logs\/_search:/)
  assert.match(msg, /rejected as malformed/)
  assert.match(msg, /parsing_exception: unexpected token/)
  assert.match(msg, /Check the query DSL/)
})

test('a 401 is reported as an authentication failure without leaking the credential', () => {
  const body = JSON.stringify({ error: { reason: 'unable to authenticate user, Bearer SUPERSECRETVALUE rejected' } })
  const msg = translateHttpFailure({ status: 401, method: 'GET', path: '/', sourceName: 'prod', body })
  assert.match(msg, /authentication failed for source "prod"/)
  assert.match(msg, /credential is missing, expired, or invalid/)
  assert.ok(!msg.includes('SUPERSECRETVALUE'), 'the secret must be redacted')
  assert.match(msg, /\[redacted\]/)
})

test('a 403 is reported as permission denied (authenticated but not allowed)', () => {
  const msg = translateHttpFailure({ status: 403, sourceName: 'prod', body: JSON.stringify({ error: { reason: 'forbidden' } }) })
  assert.match(msg, /permission denied for source "prod"/)
  assert.match(msg, /not allowed to perform this action/)
})

test('a 404 distinguishes a missing index from a generic not-found', () => {
  const missing = translateHttpFailure({ status: 404, sourceName: 'prod', body: JSON.stringify({ error: { type: 'index_not_found_exception', reason: 'no such index [logs-2020]' } }) })
  assert.match(missing, /index or pattern does not exist/)
  assert.match(missing, /searchops_indices/)
  const generic = translateHttpFailure({ status: 404, sourceName: 'prod', body: JSON.stringify({ error: { reason: 'not found' } }) })
  assert.match(generic, /not found on source "prod"/)
  assert.ok(!/index or pattern does not exist/.test(generic))
})

test('408/413/429 and 5xx each get a distinct, actionable message', () => {
  assert.match(translateHttpFailure({ status: 408 }), /search backend timed out/)
  assert.match(translateHttpFailure({ status: 413 }), /request body was too large/)
  assert.match(translateHttpFailure({ status: 429 }), /rate-limiting/)
  const server = translateHttpFailure({ status: 503, sourceName: 'prod', body: JSON.stringify({ error: { reason: 'unavailable' } }) })
  assert.match(server, /server error on source "prod"/)
  assert.match(server, /searchops_status/)
})

test('an unknown status still yields the bounded detail, never an empty message', () => {
  const msg = translateHttpFailure({ status: 418, method: 'GET', path: '/x', body: 'teapot' })
  assert.match(msg, /Search API 418 GET \/x:/)
  assert.match(msg, /teapot/)
})

test('the error detail is single-lined and redacted even from a raw upstream body', () => {
  const msg = translateHttpFailure({ status: 500, body: 'gateway error\nAuthorization: Basic dXNlcjpwYXNzd29yZA==' })
  assert.ok(!msg.includes('\n'))
  assert.ok(!msg.includes('dXNlcjpwYXNzd29yZA=='))
})

// ── translateNetworkFailure: fetch-level problems, categorized ──────────────
test('an aborted request is reported as a timeout/cancellation', () => {
  const msg = translateNetworkFailure({ error: new Error('This operation was aborted'), method: 'POST', path: '/logs/_search', sourceName: 'prod', aborted: true })
  assert.match(msg, /timed out or was cancelled/)
  assert.match(msg, /POST \/logs\/_search on source "prod"/)
})

test('DNS, connection-refused and TLS failures are named explicitly', () => {
  assert.match(translateNetworkFailure({ error: new Error('getaddrinfo ENOTFOUND search.example.com'), sourceName: 'prod' }), /Cannot resolve the host/)
  assert.match(translateNetworkFailure({ error: new Error('connect ECONNREFUSED 127.0.0.1:9200'), sourceName: 'prod' }), /Connection refused by/)
  assert.match(translateNetworkFailure({ error: new Error('self signed certificate in certificate chain'), sourceName: 'prod' }), /TLS\/certificate error/)
})

test('a network error message never carries a raw secret verbatim', () => {
  const msg = translateNetworkFailure({ error: new Error('failed https://x?token=Bearer SECRETVALUE123'), sourceName: 'prod' })
  assert.ok(!msg.includes('SECRETVALUE123'))
})

test('an unclassified network failure falls back to a generic, bounded message', () => {
  const msg = translateNetworkFailure({ error: new Error('socket hang up'), method: 'GET', path: '/', sourceName: 'prod' })
  assert.match(msg, /Search request failed: GET \/ on source "prod"/)
  assert.match(msg, /socket hang up/)
})
