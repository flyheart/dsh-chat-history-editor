/**
 * Host-side probe for the history operations.
 *
 * Builds a detached Session from the installed @deepseek-ai/dsh-session
 * package, exercises every surface mutation the plugin performs, and checks
 * both deriveMessages() and the real read path: `assertV4RowAdmission` for every
 * row plus `restoreReleasedV4Artifact` for the whole log (the relationship
 * validation a resumed Session runs). A live append that a restore would reject
 * makes the session un-resumable, so both checks are mandatory.
 *
 * Run: node test/host.test.mjs
 */

import assert from 'node:assert/strict'
import { loadDshModules, skipSuite } from './support.mjs'

const dsh = loadDshModules()
if (dsh === undefined) skipSuite('host.test.mjs')
const { Session } = await import(dsh.sessionModule)
const { assertV4RowAdmission, restoreReleasedV4Artifact } = await import(dsh.formatModule)
const ops = await import('../history-ops.js')

const MODEL_SOURCE = { kind: 'model', provider: 'probe-provider', model: 'probe-model' }

/**
 * Build one detached session with two completed turns, the second using a tool
 * call. `openStep` leaves a third Turn/Step open, which is the only state in
 * which step-scoped writes (system/developer/assistant messages) are legal.
 * @param {string} id - session id.
 * @param {{ openStep?: boolean }} [options] - framing variant.
 * @returns {object} detached Session.
 */
