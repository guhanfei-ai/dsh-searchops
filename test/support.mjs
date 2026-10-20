// test/support.mjs — Shared test scaffolding (NOT a *.test.js file, so the Node
// test runner does not execute it as a suite; it is imported by the suites).
// Everything here is deterministic and offline: no network, no Docker, no public
// service. Fetch is mocked at the globalThis boundary and providers are faked at
// the SearchProvider seam, matching how the plugin is actually composed.

// ── HTTP responses (real Response objects, Node 18+ global) ─────────────────
export function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function textResponse(text, status = 200, headers = {}) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } })
}

// A tool execution context: only `signal` is used by the tools.
export function execution() {
  return { signal: new AbortController().signal }
}

// ── OpenSearch REST payload builders (adapter-level fakes) ──────────────────
export function osRoot({ clusterName = 'searchops-test', version = '2.11.0', distribution = 'opensearch', nodeName = 'node-1', tagline = 'The OpenSearch Project: https://opensearch.org/' } = {}) {
  return {
    name: nodeName,
    cluster_name: clusterName,
    cluster_uuid: 'uuid-abc',
    version: { number: version, distribution, build_type: 'docker', lucene_version: '9.7.0' },
    tagline,
  }
}

export function osHealth({ status = 'green', clusterName = 'searchops-test', numberOfNodes = 3, numberOfDataNodes = 2, activePrimaryShards = 10, activeShards = 20, unassignedShards = 0, initializingShards = 0, relocatingShards = 0, timedOut = false } = {}) {
  return {
    cluster_name: clusterName,
    status,
    timed_out: timedOut,
    number_of_nodes: numberOfNodes,
    number_of_data_nodes: numberOfDataNodes,
    active_primary_shards: activePrimaryShards,
    active_shards: activeShards,
    unassigned_shards: unassignedShards,
    initializing_shards: initializingShards,
    relocating_shards: relocatingShards,
  }
}

// One _cat/indices row (fields arrive as strings, exactly like the real API).
export function osCatRow(index, { health = 'green', status = 'open', docs = '100', bytes = '2048', pri = '1', rep = '1' } = {}) {
  return { index, health, status, 'docs.count': docs, 'store.size': bytes, pri, rep }
}

// /{index}/_mapping payload: { [index]: { mappings: { properties } } }.
export function osMapping(indexName, properties) {
  return { [indexName]: { mappings: { properties } } }
}

// A log-ish mapping used across several suites.
export function logMappingProperties() {
  return {
    '@timestamp': { type: 'date' },
    message: { type: 'text', fields: { keyword: { type: 'keyword' } } },
    'log.level': { type: 'keyword' },
    service: { properties: { name: { type: 'keyword' } } },
    trace: { properties: { id: { type: 'keyword' } } },
    'http.response.status_code': { type: 'long' },
  }
}

// POST /{index}/_search payload.
export function osSearch({ hits = [], total, took = 5, aggregations, timedOut = false } = {}) {
  const value = total ?? hits.length
  return {
    took,
    timed_out: timedOut,
    hits: {
      total: typeof value === 'object' ? value : { value, relation: value >= 10000 ? 'gte' : 'eq' },
      hits: hits.map((h) => ({ _id: h._id ?? h.id ?? '', _index: h._index ?? h.index ?? 'logs', _source: h._source ?? h.source ?? {}, ...(h.sort ? { sort: h.sort } : {}) })),
    },
    ...(aggregations ? { aggregations } : {}),
  }
}

// ── Fetch mock ──────────────────────────────────────────────────────────────
// Replaces globalThis.fetch with a recorder. `handler(url, init, index)` returns
// a Response, or throws / returns an Error to simulate a network failure.
export function installFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method ?? 'GET').toUpperCase(),
      headers: init.headers ?? {},
      body: init.body,
      redirect: init.redirect,
      signal: init.signal,
    }
    calls.push(call)
    let result
    try {
      result = typeof handler === 'function' ? await handler(call.url, init, calls.length - 1) : handler
    } catch (error) {
      throw error
    }
    if (result instanceof Error) throw result
    return result
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
  }
}

