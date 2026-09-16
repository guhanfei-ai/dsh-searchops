// lib/util.js — Provider-agnostic pure helpers: input validation, bounded IO,
// text sanitization and credential-reference derivation. Nothing here knows
// about OpenSearch; the adapter and tools compose these primitives.
import {
  CREDENTIAL_REF_PATTERN,
  ERROR_DETAIL_MAX_CHARS,
  INDEX_PATTERN,
  MAX_COMMA_SEPARATED_ITEMS,
  MAX_INDEX_PATTERN_CHARS,
  MAX_RESPONSE_BYTES,
  MAX_SOURCE_NAME_CHARS,
  PASSWORD_REF_PREFIX,
  REQUEST_TIMEOUT_MS,
  TOKEN_REF_PREFIX,
  USERNAME_REF_PREFIX,
} from './constants.js'

// Normalize and validate an operator-configured base URL. Rejects embedded
// credentials, query strings and fragments; enforces an HTTPS-or-loopback/HTTP
// policy so a source can never be pointed at an internal address over plain
// HTTP unless the operator explicitly allows it.
export function normalizeBaseUrl(input, allowInsecureHttp = false) {
  const value = String(input ?? '').trim()
  if (!value) {
    throw new Error('Search source URL is not configured. Set it in Settings → Plugins or provide `url` in the plugin configuration.')
  }

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Search source URL must be an absolute HTTP(S) URL.')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Search source URL must use https:// or http://.')
  }
  if (url.username || url.password) {
    throw new Error('Search source URL must not contain embedded credentials; configure auth separately so secrets stay out of config and Git.')
  }
  if (url.search || url.hash) {
    throw new Error('Search source URL must not contain a query string or fragment.')
  }

  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  if (url.protocol === 'http:' && !loopback && !allowInsecureHttp) {
    throw new Error('Plain HTTP is disabled for non-loopback search hosts. Use HTTPS, target a loopback address, or explicitly set allowInsecureHttp: true.')
  }
  return url.toString().replace(/\/+$/, '')
}

export function byteLength(value) {
  return new TextEncoder().encode(String(value ?? '')).byteLength
}

export function validateCredentialRef(ref) {
  if (!CREDENTIAL_REF_PATTERN.test(String(ref ?? ''))) {
    throw new Error(`Invalid credential reference: ${JSON.stringify(ref)}`)
  }
  return ref
}

// Source id: globally unique, system-generated, read-only. Prefer crypto.randomUUID
// (Node 20+ / secure-context browsers), fall back to getRandomValues, then to a
// time+random string that is still unique enough for local config.
export function generateSourceId() {
  const c = globalThis.crypto
  if (c?.randomUUID) return String(c.randomUUID())
  if (c?.getRandomValues) {
    const bytes = c.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// Strip a source id down to credential-ref-safe characters (leading letter,
// then [A-Za-z0-9_]). The same id always maps to the same ref, so renaming a
// source never orphans its stored secrets.
function refSuffix(id) {
  return String(id ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64)
}
export function usernameRefForId(id) {
  return validateCredentialRef(`${USERNAME_REF_PREFIX}${refSuffix(id)}`)
}
export function passwordRefForId(id) {
  return validateCredentialRef(`${PASSWORD_REF_PREFIX}${refSuffix(id)}`)
}
export function tokenRefForId(id) {
  return validateCredentialRef(`${TOKEN_REF_PREFIX}${refSuffix(id)}`)
}

export function normalizeSourceName(name) {
  const value = String(name ?? '').trim()
  if (!value) throw new Error('Each search source must have a non-empty name.')
  if (value.length > MAX_SOURCE_NAME_CHARS) {
    throw new Error(`Search source name must not exceed ${MAX_SOURCE_NAME_CHARS} characters.`)
  }
  return value
}

export function combineSignals(parentSignal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal
}

export async function abortableDelay(ms, signal) {
  const reasonOf = (s) => (s?.reason instanceof Error ? s.reason : new Error(String(s?.reason ?? 'aborted')))
  if (signal?.aborted) throw reasonOf(signal)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(reasonOf(signal))
    }, { once: true })
  })
}

const RESPONSE_LIMIT_ADVICE = ' Narrow the request (filters, aggregation, a shorter range, a smaller size) to bring the response under the limit.'

