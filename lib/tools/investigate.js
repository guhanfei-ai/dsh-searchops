// lib/tools/investigate.js — searchops_investigate: the highest-value tool. It
// runs the deterministic evidence engine (lib/investigate.js) and renders the
// resulting evidence package as a structured report. The plugin COLLECTS AND
// ORGANIZES EVIDENCE (recurring error patterns, representative samples, affected
// services, correlated traces, deterministic next queries); it deliberately does
// NOT decide the root cause — reasoning over the package is the model's job.
// Read-only, bounded at every step, and every value is untrusted data.
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  INVESTIGATE_DEFAULT_MAX_EVIDENCE,
  INVESTIGATE_MAX_EVIDENCE,
  INVESTIGATE_TOOL_TIMEOUT_MS,
  MAX_MESSAGE_CHARS,
  MAX_TIME_WINDOW_DAYS,
  REQUEST_TIMEOUT_MS,
  SOURCE_PARAM,
  UNTRUSTED_NOTE,
} from '../constants.js'
import { oneLine, textOut, truncate, validateIndexPattern } from '../util.js'
import { runInvestigate } from '../investigate.js'
import { formatFieldsNote, formatLogLine, formatTotal } from '../render.js'

// Render the evidence package as bounded text. Pure: takes the domain result and
// produces the agent-facing report. Never adds a conclusion, only structure.
export function renderInvestigation(res) {
  const s = res.summary
  const lines = []
  lines.push(`# Investigation of ${JSON.stringify(s.index)} (${s.from}..${s.to})${s.service ? ` service=${JSON.stringify(s.service)}` : ''}${s.query ? ` query=${JSON.stringify(s.query)}` : ''}`)
  lines.push(`scanned=${s.scannedDocs} doc(s); matched=${formatTotal(s.totalMatches)}; distinct patterns=${s.distinctPatterns}; error-level filter=${s.levelFilterApplied ? 'on' : 'off (no level field detected — grouped all logs in the window)'}`)
  const fnote = formatFieldsNote(s.fields ? { ...s.fields, detected: s.detectedFields } : null)
  if (fnote) lines.push(fnote)
  if (s.mappingError) lines.push(`note: the mapping was unavailable (${oneLine(s.mappingError, 160)}); fields fell back to convention.`)

  if (!res.evidence.length) {
    lines.push('', '## Recurring patterns', 'No error-level lines were found in this window. That is itself evidence: either the window/service is wrong, the level field was mis-detected (see fields above), or nothing errored here.')
  } else {
    lines.push('', '## Recurring patterns (most frequent first)')
    for (const e of res.evidence) {
      lines.push(`${e.rank}. [${e.count}x] ${truncate(oneLine(e.pattern, MAX_MESSAGE_CHARS), MAX_MESSAGE_CHARS)}`)
      const meta = []
      if (e.firstSeen) meta.push(`first=${oneLine(e.firstSeen, 40)}`)
      if (e.lastSeen) meta.push(`last=${oneLine(e.lastSeen, 40)}`)
      if (e.services && e.services.length) meta.push(`services=${e.services.map((x) => oneLine(x, 40)).join(',')}`)
      if (meta.length) lines.push(`   ${meta.join(' ')}`)
      if (e.sample) lines.push(`   sample: ${truncate(oneLine(e.sample.message ?? '', MAX_MESSAGE_CHARS), MAX_MESSAGE_CHARS)}${e.sample.id ? ` (id=${oneLine(e.sample.id, 80)})` : ''}`)
      if (e.traceIds && e.traceIds.length) lines.push(`   traces: ${e.traceIds.map((t) => oneLine(t, 64)).join(', ')}`)
    }
  }

  if (res.correlations && res.correlations.length) {
    lines.push('', '## Correlated traces (what else happened in the same request)')
    for (const c of res.correlations) {
      lines.push(`trace=${oneLine(c.traceId, 64)} events=${c.events} services=${(c.services || []).map((x) => oneLine(x, 40)).join(',') || '-'}`)
      for (const ev of (c.sample || [])) lines.push(`   ${formatLogLine(ev)}`)
    }
  }

  if (res.suggestedNextQueries && res.suggestedNextQueries.length) {
    lines.push('', '## Suggested next steps (deterministic — you decide the cause)')
    for (const q of res.suggestedNextQueries) lines.push(`- ${oneLine(q, 240)}`)
  }

  if (res.budgetNote) lines.push('', res.budgetNote)
  lines.push('', `Evidence only — the plugin does not infer root cause. ${UNTRUSTED_NOTE}`)
  return lines.join('\n')
}

export function defineSearchopsInvestigateTool(rt) {
  return defineTool({
    name: 'searchops_investigate',
    description: `Start here when something looks wrong but you do not yet know what. Given an index (and optionally a service, free-text hint and time window), it runs a fixed, bounded, read-only investigation and returns a structured evidence package: the schema it resolved, how many docs it scanned, the recurring error patterns with counts/first-seen/last-seen/affected services, a representative sample per pattern, the trace ids involved, correlated events for the top traces, and deterministic next-query suggestions. It gathers and organizes evidence; it does NOT decide the root cause — that reasoning is yours. The window defaults to the last 15 minutes and may not span more than ${MAX_TIME_WINDOW_DAYS} days; evidence count is capped (default ${INVESTIGATE_DEFAULT_MAX_EVIDENCE}, max ${INVESTIGATE_MAX_EVIDENCE}). ${UNTRUSTED_NOTE}`,
    parameters: {
      index: { type: 'string', required: true, description: 'Index name or wildcard pattern to investigate (e.g. "app-logs-*").' },
      service: { type: 'string', description: 'Optional service/application name to focus the investigation on.' },
      query: { type: 'string', description: 'Optional free-text hint matched against the message/service fields to focus the evidence.' },
      from: { type: 'string', description: 'Optional window start (now-15m, now-1h, ISO-8601, epoch millis). Defaults to now-15m.' },
      to: { type: 'string', description: 'Optional window end. Defaults to now.' },
      maxEvidence: { type: 'number', description: `Optional cap on evidence patterns returned, 1-${INVESTIGATE_MAX_EVIDENCE}. Defaults to ${INVESTIGATE_DEFAULT_MAX_EVIDENCE}.` },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    // Investigate fans out into several bounded requests (mapping + errors +
    // correlated traces), so it gets a wider tool budget than a single read.
    timeoutMs: INVESTIGATE_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Investigate ${oneLine(String(args?.index ?? ''), 40)}${args?.service ? ` service=${oneLine(String(args.service), 24)}` : ''}`, kind: 'search' }),
    async execute(args, exec) {
      const view = rt.forSource(rt.resolveSource(args.source))
      const index = validateIndexPattern(args.index, { field: 'index' })
      const res = await runInvestigate(view.provider, {
        index,
        profile: view.profile,
        query: args.query,
        service: args.service,
        from: args.from,
        to: args.to,
        maxEvidence: args.maxEvidence,
        signal: exec.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
      return renderInvestigation(res)
    },
  })
}
