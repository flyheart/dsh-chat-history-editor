/**
 * Client-half probe: evaluates client.js in a stub module-loader environment
 * and exercises the pure surface fold / row projection against synthetic
 * session event windows. No browser is required.
 *
 * Run: node test/client.test.mjs
 */

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let registration
const React = {
  createElement: () => null,
  Fragment: Symbol('Fragment'),
  memo: (component) => component
}

const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      }
    }
  }
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.ok(registration, 'client.js registers a module with the loader')
assert.equal(registration.id, 'dsh-chat-history-editor')
const plugin = registration.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})
assert.deepEqual(plugin.inject, ['slots', 'remote', 'remote.commands', 'sessions', 'locale', 'uiWorkspace', 'workspaces'])
assert.equal(typeof plugin.apply, 'function')
const test = plugin.__test

/** @param {object} event @returns {object} one durable window entry */
function entry(event) {
  return { type: 'event', event }
}

const USER = (id, text, seq) => ({
  type: 'user/message',
  seq,
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  surfaceOp: 'append'
})
const ASSISTANT = (id, text, seq, turn = 1, step = 1) => ({
  type: 'assistant/message',
  seq,
  data: {
    turn,
    step,
    message: { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
    stream: []
  },
  surfaceOp: 'append'
})
const REPLACE = (event, startSeq, endSeq) => ({ ...event, surfaceOp: { op: 'replace', startSeq, endSeq } })

const checks = []
function check(name, body) {
  try {
    body()
    checks.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    checks.push({ name, ok: false, error })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

check('dictionary keys match between zh and en', () => {
  assert.deepEqual(Object.keys(test.zh).sort(), Object.keys(test.en).sort())
})

check('fold keeps append nodes and applies replacements', () => {
  const nodes = test.foldSurfaceEntries([
    entry(USER('u1', 'one', 1)),
    entry(ASSISTANT('a1', 'two', 3)),
    entry(REPLACE(USER('u2', 'one edited', 5), 1, 1)),
    entry({
      type: 'developer/message',
      seq: 6,
      data: { turn: 1, step: 1, message: { id: 't1', role: 'developer', content: [], source: { kind: 'history-editor' } } },
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
      sourceEventSeqs: [3]
    })
  ])
  assert.deepEqual(nodes.map((node) => node.seq), [5, 6])
})

check('a replacement whose endpoints are outside the window is skipped', () => {
  const nodes = test.foldSurfaceEntries([
    entry(ASSISTANT('a1', 'two', 9)),
    entry(REPLACE(USER('u2', 'later', 11), 1, 1))
  ])
  assert.deepEqual(nodes.map((node) => node.seq), [9])
})

check('transient frames and non-surface events never become nodes', () => {
  const nodes = test.foldSurfaceEntries([
    entry({ type: 'turn/start', seq: 0, data: { turn: 1 } }),
    { type: 'transient', event: { type: 'assistant/live-chunk', seq: 2, data: {} } },
    entry(USER('u1', 'one', 1))
  ])
  assert.deepEqual(nodes.map((node) => node.seq), [1])
})

check('rows project roles and hide tombstones / empty content', () => {
  const rows = test.buildHistoryRows([
    entry({ type: 'system/message', seq: 0, data: { turn: 0, step: 0, message: { id: 's', role: 'system', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' }),
    entry(USER('u1', 'one', 1)),
    entry(ASSISTANT('a1', 'two', 3)),
    entry({ type: 'tool/result', seq: 4, data: { turn: 1, step: 1, message: { id: 't', role: 'tool', content: [{ type: 'text', text: 'out' }], source: { kind: 'tool', callId: 'c' }, toolCallId: 'c' } }, surfaceOp: 'append' }),
    entry({ type: 'developer/message', seq: 5, data: { turn: 1, step: 1, message: { id: 'd', role: 'developer', content: [], source: { kind: 'history-editor' } } }, surfaceOp: 'append' }),
    entry({ type: 'developer/message', seq: 6, data: { turn: 1, step: 1, message: { id: 'd2', role: 'developer', content: [{ type: 'text', text: 'note' }], source: { kind: 'tool-registry' } } }, surfaceOp: 'append' }),
    entry({ type: 'user/message', seq: 7, data: { id: 'u7', role: 'user', content: [{ type: 'text', text: 'recall' }], source: { kind: 'session-reference' } }, surfaceOp: 'append' })
  ])
  assert.deepEqual(rows.map((row) => row.role), ['system', 'user', 'assistant', 'tool', 'context', 'context'])
  assert.equal(rows[5].source.kind, 'session-reference')
})

check('rows inherit Turn/Step from turn and step boundaries', () => {
  const rows = test.buildHistoryRows([
    entry({ type: 'turn/start', seq: 0, data: { turn: 1 } }),
    entry({ type: 'step/start', seq: 1, data: { turn: 1, step: 1 } }),
    entry(USER('u1', 'one', 2)),
    entry(ASSISTANT('a1', 'two', 3)),
    entry({ type: 'turn/start', seq: 4, data: { turn: 2 } }),
    entry({ type: 'step/start', seq: 5, data: { turn: 2, step: 1 } }),
    entry(USER('u2', 'three', 6))
  ])
  assert.deepEqual(rows.map((row) => ({ role: row.role, turn: row.turn, step: row.step })), [
    { role: 'user', turn: 1, step: 1 },
    { role: 'assistant', turn: 1, step: 1 },
    { role: 'user', turn: 2, step: 1 }
  ])
  const groups = test.groupByTurn(rows)
  assert.deepEqual(groups.map((group) => ({ turn: group.turn, count: group.rows.length })), [
    { turn: 1, count: 2 },
    { turn: 2, count: 1 }
  ])
})

check('a replacement inherits its shadowed node Turn', () => {
  const rows = test.buildHistoryRows([
    entry({ type: 'turn/start', seq: 0, data: { turn: 3 } }),
    entry({ type: 'step/start', seq: 1, data: { turn: 3, step: 1 } }),
    entry(USER('u1', 'one', 2)),
    entry(REPLACE(USER('u2', 'one edited', 7), 2, 2))
  ])
  assert.equal(rows[0].turn, 3)
  assert.equal(rows[0].text, 'one edited')
})

check('clock and preview helpers are defensive', () => {
  assert.equal(test.formatClock(undefined), '')
  assert.equal(test.formatClock('nope'), '')
  const clock = test.formatClock(new Date(2024, 0, 1, 13, 5, 9).getTime())
  assert.equal(clock, '13:05:09')
  assert.equal(test.previewText('a\n  b   c', 40), 'a b c')
  assert.equal(test.previewText('abcdef', 3), 'abc…')
})

check('editable/deletable predicates follow the Host rules', () => {
  const rows = [
    { role: 'user', seq: 1, eventType: 'user/message' },
    { role: 'assistant', seq: 3, eventType: 'assistant/message' },
    { role: 'assistant', seq: 4, eventType: 'assistant/message' },
    { role: 'tool', seq: 5, eventType: 'tool/result' },
    { role: 'context', seq: 6, eventType: 'user/message', sourceKind: 'runtime-context' },
    { role: 'context', seq: 7, eventType: 'developer/message', sourceKind: 'tool-registry' },
    { role: 'system', seq: 8, eventType: 'system/message', sourceKind: 'system-prompt' }
  ]
  const tail = [
    { role: 'user', seq: 1, eventType: 'user/message' },
    { role: 'assistant', seq: 3, eventType: 'assistant/message' }
  ]
  assert.equal(test.canEditRow(rows[0], 0, rows), true)
  assert.equal(test.canEditRow(rows[1], 1, rows), false)
  assert.equal(test.canEditRow(rows[2], 2, rows), false)
  assert.equal(test.canEditRow(tail[1], 1, tail), true)
  assert.equal(test.canEditRow(rows[3], 3, rows), false)
  assert.equal(test.canEditRow(rows[4], 4, rows), true, 'runtime-context snapshot is rewritable')
  assert.equal(test.canEditRow(rows[5], 5, rows), false, 'developer tool changes are not rewritable')
  assert.equal(test.canEditRow(rows[6], 6, rows), true, 'the system prompt node is rewritable')
  assert.equal(test.canDeleteRow(rows[0]), true)
  assert.equal(test.canDeleteRow(rows[1]), true)
  assert.equal(test.canDeleteRow(rows[3]), true)
  assert.equal(test.canDeleteRow(rows[4]), true, 'runtime-context snapshot is deletable')
  assert.equal(test.canDeleteRow(rows[5]), false)
  assert.equal(test.canDeleteRow(rows[6]), false, 'the system prompt node is never deleted directly')
})

check('draft merge places edits, deletions, and insertions in order', () => {
  const rows = [
    { seq: 1, role: 'user', text: 'one', turn: 1, step: 1 },
    { seq: 2, role: 'assistant', text: 'two', turn: 1, step: 1 },
    { seq: 3, role: 'user', text: 'three', turn: 2, step: 1 }
  ]
  const edits = new Map([[2, 'two edited']])
  const deleted = new Set([3])
  const inserts = [
    { id: 'a', afterSeq: 'top', role: 'user', text: 'top note' },
    { id: 'b', afterSeq: 2, role: 'assistant', text: 'below two' },
    { id: 'c', afterSeq: 'end', role: 'user', text: 'tail note' }
  ]
  const merged = test.mergeDraftRows(rows, edits, deleted, inserts)
  assert.deepEqual(merged.map((row) => row.insertId ?? row.seq), ['a', 1, 2, 'b', 3, 'c'])
  assert.equal(merged[2].draftText, 'two edited')
  assert.equal(merged[2].draftEdited, true)
  assert.equal(merged[4].draftDeleted, true)
  assert.deepEqual({ turn: merged[3].turn, step: merged[3].step }, { turn: 1, step: 1 })
  assert.deepEqual({ turn: merged[1].turn, step: merged[1].step }, { turn: 1, step: 1 })
})

check('draft payload keeps non-text blocks and drops deleted rows', () => {
  const image = { type: 'image', attachment: { attachmentId: 'att', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
  const rows = [
    { seq: 1, role: 'user', text: 'with image', blocks: [{ type: 'text', text: 'with image' }, image], source: { kind: 'user' }, turn: 1, step: 1, draftEdited: true, draftText: 'edited' },
    { seq: 2, role: 'user', text: 'gone', blocks: [{ type: 'text', text: 'gone' }], source: { kind: 'user' }, turn: 1, step: 1, draftDeleted: true },
    { seq: 'insert:z', insertId: 'z', role: 'assistant', text: 'inserted', turn: 1, step: 1 }
  ]
  const payload = test.buildDraftRowsPayload(rows)
  assert.equal(payload.length, 2)
  assert.deepEqual(payload[0].content, [{ type: 'text', text: 'edited' }, image])
  assert.equal(payload[0].edited, true)
  assert.equal(payload[1].role, 'assistant')
  assert.deepEqual(payload[1].content, [{ type: 'text', text: 'inserted' }])
  assert.equal(payload[1].edited, true)
})

check('system rows expose the explicit override identity', () => {
  const rows = test.buildHistoryRows([
    entry({
      type: 'system/message',
      seq: 0,
      data: { turn: 1, step: 1, message: { id: 'history-editor-abc', role: 'system', content: [{ type: 'text', text: 'custom prompt' }], source: { kind: 'system-prompt' } } },
      surfaceOp: 'append'
    }),
    entry({
      type: 'system/message',
      seq: 1,
      data: { turn: 1, step: 1, message: { id: 'plain', role: 'system', content: [{ type: 'text', text: 'assembled prompt' }], source: { kind: 'system-prompt' } } },
      surfaceOp: 'append'
    })
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].override, true)
  assert.equal(rows[1].override, false)
})

check('host failure text localizes known codes and falls back for unknown ones', () => {
  const t = (key, params) => {
    const template = test.zh[key]
    return template === undefined ? key : template
  }
  assert.equal(test.localizeError(t, '[busy] wait'), test.zh['error.busy'])
  assert.equal(test.localizeError(t, '[paired] detail here'), test.zh['error.paired'])
  assert.equal(test.localizeError(t, '[weird] raw detail'), 'raw detail')
  assert.equal(test.localizeError(t, 'plain failure'), 'plain failure')
})

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
