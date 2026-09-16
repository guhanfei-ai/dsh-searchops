// lib/aggregate.js — searchops_aggregate domain logic: turn a high-level intent
// ("top error messages", "requests per service", "errors over time") into a
// bounded OpenSearch aggregation, then normalize the bucket response into a
// compact shape. Aggregations are how an agent reasons over millions of docs
// without pulling them: we ask the cluster to count/group and return only the
// buckets. Every bucket list is capped and any truncation is disclosed.
import {
  DEFAULT_AGG_LIMIT,
  DEFAULT_LOGS_FROM,
  MAX_AGG_LIMIT,
  MAX_HISTOGRAM_BUCKETS,
} from './constants.js'
import { boolQuery, dateHistogramAgg, metricAgg, simpleText, termsAgg } from './dsl.js'
import { resolveFieldProfile } from './fields.js'
import { buildSearchBody, runSearch } from './search.js'
import { parseTimeRange, timeRangeFilter } from './time.js'
import { clampInteger, oneLine } from './util.js'
import { budgetLine, createBudget } from './budget.js'

// fixed_interval shapes we forward: a count plus a unit (e.g. 1m, 5m, 1h, 1d).
const INTERVAL_PATTERN = /^\d{1,4}[smhdwMy]$/
const SUPPORTED_METRICS = 'avg, min, max, sum, value_count, cardinality'

// Allow the agent to name a group field semantically ("service", "level") or
// literally ("http.response.status_code"). Semantic names map through the
// resolved profile; anything else is used as-is.
function resolveGroupField(groupBy, fields) {
  const g = String(groupBy ?? '').trim()
  if (!g) return ''
  const roleMap = {
    service: fields.serviceField,
    level: fields.levelField,
    loglevel: fields.levelField,
    severity: fields.levelField,
    timestamp: fields.timestampField,
    time: fields.timestampField,
    traceid: fields.traceIdField,
    trace: fields.traceIdField,
    message: fields.messageField,
  }
  return roleMap[g.toLowerCase()] ?? g
}

// Normalize one aggregation bucket to { key, count, metric? }.
function projectBucket(bucket, metricName) {
  const key = bucket.key_as_string !== undefined && bucket.key_as_string !== null
    ? String(bucket.key_as_string)
    : String(bucket.key ?? '')
  const out = { key, count: Number.isFinite(Number(bucket.doc_count)) ? Number(bucket.doc_count) : 0 }
  if (metricName && bucket[metricName] && Number.isFinite(Number(bucket[metricName].value))) {
    out.metric = Number(bucket[metricName].value)
  }
  return out
}

export async function runAggregate(provider, params = {}) {
  const {
    index, profile = {}, availableFields = null, from, to, filter,
    groupBy, metric, metricField, interval, limit, signal, timeoutMs,
  } = params

  const range = parseTimeRange({ from, to }, { defaultFrom: DEFAULT_LOGS_FROM, field: 'aggregate time range' })
  const fields = resolveFieldProfile({ profile, availableFields })
  const bucketLimit = clampInteger(limit, 1, MAX_AGG_LIMIT, DEFAULT_AGG_LIMIT)

  const groupField = resolveGroupField(groupBy, fields)
  const intervalStr = String(interval ?? '').trim()
  if (!groupField && !intervalStr) {
    throw new Error('aggregate needs at least one of: groupBy (a field to group by, e.g. "service" or "http.response.status_code") or interval (a date-histogram bucket, e.g. "5m", "1h").')
  }
  if (intervalStr && !INTERVAL_PATTERN.test(intervalStr)) {
    throw new Error(`interval must be a fixed interval: a number plus a unit (s,m,h,d,w,M,y), e.g. "5m" or "1h". Got ${JSON.stringify(oneLine(intervalStr, 20))}.`)
  }
  if (intervalStr && !fields.timestampField) {
    throw new Error('A date histogram needs a timestamp field; none is configured or detected for this source.')
  }

  // Optional metric becomes a sub-aggregation on each bucket. Validate early.
  let metricName = null
  let metricDef = null
  if (metric && String(metric).trim()) {
    if (!metricField || !String(metricField).trim()) {
      throw new Error(`metric requires metricField (the numeric field to aggregate, e.g. "duration"). Supported metrics: ${SUPPORTED_METRICS}.`)
    }
    metricDef = metricAgg(metric, metricField)
    if (!metricDef) {
      throw new Error(`Unsupported metric ${JSON.stringify(oneLine(String(metric), 20))}. Supported: ${SUPPORTED_METRICS}.`)
    }
    metricName = 'metric'
  }

  const filterClauses = [timeRangeFilter(fields.timestampField, range)]
  if (filter && String(filter).trim()) {
    const text = simpleText([fields.messageField, fields.serviceField].filter(Boolean), filter)
    if (text) filterClauses.push(text)
  }
  const query = boolQuery({ filter: filterClauses.filter(Boolean) })

  const aggs = {}
  if (groupField) aggs.group_by = termsAgg(groupField, { size: bucketLimit })
  if (intervalStr) aggs.over_time = dateHistogramAgg(fields.timestampField, { interval: intervalStr, minDocCount: 0 })
  if (metricDef) {
    const target = aggs.group_by ? 'group_by' : 'over_time'
    if (aggs[target]) aggs[target].aggs = { metric: metricDef }
  }

  // size:0 — we only want aggregation buckets, not hits. track_total_hits still
  // reports how many docs matched the filter.
  const body = buildSearchBody({ query, size: 0, aggs, sourceFilter: false })
  const result = await runSearch(provider, { index, body, signal, timeoutMs })
  const aggsOut = result.aggregations ?? {}

  const budget = createBudget()
  const out = {
    index,
    from: range.from,
    to: range.to,
    total: result.total,
    took: result.took,
    groupBy: groupField || null,
    interval: intervalStr || null,
    metric: metricName ? { metric: String(metric).toLowerCase(), field: String(metricField) } : null,
  }

  if (aggsOut.group_by && Array.isArray(aggsOut.group_by.buckets)) {
    const buckets = aggsOut.group_by.buckets
    const shown = buckets.slice(0, bucketLimit).map((b) => projectBucket(b, metricName))
    out.groups = shown
    const other = Number(aggsOut.group_by.sum_other_doc_count)
    if (Number.isFinite(other) && other > 0) out.groupsOtherDocCount = other
    if (buckets.length > shown.length) budget.spend(buckets.length - shown.length, 'group(s)', shown.length)
  }

  if (aggsOut.over_time && Array.isArray(aggsOut.over_time.buckets)) {
    const buckets = aggsOut.over_time.buckets
    const shown = buckets.slice(0, MAX_HISTOGRAM_BUCKETS).map((b) => projectBucket(b, metricName))
    out.histogram = shown
    if (buckets.length > shown.length) budget.spend(buckets.length - shown.length, 'time bucket(s)', shown.length)
  }

  out.budgetNote = budgetLine(budget)
  return out
}
