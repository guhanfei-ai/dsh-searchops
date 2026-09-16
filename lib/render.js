// lib/render.js — Presentation layer: turn the provider-neutral envelopes from
// the domain modules into compact, bounded, one-row-per-line text for the agent.
// These are pure functions. Every untrusted value is single-lined and truncated
// so a document can never forge extra rows, hide a budget note, or blow the
// output budget. Rendering lives apart from domain logic so both stay testable.
import { MAX_FIELD_VALUE_CHARS, MAX_MESSAGE_CHARS } from './constants.js'
import { oneLine, truncate } from './util.js'

// Format a normalized { value, relation } total: exact counts print as-is, a
// capped count prints as a lower bound so the agent never reads ">=" as exact.
export function formatTotal(total) {
  if (!total || typeof total !== 'object') return '0'
  const value = Number.isFinite(Number(total.value)) ? Number(total.value) : 0
  return total.relation === 'gte' ? `>=${value}` : String(value)
}

// One projected log line: timestamp, LEVEL, [service], message, trace and id.
// Missing parts are skipped so the row stays compact.
export function formatLogLine(log = {}) {
  const parts = []
  if (log.timestamp) parts.push(oneLine(log.timestamp, 40))
  if (log.level) parts.push(oneLine(log.level, 16).toUpperCase())
  if (log.service) parts.push(`[${oneLine(log.service, MAX_FIELD_VALUE_CHARS)}]`)
  parts.push(truncate(oneLine(log.message ?? '', MAX_MESSAGE_CHARS), MAX_MESSAGE_CHARS))
  if (log.traceId) parts.push(`trace=${oneLine(log.traceId, MAX_FIELD_VALUE_CHARS)}`)
  if (log.id) parts.push(`id=${oneLine(log.id, 80)}`)
  return parts.join(' ')
}

// Describe the resolved field profile and flag which roles were auto-detected
// (guessed) rather than configured, so the agent knows when a wrong field could
// explain an empty result and can suggest pinning a profile.
export function formatFieldsNote(fields) {
  if (!fields) return ''
  const roles = [
    ['timestamp', fields.timestampField],
    ['message', fields.messageField],
    ['service', fields.serviceField],
    ['level', fields.levelField],
    ['trace', fields.traceIdField],
  ]
  const parts = roles.filter(([, f]) => typeof f === 'string' && f).map(([role, f]) => `${role}=${oneLine(f, 60)}`)
  if (parts.length === 0) return ''
  let line = `fields: ${parts.join(' ')}`
  const detected = fields.detected ? Object.entries(fields.detected).filter(([, v]) => v === true).map(([k]) => k) : []
  if (detected.length) line += ` (auto-detected: ${detected.join(', ')} — configure a source profile to pin these if a result looks wrong)`
  return line
}

// Render an aggregation bucket: key, count and (when present) the metric value.
export function formatBucket(bucket = {}, metricLabel) {
  const key = oneLine(bucket.key ?? '', MAX_FIELD_VALUE_CHARS)
  let line = `${key || '(empty)'} count=${Number.isFinite(Number(bucket.count)) ? Number(bucket.count) : 0}`
  if (bucket.metric !== undefined && Number.isFinite(Number(bucket.metric))) {
    line += ` ${oneLine(metricLabel || 'metric', 24)}=${Number(bucket.metric)}`
  }
  return line
}
