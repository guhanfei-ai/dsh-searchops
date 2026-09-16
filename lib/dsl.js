// lib/dsl.js — Small, testable builders for the OpenSearch/Elasticsearch query
// DSL. The DSL is the "lingua franca" shared by the OpenSearch family, so the
// provider-neutral domain layer (logs/aggregate/context/investigate) composes
// queries here and the adapter just sends them. A future non-DSL provider would
// supply its own translator behind the same SearchProvider interface.
//
// Everything here is a pure function returning plain JSON-safe objects.

// Compose a bool query, dropping empty clauses so we never emit `{"must":[]}`.
export function boolQuery({ must = [], filter = [], should = [], mustNot = [], minimumShouldMatch } = {}) {
  const bool = {}
  const clean = (arr) => arr.filter((x) => x && typeof x === 'object' && Object.keys(x).length > 0)
  const m = clean(must)
  const f = clean(filter)
  const s = clean(should)
  const mn = clean(mustNot)
  if (m.length) bool.must = m
  if (f.length) bool.filter = f
  if (s.length) bool.should = s
  if (mn.length) bool.must_not = mn
  if (s.length && minimumShouldMatch !== undefined) bool.minimum_should_match = minimumShouldMatch
  return Object.keys(bool).length ? { bool } : { match_all: {} }
}

export function rangeFilter(field, { gte, lte, gt, lt, format } = {}) {
  if (!field) return null
  const range = {}
  if (gte !== undefined && gte !== null && gte !== '') range.gte = gte
  if (lte !== undefined && lte !== null && lte !== '') range.lte = lte
  if (gt !== undefined && gt !== null && gt !== '') range.gt = gt
  if (lt !== undefined && lt !== null && lt !== '') range.lt = lt
  if (format) range.format = format
  if (Object.keys(range).length === 0) return null
  return { range: { [field]: range } }
}

// Exact-value filter. `keyword` lets the caller target the .keyword sub-field.
export function termFilter(field, value) {
  if (!field || value === undefined || value === null || value === '') return null
  return { term: { [field]: value } }
}

export function termsFilter(field, values) {
  const list = Array.isArray(values) ? values.filter((v) => v !== undefined && v !== null && v !== '') : []
  if (!field || list.length === 0) return null
  return { terms: { [field]: list } }
}

// Lenient free-text search across fields. simple_query_string never throws on
// special characters, which matters because the text can be arbitrary agent
// input; a query_string would 400 on stray operators.
export function simpleText(fields, text, { defaultOperator = 'and' } = {}) {
  const value = String(text ?? '').trim()
  const list = (Array.isArray(fields) ? fields : [fields]).filter(Boolean)
  if (!value || list.length === 0) return null
  return { simple_query_string: { query: value, fields: list, default_operator: defaultOperator } }
}

// Match one value against a field whose mapping we cannot be sure of: it may be
// a `keyword`, an analyzed `text`, or a `text` with a `.keyword` sub-field. The
// should-set (exact term, term on .keyword, phrase match) means a single filter
// works across all three without the caller probing the mapping first. Used for
// service/trace-id equality in logs, context and investigate.
export function fieldEquals(field, value) {
  const v = String(value ?? '').trim()
  if (!field || !v) return null
  return {
    bool: {
      should: [
        { term: { [field]: v } },
        { term: { [`${field}.keyword`]: v } },
        { match_phrase: { [field]: v } },
      ],
      minimum_should_match: 1,
    },
  }
}

// Match a level value case-insensitively by trying the raw value and its common
// casings; keeps the filter a cheap term/terms query rather than a full-text one.
export function levelFilter(field, level, { variants = [] } = {}) {
  const value = String(level ?? '').trim()
  if (!field || !value) return null
  const set = new Set([value, value.toLowerCase(), value.toUpperCase()])
  for (const v of variants) if (v) set.add(v)
  return { terms: { [field]: [...set] } }
}

// ── Aggregations ────────────────────────────────────────────────────────────
export function termsAgg(field, { size = 20, order } = {}) {
  if (!field) return null
  const agg = { terms: { field, size } }
  if (order) agg.terms.order = order
  return agg
}

export function dateHistogramAgg(field, { interval = '1h', minDocCount = 0, timeZone } = {}) {
  if (!field || !interval) return null
  const dh = { date_histogram: { field, fixed_interval: interval, min_doc_count: minDocCount } }
  if (timeZone) dh.date_histogram.time_zone = timeZone
  return dh
}

// Wrap a single metric over a field, e.g. { avg: { field: "duration" } }.
export function metricAgg(metric, field) {
  const m = String(metric ?? '').toLowerCase()
  if (!field || !['avg', 'min', 'max', 'sum', 'value_count', 'cardinality'].includes(m)) return null
  return { [m]: { field } }
}