// ── Fake SearchProvider (domain-level seam) ─────────────────────────────────
// Each method's behavior comes from `config[name]`: a value, a function(opts),
// or an Error to throw. Calls are recorded for assertions.
export function fakeProvider(config = {}) {
  const calls = { ping: 0, clusterHealth: 0, listIndices: [], getMapping: [], search: [] }
  const resolve = (key, fallback, opts, bucket) => {
    const spec = config[key]
    if (bucket) bucket.push(opts)
    if (spec instanceof Error) throw spec
    if (typeof spec === 'function') return spec(opts)
    if (spec !== undefined) return spec
    return fallback
  }
  const provider = {
    name: config.name ?? 'fake',
    async ping() { calls.ping += 1; return resolve('ping', { clusterName: 'searchops-test', version: '2.11.0', distribution: 'opensearch' }, undefined, null) },
    async clusterHealth() { calls.clusterHealth += 1; return resolve('clusterHealth', { status: 'green', clusterName: 'searchops-test', numberOfNodes: 1, numberOfDataNodes: 1, activePrimaryShards: 1, activeShards: 1, unassignedShards: 0, initializingShards: 0, relocatingShards: 0, timedOut: false }, undefined, null) },
    async listIndices(opts) { return resolve('listIndices', { indices: [], truncated: false, total: 0 }, opts, calls.listIndices) },
    async getMapping(opts) { return resolve('getMapping', { indices: [], truncated: false }, opts, calls.getMapping) },
    async search(opts) { return resolve('search', { hits: [], total: { value: 0, relation: 'eq' }, took: 1 }, opts, calls.search) },
  }
  return { provider, calls }
}

// Provider-neutral search result + hit builders (what the adapter hands up).
export function searchResult(hits = [], { total, took = 1, aggregations, timedOut = false } = {}) {
  return { hits, total: total ?? { value: hits.length, relation: 'eq' }, took, timedOut, ...(aggregations ? { aggregations } : {}) }
}

export function hit(id, index, source, sort) {
  return { id, index, source, ...(sort ? { sort } : {}) }
}

// ── Mock plugin ctx for apply() ─────────────────────────────────────────────
// credentials is a plain map ref -> secret value. Without `settings`, inject is
// a no-op and apply() uses the entry config it was handed — the same fallback
// path a host without the settings service would take. With `settings`, inject
// delivers it the way cordis would.
export function createPluginContext({ credentials = {}, config = {}, settings } = {}) {
  const tools = []
  const sections = []
  const resolved = []
  const ctx = {
    credentials: {
      async resolve(ref) {
        resolved.push(ref)
        return Object.prototype.hasOwnProperty.call(credentials, ref) ? { value: credentials[ref] } : undefined
      },
    },
    inject(deps, cb) {
      if (settings && deps.includes('settings')) cb({ settings, effect() {} })
    },
    systemPrompt: { section(section) { sections.push(section) } },
    tools: { register(tool) { tools.push(tool); return () => {} } },
  }
  return { ctx, tools, sections, resolvedRefs: resolved, config }
}

export function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing tool ${name}; registered: ${tools.map((t) => t.name).join(', ')}`)
  return tool
}

// A standard two-source config used by several suites. Secret VALUES are not in
// here — only credential refs; the values come from the mock credential store.
export function twoSourceConfig() {
  return {
    sources: [
      { id: 'prod', name: 'prod', provider: 'opensearch', auth: 'basic', url: 'https://search-prod.example.com:9200', username: 'prod-user' },
      { id: 'staging', name: 'staging', provider: 'opensearch', auth: 'bearer', url: 'https://search-staging.example.com:9200' },
    ],
    defaultSource: 'prod',
  }
}

export function twoSourceCredentials() {
  return {
    SEARCHOPS_PASSWORD_prod: 'prod-secret-password',
    SEARCHOPS_TOKEN_staging: 'staging-secret-token',
  }
}
