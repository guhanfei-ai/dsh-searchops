import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_TIME_WINDOW_DAYS } from '../lib/constants.js'
import { estimateMillis, normalizeTimeValue, parseTimeRange, timeRangeFilter } from '../lib/time.js'

// ── normalizeTimeValue: shape validation, not a full parser ─────────────────
test('normalizeTimeValue accepts now, relative date math and rounding', () => {
  assert.equal(normalizeTimeValue('now'), 'now')
  assert.equal(normalizeTimeValue('now-15m'), 'now-15m')
  assert.equal(normalizeTimeValue('now-1h'), 'now-1h')
  assert.equal(normalizeTimeValue('now-24h'), 'now-24h')
  assert.equal(normalizeTimeValue('now/d'), 'now/d')
  assert.equal(normalizeTimeValue('now-7d/d'), 'now-7d/d')
})

test('normalizeTimeValue accepts epoch millis and ISO-8601', () => {
  assert.equal(normalizeTimeValue('1700000000000'), '1700000000000')
  assert.equal(normalizeTimeValue('1700000000'), '1700000000')
  assert.equal(normalizeTimeValue('2024-01-15T10:30:00Z'), '2024-01-15T10:30:00Z')
})

test('normalizeTimeValue rejects bare words and malformed relative forms', () => {
  assert.throws(() => normalizeTimeValue('yesterday'), /must be one of/)
  assert.throws(() => normalizeTimeValue('now-'), /must be one of/)
  assert.throws(() => normalizeTimeValue('now-15x'), /must be one of/)
})

test('normalizeTimeValue handles empty input per allowEmpty', () => {
  assert.throws(() => normalizeTimeValue(''), /time is required/)
  assert.equal(normalizeTimeValue('', { allowEmpty: true }), '')
  assert.equal(normalizeTimeValue(undefined, { allowEmpty: true }), '')
})

test('normalizeTimeValue rejects over-long input', () => {
  assert.throws(() => normalizeTimeValue('x'.repeat(60)), /too long/)
})

// ── estimateMillis: window estimation with an injectable clock ──────────────
test('estimateMillis resolves relative expressions against an injectable now', () => {
  const now = 1_700_000_000_000
  assert.equal(estimateMillis('now', now), now)
  assert.equal(estimateMillis('now-15m', now), now - 15 * 60_000)
  assert.equal(estimateMillis('now-1h', now), now - 3_600_000)
  assert.equal(estimateMillis('now-2d', now), now - 2 * 86_400_000)
})

test('estimateMillis treats rounding forms as "now" for window purposes', () => {
  const now = 1_700_000_000_000
  assert.equal(estimateMillis('now/d', now), now)
})

test('estimateMillis distinguishes epoch seconds from millis', () => {
  assert.equal(estimateMillis('1700000000'), 1_700_000_000_000) // 10-digit -> seconds
  assert.equal(estimateMillis('1700000000000'), 1_700_000_000_000) // 13-digit -> millis
})

test('estimateMillis parses ISO timestamps and returns null when it cannot', () => {
  assert.equal(estimateMillis('2024-01-15T00:00:00Z'), Date.parse('2024-01-15T00:00:00Z'))
  assert.equal(estimateMillis('not-a-time'), null)
  assert.equal(estimateMillis(''), null)
})

// ── parseTimeRange: defaults + the anti-"scan-a-year" window guard ──────────
test('parseTimeRange applies defaults when from/to are omitted', () => {
  const range = parseTimeRange({}, { defaultFrom: 'now-1h' })
  assert.equal(range.from, 'now-1h')
  assert.equal(range.to, 'now')
})

test('parseTimeRange passes through explicit bounds', () => {
  const range = parseTimeRange({ from: 'now-15m', to: 'now-5m' }, { defaultFrom: 'now-1h' })
  assert.equal(range.from, 'now-15m')
  assert.equal(range.to, 'now-5m')
})

test('parseTimeRange rejects a reversed range', () => {
  const now = 1_700_000_000_000
  assert.throws(
    () => parseTimeRange({ from: 'now', to: 'now-1h' }, { defaultFrom: 'now-1h', nowMs: now }),
    /is after to/,
  )
})

test('parseTimeRange rejects a window over the maximum', () => {
  const now = 1_700_000_000_000
  const over = MAX_TIME_WINDOW_DAYS + 5
  assert.throws(
    () => parseTimeRange({ from: `now-${over}d`, to: 'now' }, { defaultFrom: 'now-1h', nowMs: now }),
    /over the 31-day limit/,
  )
})

test('parseTimeRange accepts a window within the maximum', () => {
  const now = 1_700_000_000_000
  const range = parseTimeRange({ from: 'now-7d', to: 'now' }, { defaultFrom: 'now-1h', nowMs: now })
  assert.equal(range.from, 'now-7d')
})

// ── timeRangeFilter ─────────────────────────────────────────────────────────
test('timeRangeFilter builds a range on the timestamp field', () => {
  assert.deepEqual(timeRangeFilter('@timestamp', { from: 'now-1h', to: 'now' }), { range: { '@timestamp': { gte: 'now-1h', lte: 'now' } } })
})

test('timeRangeFilter omits empty sides and returns null when unbounded or fieldless', () => {
  assert.deepEqual(timeRangeFilter('@timestamp', { from: 'now-1h' }), { range: { '@timestamp': { gte: 'now-1h' } } })
  assert.equal(timeRangeFilter('@timestamp', {}), null)
  assert.equal(timeRangeFilter('', { from: 'now-1h' }), null)
})
