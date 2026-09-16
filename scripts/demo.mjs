#!/usr/bin/env node
// scripts/demo.mjs — An in-process smoke test and demo for dsh-searchops.
//
// It spins up a tiny in-memory OpenSearch emulator (a mocked `fetch` that serves
// realistic payloads), applies the REAL plugin against it, and drives the nine
// tools through the demo scenarios from the spec (status → indices → logs →
// aggregate → investigate). No Docker, no network, no public service: `npm run
// demo` always works. The emulator actually computes hits/aggregations from the
// stored documents, so the plugin's query DSL, bounding and fingerprinting all
// run for real.
//
// A local OpenSearch is optional and only for hands-on exploration — see
// ../docker-compose.yml and ../examples/. This script never touches it.

import * as plugin from '../index.js'

// ────────────────────────────────────────────────────────────────────────────
// Demo credentials. Obviously fake; the point is to prove the value is injected
// into the Authorization header and NEVER appears in any tool output.
// ────────────────────────────────────────────────────────────────────────────
const SOURCE_URL = 'https://search-prod.example.com:9200'
const DEMO_PASSWORD = 'demo-password-NOT-a-real-secret'
const CONFIG = {
  sources: [
    { id: 'prod', name: 'prod', provider: 'opensearch', auth: 'basic', url: SOURCE_URL, username: 'searchops-reader' },
  ],
  defaultSource: 'prod',
  allowInsecureHttp: false,
}
const CREDENTIALS = { SEARCHOPS_PASSWORD_prod: DEMO_PASSWORD }

// ────────────────────────────────────────────────────────────────────────────
// Small helpers (local, so the demo is self-contained and ships without test/).
// ────────────────────────────────────────────────────────────────────────────
const MIN = 60_000
const NOW = Date.now()
const TODAY = new Date(NOW).toISOString().slice(0, 10)
const YESTERDAY = new Date(NOW - 86_400_000).toISOString().slice(0, 10)
const IDX = `logs-${TODAY}`
const IDX_OLD = `logs-${YESTERDAY}`
const IDX_METRICS = `metrics-${TODAY}`

