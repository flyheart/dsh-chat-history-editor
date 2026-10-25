/**
 * Host-side probe for the history operations.
 *
 * Builds a detached Session from the installed @deepseek-ai/dsh-session
 * package, exercises every surface mutation the plugin performs, and checks
 * both deriveMessages() and restore validation (a live append that a restore
 * would reject makes the session un-resumable, so the check is mandatory).
 *
 * Run: node test/host.test.mjs
 */

import assert from 'node:assert/strict'
import { loadDshModules, skipSuite } from './support.mjs'

const dsh = loadDshModules()
if (dsh === undefined) skipSuite('host.test.mjs')
const { Session } = await import(dsh.sessionModule)
const { assertV4RowAdmission } = await import(dsh.formatModule)
const ops = await import('../history-ops.js')

const MODEL_SOURCE = { kind: 'model', provider: 'probe-provider', model: 'probe-model' }

/** Build one detached session with two completed turns, the second using a tool call. */
function buildSession(id) {
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    { surfaceOp: 'append' }
  )
  session.append('step/start', { turn: 1, step: 1 })
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'hi there' }], source: MODEL_SOURCE },
      stream: []
    },
    { surfaceOp: 'append' }
  )
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append(
    'user/message',
    { id: 'm3', role: 'user', content: [{ type: 'text', text: 'run the tool' }], source: { kind: 'user' } },
    { surfaceOp: 'append' }
  )
  session.append('step/start', { turn: 2, step: 1 })
  session.append(
    'assistant/message',
    {
      turn: 2,
      step: 1,
      message: {
        id: 'm4',
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling it' },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }
        ],
        source: MODEL_SOURCE
      },
      stream: []
    },
    { surfaceOp: 'append' }
  )
  session.append('tool/call', { turn: 2, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' })
  session.append(
    'tool/result',
    {
      turn: 2,
      step: 1,
      message: {
        id: 'm5',
        role: 'tool',
        content: [{ type: 'text', text: 'tool output' }],
        source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1'
      }
    },
    { surfaceOp: 'append' }
  )
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return session
}

/** Flatten deriveMessages() to comparable { role, text } entries. */
function derived(messages) {
  return messages.map((message) => ({
    role: message.role,
    text: (message.content ?? [])
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
      .map((block) => block.text)
      .join('')
  }))
}

/**
 * Assert the log can be restored AND that every row passes the real JSONL
 * read-path admission validator (the check a resumed session runs).
 */
function assertRestorable(session, label) {
  const seed = session.snapshotEvents()
  assert.doesNotThrow(() => Session.create(`restore-${label}-${session.seq}`, seed), `restore must accept the ${label} log`)
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    assert.doesNotThrow(
      () => assertV4RowAdmission(event, null),
      `${label}: event ${seq} (${event.type}) must pass read-path admission`
    )
  }
}

/** @returns {object | undefined} the newest developer/message event. */
function latestDeveloperMessage(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type === 'developer/message') return event
  }
  return undefined
}