// Read a response body with a hard byte ceiling enforced *while streaming*, so a
// multi-gigabyte answer is abandoned as soon as it crosses the limit instead of
// being buffered. Honors an advertised content-length as an early reject too.
export async function readLimitedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel?.() } catch { /* releasing is best-effort */ }
    throw new Error(`Search response is too large (${contentLength} bytes; limit ${maxBytes} bytes).${RESPONSE_LIMIT_ADVICE}`)
  }

  if (!response.body?.getReader) {
    const text = await response.text()
    if (byteLength(text) > maxBytes) {
      throw new Error(`Search response exceeds the ${maxBytes}-byte limit.${RESPONSE_LIMIT_ADVICE}`)
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`Search response exceeds the ${maxBytes}-byte limit.${RESPONSE_LIMIT_ADVICE}`)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

// Best-effort extraction of a short, single-line error detail from an upstream
// body. OpenSearch errors are `{ error: { type, reason, ... }, status }`; we
// prefer `error.reason` then `error.type`, else the raw text. Always redacted
// and truncated by the caller before it reaches an agent-facing message.
export function safeErrorDetail(text) {
  try {
    const parsed = JSON.parse(text)
    const err = parsed?.error
    if (err && typeof err === 'object') {
      const reason = typeof err.reason === 'string' ? err.reason : ''
      const type = typeof err.type === 'string' ? err.type : ''
      const joined = [type, reason].filter(Boolean).join(': ')
      if (joined) return oneLine(joined, ERROR_DETAIL_MAX_CHARS)
    }
    if (typeof err === 'string' && err) return oneLine(err, ERROR_DETAIL_MAX_CHARS)
    if (typeof parsed?.message === 'string' && parsed.message) return oneLine(parsed.message, ERROR_DETAIL_MAX_CHARS)
  } catch {
    // Not JSON — fall through to the bounded raw description.
  }
  return oneLine(String(text ?? ''), ERROR_DETAIL_MAX_CHARS) || 'no error details'
}

export function textOut(value) {
  return [{ type: 'text', text: String(value) }]
}

// Upstream bodies can echo credentials (proxies, gateways, error pages that
// print the Authorization header). Redact before anything is surfaced. Covers
// Bearer tokens, HTTP Basic credentials, common API-key shapes and long
// base64/hex runs. Legitimate log text survives: identifiers are broken up by
// underscores, dots and spaces so they rarely form a 24+ char contiguous run.
const SECRET_PATTERNS = [
  /Bearer\s+\S+/gi,
  /Basic\s+[A-Za-z0-9+/=]{6,}/gi,
  /\b(?:api[_-]?key|apikey|token|secret|password|passwd|pwd)["'\s:=]+["']?[^\s"',}]{6,}/gi,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\b[A-Za-z0-9+/]{24,}={0,2}\b/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
]

export function redactSecrets(text) {
  let out = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}

// Collapse newlines/tabs and truncate — used for every value that gets embedded
// into a single output line, so untrusted content can never forge extra rows.
export function oneLine(value, maxLength) {
  const s = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  return typeof maxLength === 'number' ? s.slice(0, maxLength) : s
}

// Truncate a possibly-huge field value with an explicit ellipsis marker; the
// caller decides whether to also set a `truncated` flag on the envelope.
export function truncate(value, maxLength) {
  const s = String(value ?? '')
  if (s.length <= maxLength) return s
  return `${s.slice(0, Math.max(0, maxLength - 1))}…`
}

export function requireBoundedInteger(value, field, min, max, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`)
  }
  return value
}

// Clamp instead of reject, for limits where over-asking should degrade safely
// rather than error (e.g. size above MAX falls back to MAX and sets truncated).
export function clampInteger(value, min, max, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

// Validate an index name or comma-separated pattern list before it is placed in
// a URL path. Rejects anything with slashes, spaces, query characters, etc.
export function validateIndexPattern(input, { field = 'index', required = true } = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) {
    if (required) throw new Error(`${field} is required.`)
    return ''
  }
  if (raw.length > MAX_INDEX_PATTERN_CHARS) {
    throw new Error(`${field} must not exceed ${MAX_INDEX_PATTERN_CHARS} characters.`)
  }
  const parts = raw.split(',')
  if (parts.length > MAX_COMMA_SEPARATED_ITEMS) {
    throw new Error(`${field} lists too many comma-separated patterns (limit ${MAX_COMMA_SEPARATED_ITEMS}).`)
  }
  for (const part of parts) {
    const token = part.trim()
    if (!token || !INDEX_PATTERN.test(token)) {
      throw new Error(`${field} contains an invalid index name or pattern ${JSON.stringify(part)}. Allowed characters: letters, digits, dot, dash, underscore and the * wildcard.`)
    }
  }
  // Return the normalized (whitespace-stripped) form that is safe to URL-encode.
  return parts.map((p) => p.trim()).join(',')
}

// True for a plain object (not array/null), used to guard untrusted payloads.
export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
