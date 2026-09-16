// lib/time.js — Time-range handling. We deliberately do NOT ship a full date
// parser: OpenSearch/Elasticsearch already understand date math (`now-15m`,
// `now/d`, ISO-8601, epoch millis), so we forward the operator/agent string
// almost as-is. Our job is only to (a) reject shapes that could smuggle
// something unexpected into the query, and (b) guard the *window* so one bad
// call cannot silently scan a year of logs.

import {
  DEFAULT_TO,
  EPOCH_MILLIS_PATTERN,
  MAX_TIME_WINDOW_DAYS,
  RELATIVE_TIME_PATTERN,
} from './constants.js'
import { oneLine } from './util.js'

const UNIT_MS = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  M: 2_592_000_000, // 30d approximation — window estimation only
  y: 31_536_000_000, // 365d approximation — window estimation only
}

const MAX_TIME_INPUT_CHARS = 40

// Validate the shape of a single time value and return a trimmed string that is
// safe to forward. Accepts: `now`, relative `now-15m` / `now/d`, epoch millis
// (10–13 digits), or an ISO-8601 timestamp. Anything else throws so the agent
// gets a clear message instead of a confusing upstream 400.
export function normalizeTimeValue(value, { field = 'time', allowEmpty = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (allowEmpty) return ''
    throw new Error(`${field} is required.`)
  }
  const text = oneLine(value, MAX_TIME_INPUT_CHARS + 8)
  if (text.length > MAX_TIME_INPUT_CHARS) {
    throw new Error(`${field} is too long (max ${MAX_TIME_INPUT_CHARS} characters).`)
  }
  if (RELATIVE_TIME_PATTERN.test(text)) return text
  if (EPOCH_MILLIS_PATTERN.test(text)) return text
  // ISO-8601: must contain a date and be parseable. Reject bare words.
  if (/^\d{4}-\d{2}-\d{2}/.test(text) && !Number.isNaN(Date.parse(text))) return text
  throw new Error(
    `${field} must be one of: now, a relative expression like now-15m / now-1h / now/d, an ISO-8601 timestamp, or epoch milliseconds. Got ${JSON.stringify(text)}.`,
  )
}

// Resolve a normalized time value to approximate epoch millis for window
// estimation. Returns null when it cannot be estimated (the caller then relies
// on size caps rather than blocking). `nowMs` is injectable for deterministic
// tests.
export function estimateMillis(value, nowMs = Date.now()) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (text === 'now') return nowMs
  const rel = text.match(/^now(-\d+)([smhdwMy])/)
  if (rel) {
    const n = Number(rel[1])
    const unit = UNIT_MS[rel[2]]
    if (Number.isFinite(n) && unit) return nowMs + n * unit
  }
  // now/d and other rounding forms: approximate as "now" for window purposes.
  if (/^now\//.test(text)) return nowMs
  if (EPOCH_MILLIS_PATTERN.test(text)) {
    const n = Number(text)
    // 10-digit values are seconds; 13-digit are millis.
    return text.length <= 10 ? n * 1000 : n
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : parsed
}

// Normalize a from/to pair, applying defaults, and enforce the maximum window
// when both ends can be estimated. Returns { from, to } as forwardable strings.
export function parseTimeRange(input = {}, { defaultFrom, defaultTo = DEFAULT_TO, field = 'time range', maxWindowDays = MAX_TIME_WINDOW_DAYS, nowMs = Date.now() } = {}) {
  const from = input.from === undefined || input.from === null || String(input.from).trim() === ''
    ? (defaultFrom ? normalizeTimeValue(defaultFrom, { field: `${field} from` }) : '')
    : normalizeTimeValue(input.from, { field: `${field} from` })
  const to = input.to === undefined || input.to === null || String(input.to).trim() === ''
    ? normalizeTimeValue(defaultTo, { field: `${field} to` })
    : normalizeTimeValue(input.to, { field: `${field} to` })

  if (from && to) {
    const fromMs = estimateMillis(from, nowMs)
    const toMs = estimateMillis(to, nowMs)
    if (fromMs !== null && toMs !== null) {
      if (fromMs > toMs) {
        throw new Error(`${field}: from (${from}) is after to (${to}).`)
      }
      const maxMs = maxWindowDays * 86_400_000
      if (toMs - fromMs > maxMs) {
        const days = Math.round((toMs - fromMs) / 86_400_000)
        throw new Error(`${field} spans about ${days} days, over the ${maxWindowDays}-day limit. Narrow the range so a single call cannot scan the whole index.`)
      }
    }
  }
  return { from, to }
}

// Build an OpenSearch range filter on the timestamp field. Empty from/to are
// omitted so an unbounded side stays unbounded rather than becoming "epoch 0".
export function timeRangeFilter(timestampField, { from, to }) {
  if (!timestampField) return null
  const range = {}
  if (from) range.gte = from
  if (to) range.lte = to
  if (Object.keys(range).length === 0) return null
  return { range: { [timestampField]: range } }
}