const checks = []
/** @param {string} name @param {() => void} body */
function test(name, body) {
  try {
    body()
    checks.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    checks.push({ name, ok: false, error })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

test('baseline surface and derived messages', () => {
  const session = buildSession('ops-baseline')
  const rows = ops.readSurface(session)
  assert.deepEqual(rows.map((row) => row.message?.role), ['user', 'assistant', 'user', 'assistant', 'tool'])
  assert.deepEqual(derived(session.deriveMessages()), [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi there' },
    { role: 'user', text: 'run the tool' },
    { role: 'assistant', text: 'calling it' },
    { role: 'tool', text: 'tool output' }
  ])
  assertRestorable(session, 'baseline')
})

test('edit a user message in place', () => {
  const session = buildSession('ops-edit-user')
  const target = ops.readSurface(session)[0]
  ops.editSurfaceMessage(session, target.seq, 'hello (edited)')
  assert.deepEqual(derived(session.deriveMessages()).map((item) => item.text), [
    'hello (edited)',
    'hi there',
    'run the tool',
    'calling it',
    'tool output'
  ])
  assertRestorable(session, 'edit-user')
})

test('repeated edits chain through replacements', () => {
  const session = buildSession('ops-edit-twice')
  const first = ops.readSurface(session)[0]
  ops.editSurfaceMessage(session, first.seq, 'first edit')
  const second = ops.readSurface(session)[0]
  assert.notEqual(first.seq, second.seq)
  ops.editSurfaceMessage(session, second.seq, 'second edit')
  assert.equal(derived(session.deriveMessages())[0].text, 'second edit')
  assertRestorable(session, 'edit-twice')
})

test('delete a user message', () => {
  const session = buildSession('ops-delete-user')
  const target = ops.readSurface(session)[0]
  const result = ops.deleteSurfaceMessages(session, [target.seq])
  assert.equal(result.removed, 1)
  assert.deepEqual(derived(session.deriveMessages()).map((item) => item.text), [
    'hi there',
    'run the tool',
    'calling it',
    'tool output'
  ])
  assertRestorable(session, 'delete-user')
})

test('delete an assistant message removes its tool call and result together', () => {
  const session = buildSession('ops-delete-pair')
  const rows = ops.readSurface(session)
  const assistant = rows[3]
  assert.equal(assistant.message.role, 'assistant')
  const result = ops.deleteSurfaceMessages(session, [assistant.seq])
  assert.equal(result.removed, 2, 'assistant node and its tool result are removed together')
  const remaining = ops
    .readSurface(session)
    .filter((row) => row.message !== null)
    .map((row) => row.message.role)
  assert.deepEqual(remaining, ['user', 'assistant', 'user'])
  assertRestorable(session, 'delete-pair')
})

test('delete a tool result removes its assistant call together', () => {
  const session = buildSession('ops-delete-result')
  const rows = ops.readSurface(session)
  const tool = rows[4]
  assert.equal(tool.message.role, 'tool')
  const result = ops.deleteSurfaceMessages(session, [tool.seq])
  assert.equal(result.removed, 2)
  assert.deepEqual(
    ops
      .readSurface(session)
      .filter((row) => row.message !== null)
      .map((row) => row.message.role),
    ['user', 'assistant', 'user']
  )
  assertRestorable(session, 'delete-result')
})

test('delete a multi-node range in one replacement', () => {
  const session = buildSession('ops-delete-range')
  const rows = ops.readSurface(session)
  const result = ops.deleteSurfaceMessages(session, [rows[2].seq, rows[3].seq])
  assert.equal(result.ranges, 1, 'one contiguous replacement covers the whole range')
  assert.equal(result.removed, 3, 'the requested pair plus its paired tool result are removed')
  assert.deepEqual(derived(session.deriveMessages()).map((item) => item.text), ['hello', 'hi there'])
  assertRestorable(session, 'delete-range')
})

test('append user and assistant messages at the tail', () => {
  const session = buildSession('ops-append')
  ops.appendSurfaceMessage(session, 'user', 'extra user turn')
  ops.appendSurfaceMessage(session, 'assistant', 'extra assistant answer')
  const messages = derived(session.deriveMessages())
  assert.deepEqual(messages.slice(-2), [
    { role: 'user', text: 'extra user turn' },
    { role: 'assistant', text: 'extra assistant answer' }
  ])
  assertRestorable(session, 'append')
})

test('rewrite the last assistant message', () => {
  const session = buildSession('ops-edit-assistant')
  ops.appendSurfaceMessage(session, 'assistant', 'last answer')
  const rows = ops.readSurface(session)
  const last = rows[rows.length - 1]
  assert.equal(last.message.role, 'assistant')
  ops.editSurfaceMessage(session, last.seq, 'rewritten last answer')
  const messages = derived(session.deriveMessages())
  assert.equal(messages[messages.length - 1].text, 'rewritten last answer')
  assert.equal(messages.filter((item) => item.role === 'assistant' && item.text === 'last answer').length, 0)
  assertRestorable(session, 'edit-assistant')
})

test('reject rewriting a non-last assistant message', () => {
  const session = buildSession('ops-edit-assistant-order')
  const rows = ops.readSurface(session)
  assert.throws(() => ops.editSurfaceMessage(session, rows[1].seq, 'nope'), (error) => error.code === 'assistant-not-last')
})

test('system prompt nodes are editable but not deletable', () => {
  const session = Session.create('ops-system')
  session.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'system-prompt' } } },
    { surfaceOp: 'append' }
  )
  session.append(
    'user/message',
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    { surfaceOp: 'append' }
  )
  const rows = ops.readSurface(session)
  assert.throws(() => ops.deleteSurfaceMessages(session, [rows[0].seq]), (error) => error.code === 'system-prompt')
  ops.editSurfaceMessage(session, rows[0].seq, 'edited prompt')
  assert.equal(ops.systemPromptOverride(session), 'edited prompt')
  assertRestorable(session, 'system-editable')
})