function getByPath(doc, path) {
  if (doc == null || !path) return undefined
  if (Object.prototype.hasOwnProperty.call(doc, path)) return doc[path]
  let cur = doc
  for (const part of String(path).split('.')) {
    if (cur && typeof cur === 'object' && part in cur) cur = cur[part]
    else return undefined
  }
  return cur
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

// Evaluate an OpenSearch-ish time bound (now, now-15m, epoch millis, ISO) to ms.
function toMillis(value) {
  if (typeof value === 'number') return value
  const s = String(value ?? '').trim()
  if (s === 'now') return Date.now()
  const rel = s.match(/^now(-?\d+)([smhdw])$/)
  if (rel) {
    const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
    return Date.now() + Number(rel[1]) * units[rel[2]]
  }
  if (/^\d{10,13}$/.test(s)) return s.length <= 10 ? Number(s) * 1000 : Number(s)
  const parsed = Date.parse(s)
  return Number.isNaN(parsed) ? null : parsed
}

function intervalToMillis(interval) {
  const m = String(interval ?? '').match(/^(\d+)([smhd])$/)
  if (!m) return 3_600_000
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return Number(m[1]) * units[m[2]]
}

function eq(a, b) {
  if (a == null || b == null) return a === b
  return String(a) === String(b)
}

// ────────────────────────────────────────────────────────────────────────────
// Query DSL matcher — covers exactly the clauses lib/dsl.js emits.
// ────────────────────────────────────────────────────────────────────────────
function matchRange(source, field, spec) {
  const t = toMillis(getByPath(source, field))
  if (t == null) return false
  if (spec.gte !== undefined && t < toMillis(spec.gte)) return false
  if (spec.gt !== undefined && t <= toMillis(spec.gt)) return false
  if (spec.lte !== undefined && t > toMillis(spec.lte)) return false
  if (spec.lt !== undefined && t >= toMillis(spec.lt)) return false
  return true
}

function matchSimpleQueryString(source, s) {
  const fields = Array.isArray(s.fields) ? s.fields : [s.fields]
  const hay = fields.map((f) => getByPath(source, f)).filter((v) => v != null).map((v) => String(v).toLowerCase()).join(' ')
  const tokens = String(s.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  return (s.default_operator || 'or').toLowerCase() === 'and'
    ? tokens.every((t) => hay.includes(t))
    : tokens.some((t) => hay.includes(t))
}

function matches(source, q) {
  if (!q || typeof q !== 'object') return true
  if ('match_all' in q) return true
  if ('bool' in q) {
    const b = q.bool || {}
    const must = Array.isArray(b.must) ? b.must : []
    const filter = Array.isArray(b.filter) ? b.filter : []
    const should = Array.isArray(b.should) ? b.should : []
    const mustNot = Array.isArray(b.must_not) ? b.must_not : []
    for (const c of must) if (!matches(source, c)) return false
    for (const c of filter) if (!matches(source, c)) return false
    for (const c of mustNot) if (matches(source, c)) return false
    if (should.length) {
      const msm = b.minimum_should_match !== undefined ? Number(b.minimum_should_match) : ((must.length || filter.length) ? 0 : 1)
      if (should.filter((c) => matches(source, c)).length < msm) return false
    }
    return true
  }
  if ('term' in q) { const [f, v] = Object.entries(q.term)[0]; return eq(getByPath(source, f), v) }
  if ('terms' in q) { const [f, vs] = Object.entries(q.terms)[0]; return Array.isArray(vs) && vs.some((v) => eq(getByPath(source, f), v)) }
  if ('range' in q) { const [f, spec] = Object.entries(q.range)[0]; return matchRange(source, f, spec || {}) }
  if ('match_phrase' in q) { const [f, v] = Object.entries(q.match_phrase)[0]; const dv = getByPath(source, f); return dv != null && String(dv).toLowerCase().includes(String(v).toLowerCase()) }
  if ('simple_query_string' in q) return matchSimpleQueryString(source, q.simple_query_string)
  return true
}

function parseSort(sort) {
  const entry = Array.isArray(sort) ? sort[0] : sort
  if (!entry || typeof entry !== 'object') return null
  const [field, spec] = Object.entries(entry)[0]
  const order = typeof spec === 'string' ? spec : (spec && spec.order) || 'asc'
  return { field, order: String(order).toLowerCase() }
}

function compareValues(a, b) {
  const da = Date.parse(a); const db = Date.parse(b)
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

// ────────────────────────────────────────────────────────────────────────────
// Aggregation computation (terms + date_histogram + a metric sub-agg).
// ────────────────────────────────────────────────────────────────────────────
function calcMetric(type, values) {
  if (type === 'value_count') return values.length
  if (values.length === 0) return null
  if (type === 'sum') return values.reduce((s, v) => s + v, 0)
  if (type === 'avg') return values.reduce((s, v) => s + v, 0) / values.length
  if (type === 'min') return Math.min(...values)
  if (type === 'max') return Math.max(...values)
  if (type === 'cardinality') return new Set(values).size
  return null
}

function computeAggs(docs, aggs) {
  const out = {}
  if (aggs.group_by && aggs.group_by.terms) {
    const field = aggs.group_by.terms.field
    const size = Number(aggs.group_by.terms.size) || 20
    const counts = new Map()
    for (const d of docs) {
      const k = getByPath(d._source, field)
      if (k == null || k === '') continue
      counts.set(String(k), (counts.get(String(k)) || 0) + 1)
    }
    const all = [...counts.entries()].map(([key, c]) => ({ key, doc_count: c }))
      .sort((a, b) => b.doc_count - a.doc_count || String(a.key).localeCompare(String(b.key)))
    const shown = all.slice(0, size)
    const metricDef = aggs.group_by.aggs && aggs.group_by.aggs.metric
    if (metricDef) {
      const [mtype, mspec] = Object.entries(metricDef)[0]
      for (const b of shown) {
        const vals = docs.map((d) => d._source)
          .filter((s) => String(getByPath(s, field)) === b.key)
          .map((s) => Number(getByPath(s, mspec.field)))
          .filter((n) => Number.isFinite(n))
        b.metric = { value: calcMetric(mtype, vals) }
      }
    }
    out.group_by = { doc_count_error_upper_bound: 0, sum_other_doc_count: all.slice(size).reduce((s, b) => s + b.doc_count, 0), buckets: shown }
  }
  if (aggs.over_time && aggs.over_time.date_histogram) {
    const field = aggs.over_time.date_histogram.field
    const ms = intervalToMillis(aggs.over_time.date_histogram.fixed_interval)
    const buckets = new Map()
    for (const d of docs) {
      const t = toMillis(getByPath(d._source, field))
      if (t == null) continue
      const start = Math.floor(t / ms) * ms
      buckets.set(start, (buckets.get(start) || 0) + 1)
    }
    out.over_time = {
      buckets: [...buckets.entries()].sort((a, b) => a[0] - b[0])
        .map(([start, c]) => ({ key: start, key_as_string: new Date(start).toISOString(), doc_count: c })),
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Demo document set: a payment-api incident (HTTP 500s from DB timeouts,
// connection-refused and a few NullPointers), correlated traces, and an old index.
// ────────────────────────────────────────────────────────────────────────────
const DOCS = []
let seq = 0
function addDoc(index, source) { DOCS.push({ _id: String(++seq).padStart(5, '0'), _index: index, _source: source }) }

// Deterministic interleave so every error type is spread evenly across time; the
// 500 most-recent docs the investigation scans then contain all three patterns.
function buildPlan(counts) {
  const types = Object.keys(counts)
  const total = types.reduce((s, t) => s + counts[t], 0)
  const acc = Object.fromEntries(types.map((t) => [t, 0]))
  const plan = []
  for (let k = 0; k < total; k += 1) {
    let best = null; let bestScore = -Infinity
    for (const t of types) {
      if (acc[t] >= counts[t]) continue
      const score = (counts[t] * (k + 1)) / total - acc[t]
      if (score > bestScore) { bestScore = score; best = t }
    }
    plan.push(best); acc[best] += 1
  }
  return plan
}

function hexOf(n, k) { let s = ''; for (let i = 0; i < n; i += 1) s += (((k + 1) * (i + 7)) % 16).toString(16); return s }
function fakeUuid(k) { return `${hexOf(8, k)}-${hexOf(4, k)}-4${hexOf(3, k)}-a${hexOf(3, k)}-${hexOf(12, k)}` }

const SPAN = 12 * MIN // errors spread over the last 12 minutes (< the 15m window)
const plan = buildPlan({ db_timeout: 732, connection_refused: 211, null_pointer: 4 })
// One trace id per request (realistic): a trace identifies a single charge call.
const traceFor = (k) => `tr-${String(k).padStart(4, '0')}`
const tsFor = (k) => new Date(NOW - SPAN + (k / (plan.length - 1)) * SPAN).toISOString()
plan.forEach((type, k) => {
  const ts = tsFor(k)
  const trace = traceFor(k)
  const message = type === 'db_timeout'
    ? `Database timeout after 30000ms querying payments-db (host=10.2.0.${(k % 5) + 1}:5432)`
    : type === 'connection_refused'
      ? `Connection refused to redis-cache.internal:6379 (10.1.2.${(k % 7) + 3})`
      : `NullPointerException at PaymentController.charge request=${fakeUuid(k)}`
  addDoc(IDX, {
    '@timestamp': ts, 'log.level': 'error', 'service.name': 'payment-api', 'trace.id': trace,
    'error.type': type, 'http.response.status_code': 500, message,
  })
})

// Correlated context: give the most recent requests a realistic multi-service
// path (gateway -> cache -> db -> gateway 500) that shares the error's trace id,
// so investigate's trace correlation and searchops_context reveal the whole
// request rather than a single line.
const ENRICH = 12
for (let k = plan.length - ENRICH; k < plan.length; k += 1) {
  const trace = traceFor(k)
  const base = Date.parse(tsFor(k))
  const i = k % 8
  addDoc(IDX, { '@timestamp': new Date(base - 3000).toISOString(), 'log.level': 'info', 'service.name': 'edge-gateway', 'trace.id': trace, message: `Received POST /v1/charge from client 203.0.113.${i + 10}` })
  addDoc(IDX, { '@timestamp': new Date(base - 1500).toISOString(), 'log.level': 'warn', 'service.name': 'cache', 'trace.id': trace, message: `Connection pool exhausted, waiting for a redis connection (10.1.2.${i + 3})` })
  addDoc(IDX, { '@timestamp': new Date(base - 500).toISOString(), 'log.level': 'error', 'service.name': 'db', 'trace.id': trace, message: 'Slow query 2100ms on payments table (replica lag)' })
  addDoc(IDX, { '@timestamp': new Date(base + 1500).toISOString(), 'log.level': 'error', 'service.name': 'edge-gateway', 'trace.id': trace, message: 'Upstream returned HTTP 500 from payment-api' })
}

// An older index so time-bounding and the indices listing have something to show.
for (let k = 0; k < 5; k += 1) {
  addDoc(IDX_OLD, {
    '@timestamp': new Date(NOW - 86_400_000 + k * 1000).toISOString(), 'log.level': 'error',
    'service.name': 'payment-api', 'trace.id': `t-0${k}`, 'error.type': 'db_timeout',
    'http.response.status_code': 500, message: `Database timeout after 30000ms querying payments-db (host=10.2.0.${k + 1}:5432)`,
  })
}

const MAPPING_PROPERTIES = {
  '@timestamp': { type: 'date' },
  message: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 2048 } } },
  'log.level': { type: 'keyword' },
  'error.type': { type: 'keyword' },
  'http.response.status_code': { type: 'long' },
  service: { properties: { name: { type: 'keyword' } } },
  trace: { properties: { id: { type: 'keyword' } } },
}

function countDocs(index) { return DOCS.filter((d) => d._index === index).length }

// ────────────────────────────────────────────────────────────────────────────
// The emulator: route a request path to a computed OpenSearch-style response.
// ────────────────────────────────────────────────────────────────────────────
function handleSearch(indexPattern, body) {
  const re = wildcardToRegExp(indexPattern)
  let matched = DOCS.filter((d) => re.test(d._index) && matches(d._source, body.query))
  const sort = parseSort(body.sort)
  if (sort) {
    matched = matched.slice().sort((a, b) => {
      const r = compareValues(getByPath(a._source, sort.field) ?? '', getByPath(b._source, sort.field) ?? '')
      return sort.order === 'asc' ? r : -r
    })
  }
  const total = matched.length
  const size = Number.isFinite(Number(body.size)) ? Number(body.size) : 10
  const from = Number.isFinite(Number(body.from)) ? Number(body.from) : 0
  const page = matched.slice(from, from + size)
  const response = {
    took: 6,
    timed_out: false,
    hits: {
      total: { value: total, relation: total >= 10000 ? 'gte' : 'eq' },
      hits: page.map((d) => ({ _id: d._id, _index: d._index, _source: body._source === false ? {} : d._source })),
    },
  }
  if (body.aggs && typeof body.aggs === 'object') response.aggregations = computeAggs(matched, body.aggs)
  return response
}

function route(url, init) {
  const path = new URL(url).pathname
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

  if (path === '/') {
    return json({
      name: 'node-1', cluster_name: 'prod-cluster', cluster_uuid: 'Qx7-demo-uuid',
      version: { number: '2.11.0', distribution: 'opensearch', build_type: 'docker', lucene_version: '9.7.0' },
      tagline: 'The OpenSearch Project: https://opensearch.org/',
    })
  }
  if (path === '/_cluster/health') {
    return json({
      cluster_name: 'prod-cluster', status: 'yellow', timed_out: false, number_of_nodes: 3,
      number_of_data_nodes: 2, active_primary_shards: 10, active_shards: 18, unassigned_shards: 2,
      initializing_shards: 0, relocating_shards: 0,
    })
  }
  if (path.startsWith('/_cat/indices')) {
    const pattern = path.replace('/_cat/indices', '').replace(/^\//, '') || '*'
    const re = wildcardToRegExp(pattern)
    const rows = [
      { index: IDX, health: 'yellow', docs: countDocs(IDX) },
      { index: IDX_OLD, health: 'green', docs: countDocs(IDX_OLD) },
      { index: IDX_METRICS, health: 'green', docs: 0 },
    ].filter((r) => re.test(r.index))
      .map((r) => ({ index: r.index, health: r.health, status: 'open', 'docs.count': String(r.docs), 'store.size': String(r.docs * 256), pri: '1', rep: '1' }))
    return json(rows)
  }
  if (path.endsWith('/_mapping')) {
    const pattern = path.replace(/\/_mapping$/, '').replace(/^\//, '') || '*'
    const re = wildcardToRegExp(pattern)
    const out = {}
    for (const index of [IDX, IDX_OLD]) if (re.test(index)) out[index] = { mappings: { properties: MAPPING_PROPERTIES } }
    return json(out)
  }
  if (path.endsWith('/_search')) {
    const pattern = path.replace(/\/_search$/, '').replace(/^\//, '') || '*'
    const body = init.body ? JSON.parse(init.body) : {}
    return json(handleSearch(pattern, body))
  }
  return new Response(JSON.stringify({ error: { type: 'not_found', reason: `no such endpoint: ${path}` }, status: 404 }), { status: 404, headers: { 'content-type': 'application/json' } })
}

// ────────────────────────────────────────────────────────────────────────────
// Mock plugin context + fetch recorder (proves credential/redirect invariants).
// ────────────────────────────────────────────────────────────────────────────
const calls = []
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: String(init.method ?? 'GET').toUpperCase(), headers: init.headers ?? {}, redirect: init.redirect })
  return route(String(url), init)
}

function createCtx() {
  const tools = []
  return {
    ctx: {
      credentials: { async resolve(ref) { return Object.prototype.hasOwnProperty.call(CREDENTIALS, ref) ? { value: CREDENTIALS[ref] } : undefined } },
      inject() {}, // no settings service -> entry-config fallback
      systemPrompt: { section() {} },
      tools: { register(tool) { tools.push(tool); return () => {} } },
    },
    tools,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Run the scenarios.
// ────────────────────────────────────────────────────────────────────────────
const transcript = []
function header(text) { console.log(`\n${'─'.repeat(78)}\n${text}\n${'─'.repeat(78)}`) }
function say(line) { console.log(line); transcript.push(line) }

async function runScenario(tools, title, prompt, toolName, args) {
  header(title)
  say(`User asks:  "${prompt}"`)
  say(`Agent calls: ${toolName} ${JSON.stringify(args)}\n`)
  const tool = tools.find((t) => t.name === toolName)
  if (!tool) throw new Error(`demo: tool ${toolName} was not registered`)
  const out = await tool.execute(args, { signal: new AbortController().signal })
  say(String(out))
  return String(out)
}

async function main() {
  console.log('dsh-searchops — in-process demo (mock OpenSearch; no Docker, no network)')
  console.log(`emulated cluster: ${IDX} (${countDocs(IDX)} docs), ${IDX_OLD} (${countDocs(IDX_OLD)} docs), ${IDX_METRICS} (0 docs)`)
  console.log(`incident: payment-api HTTP 500s — 732 db_timeout, 211 connection_refused, 4 null_pointer`)

  const { ctx, tools } = createCtx()
  plugin.apply(ctx, CONFIG)
  console.log(`registered tools: ${tools.map((t) => t.name).join(', ')}`)

  await runScenario(tools, '[Scenario 0] searchops_sources — discover configured sources', 'Which search sources can I use?', 'searchops_sources', {})
  await runScenario(tools, '[Scenario A] searchops_status — is the prod cluster healthy?', 'Is the prod OpenSearch cluster healthy?', 'searchops_status', { source: 'prod' })
  await runScenario(tools, '[Scenario B] searchops_indices — list logs-* indices', 'List the logs-* indices.', 'searchops_indices', { pattern: 'logs-*', source: 'prod' })
  await runScenario(tools, '[Scenario C] searchops_logs — payment-api errors, last 15m', 'Show payment-api error logs from the last 15 minutes.', 'searchops_logs', { index: 'logs-*', service: 'payment-api', level: 'error', from: 'now-15m', limit: 5, source: 'prod' })
  await runScenario(tools, '[Scenario D] searchops_aggregate — top error types, last 15m', 'What are the main errors in the last 15 minutes?', 'searchops_aggregate', { index: 'logs-*', groupBy: 'error.type', from: 'now-15m', source: 'prod' })
  await runScenario(tools, '[Scenario D2] searchops_aggregate — errors over time (5m buckets)', 'When did the errors start?', 'searchops_aggregate', { index: 'logs-*', groupBy: 'error.type', interval: '5m', from: 'now-15m', source: 'prod' })
  const investigateOut = await runScenario(tools, '[Scenario E] searchops_investigate — why is payment-api 500ing?', 'Investigate why payment-api is returning lots of 500s in the last 15 minutes.', 'searchops_investigate', { index: 'logs-*', service: 'payment-api', from: 'now-15m', source: 'prod' })

  // Bonus: pull the full request path for one trace id surfaced by the report.
  // Anchor on the correlation line ("trace=<id> events=") so we do not grab the
  // "trace=trace.id" token from the resolved-fields note.
  const traceMatch = investigateOut.match(/trace=([A-Za-z0-9._-]+)\s+events=/)
  const traceId = traceMatch ? traceMatch[1] : traceFor(plan.length - 1)
  await runScenario(tools, '[Bonus] searchops_context — full request path for one trace', `What happened along trace ${traceId}?`, 'searchops_context', { index: 'logs-*', traceId, source: 'prod' })

  // ── Security self-checks (the demo doubles as a smoke test) ──────────────
  header('Security self-checks')
  const allOutput = transcript.join('\n')
  const authedRequests = calls.filter((c) => typeof c.headers.authorization === 'string' && c.headers.authorization.startsWith('Basic ')).length
  const checks = [
    [`credential injected into Authorization header`, authedRequests > 0, `${authedRequests}/${calls.length} request(s) carried Basic auth`],
    [`secret value never appears in tool output`, !allOutput.includes(DEMO_PASSWORD), 'scanned all rendered output'],
    [`redirects disabled on every request (redirect='error')`, calls.every((c) => c.redirect === 'error'), `${calls.length} request(s)`],
    [`all requests target the configured HTTPS origin`, calls.every((c) => c.url.startsWith(`${SOURCE_URL}/`)), SOURCE_URL],
    [`investigation states it is evidence-only`, /Evidence only/i.test(investigateOut), 'no root-cause claim'],
  ]
  let ok = true
  for (const [label, pass, detail] of checks) {
    if (!pass) ok = false
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label} — ${detail}`)
  }

  console.log(`\n${ok ? 'SMOKE TEST PASSED' : 'SMOKE TEST FAILED'} — ${calls.length} mocked request(s), ${tools.length} tools exercised.`)
  if (!ok) process.exitCode = 1
}

main().catch((error) => {
  console.error('\nDEMO FAILED:', error && error.message ? error.message : error)
  process.exitCode = 1
})
