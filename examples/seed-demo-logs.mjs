#!/usr/bin/env node
// examples/seed-demo-logs.mjs — Insert a small payment-api incident into a REAL
// local OpenSearch so you can drive dsh-searchops against it end to end.
//
// This is the hands-on counterpart to scripts/demo.mjs (which is fully in-process
// and needs no cluster). Use it with docker-compose.yml:
//
//   docker compose up -d
//   node examples/seed-demo-logs.mjs
//
// Then configure the plugin with examples/config.local.json and ask the agent to
// run searchops_status / _indices / _logs / _aggregate / _investigate on "local".
//
// Target: OPENSEARCH_URL (default http://localhost:9200), INDEX (default logs-demo).

const URL = (process.env.OPENSEARCH_URL || 'http://localhost:9200').replace(/\/+$/, '')
const INDEX = process.env.INDEX || 'logs-demo'

const MAPPING = {
  mappings: {
    properties: {
      '@timestamp': { type: 'date' },
      message: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 2048 } } },
      'log.level': { type: 'keyword' },
      'error.type': { type: 'keyword' },
      'http.response.status_code': { type: 'long' },
      service: { properties: { name: { type: 'keyword' } } },
      trace: { properties: { id: { type: 'keyword' } } },
    },
  },
}

const MIN = 60_000
const NOW = Date.now()
const SPAN = 12 * MIN
const docs = []
let seq = 0
const traceFor = (k) => `tr-${String(k).padStart(4, '0')}`
const tsFor = (k, total) => new Date(NOW - SPAN + (k / (total - 1)) * SPAN).toISOString()

// A modest incident: 100 db_timeout, 30 connection_refused, 3 null_pointer.
const plan = []
for (let i = 0; i < 100; i += 1) plan.push('db_timeout')
for (let i = 0; i < 30; i += 1) plan.push('connection_refused')
for (let i = 0; i < 3; i += 1) plan.push('null_pointer')
// Interleave so all three patterns appear across the window.
plan.sort(() => 0) // keep deterministic; the mix below already alternates by construction
const mixed = []
{
  let d = 0; let c = 0; let n = 0
  for (let k = 0; k < plan.length; k += 1) {
    if (n < 3 && k % 44 === 43) mixed.push('null_pointer'), n += 1
    else if (c < 30 && k % 4 === 3) mixed.push('connection_refused'), c += 1
    else if (d < 100) mixed.push('db_timeout'), d += 1
    else if (c < 30) mixed.push('connection_refused'), c += 1
    else mixed.push('null_pointer'), n += 1
  }
}

mixed.forEach((type, k) => {
  const message = type === 'db_timeout'
    ? `Database timeout after 30000ms querying payments-db (host=10.2.0.${(k % 5) + 1}:5432)`
    : type === 'connection_refused'
      ? `Connection refused to redis-cache.internal:6379 (10.1.2.${(k % 7) + 3})`
      : `NullPointerException at PaymentController.charge request=${crypto.randomUUID()}`
  docs.push({
    '@timestamp': tsFor(k, mixed.length), 'log.level': 'error', 'service.name': 'payment-api',
    'trace.id': traceFor(k), 'error.type': type, 'http.response.status_code': 500, message,
  })
})

// Give the last few requests a multi-service path so trace correlation is useful.
for (let k = mixed.length - 6; k < mixed.length; k += 1) {
  const trace = traceFor(k)
  const base = Date.parse(tsFor(k, mixed.length))
  docs.push({ '@timestamp': new Date(base - 3000).toISOString(), 'log.level': 'info', 'service.name': 'edge-gateway', 'trace.id': trace, message: `Received POST /v1/charge from client 203.0.113.${k % 20}` })
  docs.push({ '@timestamp': new Date(base - 1500).toISOString(), 'log.level': 'warn', 'service.name': 'cache', 'trace.id': trace, message: `Connection pool exhausted, waiting for a redis connection (10.1.2.${(k % 7) + 3})` })
  docs.push({ '@timestamp': new Date(base - 500).toISOString(), 'log.level': 'error', 'service.name': 'db', 'trace.id': trace, message: 'Slow query 2100ms on payments table (replica lag)' })
  docs.push({ '@timestamp': new Date(base + 1500).toISOString(), 'log.level': 'error', 'service.name': 'edge-gateway', 'trace.id': trace, message: 'Upstream returned HTTP 500 from payment-api' })
}

async function main() {
  console.log(`Seeding ${docs.length} demo documents into ${URL}/${INDEX}`)
  // (Re)create the index with an explicit mapping. Ignore "already exists".
  const put = await fetch(`${URL}/${INDEX}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MAPPING) })
  if (!put.ok) {
    const text = await put.text()
    if (!/resource_already_exists/i.test(text)) throw new Error(`create index failed (${put.status}): ${text.slice(0, 200)}`)
    console.log(`index ${INDEX} already exists; adding documents`)
  }

  // Bulk index (NDJSON: one action line, one source line, trailing newline).
  const lines = []
  docs.forEach((doc, i) => {
    lines.push(JSON.stringify({ index: { _index: INDEX, _id: String(i + 1).padStart(5, '0') } }))
    lines.push(JSON.stringify(doc))
  })
  const bulk = await fetch(`${URL}/_bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: `${lines.join('\n')}\n`,
  })
  const result = await bulk.json().catch(() => ({}))
  if (!bulk.ok || result.errors) {
    throw new Error(`bulk insert had errors: ${JSON.stringify(result).slice(0, 400)}`)
  }
  // Refresh so the documents are searchable immediately.
  await fetch(`${URL}/${INDEX}/_refresh`, { method: 'POST' })
  console.log(`Done. Indexed ${result.items ? result.items.length : docs.length} documents into ${INDEX}.`)
  console.log('Now ask the agent, for example:')
  console.log('  • Is the local search cluster healthy?')
  console.log(`  • Show payment-api error logs from the last 15 minutes in ${INDEX}.`)
  console.log(`  • Investigate why payment-api is returning 500s (index ${INDEX}, last 15 minutes).`)
}

main().catch((error) => {
  console.error('seed failed:', error && error.message ? error.message : error)
  console.error('Is OpenSearch running? Try: docker compose up -d')
  process.exitCode = 1
})