test('reject blank text and unknown/invalid payloads', () => {
  const session = buildSession('ops-reject')
  const rows = ops.readSurface(session)
  assert.throws(() => ops.editSurfaceMessage(session, rows[0].seq, '   '), (error) => error.code === 'empty')
  assert.throws(() => ops.executeHistoryOperation(session, { op: 'nope' }), (error) => error.code === 'bad-request')
  assert.throws(() => ops.deleteSurfaceMessages(session, []), (error) => error.code === 'bad-request')
  assert.throws(() => ops.deleteSurfaceMessages(session, [999]), (error) => error.code === 'not-found')
})

test('rewrite and delete injected context snapshots', () => {
  const session = Session.create('ops-context')
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    { id: 'c1', role: 'user', content: [{ type: 'text', text: 'Runtime context: time=12:00' }], source: { kind: 'runtime-context', form: 'snapshot', sections: ['time'] } },
    { surfaceOp: 'append' }
  )
  session.append(
    'user/message',
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    { surfaceOp: 'append' }
  )
  const contextRow = ops.readSurface(session)[0]
  assert.equal(contextRow.message.role, 'user')
  assert.equal(contextRow.event.data.source.kind, 'runtime-context')
  ops.editSurfaceMessage(session, contextRow.seq, 'Runtime context: time=23:59')
  const rewritten = ops.readSurface(session)[0]
  assert.equal(rewritten.message.content[0].text, 'Runtime context: time=23:59')
  assert.equal(rewritten.event.data.source.kind, 'runtime-context', 'the injection source kind is preserved')
  ops.deleteSurfaceMessages(session, [rewritten.seq])
  assert.deepEqual(derived(session.deriveMessages()), [{ role: 'user', text: 'hello' }])
  assertRestorable(session, 'context')
})

test('deleting a user message keeps a positive tombstone position', () => {
  const session = Session.create('ops-user-tombstone')
  session.append(
    'user/message',
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'orphan prompt' }], source: { kind: 'user' } },
    { surfaceOp: 'append' }
  )
  const target = ops.readSurface(session)[0]
  ops.deleteSurfaceMessages(session, [target.seq])
  const tombstone = latestDeveloperMessage(session)
  assert.ok(tombstone, 'delete writes a tombstone')
  assert.ok(tombstone.data.turn > 0, `tombstone turn must be positive, got ${tombstone.data.turn}`)
  assert.ok(tombstone.data.step > 0, `tombstone step must be positive, got ${tombstone.data.step}`)
  assert.deepEqual(derived(session.deriveMessages()), [])
  assertRestorable(session, 'user-tombstone')
})

test('assistant appends on an empty session use positive settlement fields', () => {
  const session = Session.create('ops-assistant-empty')
  ops.appendSurfaceMessage(session, 'assistant', 'prefilled answer')
  const last = session.eventAt(session.seq - 1)
  assert.equal(last.type, 'assistant/message')
  assert.ok(last.data.turn > 0)
  assert.ok(last.data.step > 0)
  assertRestorable(session, 'assistant-empty')
})

test('system prompt edit records an override and reset clears it', () => {
  const session = Session.create('ops-system-edit')
  session.append(
    'system/message',
    {
      turn: 1,
      step: 1,
      message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'assembled prompt' }], source: { kind: 'system-prompt' } }
    },
    { surfaceOp: 'append' }
  )
  session.append(
    'user/message',
    { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    { surfaceOp: 'append' }
  )
  assert.equal(ops.systemPromptOverride(session), undefined)
  const systemSeq = ops.readSurface(session)[0].seq
  ops.editSurfaceMessage(session, systemSeq, 'custom prompt')
  assert.equal(ops.systemPromptOverride(session), 'custom prompt')
  const marked = ops.readSurface(session)[0]
  assert.equal(marked.message.role, 'system')
  assert.equal(marked.event.data.message.source.kind, 'system-prompt')
  assert.match(marked.event.data.message.id, /^history-editor-/)
  assertRestorable(session, 'system-edit')
  ops.resetSystemPrompt(session)
  assert.equal(ops.systemPromptOverride(session), undefined)
  assertRestorable(session, 'system-reset')
})

