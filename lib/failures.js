// lib/failures.js — The error model. Turn an upstream HTTP failure into a short,
// actionable message that never leaks a secret, never echoes request headers, and
// distinguishes the cases the agent must react to differently: auth vs permission
// vs bad query vs missing index vs timeout vs upstream error. Upstream bodies are
// untrusted and may echo credentials, so every fragment is redacted, single-lined
// and truncated before it reaches an agent-facing string.
import { ERROR_DETAIL_MAX_CHARS } from './constants.js'
import { oneLine, redactSecrets, safeErrorDetail } from './util.js'

// Pull the OpenSearch/Elasticsearch error `type` out of a body when present, so
// we can distinguish e.g. index_not_found_exception from a generic 404.
function errorType(body) {
  try {
    const parsed = JSON.parse(body)
    const t = parsed?.error?.type ?? parsed?.error?.root_cause?.[0]?.type
    return typeof t === 'string' ? t : ''
  } catch {
    return ''
  }
}

function safe(body, detail) {
  const raw = typeof detail === 'string' && detail ? detail : safeErrorDetail(body)
  return oneLine(redactSecrets(raw), ERROR_DETAIL_MAX_CHARS) || 'no error details'
}

function sourcePhrase(sourceName) {
  const name = oneLine(sourceName, 100)
  return name ? `source ${JSON.stringify(name)}` : 'the configured source'
}

// status: HTTP status; method/path: the request line (path may include an index
// name, which is not secret); detail: pre-extracted short reason (optional);
// body: raw upstream body for structured extraction; sourceName: for the message.
export function translateHttpFailure({ status, method = 'GET', path = '', detail, body = '', sourceName = '' } = {}) {
  const code = Number(status)
  const verb = String(method).toUpperCase()
  const route = oneLine(path, 200)
  const head = `Search API ${Number.isFinite(code) ? code : 'unknown'} ${verb} ${route}:`
  const who = sourcePhrase(sourceName)
  const d = safe(body, detail)
  const type = errorType(body)

  if (code === 400 || code === 422) {
    return `${head} the request was rejected as malformed — ${d}. Check the query DSL, index pattern, sort and aggregation fields.`
  }
  if (code === 401) {
    return `${head} authentication failed for ${who} — the credential is missing, expired, or invalid. Set it in Settings → Plugins or the DSH credential store. (${d})`
  }
  if (code === 403) {
    return `${head} permission denied for ${who} — the account can authenticate but is not allowed to perform this action or read this index. Grant the needed cluster/index privilege. (${d})`
  }
  if (code === 404) {
    if (type === 'index_not_found_exception' || /index_not_found|no such index/i.test(d)) {
      return `${head} the index or pattern does not exist on ${who}. Call searchops_indices to see what is available. (${d})`
    }
    return `${head} not found on ${who} — the endpoint or index does not exist. (${d})`
  }
  if (code === 408) {
    return `${head} the search backend timed out. Narrow the time range or filters and retry.`
  }
  if (code === 413) {
    return `${head} the request body was too large for the backend. Reduce the query size.`
  }
  if (code === 429) {
    return `${head} the backend is rate-limiting requests. Slow down and retry shortly.`
  }
  if (code >= 500 && code <= 599) {
    return `${head} the search backend returned a server error on ${who}. This is usually transient; retry, and if it persists check cluster health with searchops_status. (${d})`
  }
  return `${head} ${d}`
}

// Wrap a fetch-level (network) failure — DNS, connection refused, TLS, abort —
// into a categorized, secret-free message. `aborted` distinguishes timeout from
// a genuine connection problem so the agent reasons correctly.
export function translateNetworkFailure({ error, method = 'GET', path = '', sourceName = '', aborted = false } = {}) {
  const verb = String(method).toUpperCase()
  const route = oneLine(path, 200)
  const who = sourcePhrase(sourceName)
  if (aborted) {
    return `Search request timed out or was cancelled: ${verb} ${route} on ${who}. The cluster may be slow or unreachable; try a narrower query.`
  }
  // Never interpolate the raw error verbatim — it can contain the URL with a
  // query string. Redact and bound it; connection errors are not secret but may
  // carry a proxy's diagnostic text.
  const reason = oneLine(redactSecrets(error?.message ?? String(error ?? '')), ERROR_DETAIL_MAX_CHARS) || 'network error'
  // Surface the common causes explicitly so the agent can advise the operator.
  if (/getaddrinfo|enotfound|dns/i.test(reason)) {
    return `Cannot resolve the host for ${who}: ${verb} ${route}. Check the source URL hostname. (${reason})`
  }
  if (/econnrefused|connection refused/i.test(reason)) {
    return `Connection refused by ${who}: ${verb} ${route}. Is the cluster running and reachable from here? (${reason})`
  }
  if (/self.signed|unable to verify|certificate|tls|ssl|depth/i.test(reason)) {
    return `TLS/certificate error talking to ${who}: ${verb} ${route}. The cluster certificate could not be verified. (${reason})`
  }
  return `Search request failed: ${verb} ${route} on ${who}. (${reason})`
}
