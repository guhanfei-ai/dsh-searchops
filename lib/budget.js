// lib/budget.js — Explicit truncation disclosure. When a tool drops rows to stay
// inside a bound, it must say how many were dropped and on which dimension, so
// the agent knows it is looking at a slice rather than the whole picture. This
// is a tiny counter: call spend() each time you discard something, then note()
// to render a single disclosure line (null when nothing was dropped).
import { oneLine } from './util.js'

const LABEL_MAX_CHARS = 40
const NOTE_MAX_CHARS = 240

export function createBudget() {
  // label -> { hidden, shown }; shown stays null if the caller never reports it.
  const rows = new Map()

  // count: how many were discarded this time; label: the dimension name
  // (e.g. "hit(s)", "index(es)", "pattern(s)"); shown: optional, how many were
  // actually kept — only with it can we render "20 of 982 shown".
  function spend(count, label, shown) {
    const hidden = Math.floor(Number(count))
    if (!Number.isFinite(hidden) || hidden <= 0) return
    const key = oneLine(label, LABEL_MAX_CHARS) || 'item'
    const row = rows.get(key) ?? { hidden: 0, shown: null }
    row.hidden += hidden
    const kept = Math.floor(Number(shown))
    if (Number.isFinite(kept) && kept >= 0) row.shown = (row.shown ?? 0) + kept
    rows.set(key, row)
  }

  function note() {
    const parts = []
    for (const [label, row] of rows) {
      if (row.hidden <= 0) continue
      parts.push(row.shown === null
        ? `${row.hidden} ${label} hidden`
        : `${row.shown} of ${row.shown + row.hidden} ${label} shown; ${row.hidden} hidden`)
    }
    if (parts.length === 0) return null
    return oneLine(`budget: ${parts.join(' — ')} (narrow the request or raise the limit to include them)`, NOTE_MAX_CHARS)
  }

  return { spend, note }
}

// Convenience reader: returns null if the budget is missing or empty, so callers
// never have to null-check.
export function budgetLine(budget) {
  if (!budget || typeof budget.note !== 'function') return null
  return budget.note()
}

// Local pagination for in-memory lists (e.g. resolved indices). Reports the page,
// the visible slice and how many remain, plus the exact parameter to continue.
export function paginate(rows, { page, limit, label, pageParam }) {
  const list = Array.isArray(rows) ? rows : []
  const total = list.length
  const size = Math.max(1, Math.floor(Number(limit)) || 1)
  const pages = Math.max(1, Math.ceil(total / size))
  const current = Math.max(1, Math.floor(Number(page)) || 1)
  const start = (current - 1) * size
  const shown = list.slice(start, start + size)
  if (total <= size && current === 1) return { shown, line: null, pages }
  const name = oneLine(label, LABEL_MAX_CHARS) || 'item'
  let text
  if (shown.length === 0) {
    text = `page ${current} of ${pages}: no ${name} on this page; ${total} in total (last page is ${pages})`
  } else {
    const remaining = total - (start + shown.length)
    text = `page ${current} of ${pages}: ${name} ${start + 1}-${start + shown.length} of ${total} shown`
    if (remaining > 0) text += `; ${remaining} remaining (pass ${oneLine(pageParam, 20) || 'page'}=${current + 1} to continue)`
  }
  return { shown, line: oneLine(text, NOTE_MAX_CHARS), pages }
}