test('a later system node does not survive an earlier system prompt edit', () => {
  const session = Session.create('ops-system-order')
  session.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'first' }], source: { kind: 'system-prompt' } } },
    { surfaceOp: 'append' }
  )
  session.append(
    'system/message',
    { turn: 2, step: 1, message: { id: 's2', role: 'system', content: [{ type: 'text', text: 'in-history update' }], source: { kind: 'system-prompt' } } },
    { surfaceOp: 'append' }
  )
  const firstSeq = ops.readSurface(session)[0].seq
  ops.editSurfaceMessage(session, firstSeq, 'edited first')
  assert.equal(ops.systemPromptOverride(session), 'edited first')
  assertRestorable(session, 'system-order')
})

test('rebuild a rewritten conversation into a child session', () => {
  const source = buildSession('ops-rebuild-source')
  const sourceRows = ops.readSurface(source)
  const draftRows = sourceRows.map((row) => ({
    role: row.message.role === 'tool' ? 'tool' : row.message.role,
    content: row.message.role === 'assistant'
      ? [{ type: 'text', text: 'rewritten answer' }, ...row.message.content.filter((block) => block.type !== 'text')]
      : row.message.content,
    ...row.message.role === 'tool'
      ? { toolCallId: row.message.toolCallId ?? row.message.source.callId, isError: row.message.isError === true }
      : row.message.role === 'assistant'
        ? { source: row.message.source }
        : { source: row.message.source },
    position: row.position
  }))
  draftRows[1] = { role: 'user', content: [{ type: 'text', text: 'inserted between turns' }], position: { turn: 1, step: 2 } }
  const target = Session.create('ops-rebuild-target')
  const summary = ops.rebuildRewrittenSession(target, source.snapshotEvents(), { rows: draftRows })
  assert.ok(summary.records > 0)
  const messages = derived(target.deriveMessages())
  assert.deepEqual(messages.map((message) => message.text), ['hello', 'inserted between turns', 'run the tool', 'rewritten answer', 'tool output'])
  assertRestorable(target, 'rebuild')
})

test('rebuild strips tool blocks whose result was deleted', () => {
  const source = buildSession('ops-rebuild-tool')
  const sourceRows = ops.readSurface(source)
  const draftRows = sourceRows
    .filter((row) => row.message.role !== 'tool' || !row.message.content.some((block) => block.type === 'text' && block.text === 'tool output'))
    .map((row) => ({
      role: row.message.role,
      content: row.message.content,
      ...row.message.role === 'tool' ? { toolCallId: row.message.toolCallId ?? row.message.source.callId } : {},
      ...row.message.role === 'assistant' ? { source: row.message.source } : {},
      ...row.message.role === 'user' ? { source: row.message.source } : {},
      position: row.position
    }))
  const target = Session.create('ops-rebuild-tool-target')
  ops.rebuildRewrittenSession(target, source.snapshotEvents(), { rows: draftRows })
  const messages = derived(target.deriveMessages())
  assert.equal(messages.some((message) => message.role === 'tool'), false, 'the orphan tool result is dropped')
  const assistantCalls = target.deriveMessages().flatMap((message) => message.content ?? []).filter((block) => block.type === 'tool-call')
  assert.equal(assistantCalls.length, 0, 'the dangling tool-call block is stripped')
  assertRestorable(target, 'rebuild-tool')
})

test('rebuild marks an edited system prompt as an override', () => {
  const source = Session.create('ops-rebuild-system-source')
  source.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'assembled prompt' }], source: { kind: 'system-prompt' } } },
    { surfaceOp: 'append' }
  )
  source.append(
    'user/message',
    { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    { surfaceOp: 'append' }
  )
  const target = Session.create('ops-rebuild-system-target')
  ops.rebuildRewrittenSession(target, source.snapshotEvents(), {
    rows: [
      { role: 'system', content: [{ type: 'text', text: 'custom prompt' }], position: { turn: 1, step: 1 }, edited: true },
      { role: 'context', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' }, position: { turn: 1, step: 1 } }
    ]
  })
  assert.equal(ops.systemPromptOverride(target), 'custom prompt')
  assertRestorable(target, 'rebuild-system')
})

const failed = checks.filter((check) => !check.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
