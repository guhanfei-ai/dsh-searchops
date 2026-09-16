// lib/investigate.js — searchops_investigate: the deterministic evidence engine
// and the plugin's highest-value feature. Given "something is wrong with X in the
// last 15 minutes", it runs a fixed, bounded, read-only sequence and returns a
// structured evidence package:
//   resolve fields (via mapping) → find error-level logs → group them into
//   recurring fingerprints → identify representative events → extract trace ids
//   → pull correlated context for the top traces → emit evidence + correlations
//   + deterministic next-query suggestions.
//
// Crucially, the plugin COLLECTS AND ORGANIZES EVIDENCE; it does NOT decide the
// root cause. Reasoning over the evidence package is the model's job. Every step
// is bounded and every returned value is untrusted data.
import {
  ERROR_LEVELS,
  INVESTIGATE_DEFAULT_FROM,
  INVESTIGATE_DEFAULT_MAX_EVIDENCE,
  INVESTIGATE_MAX_CORRELATIONS,
  INVESTIGATE_MAX_DOCS,
  INVESTIGATE_MAX_EVIDENCE,
  INVESTIGATE_MAX_PATTERNS,
  INVESTIGATE_MAX_SUGGESTIONS,
  MAX_MAPPING_FIELDS,
  MAX_MESSAGE_CHARS,
  UNTRUSTED_NOTE,
} from './constants.js'
import { boolQuery, fieldEquals, simpleText } from './dsl.js'
import { profileSourceFields, resolveFieldProfile } from './fields.js'
import { groupPatterns } from './patterns.js'
import { runContext } from './context.js'
import { buildSearchBody, runSearch } from './search.js'
import { parseTimeRange, timeRangeFilter } from './time.js'
import { clampInteger, oneLine, truncate } from './util.js'
import { budgetLine, createBudget } from './budget.js'

// Bound the correlated-trace fan-out so one investigation stays inside its tool
// timeout even on a slow cluster.
const MAX_TRACE_LOOKUPS = 3

// Collect every field path across all indices in a mapping response, so field
// auto-detection sees the real schema instead of guessing.
function collectMappingFields(mapping) {
  const set = new Set()
  for (const idx of (mapping && Array.isArray(mapping.indices) ? mapping.indices : [])) {
    for (const f of (idx && Array.isArray(idx.fields) ? idx.fields : [])) {
      if (f && typeof f.path === 'string' && f.path) set.add(f.path)
    }
  }
  return set
}

// Expand ERROR_LEVELS into the case variants an OpenSearch term filter needs, and
// target both the field and its .keyword sub-field.
function errorLevelTerms(levelField) {
  if (!levelField) return null
  const variants = new Set()
  for (const lvl of ERROR_LEVELS) {
    variants.add(lvl)
    variants.add(lvl.toUpperCase())
    variants.add(lvl.toLowerCase())
  }
  const list = [...variants]
  return {
    bool: {
      should: [
        { terms: { [levelField]: list } },
        { terms: { [`${levelField}.keyword`]: list } },
      ],
      minimum_should_match: 1,
    },
  }
}

function distinctServices(logs) {
  const set = new Set()
  for (const log of logs) if (log && log.service) set.add(log.service)
  return [...set].slice(0, 10)
}

