// lib/runtime.js — Stateful infrastructure: multi-source resolution and the
// authenticated, bounded HTTP client each provider adapter runs on.
//
// Security invariants enforced here (and only here):
//   • Credentials are resolved from the DSH credential store per request and go
//     straight into the Authorization header. They are never returned, logged, or
//     interpolated into an error message.
//   • `redirect: 'error'` — redirects are never followed, so an Authorization
//     header can never be forwarded to a different origin (SSRF/cred-leak guard).
//   • Every request has a timeout (combined with the host's abort signal) and a
//     hard response-byte cap enforced while streaming.
//   • Upstream bodies are treated as untrusted: parsed strictly, redacted, and
//     single-lined before any fragment reaches an error string.
import {
  AUTH_BASIC,
  AUTH_BEARER,
  AUTH_NONE,
  MAX_RESPONSE_BYTES,
  REDIRECT_HINT,
  REQUEST_TIMEOUT_MS,
  RETRYABLE_STATUS,
} from './constants.js'
import { defaultSourceId, effectiveSources, resolveSource as resolveSourceFromConfig, resolveSourceProfile, sanitizeUrlForDisplay } from './config.js'
import { translateHttpFailure, translateNetworkFailure } from './failures.js'
import { createProvider } from './providers/index.js'
import {
  abortableDelay,
  combineSignals,
  normalizeBaseUrl,
  oneLine,
  readLimitedText,
  redactSecrets,
} from './util.js'

// base64 for HTTP Basic. Prefer Node's Buffer; fall back to btoa (browser client
// runtimes). Input is treated as latin1 bytes, matching how user:pass is encoded.
function base64(input) {
  const str = String(input ?? '')
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64')
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(str)))
  throw new Error('No base64 encoder available in this runtime.')
}

