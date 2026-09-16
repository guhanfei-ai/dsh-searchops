// lib/tools/analysis.js — The two analysis tools:
//   searchops_aggregate — group/count/metric over an index (top services, status
//                         distribution, errors over time) without pulling docs.
//   searchops_context   — the lines around one event, or every event sharing a
//                         trace id.
// Both are read-only, bounded, and return untrusted data.
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  DEFAULT_AGG_LIMIT,
  DEFAULT_CONTEXT_LINES,
  MAX_AGG_LIMIT,
  MAX_CONTEXT_LINES,
  MAX_CONTEXT_WINDOW_SECONDS,
  MAX_TIME_WINDOW_DAYS,
  REQUEST_TIMEOUT_MS,
  SOURCE_PARAM,
  TOOL_TIMEOUT_MS,
  UNTRUSTED_NOTE,
} from '../constants.js'
import { oneLine, textOut, validateIndexPattern } from '../util.js'
import { runAggregate } from '../aggregate.js'
import { runContext } from '../context.js'
import { formatBucket, formatFieldsNote, formatLogLine, formatTotal } from '../render.js'

const METRIC_ENUM = ['avg', 'min', 'max', 'sum', 'value_count', 'cardinality']

export function defineSearchopsAggregateTool(rt) {
  return defineTool({
    name: 'searchops_aggregate',
    description: `Aggregate over an index instead of reading documents: group by a field (top services, status-code distribution, most frequent error field values), and/or bucket over time (a date histogram), optionally with a metric sub-aggregation (avg/max/sum/cardinality of a numeric field). Give at least one of groupBy or interval. A field can be named semantically ("service", "level") or literally ("http.response.status_code"). Bucket lists are capped (default ${DEFAULT_AGG_LIMIT}, max ${MAX_AGG_LIMIT}) and the window may not span more than ${MAX_TIME_WINDOW_DAYS} days; truncation is disclosed. Read-only; bucket keys are untrusted data.`,
    parameters: {
      index: { type: 'string', required: true, description: 'Index name or wildcard pattern to aggregate over.' },
      groupBy: { type: 'string', description: 'Field to group by (a terms aggregation), e.g. "service", "level", or "http.response.status_code". Semantic names map through the field profile.' },
      interval: { type: 'string', description: 'Date-histogram bucket size, a number plus a unit (s,m,h,d,w,M,y), e.g. "5m" or "1h". Requires a timestamp field.' },
      metric: { type: 'string', enum: METRIC_ENUM, description: 'Optional metric to compute per bucket: avg, min, max, sum, value_count, cardinality. Requires metricField.' },
      metricField: { type: 'string', description: 'Optional numeric field the metric is computed over, e.g. "duration".' },
      filter: { type: 'string', description: 'Optional free-text filter applied before aggregating (matched against message/service).' },
      from: { type: 'string', description: 'Optional range start (now-1h, ISO-8601, epoch millis). Defaults to now-1h.' },
      to: { type: 'string', description: 'Optional range end. Defaults to now.' },
      limit: { type: 'number', description: `Optional max buckets per group, 1-${MAX_AGG_LIMIT}. Defaults to ${DEFAULT_AGG_LIMIT}.` },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Aggregate ${oneLine(String(args?.index ?? ''), 40)}${args?.groupBy ? ` by ${oneLine(String(args.groupBy), 24)}` : ''}${args?.interval ? ` /${oneLine(String(args.interval), 8)}` : ''}`, kind: 'read' }),
    async execute(args, exec) {
      const view = rt.forSource(rt.resolveSource(args.source))
      const index = validateIndexPattern(args.index, { field: 'index' })
      const res = await runAggregate(view.provider, {
        index,
        profile: view.profile,
        from: args.from,
        to: args.to,
        filter: args.filter,
        groupBy: args.groupBy,
        metric: args.metric,
        metricField: args.metricField,
        interval: args.interval,
        limit: args.limit,
        signal: exec.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
      const metricLabel = res.metric ? `${res.metric.metric}(${res.metric.field})` : null
      const lines = [`aggregate on ${JSON.stringify(index)} range=${res.from}..${res.to} matched=${formatTotal(res.total)} took=${res.took ?? '-'}ms`]
      if (res.groups) {
        lines.push(`groups by ${JSON.stringify(res.groupBy)}:`)
        if (res.groups.length === 0) lines.push('  (no buckets)')
        for (const b of res.groups) lines.push(`  ${formatBucket(b, metricLabel)}`)
        if (res.groupsOtherDocCount) lines.push(`  (other: ${res.groupsOtherDocCount} doc(s) in groups beyond the limit)`)
      }
      if (res.histogram) {
        lines.push(`over time (every ${res.interval}):`)
        if (res.histogram.length === 0) lines.push('  (no buckets)')
        for (const b of res.histogram) lines.push(`  ${formatBucket(b, metricLabel)}`)
      }
      if (res.budgetNote) lines.push(res.budgetNote)
      lines.push(UNTRUSTED_NOTE)
      return lines.join('\n')
    },
  })
}

export function defineSearchopsContextTool(rt) {
  return defineTool({
    name: 'searchops_context',
    description: `Fetch the context around one log event. Two modes: (1) pass traceId to pull every event sharing that trace/request/correlation id, ordered by time — the full path of one request across services; (2) pass timestamp to pull up to N lines before and after that instant, within a bounded window each side. Optionally narrow to one service. Line counts are capped (default ${DEFAULT_CONTEXT_LINES}, max ${MAX_CONTEXT_LINES}) and the window per side is capped at ${MAX_CONTEXT_WINDOW_SECONDS}s. Read-only; ${UNTRUSTED_NOTE}`,
    parameters: {
      index: { type: 'string', required: true, description: 'Index name or wildcard pattern holding the logs.' },
      traceId: { type: 'string', description: 'Trace/request/correlation id: pulls every event with this id (mode 1). Preferred when you have one.' },
      timestamp: { type: 'string', description: 'Anchor timestamp (ISO-8601 or epoch millis): pulls surrounding lines (mode 2). Used when no traceId is given.' },
      service: { type: 'string', description: 'Optional service name to narrow the context to one service.' },
      lines: { type: 'number', description: `Optional max lines per side (timestamp mode) or event cap hint (trace mode), 1-${MAX_CONTEXT_LINES}. Defaults to ${DEFAULT_CONTEXT_LINES}.` },
      windowSeconds: { type: 'number', description: `Optional window per side in seconds for timestamp mode, 1-${MAX_CONTEXT_WINDOW_SECONDS}. Defaults to 300.` },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Log context in ${oneLine(String(args?.index ?? ''), 40)}${args?.traceId ? ` trace=${oneLine(String(args.traceId), 24)}` : ''}`, kind: 'search' }),
    async execute(args, exec) {
      const view = rt.forSource(rt.resolveSource(args.source))
      const index = validateIndexPattern(args.index, { field: 'index' })
      const res = await runContext(view.provider, {
        index,
        profile: view.profile,
        traceId: args.traceId,
        timestamp: args.timestamp,
        service: args.service,
        lines: args.lines,
        windowSeconds: args.windowSeconds,
        signal: exec.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
      const lines = []
      if (res.mode === 'trace') {
        lines.push(`context for trace=${JSON.stringify(res.traceId)} on ${JSON.stringify(index)}: ${res.returned} event(s) (total ${formatTotal(res.total)}) took=${res.took ?? '-'}ms`)
      } else {
        lines.push(`context around ${oneLine(res.anchor, 40)} on ${JSON.stringify(index)}: ${res.before} before / ${res.after} after within ±${res.windowSeconds}s`)
      }
      const note = formatFieldsNote(res.fields)
      if (note) lines.push(note)
      if (res.logs.length === 0) lines.push('(no surrounding events found)')
      for (const log of res.logs) lines.push(formatLogLine(log))
      if (res.mode === 'timestamp' && (res.beforeSaturated || res.afterSaturated)) {
        const sides = [res.beforeSaturated ? 'before' : null, res.afterSaturated ? 'after' : null].filter(Boolean).join('/')
        lines.push(`note: the ${sides} side filled its line budget — raise lines or widen windowSeconds for more.`)
      }
      if (res.budgetNote) lines.push(res.budgetNote)
      lines.push(UNTRUSTED_NOTE)
      return lines.join('\n')
    },
  })
}