function buildSession(id, options = {}) {
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
  if (options.openStep === true) {
    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
  }
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

/** @param {object} session @returns {object} the logical V4 header of a probe session. */
function logicalHeader(session) {
  const header = {
    version: 4,
    id: session.id,
    createdAt: session.header.createdAt,
    isSeeded: false,
    delegationDepth: 0
  }
  if (typeof session.header.cwd === 'string') header.cwd = session.header.cwd
  return header
}

/**
 * Assert the log can be restored AND that every row passes the real JSONL
 * read-path admission validator (the check a resumed session runs), including
 * the V4 relationship validation (open turn/step framing, tool lifecycles,
 * surface replacements, commands, titles, delivery markers).
 *
 * @param {object} session - probe Session.
 * @param {string} label - assertion label.
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
  const known = new Set(seed.map((event) => event.type))
  assert.doesNotThrow(
    () => restoreReleasedV4Artifact({ header: logicalHeader(session), events: seed, inheritedEventCount: 0 }, known),
    `${label}: read-path relationship validation must accept the log`
  )
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

test('edit a user message in place without an open step', () => {
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

test('step-scoped mutations are refused while no turn is open', () => {
  const session = buildSession('ops-idle')
  const rows = ops.readSurface(session)
  const before = session.seq
  assert.equal(ops.openStepPosition(session), undefined, 'an idle session has no open turn/step')
  assert.throws(() => ops.deleteSurfaceMessages(session, [rows[0].seq]), (error) => error.code === 'needs-branch')
  assert.throws(() => ops.appendSurfaceMessage(session, 'assistant', 'nope'), (error) => error.code === 'needs-branch')
  assert.equal(session.seq, before, 'refused operations append nothing')

  const idle = Session.create('ops-idle-system')
  idle.append('turn/start', { turn: 1 })
  idle.append('step/start', { turn: 1, step: 1 })
  idle.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'system-prompt' } } },
    { surfaceOp: 'append' }
  )
  idle.append(
    'user/message',
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    { surfaceOp: 'append' }
  )
  idle.append(
    'assistant/message',
    { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: MODEL_SOURCE }, stream: [] },
    { surfaceOp: 'append' }
  )
  idle.append('step/end', { turn: 1, step: 1 })
  idle.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const idleBefore = idle.seq
  const idleRows = ops.readSurface(idle)
  assert.throws(() => ops.editSurfaceMessage(idle, idleRows[0].seq, 'edited prompt'), (error) => error.code === 'needs-branch')
  assert.throws(() => ops.editSurfaceMessage(idle, idleRows[2].seq, 'rewritten answer'), (error) => error.code === 'needs-branch')
  assert.throws(() => ops.resetSystemPrompt(idle), (error) => error.code === 'no-override')
  assert.equal(idle.seq, idleBefore, 'refused mutations append nothing')
  // User-role rewrites stay legal in place.
  ops.editSurfaceMessage(idle, idleRows[1].seq, 'hi (edited)')
  assert.equal(derived(idle.deriveMessages())[1].text, 'hi (edited)')
  assertRestorable(idle, 'idle-classified')
})

test('delete a user message inside an open step', () => {
  const session = buildSession('ops-delete-user', { openStep: true })
  assert.deepEqual(ops.openStepPosition(session), { turn: 3, step: 1 })
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
  const session = buildSession('ops-delete-pair', { openStep: true })
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
  const session = buildSession('ops-delete-result', { openStep: true })
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
  const session = buildSession('ops-delete-range', { openStep: true })
  const rows = ops.readSurface(session)
  const result = ops.deleteSurfaceMessages(session, [rows[2].seq, rows[3].seq])
  assert.equal(result.ranges, 1, 'one contiguous replacement covers the whole range')
  assert.equal(result.removed, 3, 'the requested pair plus its paired tool result are removed')
  assert.deepEqual(derived(session.deriveMessages()).map((item) => item.text), ['hello', 'hi there'])
  assertRestorable(session, 'delete-range')
})

test('append a user message at the tail without an open step', () => {
  const session = buildSession('ops-append-user')
  ops.appendSurfaceMessage(session, 'user', 'extra user turn')
  assert.deepEqual(derived(session.deriveMessages()).slice(-1), [{ role: 'user', text: 'extra user turn' }])
  assertRestorable(session, 'append-user')
})

test('append an assistant message inside an open step', () => {
  const session = buildSession('ops-append-assistant', { openStep: true })
  ops.appendSurfaceMessage(session, 'assistant', 'extra assistant answer')
  const messages = derived(session.deriveMessages())
  assert.deepEqual(messages.slice(-1), [{ role: 'assistant', text: 'extra assistant answer' }])
  const last = session.eventAt(session.seq - 1)
  assert.equal(last.type, 'assistant/message')
  assert.deepEqual([last.data.turn, last.data.step], [3, 1], 'the append lands in the open step')
  assertRestorable(session, 'append-assistant')
})

test('rewrite the last assistant message inside an open step', () => {
  const session = buildSession('ops-edit-assistant', { openStep: true })
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
  const session = buildSession('ops-edit-assistant-order', { openStep: true })
  const rows = ops.readSurface(session)
  assert.throws(() => ops.editSurfaceMessage(session, rows[1].seq, 'nope'), (error) => error.code === 'assistant-not-last')
})

test('system prompt nodes are editable but not deletable', () => {
  const session = Session.create('ops-system')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
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
  assert.throws(
    () => ops.executeHistoryOperation(session, { op: 'delete', seqs: [rows[0].seq] }),
    (error) => error.code === 'needs-branch',
    'the idle command path classifies deletes as needing a branch'
  )
})

test('rewrite and delete injected context snapshots', () => {
  const session = Session.create('ops-context')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
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
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
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

test('assistant appends inside an open step use the open coordinates', () => {
  const session = Session.create('ops-assistant-empty')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  ops.appendSurfaceMessage(session, 'assistant', 'prefilled answer')
  const last = session.eventAt(session.seq - 1)
  assert.equal(last.type, 'assistant/message')
  assert.deepEqual([last.data.turn, last.data.step], [1, 1])
  assertRestorable(session, 'assistant-empty')
})

test('system prompt edit records an override and reset clears it', () => {
  const session = Session.create('ops-system-edit')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
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
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'first' }], source: { kind: 'system-prompt' } } },
    { surfaceOp: 'append' }
  )
  session.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 's2', role: 'system', content: [{ type: 'text', text: 'in-history update' }], source: { kind: 'system-prompt' } } },
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
  source.append('turn/start', { turn: 1 })
  source.append('step/start', { turn: 1, step: 1 })
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

test('rebuild without a system row still starts the child with a system head', () => {
  const source = buildSession('ops-rebuild-head-source')
  const target = Session.create('ops-rebuild-head-target')
  ops.rebuildRewrittenSession(target, source.snapshotEvents(), {
    rows: [{ role: 'user', content: [{ type: 'text', text: 'only a user row' }], position: { turn: 1, step: 1 } }]
  })
  const first = target.eventAt(target.surface.nodes[0])
  assert.equal(first?.type, 'system/message', 'the child surface must open with a system node')
  assert.deepEqual(first.data.message.content, [], 'the placeholder head is empty')
  assertRestorable(target, 'rebuild-head')
})

const failed = checks.filter((check) => !check.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