export async function runInvestigate(provider, params = {}) {
  const {
    index, profile = {}, query, service, from, to, maxEvidence, signal, timeoutMs,
  } = params

  const range = parseTimeRange({ from, to }, { defaultFrom: INVESTIGATE_DEFAULT_FROM, field: 'investigation window' })
  const evidenceCap = clampInteger(maxEvidence, 1, INVESTIGATE_MAX_EVIDENCE, INVESTIGATE_DEFAULT_MAX_EVIDENCE)
  const budget = createBudget()

  // Step 1 — resolve the real schema (best-effort). A mapping failure is not
  // fatal: we fall back to convention-based detection and record why.
  let availableFields = null
  let mappingError = null
  try {
    const mapping = await provider.getMapping({ index, maxFields: MAX_MAPPING_FIELDS, signal, timeoutMs })
    availableFields = collectMappingFields(mapping)
  } catch (error) {
    mappingError = oneLine(error?.message ?? 'mapping unavailable', 160)
  }

  const fields = resolveFieldProfile({ profile, availableFields })

  // Step 2 — find error-level logs in the window (bounded to INVESTIGATE_MAX_DOCS).
  const filter = []
  const time = timeRangeFilter(fields.timestampField, range)
  if (time) filter.push(time)
  if (service && fields.serviceField) {
    const svc = fieldEquals(fields.serviceField, service)
    if (svc) filter.push(svc)
  }
  const levelClause = errorLevelTerms(fields.levelField)
  if (levelClause) filter.push(levelClause)

  const must = []
  if (query && String(query).trim()) {
    const text = simpleText([fields.messageField, fields.serviceField].filter(Boolean), query)
    if (text) must.push(text)
  }

  const searchBody = buildSearchBody({
    query: boolQuery({ must, filter }),
    size: Math.min(INVESTIGATE_MAX_DOCS, 500),
    sort: fields.timestampField ? [{ [fields.timestampField]: { order: 'desc' } }] : undefined,
    sourceFilter: profileSourceFields(fields),
  })
  const result = await runSearch(provider, { index, body: searchBody, signal, timeoutMs })

  // Step 3 — group the docs into recurring fingerprints (deterministic, no ML).
  const grouped = groupPatterns(result.hits, fields, {
    maxPatterns: INVESTIGATE_MAX_PATTERNS,
    maxSamplesPerPattern: 1,
    maxTraceIds: 5,
  })
  if (grouped.truncated) budget.spend(grouped.totalPatterns - grouped.patterns.length, 'pattern(s)', grouped.patterns.length)
  if (result.truncated && Number.isFinite(result.total?.value)) {
    budget.spend(Math.max(0, result.total.value - result.returned), 'matching doc(s)', result.returned)
  }

  // Step 4 — representative evidence drawn from the top patterns.
  const evidence = grouped.patterns.slice(0, evidenceCap).map((p, i) => ({
    rank: i + 1,
    pattern: p.label,
    count: p.count,
    firstSeen: p.firstSeen || null,
    lastSeen: p.lastSeen || null,
    services: p.services,
    traceIds: p.traceIds,
    sample: p.sample ? {
      id: p.sample.id || null,
      index: p.sample.index || null,
      timestamp: p.sample.timestamp || null,
      message: truncate(oneLine(p.sample.message, MAX_MESSAGE_CHARS), MAX_MESSAGE_CHARS),
    } : null,
  }))
  if (grouped.patterns.length > evidence.length) {
    budget.spend(grouped.patterns.length - evidence.length, 'evidence pattern(s)', evidence.length)
  }

  // Step 5 — extract distinct trace ids across the top patterns and pull
  // correlated context for a few of them (bounded fan-out).
  const traceIds = []
  for (const p of grouped.patterns) {
    for (const t of (p.traceIds || [])) {
      if (t && !traceIds.includes(t)) traceIds.push(t)
    }
  }
  const correlations = []
  if (fields.traceIdField && traceIds.length) {
    const topTraces = traceIds.slice(0, INVESTIGATE_MAX_CORRELATIONS)
    for (const traceId of topTraces.slice(0, MAX_TRACE_LOOKUPS)) {
      try {
        const ctx = await runContext(provider, { index, profile, availableFields, traceId, lines: 20, signal, timeoutMs })
        correlations.push({
          traceId,
          events: ctx.returned,
          services: distinctServices(ctx.logs),
          sample: (ctx.logs || []).slice(0, 3).map((l) => ({
            timestamp: l.timestamp ?? null,
            service: l.service ?? null,
            level: l.level ?? null,
            message: truncate(oneLine(l.message ?? '', MAX_MESSAGE_CHARS), MAX_MESSAGE_CHARS),
          })),
        })
      } catch {
        // A single failed correlation is non-fatal; the rest of the evidence stands.
      }
    }
    if (topTraces.length > correlations.length) {
      budget.spend(topTraces.length - correlations.length, 'correlated trace(s)', correlations.length)
    }
  }

  // Step 6 — deterministic next-query suggestions derived from the evidence.
  // These are actions the agent can take, never conclusions about cause.
  const suggestions = []
  const top = grouped.patterns[0]
  if (top) {
    suggestions.push(`searchops_logs on ${index} with query=${JSON.stringify(truncate(top.label, 60))} to read the raw lines behind the top pattern (${top.count} in window).`)
  }
  if (traceIds[0]) {
    suggestions.push(`searchops_context on ${index} with traceId=${JSON.stringify(traceIds[0])} to see the full request path for one affected event.`)
  }
  if (fields.serviceField) {
    suggestions.push(`searchops_aggregate on ${index} groupBy=${JSON.stringify(fields.serviceField)} to see which services emit the most errors in the window.`)
  }
  if (fields.timestampField) {
    suggestions.push(`searchops_aggregate on ${index} interval=5m to see when the errors started and whether they are still rising.`)
  }
  if (fields.levelField) {
    suggestions.push(`searchops_aggregate on ${index} groupBy=${JSON.stringify(fields.levelField)} to confirm the severity distribution.`)
  }

  const summary = {
    index,
    from: range.from,
    to: range.to,
    service: service || null,
    query: query ? oneLine(query, 120) : null,
    scannedDocs: result.returned,
    totalMatches: result.total,
    distinctPatterns: grouped.totalPatterns,
    fields: {
      timestampField: fields.timestampField,
      messageField: fields.messageField,
      serviceField: fields.serviceField,
      levelField: fields.levelField,
      traceIdField: fields.traceIdField,
    },
    detectedFields: fields.detected,
    levelFilterApplied: Boolean(levelClause),
    mappingError,
    note: UNTRUSTED_NOTE,
  }

  return {
    summary,
    evidence,
    correlations,
    suggestedNextQueries: suggestions.slice(0, INVESTIGATE_MAX_SUGGESTIONS),
    traceIds: traceIds.slice(0, INVESTIGATE_MAX_CORRELATIONS),
    budgetNote: budgetLine(budget),
  }
}
