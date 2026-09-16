// lib/logs.js — searchops_logs domain logic: a *semantic* log query. The agent
// says "errors from checkout-service in the last hour matching 'timeout'" and we
// translate that into a bounded OpenSearch query using the resolved field
// profile, then project each hit down to a small, safe, readable line. Every cap
// (time window, size, per-message length) is enforced here so the tool layer
// stays thin. Results are untrusted data: messages are single-lined, truncated
// and never interpreted.
import {
  DEFAULT_LOGS_FROM,
  DEFAULT_LOGS_LIMIT,
  MAX_FIELD_VALUE_CHARS,
  MAX_LOGS_LIMIT,
  MAX_MESSAGE_CHARS,
} from './constants.js'
import { boolQuery, fieldEquals, levelFilter, simpleText } from './dsl.js'
import { getByPath, profileSourceFields, resolveFieldProfile } from './fields.js'
import { buildSearchBody, clampSize, runSearch } from './search.js'
import { parseTimeRange, timeRangeFilter } from './time.js'
import { oneLine, truncate } from './util.js'
import { budgetLine, createBudget } from './budget.js'

// Resolve the effective field profile for a logs query. `availableFields` (from
// the mapping) lets detection pick the real field names; without it we fall back
// to convention. Pure and side-effect free.
export function resolveLogsFields({ profile = {}, availableFields = null } = {}) {
  return resolveFieldProfile({ profile, availableFields })
}

// Build the bool query for a logs request. Filters are cheap (filter context,
// no scoring): time range, service equality, level. The free-text `query` is a
// lenient simple_query_string across the message (+ service and any extra
// fields) so arbitrary agent text never 400s on stray operators.
export function buildLogsQuery({ fields = {}, from, to, service, level, query, extraMatchFields = [] } = {}) {
  const filter = []
  const must = []

  const time = timeRangeFilter(fields.timestampField, { from, to })
  if (time) filter.push(time)

  if (service && fields.serviceField) {
    const svc = fieldEquals(fields.serviceField, service)
    if (svc) filter.push(svc)
  }

  if (level && fields.levelField) {
    // Match on the field and its .keyword sub-field, case-insensitively.
    const variants = [levelFilter(fields.levelField, level), levelFilter(`${fields.levelField}.keyword`, level)].filter(Boolean)
    if (variants.length === 1) filter.push(variants[0])
    else if (variants.length > 1) filter.push({ bool: { should: variants, minimum_should_match: 1 } })
  }

  if (query && String(query).trim()) {
    const textFields = [...new Set([fields.messageField, fields.serviceField, ...extraMatchFields].filter(Boolean))]
    const text = simpleText(textFields, query)
    if (text) must.push(text)
  }

  return boolQuery({ must, filter })
}

// Project one search hit into a small, bounded log line. Empty keys are dropped
// so the output stays compact; long values are truncated and single-lined.
export function projectLog(hit, fields = {}, requestedFields = []) {
  const doc = hit && typeof hit === 'object' && hit.source ? hit.source : {}
  const out = {}

  const ts = getByPath(doc, fields.timestampField)
  if (ts != null && ts !== '') out.timestamp = truncate(oneLine(ts, MAX_FIELD_VALUE_CHARS), MAX_FIELD_VALUE_CHARS)

  if (fields.serviceField) {
    const svc = getByPath(doc, fields.serviceField)
    if (svc != null && svc !== '') out.service = truncate(oneLine(svc, MAX_FIELD_VALUE_CHARS), MAX_FIELD_VALUE_CHARS)
  }

  if (fields.levelField) {
    const lvl = getByPath(doc, fields.levelField)
    if (lvl != null && lvl !== '') out.level = truncate(oneLine(lvl, MAX_FIELD_VALUE_CHARS), MAX_FIELD_VALUE_CHARS)
  }

  const rawMessage = getByPath(doc, fields.messageField)
  const messageText = rawMessage == null ? '' : (typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage))
  out.message = truncate(oneLine(messageText, MAX_MESSAGE_CHARS), MAX_MESSAGE_CHARS)

  if (fields.traceIdField) {
    const trace = getByPath(doc, fields.traceIdField)
    if (trace != null && trace !== '') out.traceId = truncate(oneLine(trace, MAX_FIELD_VALUE_CHARS), MAX_FIELD_VALUE_CHARS)
  }

  if (hit && typeof hit === 'object') {
    if (hit.id) out.id = hit.id
    if (hit.index) out.index = hit.index
  }

  if (Array.isArray(requestedFields) && requestedFields.length) {
    const extra = {}
    for (const f of requestedFields) {
      const v = getByPath(doc, f)
      if (v == null || v === '') continue
      extra[f] = truncate(oneLine(typeof v === 'string' ? v : JSON.stringify(v), MAX_FIELD_VALUE_CHARS), MAX_FIELD_VALUE_CHARS)
    }
    if (Object.keys(extra).length) out.fields = extra
  }

  return out
}

// Orchestrate a bounded logs query end-to-end and return a provider-neutral
// envelope. Never fabricates rows; always reports the resolved fields (with a
// `detected` map so the tool can flag guessed fields) and any truncation.
export async function runLogs(provider, params = {}) {
  const {
    index,
    profile = {},
    availableFields = null,
    from,
    to,
    service,
    level,
    query,
    limit,
    fields: extraFields,
    signal,
    timeoutMs,
  } = params

  const range = parseTimeRange({ from, to }, { defaultFrom: DEFAULT_LOGS_FROM, field: 'logs time range' })
  const size = clampSize(limit, { def: DEFAULT_LOGS_LIMIT, max: MAX_LOGS_LIMIT })
  const fields = resolveLogsFields({ profile, availableFields })

  const requestedFields = Array.isArray(extraFields)
    ? [...new Set(extraFields.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim()))].slice(0, 20)
    : []

  const bool = buildLogsQuery({ fields, from: range.from, to: range.to, service, level, query, extraMatchFields: requestedFields })
  const sourceFields = [...new Set([...profileSourceFields(fields), ...requestedFields])]
  const sort = fields.timestampField ? [{ [fields.timestampField]: { order: 'desc' } }] : undefined

  const body = buildSearchBody({ query: bool, size: size.size, sort, sourceFilter: sourceFields })
  const result = await runSearch(provider, { index, body, signal, timeoutMs })

  const logs = result.hits.map((hit) => projectLog(hit, fields, requestedFields))

  const budget = createBudget()
  if (result.truncated && Number.isFinite(result.total?.value)) {
    budget.spend(Math.max(0, result.total.value - result.returned), 'log(s)', result.returned)
  }

  return {
    logs,
    fields,
    total: result.total,
    returned: result.returned,
    limit: size.size,
    clamped: size.clamped,
    truncated: result.truncated,
    took: result.took,
    from: range.from,
    to: range.to,
    budgetNote: budgetLine(budget),
  }
}
