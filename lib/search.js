// lib/search.js — The bounded search core behind searchops_query and reused by
// the higher-level tools. It enforces every size/offset/byte cap so no single
// agent call can pull gigabytes or force a full count of a huge index, and it
// normalizes the result into a provider-neutral envelope with explicit
// truncation. It never fabricates data and never silently drops rows.
import {
  DEFAULT_QUERY_SIZE,
  HARD_MAX_SIZE,
  MAX_QUERY_BODY_BYTES,
  MAX_QUERY_SIZE,
  MAX_TRACK_TOTAL_HITS,
} from './constants.js'
import { byteLength, isPlainObject, validateIndexPattern } from './util.js'

// Deep pagination guard: OpenSearch's default max_result_window is 10000; beyond
// that you must use search_after, which v0.1 does not expose. Reject rather than
// let the agent hit a confusing upstream error.
const MAX_SEARCH_FROM = 10_000

// Clamp the requested size into [1, effectiveMax]. Returns the effective size and
// whether it was clamped down (so the tool can disclose it).
export function clampSize(size, { def = DEFAULT_QUERY_SIZE, max = MAX_QUERY_SIZE } = {}) {
  if (size === undefined || size === null || String(size).trim() === '') return { size: def, clamped: false }
  const n = Number(size)
  if (!Number.isFinite(n) || n < 1) return { size: def, clamped: false }
  const floored = Math.floor(n)
  const cap = Math.min(max, HARD_MAX_SIZE)
  if (floored > cap) return { size: cap, clamped: true }
  return { size: floored, clamped: false }
}

// Validate `from` (result offset). Reject deep pagination with a clear message.
export function clampFrom(from) {
  if (from === undefined || from === null || String(from).trim() === '') return { from: 0 }
  const n = Number(from)
  if (!Number.isFinite(n) || n < 0) return { from: 0 }
  const floored = Math.floor(n)
  if (floored > MAX_SEARCH_FROM) {
    throw new Error(`from=${floored} exceeds the ${MAX_SEARCH_FROM} offset limit. Deep pagination needs search_after, which is not exposed in v0.1; narrow the query or use aggregations instead.`)
  }
  return { from: floored }
}

// Normalize track_total_hits: boolean passes through; a number is capped so the
// agent cannot force an exact count over a billion-doc index.
export function normalizeTrackTotalHits(value) {
  if (value === true || value === false) return value
  if (value === undefined || value === null || String(value).trim() === '') return MAX_TRACK_TOTAL_HITS
  const n = Number(value)
  if (!Number.isFinite(n)) return MAX_TRACK_TOTAL_HITS
  return Math.max(1, Math.min(MAX_TRACK_TOTAL_HITS, Math.floor(n)))
}

// Normalize the _source field filter: boolean, array of field paths, or
// {includes,excludes}. Bounded to a sane number of fields.
export function normalizeSourceFilter(fields) {
  if (fields === undefined || fields === null || fields === '') return undefined
  if (typeof fields === 'boolean') return fields
  if (typeof fields === 'string') return [fields]
  if (Array.isArray(fields)) return fields.filter((f) => typeof f === 'string' && f.trim()).slice(0, 100)
  if (isPlainObject(fields)) {
    const out = {}
    if (Array.isArray(fields.includes)) out.includes = fields.includes.filter((f) => typeof f === 'string').slice(0, 100)
    if (Array.isArray(fields.excludes)) out.excludes = fields.excludes.filter((f) => typeof f === 'string').slice(0, 100)
    return Object.keys(out).length ? out : undefined
  }
  return undefined
}

// Validate the agent-supplied query DSL object and enforce a serialized byte cap.
export function validateQueryDsl(query) {
  let value = query
  if (value === undefined || value === null || (isPlainObject(value) && Object.keys(value).length === 0)) {
    return { match_all: {} }
  }
  if (typeof value === 'string') {
    let parsed
    try { parsed = JSON.parse(value) } catch { throw new Error('query must be a JSON object (OpenSearch query DSL) or a JSON string of one.') }
    if (!isPlainObject(parsed)) throw new Error('query must parse to a JSON object.')
    value = parsed
  }
  if (!isPlainObject(value)) throw new Error('query must be a JSON object (OpenSearch query DSL).')
  const bytes = byteLength(JSON.stringify(value))
  if (bytes > MAX_QUERY_BODY_BYTES) {
    throw new Error(`query DSL is too large (${bytes} bytes; limit ${MAX_QUERY_BODY_BYTES}). Simplify the query.`)
  }
  return value
}

// Build the final OpenSearch search body from validated, bounded parts.
// `aggs` is optional and only used by the aggregate/investigate paths; it is
// shallow-validated (must be a non-empty plain object) and counted toward the
// serialized byte guard below.
export function buildSearchBody({ query, size, from, sort, sourceFilter, trackTotalHits, aggs } = {}) {
  const body = { size, query: validateQueryDsl(query) }
  if (from) body.from = from
  if (sort !== undefined && sort !== null && !(Array.isArray(sort) && sort.length === 0)) body.sort = sort
  const sf = normalizeSourceFilter(sourceFilter)
  if (sf !== undefined) body._source = sf
  body.track_total_hits = normalizeTrackTotalHits(trackTotalHits)
  if (isPlainObject(aggs) && Object.keys(aggs).length > 0) body.aggs = aggs
  // Guard the whole serialized body (query + sort + _source) against the cap.
  const bytes = byteLength(JSON.stringify(body))
  if (bytes > MAX_QUERY_BODY_BYTES * 2) {
    throw new Error(`search request body is too large (${bytes} bytes). Reduce the query, sort or field list.`)
  }
  return body
}

// Execute a bounded search through a provider and normalize into the envelope:
// { hits, total:{value,relation}, took, returned, requested, truncated }.
export async function runSearch(provider, { index, body, signal, timeoutMs } = {}) {
  const target = validateIndexPattern(index, { field: 'index' })
  const result = await provider.search({ index: target, body, signal, timeoutMs })
  const returned = result.hits.length
  const requested = Number.isFinite(Number(body?.size)) ? Number(body.size) : returned
  return {
    hits: result.hits,
    total: result.total,
    took: result.took,
    timedOut: result.timedOut,
    aggregations: result.aggregations,
    returned,
    requested,
    // truncated if the backend counted more than it returned, or cut the count.
    truncated: (result.total?.relation === 'gte' && result.total.value > returned) || returned < requested,
  }
}
