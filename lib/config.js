// lib/config.js — Source & profile configuration: normalization, validation and
// resolution. This module is pure (no ctx, no IO). The credential *values* are
// never here — config holds only credential *references*; runtime.js resolves the
// secrets from the DSH credential store at request time.
//
// Config accepts two shapes for `sources` and `profiles` and canonicalizes both:
//   - array form (what the DSH settings schema persists)
//   - object-map form (what hand-written JSON / the README examples use)
// Secrets inline in config are rejected outright so they can never reach Git.

import {
  AUTH_BASIC,
  DEFAULT_SOURCE_NAME,
  MAX_SOURCES,
  PROVIDER_OPENSEARCH,
  SUPPORTED_AUTH,
  SUPPORTED_PROVIDERS,
  SOURCE_ID_PATTERN,
} from './constants.js'
import { resolveProfileConfig } from './fields.js'
import {
  normalizeSourceName,
  passwordRefForId,
  tokenRefForId,
  usernameRefForId,
  validateCredentialRef,
} from './util.js'

// Keys that must never appear as literal secrets in source config. If present we
// fail loudly and point the operator at the credential store instead of silently
// ignoring them (which would leave a secret sitting in a config file / Git).
const FORBIDDEN_SECRET_KEYS = ['password', 'passwd', 'pwd', 'token', 'apiKey', 'api_key', 'secret', 'authorization']

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

// Turn an object-map ({ name: {...} }) or an array into an array of raw entries,
// attaching the map key as `name` when the entry has none.
function entriesFrom(mapOrArray) {
  if (Array.isArray(mapOrArray)) return mapOrArray.filter(isPlainObject)
  if (isPlainObject(mapOrArray)) {
    return Object.entries(mapOrArray).map(([key, value]) => (isPlainObject(value) ? { name: key, ...value } : null)).filter(Boolean)
  }
  return []
}

// Turn profiles (object-map keyed by profile name, or array with a `name` field)
// into a plain map { profileName: {timestampField,...} }.
export function normalizeProfiles(profiles) {
  const out = {}
  if (isPlainObject(profiles) && !Array.isArray(profiles)) {
    // Could already be a map of profiles, or a single profile object. Detect by
    // checking whether any value looks like a profile (has *Field keys).
    const values = Object.values(profiles)
    const looksLikeProfileMap = values.some((v) => isPlainObject(v) && Object.keys(v).some((k) => k.endsWith('Field')))
    if (looksLikeProfileMap) {
      for (const [name, prof] of Object.entries(profiles)) {
        if (isPlainObject(prof)) out[name] = pickProfileFields(prof)
      }
      return out
    }
    // A single inline profile object → treat as the default profile.
    return { default: pickProfileFields(profiles) }
  }
  if (Array.isArray(profiles)) {
    for (const prof of profiles) {
      if (!isPlainObject(prof)) continue
      const name = typeof prof.name === 'string' && prof.name.trim() ? prof.name.trim() : 'default'
      out[name] = pickProfileFields(prof)
    }
  }
  return out
}

function pickProfileFields(prof) {
  const keep = ['timestampField', 'messageField', 'serviceField', 'levelField', 'traceIdField']
  const out = {}
  for (const k of keep) {
    if (typeof prof[k] === 'string' && prof[k].trim()) out[k] = prof[k].trim()
  }
  return out
}

// Validate a raw config object (used by settings.register and the entry config).
// Returns the value unchanged so the settings store persists what the user wrote.
export function validateConfig(value) {
  const cfg = isPlainObject(value) ? value : {}
  const sources = entriesFrom(cfg.sources)
  if (sources.length > MAX_SOURCES) {
    throw new Error(`Too many search sources (${sources.length}; limit ${MAX_SOURCES}).`)
  }
  const names = new Set()
  for (const source of sources) {
    // id, when present, must be system-shaped; a missing id is allowed here and
    // synthesized during normalization (name-derived) for hand-written configs.
    if (source.id !== undefined && source.id !== null && String(source.id).trim() !== '') {
      if (!SOURCE_ID_PATTERN.test(String(source.id).trim())) {
        throw new Error(`Invalid search source id ${JSON.stringify(source.id)}: ids are system-generated and read-only (1-64 chars: letters, digits, underscore, hyphen).`)
      }
    }
    const name = normalizeSourceName(source.name)
    const lower = name.toLowerCase()
    if (names.has(lower)) throw new Error(`Duplicate search source name ${JSON.stringify(name)}. Source names must be unique.`)
    names.add(lower)

    const provider = String(source.provider ?? PROVIDER_OPENSEARCH).trim().toLowerCase()
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      throw new Error(`Unsupported provider ${JSON.stringify(source.provider)} for search source ${JSON.stringify(name)}. Supported in v0.1: ${[...SUPPORTED_PROVIDERS].join(', ')}. (elasticsearch is on the roadmap, not implemented.)`)
    }
    const auth = String(source.auth ?? AUTH_BASIC).trim().toLowerCase()
    if (!SUPPORTED_AUTH.has(auth)) {
      throw new Error(`Unsupported auth ${JSON.stringify(source.auth)} for search source ${JSON.stringify(name)}. Supported: ${[...SUPPORTED_AUTH].join(', ')}.`)
    }
    // Reject literal secrets in config — they belong in the credential store.
    const refHint = auth === 'basic' ? 'usernameRef/passwordRef' : (auth === 'bearer' ? 'tokenRef' : 'a credential ref')
    for (const key of FORBIDDEN_SECRET_KEYS) {
      if (typeof source[key] === 'string' && source[key].trim()) {
        throw new Error(`Search source ${JSON.stringify(name)} must not contain a literal "${key}" in config. Store secrets in the DSH credential store and reference them via ${refHint} so they never enter Git.`)
      }
    }
    for (const refKey of ['usernameRef', 'passwordRef', 'tokenRef']) {
      if (source[refKey] !== undefined && source[refKey] !== null && String(source[refKey]).trim() !== '') {
        validateCredentialRef(String(source[refKey]).trim())
      }
    }
  }
  // Profiles are validated leniently (string fields only); normalizeProfiles
  // already ignores malformed values.
  normalizeProfiles(cfg.profiles)
  return value
}

