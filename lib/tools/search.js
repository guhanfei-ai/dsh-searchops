// lib/tools/search.js — The two search tools:
//   searchops_query — a raw, bounded OpenSearch/Elasticsearch DSL query for power
//                     users, returning matching documents.
//   searchops_logs  — a semantic log query that resolves the field profile,
//                     filters by time/service/level/free-text and projects
//                     readable, bounded lines.
// Both are strictly read-only and bounded, and both return untrusted data.
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  DEFAULT_LOGS_LIMIT,
  DEFAULT_QUERY_SIZE,
  HARD_MAX_SIZE,
  MAX_LOGS_LIMIT,
  MAX_MESSAGE_CHARS,
  MAX_QUERY_SIZE,
  MAX_TIME_WINDOW_DAYS,
  REQUEST_TIMEOUT_MS,
  SOURCE_PARAM,
  TOOL_TIMEOUT_MS,
  UNTRUSTED_NOTE,
} from '../constants.js'
import { oneLine, textOut, truncate, validateIndexPattern } from '../util.js'
import { buildSearchBody, clampFrom, clampSize, runSearch } from '../search.js'
import { runLogs } from '../logs.js'
import { formatFieldsNote, formatLogLine, formatTotal } from '../render.js'

export function defineSearchopsQueryTool(rt) {
  return defineTool({
    name: 'searchops_query',
    description: `Run a bounded raw query against an index using OpenSearch/Elasticsearch query DSL and return the matching documents. Use it when the semantic tools (logs/aggregate/context/investigate) cannot express what you need. The query is a JSON DSL object (or a JSON string of one); omit it for match_all. Size is capped (${MAX_QUERY_SIZE} by default, ${HARD_MAX_SIZE} absolute), offsets past 10000 are rejected (use aggregations or narrow the query instead of deep paging), track_total_hits is capped, and the request body is size-limited. ${UNTRUSTED_NOTE}`,
    parameters: {
      index: { type: 'string', required: true, description: 'Index name or wildcard pattern to search.' },
      query: { type: 'json', description: 'Optional OpenSearch query DSL object (e.g. {"bool":{"filter":[{"term":{"service.name":"checkout"}}]}}) or a JSON string of one. Defaults to match_all.' },
      size: { type: 'number', description: `Optional max documents to return, 1-${MAX_QUERY_SIZE}. Defaults to ${DEFAULT_QUERY_SIZE}.` },
      from: { type: 'number', description: 'Optional result offset for pagination (max 10000).' },
      sort: { type: 'json', description: 'Optional sort clause, e.g. [{"@timestamp":{"order":"desc"}}].' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Optional _source filter: a list of field paths to return (omit for the whole document).' },
      trackTotalHits: { type: 'number', description: 'Optional cap on exact total counting (defaults to 100000; the relation gte/eq is reported).' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Query ${oneLine(String(args?.index ?? ''), 40)}`, kind: 'search' }),
    async execute(args, exec) {
      const view = rt.forSource(rt.resolveSource(args.source))
      const index = validateIndexPattern(args.index, { field: 'index' })
      const size = clampSize(args.size, { def: DEFAULT_QUERY_SIZE, max: MAX_QUERY_SIZE })
      const from = clampFrom(args.from)
      const body = buildSearchBody({
        query: args.query,
        size: size.size,
        from: from.from,
        sort: args.sort,
        sourceFilter: args.fields,
        trackTotalHits: args.trackTotalHits,
      })
      const res = await runSearch(view.provider, { index, body, signal: exec.signal, timeoutMs: REQUEST_TIMEOUT_MS })
      const lines = [`query on ${JSON.stringify(index)} total=${formatTotal(res.total)} returned=${res.returned}${size.clamped ? ` (size clamped to ${size.size})` : ''}${res.truncated ? ' truncated=yes' : ''} took=${res.took ?? '-'}ms`]
      if (res.hits.length === 0) lines.push('(no documents matched)')
      for (const hit of res.hits) {
        lines.push(`${oneLine(hit.index, 120)}#${oneLine(hit.id, 80)} ${truncate(oneLine(JSON.stringify(hit.source), MAX_MESSAGE_CHARS * 2), MAX_MESSAGE_CHARS * 2)}`)
      }
      if (res.truncated) lines.push('note: more documents match than were returned; narrow the query or reduce size to see them.')
      lines.push(UNTRUSTED_NOTE)
      return lines.join('\n')
    },
  })
}

export function defineSearchopsLogsTool(rt) {
  return defineTool({
    name: 'searchops_logs',
    description: `Semantic log search: return recent log lines from an index, filtered by time range, service, level and/or free text, without needing to know the exact field names. The field profile (timestamp/message/service/level/trace) is taken from the source config, else auto-detected, else a common convention; the resolved fields are reported so you can see what was used. The window may not span more than ${MAX_TIME_WINDOW_DAYS} days and the line count is capped (default ${DEFAULT_LOGS_LIMIT}, max ${MAX_LOGS_LIMIT}); truncation is disclosed. ${UNTRUSTED_NOTE}`,
    parameters: {
      index: { type: 'string', required: true, description: 'Index name or wildcard pattern holding the logs (e.g. "app-logs-*").' },
      query: { type: 'string', description: 'Optional free-text filter matched leniently against the message (and service) fields.' },
      service: { type: 'string', description: 'Optional exact service/application name to filter on.' },
      level: { type: 'string', description: 'Optional log level to filter on (e.g. error, warn, info); matched case-insensitively.' },
      from: { type: 'string', description: 'Optional range start: now, a relative expression (now-15m, now-1h, now/d), an ISO-8601 timestamp, or epoch millis. Defaults to now-1h.' },
      to: { type: 'string', description: 'Optional range end, same syntax. Defaults to now.' },
      limit: { type: 'number', description: `Optional max lines to return, 1-${MAX_LOGS_LIMIT}. Defaults to ${DEFAULT_LOGS_LIMIT}, newest first.` },
      fields: { type: 'array', items: { type: 'string' }, description: 'Optional extra _source fields to include per line (beyond the profile fields).' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Search logs in ${oneLine(String(args?.index ?? ''), 40)}${args?.level ? ` level=${oneLine(String(args.level), 12)}` : ''}`, kind: 'search' }),
    async execute(args, exec) {
      const view = rt.forSource(rt.resolveSource(args.source))
      const index = validateIndexPattern(args.index, { field: 'index' })
      const res = await runLogs(view.provider, {
        index,
        profile: view.profile,
        from: args.from,
        to: args.to,
        service: args.service,
        level: args.level,
        query: args.query,
        limit: args.limit,
        fields: args.fields,
        signal: exec.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
      const lines = [`logs on ${JSON.stringify(index)} range=${res.from}..${res.to} matched=${formatTotal(res.total)} returned=${res.returned}${res.clamped ? ` (limit clamped to ${res.limit})` : ''}${res.truncated ? ' truncated=yes' : ''} took=${res.took ?? '-'}ms`]
      const note = formatFieldsNote(res.fields)
      if (note) lines.push(note)
      if (res.logs.length === 0) lines.push('(no log lines matched — widen the time range or relax the filters; if the fields above look wrong, configure a source profile)')
      for (const log of res.logs) lines.push(formatLogLine(log))
      if (res.budgetNote) lines.push(res.budgetNote)
      lines.push(UNTRUSTED_NOTE)
      return lines.join('\n')
    },
  })
}
