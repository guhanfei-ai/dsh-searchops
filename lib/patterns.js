// lib/patterns.js — Deterministic log pattern fingerprinting (no ML, no model).
// A wall of logs like "Connection refused" × 842 is useless to an agent that has
// to read and count it token by token. We normalize each message into a stable
// fingerprint and aggregate counts, first/last seen and representative samples
// *in the plugin*, so the agent receives "Connection refused — 842" instead of
// 842 raw lines.
//
// Normalization is deliberately conservative: it only replaces high-entropy
// tokens (timestamps, UUIDs, IPs, hex/trace ids, long numbers) with placeholders.
// It never strips meaningful words, so distinct errors stay distinct.
import { MAX_FINGERPRINT_CHARS, MAX_MESSAGE_CHARS, MIN_PLACEHOLDER_DIGITS } from './constants.js'
import { getByPath } from './fields.js'
import { oneLine, sanitizeDocument } from './util.js'

// Order matters: high-specificity patterns first so their digits/colons are not
// consumed by the generic number/IP rules below.
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g
const TIME_ONLY = /(?<![\d:])\d{2}:\d{2}:\d{2}(?:\.\d+)?(?![\d:])/g
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const HEX_PREFIXED = /\b0x[0-9a-fA-F]+\b/g
const IP_PORT = /\b\d{1,3}(?:\.\d{1,3}){3}:\d+\b/g
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g
const LONG_HEX = /\b[0-9a-fA-F]{16,}\b/g
const LONG_NUMBER = new RegExp(`\\b\\d{${MIN_PLACEHOLDER_DIGITS},}\\b`, 'g')

// Normalize one message into a fingerprint label. Pure and deterministic.
export function normalizeMessage(text, { maxLength = MAX_FINGERPRINT_CHARS } = {}) {
  let out = oneLine(text, MAX_MESSAGE_CHARS) // collapse newlines/tabs, cap raw size
  if (!out) return ''
  out = out
    .replace(ISO_TIMESTAMP, '<ts>')
    .replace(UUID, '<uuid>')
    .replace(HEX_PREFIXED, '<hex>')
    .replace(IP_PORT, '<ip>:<port>')
    .replace(IPV4, '<ip>')
    .replace(LONG_HEX, '<hex>')
    .replace(TIME_ONLY, '<time>')
    .replace(LONG_NUMBER, '<num>')
  // Collapse runs of whitespace introduced by replacements.
  out = out.replace(/\s{2,}/g, ' ').trim()
  if (out.length > maxLength) out = `${out.slice(0, maxLength - 1)}…`
  return out
}

// A fingerprint is a display label plus a case-insensitive grouping key so that
// "Connection refused" and "connection refused" collapse into one pattern while
// the label keeps the first-seen casing for readability.
export function fingerprint(text) {
  const label = normalizeMessage(text)
  return { label, key: label.toLowerCase() }
}

// Group a bounded list of hits into recurring patterns.
//   hits: [{ id, index, source }]  (the provider-neutral search shape)
//   fields: { messageField, timestampField, traceIdField, serviceField }
// Returns patterns sorted by count desc, each with first/last seen, a redacted
// representative sample and up to `maxTraceIds` correlation ids.
export function groupPatterns(hits, fields = {}, { maxPatterns = Infinity, maxSamplesPerPattern = 1, maxTraceIds = 5 } = {}) {
  const list = Array.isArray(hits) ? hits : []
  const { messageField = 'message', timestampField = '@timestamp', traceIdField = 'trace.id', serviceField = 'service.name' } = fields
  const byKey = new Map()

  for (const hit of list) {
    const rawDoc = hit && typeof hit === 'object' && hit.source ? hit.source : hit
    // Redact before fingerprinting so a credential cannot survive into the
    // pattern label, the representative sample, a trace id or a service name.
    const doc = sanitizeDocument(rawDoc)
    const rawMessage = getByPath(doc, messageField)
    const message = typeof rawMessage === 'string' ? rawMessage : (rawMessage == null ? '' : JSON.stringify(rawMessage))
    const { key, label } = fingerprint(message)
    if (!key) continue
    const ts = getByPath(doc, timestampField)
    const tsStr = ts == null ? '' : String(ts)
    const traceId = traceIdField ? getByPath(doc, traceIdField) : undefined
    const service = serviceField ? getByPath(doc, serviceField) : undefined

    let p = byKey.get(key)
    if (!p) {
      p = { key, label, count: 0, firstSeen: tsStr, lastSeen: tsStr, samples: [], traceIds: [], services: new Set() }
      byKey.set(key, p)
    }
    p.count += 1
    if (tsStr) {
      if (!p.firstSeen || tsStr < p.firstSeen) p.firstSeen = tsStr
      if (!p.lastSeen || tsStr > p.lastSeen) p.lastSeen = tsStr
    }
    if (p.samples.length < maxSamplesPerPattern) {
      p.samples.push({ id: hit?.id ?? '', index: hit?.index ?? '', message: oneLine(message, MAX_MESSAGE_CHARS), timestamp: tsStr })
    }
    if (traceId != null && traceId !== '' && p.traceIds.length < maxTraceIds && !p.traceIds.includes(String(traceId))) {
      p.traceIds.push(String(traceId))
    }
    if (service != null && service !== '' && p.services.size < 10) p.services.add(String(service))
  }

  const patterns = [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map((p) => ({
      label: p.label,
      count: p.count,
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
      sample: p.samples[0] ?? null,
      traceIds: p.traceIds,
      services: [...p.services],
    }))
  const totalPatterns = patterns.length
  const capped = Number.isFinite(maxPatterns) ? patterns.slice(0, maxPatterns) : patterns
  return { patterns: capped, totalPatterns, truncated: capped.length < totalPatterns, totalDocs: list.length }
}