// Canonical, runtime-ready source list. Fills defaults and derives credential
// refs from the source id when not explicitly set.
export function effectiveSources(cfg) {
  const raw = entriesFrom(isPlainObject(cfg) ? cfg.sources : null)
  const list = []
  for (const entry of raw) {
    let name
    try { name = normalizeSourceName(entry.name) } catch { continue }
    const id = (typeof entry.id === 'string' && SOURCE_ID_PATTERN.test(entry.id.trim()))
      ? entry.id.trim()
      : stableIdFromName(name)
    const provider = String(entry.provider ?? PROVIDER_OPENSEARCH).trim().toLowerCase() || PROVIDER_OPENSEARCH
    const auth = String(entry.auth ?? AUTH_BASIC).trim().toLowerCase() || AUTH_BASIC
    const url = typeof entry.url === 'string' && entry.url.trim()
      ? entry.url.trim()
      : (typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '')
    const username = typeof entry.username === 'string' ? entry.username.trim() : '' // non-secret convenience
    list.push({
      id,
      name,
      provider,
      auth,
      url,
      username,
      usernameRef: refOr(entry.usernameRef, usernameRefForId(id)),
      passwordRef: refOr(entry.passwordRef, passwordRefForId(id)),
      tokenRef: refOr(entry.tokenRef, tokenRefForId(id)),
      profile: typeof entry.profile === 'string' ? entry.profile.trim() : '',
    })
  }
  return list
}

function refOr(value, fallback) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) return fallback
  try { return validateCredentialRef(v) } catch { return fallback }
}

// Derive a stable, source-id-shaped key from a name for hand-written configs
// that omit an explicit id. Keeps credential refs stable across restarts.
function stableIdFromName(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug || DEFAULT_SOURCE_NAME
}

export function defaultSourceId(cfg, sources) {
  const wanted = isPlainObject(cfg) && typeof cfg.defaultSource === 'string' ? cfg.defaultSource.trim() : ''
  if (wanted) {
    const byId = sources.find((s) => s.id === wanted)
    if (byId) return byId.id
    const byName = sources.find((s) => s.name.toLowerCase() === wanted.toLowerCase())
    if (byName) return byName.id
  }
  return sources.length === 1 ? sources[0].id : null
}

// Resolve a source by name (preferred) or id; omit to use the default. Throws a
// helpful, secret-free error listing the configured names when it cannot resolve.
export function resolveSource(cfg, sourceArg) {
  const sources = effectiveSources(cfg)
  const key = String(sourceArg ?? '').trim()
  if (key) {
    const byName = sources.find((s) => s.name === key)
    if (byName) return byName
    const byNameCi = sources.find((s) => s.name.toLowerCase() === key.toLowerCase())
    if (byNameCi) return byNameCi
    const byId = sources.find((s) => s.id === key)
    if (byId) return byId
    const names = sources.map((s) => JSON.stringify(s.name)).join(', ')
    throw new Error(`Unknown search source ${JSON.stringify(key)}. Configured sources: ${names || '(none)'}. Call searchops_sources to list them.`)
  }
  const defId = defaultSourceId(cfg, sources)
  const def = sources.find((s) => s.id === defId)
  if (def) return def
  if (sources.length === 0) {
    throw new Error('No search sources are configured. Add one in Settings → Plugins (or provide `sources` in the plugin configuration).')
  }
  const names = sources.map((s) => JSON.stringify(s.name)).join(', ')
  throw new Error(`Multiple search sources are configured (${names}) but none is the default and no source was specified. Pass the source name, or set a default in Settings → Plugins.`)
}

// Resolve the profile object bound to a source (by name), from the config map.
export function resolveSourceProfile(cfg, source) {
  const profiles = normalizeProfiles(isPlainObject(cfg) ? cfg.profiles : null)
  return resolveProfileConfig(profiles, source?.profile)
}

// Sanitize a URL for display in searchops_sources: drop any userinfo, keep
// scheme://host[:port]/path. URLs never contain secrets by construction
// (normalizeBaseUrl rejects embedded credentials), but we sanitize defensively.
export function sanitizeUrlForDisplay(url) {
  const raw = String(url ?? '').trim()
  if (!raw) return '(not set)'
  try {
    const u = new URL(raw)
    u.username = ''
    u.password = ''
    return u.toString().replace(/\/+$/, '')
  } catch {
    return raw.replace(/\/\/[^@/]+@/, '//[redacted]@')
  }
}
