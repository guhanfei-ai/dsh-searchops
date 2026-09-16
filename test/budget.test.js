import assert from 'node:assert/strict'
import test from 'node:test'

import { budgetLine, createBudget, paginate } from '../lib/budget.js'

test('an untouched budget reports nothing', () => {
  const budget = createBudget()
  assert.equal(budget.note(), null)
})

test('spend ignores non-positive and non-finite counts', () => {
  const budget = createBudget()
  budget.spend(0, 'log(s)')
  budget.spend(-5, 'log(s)')
  budget.spend(NaN, 'log(s)')
  assert.equal(budget.note(), null)
})

test('spend without a shown count discloses only the hidden number', () => {
  const budget = createBudget()
  budget.spend(5, 'log(s)')
  assert.equal(budget.note(), 'budget: 5 log(s) hidden (narrow the request or raise the limit to include them)')
})

test('spend with a shown count discloses "X of Y shown; N hidden"', () => {
  const budget = createBudget()
  budget.spend(5, 'log(s)', 10)
  assert.equal(budget.note(), 'budget: 10 of 15 log(s) shown; 5 hidden (narrow the request or raise the limit to include them)')
})

test('multiple dimensions accumulate and are joined', () => {
  const budget = createBudget()
  budget.spend(2, 'pattern(s)')
  budget.spend(3, 'trace(s)')
  const note = budget.note()
  assert.match(note, /^budget: 2 pattern\(s\) hidden — 3 trace\(s\) hidden /)
})

test('repeated spend on the same label accumulates the hidden count', () => {
  const budget = createBudget()
  budget.spend(2, 'group(s)')
  budget.spend(3, 'group(s)')
  assert.match(budget.note(), /5 group\(s\) hidden/)
})

test('budgetLine tolerates a missing or malformed budget', () => {
  assert.equal(budgetLine(null), null)
  assert.equal(budgetLine(undefined), null)
  assert.equal(budgetLine({}), null)
  const budget = createBudget()
  budget.spend(1, 'x')
  assert.match(budgetLine(budget), /1 x hidden/)
})

// ── paginate ────────────────────────────────────────────────────────────────
test('paginate returns a null line when everything fits on one page', () => {
  const res = paginate([1, 2, 3], { page: 1, limit: 10, label: 'index/indices', pageParam: 'page' })
  assert.deepEqual(res.shown, [1, 2, 3])
  assert.equal(res.line, null)
  assert.equal(res.pages, 1)
})

test('paginate discloses the page, the visible slice and how to continue', () => {
  const res = paginate([1, 2, 3, 4, 5], { page: 1, limit: 2, label: 'index/indices', pageParam: 'page' })
  assert.deepEqual(res.shown, [1, 2])
  assert.equal(res.pages, 3)
  assert.match(res.line, /page 1 of 3: index\/indices 1-2 of 5 shown; 3 remaining \(pass page=2 to continue\)/)
})

test('paginate omits the continuation hint on the last page', () => {
  const res = paginate([1, 2, 3, 4, 5], { page: 3, limit: 2, label: 'index/indices', pageParam: 'page' })
  assert.deepEqual(res.shown, [5])
  assert.match(res.line, /page 3 of 3: index\/indices 5-5 of 5 shown/)
  assert.ok(!/remaining/.test(res.line))
})

test('paginate reports an out-of-range page as empty rather than throwing', () => {
  const res = paginate([1, 2, 3], { page: 9, limit: 2, label: 'index/indices', pageParam: 'page' })
  assert.deepEqual(res.shown, [])
  assert.match(res.line, /page 9 of 2: no index\/indices on this page; 3 in total \(last page is 2\)/)
})

test('paginate is robust to a non-array input and bad page/limit', () => {
  const res = paginate(null, { page: 0, limit: 0, label: 'x', pageParam: 'page' })
  assert.deepEqual(res.shown, [])
  assert.equal(res.pages, 1)
})
