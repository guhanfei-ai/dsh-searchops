// lib/context.js — searchops_context domain logic: fetch the surrounding lines
// of a log event, or every event sharing a trace id. When an agent finds one
// interesting line, the next question is always "what happened around it?" — this
// answers that deterministically and bounded, either by a time window
// (before/after a timestamp) or by correlation (all events with the same trace
// id). It never guesses; it only returns what the cluster actually has, and all
// returned content is untrusted data.
import {
  DEFAULT_CONTEXT_LINES,
  DEFAULT_LOGS_LIMIT,
  MAX_CONTEXT_LINES,
  MAX_CONTEXT_WINDOW_SECONDS,
  MAX_LOGS_LIMIT,
} from './constants.js'
import { boolQuery, fieldEquals, rangeFilter } from './dsl.js'
import { profileSourceFields, resolveFieldProfile } from './fields.js'
import { projectLog } from './logs.js'
import { buildSearchBody, runSearch } from './search.js'
import { estimateMillis, normalizeTimeValue } from './time.js'
import { clampInteger } from './util.js'
import { budgetLine, createBudget } from './budget.js'

const DEFAULT_CONTEXT_WINDOW_SECONDS = 300

export async function runContext(provider, params = {}) {
  const {
    index, profile = {}, availableFields = null, timestamp, traceId, service,
    lines, windowSeconds, signal, timeoutMs,
  } = params

  const fields = resolveFieldProfile({ profile, availableFields })
  const n = clampInteger(lines, 1, MAX_CONTEXT_LINES, DEFAULT_CONTEXT_LINES)
  const sourceFields = profileSourceFields(fields)
  const sortAsc = fields.timestampField ? [{ [fields.timestampField]: { order: 'asc' } }] : undefined

  // Mode 1 — trace correlation: all events sharing a trace/request/correlation
  // id, ordered by time. The most useful "context" for a distributed request.
  const tid = String(traceId ?? '').trim()
  if (tid && fields.traceIdField) {
    const filter = [fieldEquals(fields.traceIdField, tid)]
    if (service && fields.serviceField) filter.push(fieldEquals(fields.serviceField, service))
    const body = buildSearchBody({
      query: boolQuery({ filter: filter.filter(Boolean) }),
      size: Math.min(MAX_LOGS_LIMIT, Math.max(n * 4, DEFAULT_LOGS_LIMIT)),
      sort: sortAsc,
      sourceFilter: sourceFields,
    })
    const result = await runSearch(provider, { index, body, signal, timeoutMs })
    const logs = result.hits.map((h) => projectLog(h, fields))
    const budget = createBudget()
    if (result.truncated && Number.isFinite(result.total?.value)) {
      budget.spend(Math.max(0, result.total.value - result.returned), 'event(s)', result.returned)
    }
    return {
      mode: 'trace',
      traceId: tid,
      index,
      logs,
      total: result.total,
      returned: result.returned,
      took: result.took,
      fields,
      budgetNote: budgetLine(budget),
    }
  }

  // Mode 2 — time window around a timestamp: `n` lines before and `n` after,
  // within a bounded window each side.
  const anchorRaw = String(timestamp ?? '').trim()
  if (!anchorRaw) {
    throw new Error('context needs either a traceId (to pull a whole request) or a timestamp (to pull surrounding lines).')
  }
  if (!fields.timestampField) {
    throw new Error('A time-based context needs a timestamp field; none is configured or detected for this source.')
  }
  const anchor = normalizeTimeValue(anchorRaw, { field: 'timestamp' })
  const anchorMs = estimateMillis(anchor)
  if (anchorMs === null) {
    throw new Error(`Could not interpret timestamp ${JSON.stringify(anchor)} as a point in time for the context window.`)
  }
  const win = clampInteger(windowSeconds, 1, MAX_CONTEXT_WINDOW_SECONDS, DEFAULT_CONTEXT_WINDOW_SECONDS)
  const fromMs = anchorMs - win * 1000
  const toMs = anchorMs + win * 1000

  const baseFilter = []
  if (service && fields.serviceField) baseFilter.push(fieldEquals(fields.serviceField, service))

  // before: [fromMs, anchorMs], newest first (reversed to ascending below).
  const beforeBody = buildSearchBody({
    query: boolQuery({ filter: [...baseFilter, rangeFilter(fields.timestampField, { gte: fromMs, lte: anchorMs, format: 'epoch_millis' })].filter(Boolean) }),
    size: n,
    sort: fields.timestampField ? [{ [fields.timestampField]: { order: 'desc' } }] : undefined,
    sourceFilter: sourceFields,
  })
  // after: (anchorMs, toMs], oldest first.
  const afterBody = buildSearchBody({
    query: boolQuery({ filter: [...baseFilter, rangeFilter(fields.timestampField, { gt: anchorMs, lte: toMs, format: 'epoch_millis' })].filter(Boolean) }),
    size: n,
    sort: sortAsc,
    sourceFilter: sourceFields,
  })

  const [beforeRes, afterRes] = await Promise.all([
    runSearch(provider, { index, body: beforeBody, signal, timeoutMs }),
    runSearch(provider, { index, body: afterBody, signal, timeoutMs }),
  ])

  const beforeHits = beforeRes.hits.slice().reverse()
  const seen = new Set()
  const merged = []
  for (const hit of [...beforeHits, ...afterRes.hits]) {
    const key = hit.id || `${hit.index}:${JSON.stringify(hit.source)}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(hit)
  }
  const logs = merged.map((h) => projectLog(h, fields))

  // A side that filled its `n` budget likely has more lines just outside; say so.
  const beforeSaturated = beforeRes.hits.length >= n
  const afterSaturated = afterRes.hits.length >= n

  return {
    mode: 'timestamp',
    anchor,
    index,
    windowSeconds: win,
    before: beforeHits.length,
    after: afterRes.hits.length,
    beforeSaturated,
    afterSaturated,
    logs,
    returned: logs.length,
    took: (beforeRes.took ?? 0) + (afterRes.took ?? 0),
    fields,
  }
}
