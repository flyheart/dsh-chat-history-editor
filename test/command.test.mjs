/**
 * Command-wiring probe: mounts the Host plugin with a stub Cordis context and
 * drives the registered `/history` handler against a real detached Session.
 * This covers the index.js wrapper (payload decoding, busy guard, classified
 * results) that the module tests skip.
 *
 * Run: node test/command.test.mjs
 */

import assert from 'node:assert/strict'
import { loadDshModules, skipSuite } from './support.mjs'

const dsh = loadDshModules()
if (dsh === undefined) skipSuite('command.test.mjs')
const { Session } = await import(dsh.sessionModule)
const { apply, inject, COMMAND_NAME } = await import('../index.js')

assert.deepEqual(inject, ['commands', 'sessions'])
assert.equal(COMMAND_NAME, 'history')

/** @returns {{ ctx: object, definition: object, warned: string[] }} mount result */
function mount(session, extraSessions = {}) {
  let definition
  const warned = []
  const ctx = {
    effect(factory) {
      return factory()
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
    commands: {
      register(candidate) {
        definition = candidate
        return () => {}
      }
    },
    sessions: {
      get(id) {
        if (id === session.id) return session
        return extraSessions[id]
      },
      async flush() {
        return true
      }
    },
    logger: {
      warn(message) {
        warned.push(String(message))
      }
    }
  }
  apply(ctx)
  assert.ok(definition, 'apply registers a command definition')
  return { ctx, definition, warned }
}

function buildSession() {
  const session = Session.create('command-probe')
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
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: []
    },
    { surfaceOp: 'append' }
  )
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

function derivedTexts(session) {
  return session
    .deriveMessages()
    .map((message) =>
      (message.content ?? [])
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
        .map((block) => block.text)
        .join('')
    )
}

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

check('the registered command is named and records no input', () => {
  const { definition } = mount(buildSession())
  assert.equal(definition.name, 'history')
  assert.equal(definition.recordInput, false)
  assert.equal(typeof definition.handler, 'function')
})

check('append over the command succeeds and reaches deriveMessages', () => {
  const session = buildSession()
  const { definition } = mount(session)
  const result = definition.handler({
    rawInput: ' {"op":"append","role":"user","text":"from the editor"}',
    agent: { id: session.id, status: 'idle', session }
  })
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(derivedTexts(session), ['hello', 'hi', 'from the editor'])
})

check('edit and delete run through the command wrapper', () => {
  const session = buildSession()
  const { definition } = mount(session)
  const rows = session.surface.nodes
  const userSeq = rows.find((seq) => session.eventAt(seq)?.type === 'user/message')
  assert.deepEqual(
    definition.handler({ rawInput: JSON.stringify({ op: 'edit', seq: userSeq, text: 'edited' }), agent: { id: session.id, status: 'idle', session } }),
    { kind: 'success' }
  )
  assert.deepEqual(derivedTexts(session), ['edited', 'hi'])
  const assistantSeq = session.surface.nodes.find((seq) => session.eventAt(seq)?.type === 'assistant/message')
  assert.deepEqual(
    definition.handler({ rawInput: JSON.stringify({ op: 'delete', seqs: [assistantSeq] }), agent: { id: session.id, status: 'idle', session } }),
    { kind: 'success' }
  )
  assert.deepEqual(derivedTexts(session), ['edited'])
})

check('malformed payloads return a classified error without touching the log', () => {
  const session = buildSession()
  const { definition } = mount(session)
  const before = session.seq
  for (const rawInput of ['', 'not json', '[]', 'null', '{"op":"wat"}']) {
    const result = definition.handler({ rawInput, agent: { id: session.id, status: 'idle', session } })
    assert.equal(result.kind, 'error', `raw input ${JSON.stringify(rawInput)} must fail`)
    assert.match(result.text, /^\[(bad-request|internal)\] /)
  }
  assert.equal(session.seq, before, 'rejected operations append nothing')
})

check('a running turn is refused', () => {
  const session = buildSession()
  const { definition } = mount(session)
  const before = session.seq
  const result = definition.handler({
    rawInput: JSON.stringify({ op: 'append', role: 'user', text: 'blocked' }),
    agent: { id: session.id, status: 'running', session }
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^\[busy\] /)
  assert.equal(session.seq, before)
})

check('missing live session is refused', () => {
  const session = buildSession()
  const { definition } = mount(session)
  const result = definition.handler({ rawInput: '{"op":"append","role":"user","text":"x"}', agent: { id: 'other', status: 'idle' } })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^\[no-session\] /)
})

check('reset-system without an override is a classified failure', () => {
  const session = buildSession()
  const { definition } = mount(session)
  const result = definition.handler({ rawInput: '{"op":"reset-system"}', agent: { id: session.id, status: 'idle', session } })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^\[no-override\] /)
})

check('a classified failure keeps its code', () => {
  const session = buildSession()
  const { definition } = mount(session)
  const result = definition.handler({ rawInput: '{"op":"append","role":"user","text":"   "}', agent: { id: session.id, status: 'idle', session } })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^\[empty\] /)
})

async function asyncCheck(name, body) {
  try {
    await body()
    checks.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    checks.push({ name, ok: false, error })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

await asyncCheck('rebuild rewrites a forked child from the source log', async () => {
  const source = buildSession()
  const child = Session.create('command-rebuild-child')
  const { definition } = mount(child, { [source.id]: source })
  const result = await definition.handler({
    rawInput: JSON.stringify({
      op: 'rebuild',
      sourceSessionId: source.id,
      draft: {
        rows: [
          { role: 'user', content: [{ type: 'text', text: 'rewritten hello' }], position: { turn: 1, step: 1 } },
          { role: 'assistant', content: [{ type: 'text', text: 'rewritten hi' }], position: { turn: 1, step: 1 } }
        ]
      }
    }),
    agent: { id: child.id, status: 'idle', session: child }
  })
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(derivedTexts(child), ['rewritten hello', 'rewritten hi'])
  const types = []
  for (let seq = 0; seq < child.seq; seq += 1) types.push(child.eventAt(seq).type)
  assert.ok(types.includes('turn/start'))
  assert.ok(types.includes('step/end'))
})

await asyncCheck('rebuild reports an unknown source session', async () => {
  const child = Session.create('command-rebuild-missing')
  const { definition } = mount(child)
  const result = await definition.handler({
    rawInput: JSON.stringify({ op: 'rebuild', sourceSessionId: 'session-missing', draft: { rows: [] } }),
    agent: { id: child.id, status: 'idle', session: child }
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^\[no-source\] /)
})

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
