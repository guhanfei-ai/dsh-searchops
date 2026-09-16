// lib/fields.js — Configurable field profiles with best-effort auto-detection.
// The log world's biggest pain is that schemas are not uniform: one index uses
// `@timestamp`/`message`/`service.name`, another uses `ts`/`msg`/`app`. We never
// hard-code a single schema. An operator can bind a profile per source; when
// there is none we detect from the mapping (or a sample doc) and finally fall
// back to the most common convention so queries still work.

import { DEFAULT_PROFILE_NAME, FIELD_CANDIDATES, MAX_MAPPING_FIELDS } from './constants.js'
import { oneLine } from './util.js'

export const FIELD_ROLES = ['timestamp', 'message', 'service', 'level', 'traceId']

// Read a possibly-dotted path from a _source document. OpenSearch mappings may
// store `service.name` either as a nested object {service:{name}} or as a
// literal flattened key "service.name"; we honor the literal key first.
export function getByPath(doc, path) {
  if (!doc || typeof doc !== 'object' || !path) return undefined
  if (Object.prototype.hasOwnProperty.call(doc, path)) return doc[path]
  const parts = String(path).split('.')
  let cursor = doc
  for (const part of parts) {
    if (cursor && typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, part)) {
      cursor = cursor[part]
    } else {
      return undefined
    }
  }
  return cursor
}

// Normalize whatever "available fields" we were given (array, Set, or object of
// mappings) into a lowercase-lookup Set of exact field paths.
function toFieldSet(availableFields) {
  const set = new Set()
  if (!availableFields) return set
  const iter = availableFields instanceof Set ? [...availableFields] : (Array.isArray(availableFields) ? availableFields : Object.keys(availableFields))
  for (const f of iter) {
    if (typeof f === 'string' && f) set.add(f)
  }
  return set
}

// Pick the first candidate that actually exists in the field set (case-sensitive
// match, then case-insensitive). Returns null when nothing matches.
function detectRole(role, fieldSet) {
  const candidates = FIELD_CANDIDATES[role] ?? []
  for (const cand of candidates) {
    if (fieldSet.has(cand)) return cand
  }
  const lower = new Map()
  for (const f of fieldSet) lower.set(f.toLowerCase(), f)
  for (const cand of candidates) {
    const hit = lower.get(cand.toLowerCase())
    if (hit) return hit
  }
  return null
}

// Resolve the profile object referenced by name from the config `profiles` map.
// Falls back to the `default` profile, then to an empty object.
export function resolveProfileConfig(profiles, profileName) {
  const map = profiles && typeof profiles === 'object' ? profiles : {}
  const wanted = typeof profileName === 'string' && profileName.trim() ? profileName.trim() : DEFAULT_PROFILE_NAME
  const chosen = map[wanted] ?? map[DEFAULT_PROFILE_NAME] ?? {}
  return chosen && typeof chosen === 'object' ? chosen : {}
}

// Build the effective field profile for a source. Explicit profile fields win;
// each unset role is detected from `availableFields`; anything still unset uses
// the most common convention (first candidate) so a query is never missing a
// timestamp/message field entirely. `detected` records which roles were guessed
// rather than configured, so tools can flag uncertainty to the agent.
export function resolveFieldProfile({ profile = {}, availableFields = null } = {}) {
  const fieldSet = toFieldSet(availableFields)
  const out = {}
  const detected = {}
  const keyFor = { timestamp: 'timestampField', message: 'messageField', service: 'serviceField', level: 'levelField', traceId: 'traceIdField' }

  for (const role of FIELD_ROLES) {
    const configured = typeof profile[keyFor[role]] === 'string' ? profile[keyFor[role]].trim() : ''
    if (configured) {
      out[keyFor[role]] = configured
      detected[role] = false
      continue
    }
    const found = detectRole(role, fieldSet)
    if (found) {
      out[keyFor[role]] = found
      detected[role] = true
      continue
    }
    // Final fallback: the most common convention for this role.
    out[keyFor[role]] = (FIELD_CANDIDATES[role] ?? [])[0] ?? ''
    detected[role] = true
  }
  return { ...out, detected }
}

// The `_source` field list implied by a resolved profile: deduped and in a
// stable role order (timestamp, message, service, level, traceId). Restricting
// `_source` to these keeps a bounded log/context response small even when the
// underlying documents are huge.
export function profileSourceFields(fields = {}) {
  const list = [fields.timestampField, fields.messageField, fields.serviceField, fields.levelField, fields.traceIdField]
  return [...new Set(list.filter((f) => typeof f === 'string' && f.trim()))]
}

// Flatten an OpenSearch/Elasticsearch mapping `properties` tree into a list of
// dotted field paths (with their leaf type), used for detection and for the
// bounded field summary in searchops_mapping.
export function flattenMappingProperties(properties, { maxFields = Infinity, prefix = '' } = {}) {
  const out = []
  const walk = (props, base) => {
    if (!props || typeof props !== 'object') return
    for (const [name, def] of Object.entries(props)) {
      if (out.length >= maxFields) return
      if (!def || typeof def !== 'object') continue
      const path = base ? `${base}.${name}` : name
      const type = typeof def.type === 'string' ? def.type : (def.properties ? 'object' : '')
      // A node with sub-properties is a branch; record it only if it also has a
      // concrete type, then descend. Leaf fields are always recorded.
      if (def.properties && typeof def.properties === 'object') {
        if (type && type !== 'object') out.push({ path, type })
        walk(def.properties, path)
      } else {
        out.push({ path, type: type || 'unknown' })
      }
    }
  }
  walk(properties, prefix)
  return out
}

// Collect every field path across all indices in a mapping response, so field
// auto-detection sees the real schema instead of guessing. Mirrors the shape the
// OpenSearch adapter returns from getMapping: { indices: [{ fields: [{ path }] }] }.
function collectMappingFields(mapping) {
  const set = new Set()
  for (const idx of (mapping && Array.isArray(mapping.indices) ? mapping.indices : [])) {
    for (const f of (idx && Array.isArray(idx.fields) ? idx.fields : [])) {
      if (f && typeof f.path === 'string' && f.path) set.add(f.path)
    }
  }
  return set
}

// Resolve the effective field profile for one tool invocation, following the same
// precedence everywhere: explicit source profile → mapping auto-detection →
// convention fallback. A caller that already fetched the schema (investigate reads
// the mapping once, then correlates) passes `availableFields` so we skip the extra
// round-trip. A mapping failure is never fatal: we degrade to convention and
// return `mappingError` so the tool can disclose it — evidence stays bounded but
// truthful. Returns { fields, availableFields, mappingError }.
export async function resolveSourceFields(provider, { index, profile = {}, availableFields = null, signal, timeoutMs } = {}) {
  let detected = availableFields
  let mappingError = null
  if (detected == null) {
    try {
      const mapping = await provider.getMapping({ index, maxFields: MAX_MAPPING_FIELDS, signal, timeoutMs })
      detected = collectMappingFields(mapping)
    } catch (error) {
      mappingError = oneLine(error?.message ?? 'mapping unavailable', 160)
      detected = new Set()
    }
  }
  return {
    fields: resolveFieldProfile({ profile, availableFields: detected }),
    availableFields: detected,
    mappingError,
  }
}
