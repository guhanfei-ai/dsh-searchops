// lib/providers/opensearch.js — The OpenSearch adapter. This is the ONLY module
// that knows OpenSearch REST paths and response shapes; it implements the
// provider-neutral SearchProvider interface (see providers/index.js). It receives
// an `http` function from the runtime that already handles base URL, credential
// injection, disabled redirects, timeouts, response-size caps and error
// translation — so no secret or raw network handling lives here.
import { flattenMappingProperties } from '../fields.js'
import { isPlainObject } from '../util.js'

// Index names/patterns are validated upstream (validateIndexPattern) to a safe
// allow-list of [A-Za-z0-9_.*-] and commas, all of which are URL-path-safe, so
// they are inserted directly without percent-encoding (encoding `*`/`,` would
// change OpenSearch's multi-index/wildcard semantics).
export function createOpenSearchProvider({ http }) {
  if (typeof http !== 'function') throw new Error('OpenSearch provider requires an http function.')

  async function ping(opts = {}) {
    const root = await http('GET', '/', {}, opts)
    if (!isPlainObject(root)) {
      throw new Error('The source did not answer like OpenSearch: GET / returned no cluster info. Check the base URL and any proxy in front of it.')
    }
    const version = isPlainObject(root.version) ? root.version : {}
    return {
      clusterName: typeof root.cluster_name === 'string' ? root.cluster_name : '',
      clusterUuid: typeof root.cluster_uuid === 'string' ? root.cluster_uuid : '',
      nodeName: typeof root.name === 'string' ? root.name : '',
      version: typeof version.number === 'string' ? version.number : '',
      distribution: typeof version.distribution === 'string' ? version.distribution : (typeof root.version === 'object' ? 'opensearch' : ''),
      tagline: typeof root.tagline === 'string' ? root.tagline : '',
    }
  }

  async function clusterHealth(opts = {}) {
    const health = await http('GET', '/_cluster/health', {}, opts)
    if (!isPlainObject(health) || typeof health.status !== 'string') {
      throw new Error('OpenSearch /_cluster/health did not return the expected payload (a "status" field); the source did not answer like OpenSearch.')
    }
    const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
    return {
      status: health.status,
      clusterName: typeof health.cluster_name === 'string' ? health.cluster_name : '',
      numberOfNodes: int(health.number_of_nodes),
      numberOfDataNodes: int(health.number_of_data_nodes),
      activePrimaryShards: int(health.active_primary_shards),
      activeShards: int(health.active_shards),
      unassignedShards: int(health.unassigned_shards),
      initializingShards: int(health.initializing_shards),
      relocatingShards: int(health.relocating_shards),
      timedOut: Boolean(health.timed_out),
    }
  }

  // GET /_cat/indices[/<pattern>]?format=json&bytes=b&h=...&s=index
  async function listIndices({ pattern = '', limit = 50, signal, timeoutMs } = {}) {
    const params = new URLSearchParams({
      format: 'json',
      bytes: 'b',
      h: 'index,health,status,docs.count,store.size,pri,rep',
      s: 'index',
    })
    const path = pattern ? `/_cat/indices/${pattern}?${params.toString()}` : `/_cat/indices?${params.toString()}`
    const rows = await http('GET', path, {}, { signal, timeoutMs })
    // An empty result set is normal (no matching indices); a non-array means the
    // source did not answer like OpenSearch.
    const list = Array.isArray(rows) ? rows : (rows == null ? [] : null)
    if (list === null) {
      throw new Error('OpenSearch /_cat/indices did not return a list of indices; the source did not answer like OpenSearch.')
    }
    const all = list.filter(isPlainObject).map((row) => ({
      index: typeof row.index === 'string' ? row.index : '',
      health: typeof row.health === 'string' ? row.health : '',
      status: typeof row.status === 'string' ? row.status : '',
      docsCount: parseCount(row['docs.count']),
      storeSize: parseCount(row['store.size']),
      primaryShards: parseCount(row.pri),
      replicaShards: parseCount(row.rep),
    }))
    const total = all.length
    const capped = Math.max(0, Math.floor(Number(limit)) || 0)
    const indices = capped > 0 ? all.slice(0, capped) : all
    return { indices, truncated: indices.length < total, total }
  }

  // GET /<index>/_mapping  ->  { [index]: { mappings: { properties } } }
  async function getMapping({ index, maxFields = Infinity, signal, timeoutMs } = {}) {
    if (!index) throw new Error('getMapping requires an index or pattern.')
    const raw = await http('GET', `/${index}/_mapping`, {}, { signal, timeoutMs })
    if (!isPlainObject(raw)) {
      throw new Error('OpenSearch /_mapping did not return the expected object; the source did not answer like OpenSearch.')
    }
    const indices = []
    let anyTruncated = false
    for (const [indexName, def] of Object.entries(raw)) {
      const properties = isPlainObject(def) && isPlainObject(def.mappings) ? def.mappings.properties : null
      const fields = flattenMappingProperties(properties, { maxFields })
      const truncated = fields.length >= maxFields
      if (truncated) anyTruncated = true
      indices.push({
        index: indexName,
        fields,
        fieldCount: fields.length,
        truncated,
        raw: def, // retained for the opt-in raw mapping mode; the tool bounds it
      })
    }
    return { indices, truncated: anyTruncated }
  }

  // POST /<index>/_search with a DSL body -> provider-neutral result envelope.
  async function search({ index, body = {}, signal, timeoutMs } = {}) {
    if (!index) throw new Error('search requires an index or pattern.')
    const res = await http('POST', `/${index}/_search`, { body }, { signal, timeoutMs })
    return normalizeSearchResponse(res)
  }

  return { name: 'opensearch', ping, clusterHealth, listIndices, getMapping, search }
}

// Shared response normalization so search and aggregate map identically and
// malformed payloads raise a clear error instead of silently returning nothing.
export function normalizeSearchResponse(res) {
  if (!isPlainObject(res) || !isPlainObject(res.hits)) {
    throw new Error('OpenSearch /_search did not return the expected payload (a "hits" object); the response was malformed or intercepted by a proxy.')
  }
  const hitsRoot = res.hits
  const rawHits = Array.isArray(hitsRoot.hits) ? hitsRoot.hits : []
  const hits = rawHits.filter(isPlainObject).map((h) => ({
    id: typeof h._id === 'string' ? h._id : '',
    index: typeof h._index === 'string' ? h._index : '',
    source: isPlainObject(h._source) ? h._source : {},
    sort: Array.isArray(h.sort) ? h.sort : undefined,
  }))
  return {
    hits,
    total: normalizeTotal(hitsRoot.total),
    took: Number.isFinite(Number(res.took)) ? Number(res.took) : undefined,
    timedOut: Boolean(res.timed_out),
    aggregations: isPlainObject(res.aggregations) ? res.aggregations : undefined,
  }
}

// hits.total is { value, relation } in modern OpenSearch but a bare number in
// older clusters; normalize both to { value, relation }.
export function normalizeTotal(total) {
  if (typeof total === 'number') return { value: total, relation: total >= 10000 ? 'gte' : 'eq' }
  if (isPlainObject(total)) {
    return {
      value: Number.isFinite(Number(total.value)) ? Number(total.value) : 0,
      relation: typeof total.relation === 'string' ? total.relation : 'eq',
    }
  }
  return { value: 0, relation: 'eq' }
}

// _cat fields arrive as strings ("1234", or "" / null for red shards). Parse to
// a number when possible, else null, so the UI never shows "NaN".
function parseCount(v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