export function createRuntime(ctx, activeConfig) {
  function config() {
    return activeConfig() ?? {}
  }

  function resolveSource(sourceArg) {
    return resolveSourceFromConfig(config(), sourceArg)
  }

  // Resolve a credential value by ref. Returns '' when unset. The value is a
  // secret: callers may only use it to build a header, never to build a message.
  async function resolveCredential(ref) {
    if (!ref) return ''
    try {
      const result = await ctx.credentials.resolve(ref)
      return typeof result?.value === 'string' ? result.value : ''
    } catch {
      return ''
    }
  }

  async function credentialPresent(ref) {
    return Boolean(await resolveCredential(ref))
  }

  // For searchops_sources: non-secret description of each source. Credentials are
  // reported only as a boolean (configured/missing), never as a value.
  async function listSources() {
    const cfg = config()
    const sources = effectiveSources(cfg)
    const defaultId = defaultSourceId(cfg, sources)
    const out = []
    for (const source of sources) {
      let credentialsConfigured = true
      if (source.auth === AUTH_BASIC) {
        const haveUser = Boolean(source.username) || (await credentialPresent(source.usernameRef))
        const havePass = await credentialPresent(source.passwordRef)
        credentialsConfigured = haveUser && havePass
      } else if (source.auth === AUTH_BEARER) {
        credentialsConfigured = await credentialPresent(source.tokenRef)
      }
      out.push({
        name: source.name,
        id: source.id,
        provider: source.provider,
        url: sanitizeUrlForDisplay(source.url),
        auth: source.auth,
        profile: source.profile || '(auto-detect)',
        credentialsConfigured,
        isDefault: source.id === defaultId,
      })
    }
    return out
  }

  // Build the Authorization header for a source, resolving secrets at call time.
  // Throws a clear, secret-free error when a required credential is not set.
  async function buildAuthHeaders(source) {
    if (source.auth === AUTH_NONE) return {}
    if (source.auth === AUTH_BASIC) {
      const username = source.username || (await resolveCredential(source.usernameRef))
      const password = await resolveCredential(source.passwordRef)
      if (!username) {
        throw new Error(`Basic auth for search source ${JSON.stringify(source.name)} needs a username. Set it in config or store it under credential ref ${source.usernameRef}.`)
      }
      if (!password) {
        throw new Error(`Basic auth for search source ${JSON.stringify(source.name)} needs a password. Store it in the DSH credential store under ref ${source.passwordRef} (never in config or Git).`)
      }
      return { authorization: `Basic ${base64(`${username}:${password}`)}` }
    }
    if (source.auth === AUTH_BEARER) {
      const token = await resolveCredential(source.tokenRef)
      if (!token) {
        throw new Error(`Bearer auth for search source ${JSON.stringify(source.name)} needs a token. Store it in the DSH credential store under ref ${source.tokenRef}.`)
      }
      return { authorization: `Bearer ${token}` }
    }
    throw new Error(`Unsupported auth mode ${JSON.stringify(source.auth)} for search source ${JSON.stringify(source.name)}.`)
  }

  // A client view bound to one source: an `http` function plus a provider adapter
  // wired to it. Everything downstream (tools, domain logic) uses this.
  function forSource(source) {
    async function resolveBaseUrl() {
      const { allowInsecureHttp } = config()
      return normalizeBaseUrl(source.url, allowInsecureHttp === true)
    }

    async function http(method, path, init = {}, opts = {}) {
      const baseUrl = await resolveBaseUrl()
      const verb = String(method ?? 'GET').toUpperCase()
      const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS
      const authHeaders = await buildAuthHeaders(source)
      const attempts = verb === 'GET' ? 2 : 1
      const headers = {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...authHeaders,
        ...(init.headers ?? {}),
      }
      const payload = init.body !== undefined ? JSON.stringify(init.body) : undefined
      const byteCap = Number.isFinite(Number(opts.maxResponseBytes)) ? Number(opts.maxResponseBytes) : MAX_RESPONSE_BYTES

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const signal = combineSignals(opts.signal, timeoutMs)
        let response
        try {
          response = await fetch(`${baseUrl}${path}`, {
            method: verb,
            headers,
            body: payload,
            redirect: 'error', // never follow redirects; never forward creds cross-origin
            signal,
          })
        } catch (error) {
          const aborted = signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError'
          if (aborted) {
            throw new Error(translateNetworkFailure({ error, method: verb, path, sourceName: source.name, aborted: true }))
          }
          // redirect:'error' rejects with a TypeError; surface the security hint.
          const msg = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`.toLowerCase()
          if (msg.includes('redirect')) {
            throw new Error(`${REDIRECT_HINT} (${verb} ${oneLine(path, 160)})`)
          }
          if (attempt + 1 < attempts) {
            await abortableDelay(200, opts.signal)
            continue
          }
          throw new Error(translateNetworkFailure({ error, method: verb, path, sourceName: source.name }))
        }

        let text
        try {
          text = await readLimitedText(response, byteCap)
        } catch (error) {
          const aborted = signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError'
          if (aborted) {
            throw new Error(translateNetworkFailure({ error, method: verb, path, sourceName: source.name, aborted: true }))
          }
          throw error // size-limit errors are already safe & bounded
        }

        if (response.ok) {
          if (!text) return null
          try {
            return JSON.parse(text)
          } catch {
            // A 200 with a non-JSON body is almost always a login gateway or proxy
            // intercepting the API path. Redact (the page may echo credentials)
            // and never treat it as success.
            throw new Error(`Search API ${verb} ${oneLine(path, 160)} returned HTTP ${response.status} with a non-JSON body (${oneLine(redactSecrets(text), 120) || 'empty'}); expected JSON. If this source sits behind a login gateway or proxy, check that API paths reach the cluster unchanged.`)
          }
        }

        if (attempt + 1 < attempts && RETRYABLE_STATUS.has(response.status)) {
          await abortableDelay(200, opts.signal)
          continue
        }
        throw new Error(translateHttpFailure({
          status: response.status,
          method: verb,
          path,
          body: text,
          sourceName: source.name,
        }))
      }
      throw new Error(`Search request failed unexpectedly: ${verb} ${oneLine(path, 160)}`)
    }

    const provider = createProvider(source.provider, { http })
    // The field profile bound to this source (from config `profiles`); domain
    // logic merges it with auto-detection/convention so custom schemas work.
    const profile = resolveSourceProfile(config(), source)
    return { source, http, provider, resolveBaseUrl, profile }
  }

  return { resolveSource, listSources, forSource, resolveCredential }
}
