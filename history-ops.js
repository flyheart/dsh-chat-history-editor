/**
 * Session-surface history mutations for the chat-history-editor plugin.
 *
 * The session log is append-only, so the history an agent actually sees is the
 * derived *surface* of the log. This module never rewrites stored events; it
 * appends well-formed surface events:
 *
 * - a rewritten user message is a `user/message` replacement of its own node;
 * - a removed range is an empty `developer/message` replacement: a surface node
 *   that projects no model message, leaving the model history without it;
 * - an appended message is an ordinary surface append at the tail;
 * - a rewritten assistant message is a fresh `assistant/message` append for the
 *   same Turn/Step plus a hidden tombstone for the old node (assistant messages
 *   cannot carry `sourceEventSeqs`, so they cannot replace a node directly).
 *
 * Tool results are kept tool-pairing balanced: deleting a message that takes
 * part in a tool call/result pair extends the deletion to its counterpart.
 *
 * This module imports nothing from the Harness so it can be exercised against a
 * plain `Session` instance in a Node probe.
 *
 * @module @local/chat-history-editor/history-ops
 */

import { randomUUID } from 'node:crypto'

/**
 * Identity prefix for a system prompt node written by this plugin. The session
 * format admits a `system/message` only with a `system-prompt` source, so an
 * explicit override is recognized by its opaque message identity instead.
 */
const HISTORY_EDITOR_ID_PREFIX = 'history-editor-'

/** Message-producing event types that own a surface node. */
const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result'
])

/** Upper bound for one edited or added message, in characters. */
const MAX_TEXT_CHARS = 200_000

/** At most this many surface nodes may be removed by one command. */
const MAX_DELETE_NODES = 200

/** Classified history-operation failure surfaced to the command caller. */
export class HistoryError extends Error {
  /**
   * @param {string} code - stable failure code used by the UI to localize.
   * @param {string} message - diagnostic in English for logs and fallbacks.
   */
  constructor(code, message) {
    super(message)
    this.name = 'HistoryError'
    this.code = code
  }
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new HistoryError(code, message)
}

/**
 * Accept a positive integer count, or fall back to a known-positive value.
 * The session format admits `developer/message` and `system/message` only with
 * positive `turn`/`step`; every event this plugin writes must satisfy that.
 * @param {unknown} value - candidate coordinate from an event.
 * @param {number} fallback - positive value to use when the candidate is invalid.
 * @returns {number} a positive integer.
 */
function positiveCount(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** @returns {string} a fresh durable message identity. */
function newMessageId() {
  return randomUUID()
}

/** @returns {string} a fresh identity marking an explicit system prompt override. */
function newOverrideId() {
  return `${HISTORY_EDITOR_ID_PREFIX}${randomUUID()}`
}

/**
 * Join the text blocks of one content array.
 * @param {readonly object[] | undefined} content - model-facing content blocks.
 * @returns {string} the text of the message, in block order.
 */
export function contentText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Read the current surface as rows in model-visible order.
 * @param {object} session - live Session instance.
 * @returns {Array<{ seq: number, event: object, message: object | null }>} surface rows.
 */
export function readSurface(session) {
  // Track Turn/Step boundaries while walking the log so every surface row can
  // carry a canonical positive position. `user/message` payloads carry no
  // position of their own, and appends must still satisfy format admission.
  const positions = new Map()
  let turn = 1
  let step = 1
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      turn = positiveCount(event.data?.turn, turn)
      step = 1
      continue
    }
    if (event.type === 'step/start') {
      step = positiveCount(event.data?.step, step)
      continue
    }
    if (!SURFACE_TYPES.has(event.type)) continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    positions.set(event.seq, {
      turn: positiveCount(data.turn, turn),
      step: positiveCount(data.step, step)
    })
  }
  const rows = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event === undefined || !SURFACE_TYPES.has(event.type)) continue
    let message = null
    try {
      message = session.deriveEventMessage(event)
    } catch {
      message = null
    }
    rows.push({ seq, event, message, position: positions.get(seq) ?? { turn: 1, step: 1 } })
  }
  return rows
}

/** @param {object | null} message @returns {string[]} tool-call ids carried by an assistant message. */
function callIdsOf(message) {
  if (message === null || message.role !== 'assistant' || !Array.isArray(message.content)) return []
  const ids = []
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'tool-call' && typeof block.id === 'string') ids.push(block.id)
  }
  return ids
}

/** @param {object | null} message @returns {string | undefined} the call id a tool message answers. */
function toolCallIdOf(message) {
  if (message === null || message.role !== 'tool') return undefined
  if (typeof message.toolCallId === 'string') return message.toolCallId
  const source = message.source
  if (source !== null && typeof source === 'object' && typeof source.callId === 'string') return source.callId
  return undefined
}

/** @param {object} row @returns {{ turn: number, step: number }} the row's canonical positive position. */
function rowPosition(row) {
  return {
    turn: positiveCount(row?.position?.turn, 1),
    step: positiveCount(row?.position?.step, 1)
  }
}

/** @param {object[]} rows @returns {{ turn: number, step: number }} the last canonical positive position. */
function lastPosition(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const position = rows[index].position
    if (position !== undefined) {
      return { turn: positiveCount(position.turn, 1), step: positiveCount(position.step, 1) }
    }
  }
  return { turn: 1, step: 1 }
}

/**
 * Resolve the provider/model metadata for an assistant message.
 * @param {object[]} rows - current surface rows.
 * @param {object | undefined} preferred - row whose own source is preferred.
 * @returns {{ provider: string, model: string }} recorded or fallback identity.
 */
function assistantSource(rows, preferred) {
  const own = preferred?.message?.source
  if (own !== undefined && own !== null && typeof own.provider === 'string' && typeof own.model === 'string') {
    return { provider: own.provider, model: own.model }
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const candidate = rows[index].message
    if (candidate === null || candidate.role !== 'assistant') continue
    const source = candidate.source
    if (source !== undefined && source !== null && typeof source.provider === 'string' && typeof source.model === 'string') {
      return { provider: source.provider, model: source.model }
    }
  }
  return { provider: 'history-editor', model: 'manual' }
}

/**
 * Validate one replacement/add text.
 * @param {unknown} text - caller-provided message text.
 * @returns {string} the accepted text.
 */
function validText(text) {
  if (typeof text !== 'string') fail('bad-request', 'message text must be a string')
  if (text.trim().length === 0) fail('empty', 'message text must not be blank')
  if (text.length > MAX_TEXT_CHARS) fail('too-long', `message text exceeds ${MAX_TEXT_CHARS} characters`)
  return text
}

/** @param {unknown} value @returns {number} a validated event sequence. */
function validSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('bad-request', 'message sequence must be a non-negative integer')
  return value
}

/** @param {unknown} value @returns {number[]} validated distinct event sequences. */
function validSeqList(value) {
  if (!Array.isArray(value) || value.length === 0) fail('bad-request', 'at least one message sequence is required')
  const seen = new Set()
  const out = []
  for (const item of value) {
    const seq = validSeq(item)
    if (seen.has(seq)) continue
    seen.add(seq)
    out.push(seq)
  }
  if (out.length > MAX_DELETE_NODES) fail('bad-request', `at most ${MAX_DELETE_NODES} messages may be removed at once`)
  return out
}

/**
 * Append one hidden replacement that projects no model message.
 * @param {object} session - live Session.
 * @param {{ turn: number, step: number }} position - recorded position for the event.
 * @param {number} startSeq - first current surface node to shadow.
 * @param {number} endSeq - last current surface node to shadow.
 * @param {number[]} shadowedSeqs - every current surface node in the range.
 * @returns {object} the logged event.
 */
function appendTombstone(session, position, startSeq, endSeq, shadowedSeqs) {
  return session.append(
    'developer/message',
    {
      turn: position.turn,
      step: position.step,
      message: {
        id: newMessageId(),
        role: 'developer',
        content: [],
        source: { kind: 'history-editor' }
      }
    },
    {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: [...shadowedSeqs]
    }
  )
}

/**
 * Plan a tool-pairing-balanced deletion.
 *
 * Deleting an assistant message that issued tool calls also removes their
 * results; deleting a tool result also removes the assistant message that
 * issued its call. Any surviving tool result must keep a surviving call.
 *
 * @param {object[]} rows - current surface rows.
 * @param {number[]} requestedSeqs - surface node sequences the caller wants gone.
 * @returns {Array<{ startSeq: number, endSeq: number, shadowedSeqs: number[], position: { turn: number, step: number } }>}
 *   contiguous replacement ranges in surface order.
 */
export function planDeletion(rows, requestedSeqs) {
  const indexOf = new Map()
  rows.forEach((row, index) => indexOf.set(row.seq, index))
  /** @type {Set<number>} */
  const removed = new Set()
  for (const seq of requestedSeqs) {
    const index = indexOf.get(seq)
    if (index === undefined) fail('not-found', `message ${seq} is not in the current history`)
    const row = rows[index]
    if (row.message === null) fail('not-found', `message ${seq} carries no model message`)
    if (row.event.type === 'system/message') fail('system-prompt', 'the system prompt cannot be removed')
    if (row.event.type === 'developer/message') fail('not-deletable', 'context injection records cannot be removed individually')
    removed.add(index)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const index of [...removed]) {
      const message = rows[index].message
      if (message === null) continue
      if (message.role === 'assistant') {
        for (const callId of callIdsOf(message)) {
          rows.forEach((row, other) => {
            if (removed.has(other) || toolCallIdOf(row.message) !== callId) return
            removed.add(other)
            changed = true
          })
        }
      } else if (message.role === 'tool') {
        const callId = toolCallIdOf(message)
        if (callId === undefined) continue
        rows.forEach((row, other) => {
          if (removed.has(other) || !callIdsOf(row.message).includes(callId)) return
          removed.add(other)
          changed = true
        })
      }
    }
  }
  const survivingCalls = new Set()
  rows.forEach((row, index) => {
    if (removed.has(index)) return
    for (const callId of callIdsOf(row.message)) survivingCalls.add(callId)
  })
  rows.forEach((row, index) => {
    if (removed.has(index)) return
    const callId = toolCallIdOf(row.message)
    if (callId !== undefined && !survivingCalls.has(callId)) {
      fail('paired', 'that message is paired with a tool call that must be removed together')
    }
  })
  const indices = [...removed].sort((left, right) => left - right)
  const runs = []
  for (const index of indices) {
    const run = runs[runs.length - 1]
    if (run !== undefined && run.end === index - 1) run.end = index
    else runs.push({ start: index, end: index })
  }
  return runs.map((run) => ({
    startSeq: rows[run.start].seq,
    endSeq: rows[run.end].seq,
    shadowedSeqs: rows.slice(run.start, run.end + 1).map((row) => row.seq),
    position: rowPosition(rows[run.start])
  }))
}

/**
 * Rewrite one message in place.
 * @param {object} session - live Session.
 * @param {number} seq - current surface node sequence to rewrite.
 * @param {unknown} text - replacement text.
 * @returns {{ seq: number }} the shadowed node sequence.
 */
export function editSurfaceMessage(session, seq, text) {
  const accepted = validText(text)
  const rows = readSurface(session)
  const index = rows.findIndex((row) => row.seq === seq)
  if (index === -1) fail('not-found', `message ${seq} is not in the current history`)
  const row = rows[index]
  const message = row.message
  if (message === null) fail('not-found', `message ${seq} carries no model message`)
  if (message.role === 'system') {
    // The system prompt is the rendered prompt history node. Rewriting it with a
    // `history-editor` source marks it as an explicit user override; the plugin's
    // assembly pin keeps that text effective until the user restores the default.
    const position = rowPosition(row)
    const preserved = Array.isArray(message.content)
      ? message.content.filter((block) => block !== null && typeof block === 'object' && block.type !== 'text')
      : []
    session.append(
      'system/message',
      {
        turn: position.turn,
        step: position.step,
        message: {
          id: newOverrideId(),
          role: 'system',
          content: [{ type: 'text', text: accepted }, ...preserved],
          source: { kind: 'system-prompt' }
        }
      },
      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
    )
    // A later non-empty system node would win as the effective prompt; empty it
    // so the edited node is the one the model receives.
    for (let later = index + 1; later < rows.length; later += 1) {
      const laterRow = rows[later]
      const laterMessage = laterRow.message
      if (laterMessage === null || laterMessage.role !== 'system') continue
      if (contentText(laterMessage.content).trim() === '') continue
      const laterPosition = rowPosition(laterRow)
      session.append(
        'system/message',
        {
          turn: laterPosition.turn,
          step: laterPosition.step,
          message: { id: newMessageId(), role: 'system', content: [], source: { kind: 'system-prompt' } }
        },
        { surfaceOp: { op: 'replace', startSeq: laterRow.seq, endSeq: laterRow.seq }, sourceEventSeqs: [laterRow.seq] }
      )
    }
    return { seq }
  }
  if (message.role === 'user') {
    // A user-role surface node may be a human message or an injected context
    // snapshot (runtime context, model selection, working directory, ...).
    // Both are rewritable: the replacement keeps the recorded source so the
    // injection stays classified as the same kind of context.
    const source = row.event.data?.source
    const preservedSource = source !== undefined && source !== null && typeof source === 'object' ? { ...source } : { kind: 'user' }
    if (typeof preservedSource.kind !== 'string') preservedSource.kind = 'user'
    const preserved = Array.isArray(message.content)
      ? message.content.filter((block) => block !== null && typeof block === 'object' && block.type !== 'text')
      : []
    session.append(
      'user/message',
      {
        id: newMessageId(),
        role: 'user',
        content: [{ type: 'text', text: accepted }, ...preserved],
        source: preservedSource
      },
      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
    )
    return { seq }
  }
  if (message.role === 'assistant') {
    const laterVisible = rows.slice(index + 1).some((later) => later.message !== null)
    if (laterVisible) {
      fail('assistant-not-last', 'only the last assistant message can be rewritten; delete the message instead')
    }
    const position = rowPosition(row)
    const source = assistantSource(rows, row)
    session.append(
      'assistant/message',
      {
        turn: position.turn,
        step: position.step,
        message: {
          id: newMessageId(),
          role: 'assistant',
          content: [{ type: 'text', text: accepted }],
          source: { kind: 'model', provider: source.provider, model: source.model }
        },
        stream: []
      },
      { surfaceOp: 'append' }
    )
    appendTombstone(session, position, seq, seq, [seq])
    return { seq }
  }
  fail('not-editable', 'only user and assistant messages can be rewritten')
}

/**
 * Remove one or more messages from the model-visible history.
 * @param {object} session - live Session.
 * @param {unknown} seqs - current surface node sequences to remove.
 * @returns {{ removed: number, ranges: number }} removed node count and replacement count.
 */
export function deleteSurfaceMessages(session, seqs) {
  const requested = validSeqList(seqs)
  const rows = readSurface(session)
  const runs = planDeletion(rows, requested)
  let removed = 0
  for (const run of runs) {
    appendTombstone(session, run.position, run.startSeq, run.endSeq, run.shadowedSeqs)
    removed += run.shadowedSeqs.length
  }
  return { removed, ranges: runs.length }
}

/**
 * Append one new model-visible message at the end of the history.
 * @param {object} session - live Session.
 * @param {unknown} role - `user` or `assistant`.
 * @param {unknown} text - message text.
 * @returns {{ role: string }} the appended role.
 */
export function appendSurfaceMessage(session, role, text) {
  const accepted = validText(text)
  const rows = readSurface(session)
  if (role === 'user') {
    session.append(
      'user/message',
      { id: newMessageId(), role: 'user', content: [{ type: 'text', text: accepted }], source: { kind: 'user' } },
      { surfaceOp: 'append' }
    )
    return { role: 'user' }
  }
  if (role === 'assistant') {
    const position = lastPosition(rows)
    const source = assistantSource(rows, undefined)
    session.append(
      'assistant/message',
      {
        turn: position.turn,
        step: position.step + 1,
        message: {
          id: newMessageId(),
          role: 'assistant',
          content: [{ type: 'text', text: accepted }],
          source: { kind: 'model', provider: source.provider, model: source.model }
        },
        stream: []
      },
      { surfaceOp: 'append' }
    )
    return { role: 'assistant' }
  }
  fail('bad-request', `unsupported message role: ${String(role)}`)
}

//#region rewrite-into-branch support

/** Session-level policy events replayed into a rewritten branch, in log order. */
const POLICY_REPLAY_TYPES = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'model/selection',
  'working-directory/change'
])

/** Draft row roles understood by the rewrite builder. */
const DRAFT_ROLES = new Set(['user', 'context', 'assistant', 'tool', 'system'])

/** Upper bound for one rewrite payload, in JSON characters. */
const MAX_REWRITE_CHARS = 8_000_000

/** Deep-clone one lossless JSON value. */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Normalize one draft row from the client.
 * @param {unknown} raw - untrusted draft row.
 * @returns {{ role: string, content: object[], source: object | undefined, toolCallId: string | undefined, isError: boolean, edited: boolean, position: { turn: number, step: number } }}
 */
function normalizeDraftRow(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('bad-request', 'draft row must be an object')
  const row = raw
  if (typeof row.role !== 'string' || !DRAFT_ROLES.has(row.role)) fail('bad-request', `unsupported draft row role: ${String(row.role)}`)
  if (!Array.isArray(row.content) || row.content.length === 0) fail('empty', 'a draft row needs content')
  let content
  try {
    content = cloneJson(row.content)
  } catch {
    fail('bad-request', 'draft row content is not lossless JSON')
  }
  const source = row.source !== null && typeof row.source === 'object' && typeof row.source.kind === 'string' ? cloneJson(row.source) : undefined
  return {
    role: row.role,
    content,
    source,
    toolCallId: typeof row.toolCallId === 'string' ? row.toolCallId : undefined,
    isError: row.isError === true,
    edited: row.edited === true,
    position: {
      turn: positiveCount(row.position?.turn, 1),
      step: positiveCount(row.position?.step, 1)
    }
  }
}

/** @param {object | undefined} source @returns {object} an admissible human/context message source. */
function draftUserSource(source) {
  if (source === undefined || source.kind === 'plugin') return { kind: 'user' }
  return source
}

/**
 * @param {object | undefined} source - recorded model source, when present.
 * @param {object[]} sourceEvents - source session log, for header fallback.
 * @returns {{ provider: string, model: string }} model identity for a rewritten assistant message.
 */
function draftModelSource(source, sourceEvents) {
  if (source !== undefined && typeof source.provider === 'string' && typeof source.model === 'string') {
    return { provider: source.provider, model: source.model }
  }
  for (let index = sourceEvents.length - 1; index >= 0; index -= 1) {
    const event = sourceEvents[index]
    if (event.type !== 'request/header') continue
    const config = event.data?.header?.config
    if (config !== null && typeof config === 'object' && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  return { provider: 'history-editor', model: 'manual' }
}

/**
 * Drop tool-call blocks whose result is gone and tool results whose call is
 * gone, so the rewritten request stays tool-pairing balanced.
 * @param {object[]} rows - normalized draft rows.
 * @returns {object[]} the surviving rows.
 */
function normalizeDraftToolPairing(rows) {
  const toolCallIds = new Set()
  for (const row of rows) if (row.role === 'tool' && row.toolCallId !== undefined) toolCallIds.add(row.toolCallId)
  const retainedCalls = new Set()
  const kept = []
  for (const row of rows) {
    if (row.role === 'assistant') {
      const content = []
      for (const block of row.content) {
        if (block !== null && typeof block === 'object' && block.type === 'tool-call') {
          if (typeof block.id !== 'string' || !toolCallIds.has(block.id)) continue
          if (typeof block.name !== 'string' || typeof block.arguments !== 'string') continue
          retainedCalls.add(block.id)
          content.push(block)
          continue
        }
        if (block !== null && typeof block === 'object' && block.type === 'reasoning' && row.edited) continue
        content.push(block)
      }
      if (content.length === 0) continue
      kept.push({ ...row, content })
      continue
    }
    if (row.role === 'tool') {
      if (row.toolCallId === undefined || !retainedCalls.has(row.toolCallId)) continue
      kept.push(row)
      continue
    }
    kept.push(row)
  }
  return kept
}

/**
 * Rebuild a rewritten conversation into one freshly forked child session.
 * Every emitted event is a canonical surface append with positive Turn/Step
 * coordinates, so the child is a normal, resumable session whose Chat,
 * trajectory, and model history all show the edited conversation.
 * @param {object} target - live child Session receiving the rewritten history.
 * @param {object[]} sourceEvents - source Session log (for policy replay and metadata fallbacks).
 * @param {{ rows?: unknown }} draft - client-supplied edited history.
 * @returns {{ turns: number, records: number }} rebuild summary.
 */
export function rebuildRewrittenSession(target, sourceEvents, draft) {
  if (draft === null || typeof draft !== 'object' || !Array.isArray(draft.rows)) fail('bad-request', 'draft must carry a rows array')
  let size = 0
  try {
    size = JSON.stringify(draft.rows).length
  } catch {
    fail('bad-request', 'draft is not lossless JSON')
  }
  if (size > MAX_REWRITE_CHARS) fail('too-large', `draft exceeds ${MAX_REWRITE_CHARS} characters`)
  if (draft.rows.length > 4000) fail('too-large', 'draft has too many rows')

  const rows = draft.rows.map(normalizeDraftRow)
  const kept = normalizeDraftToolPairing(rows)

  // Preserve the session-level policy facts the child would otherwise lose.
  for (const event of sourceEvents) {
    if (!POLICY_REPLAY_TYPES.has(event.type)) continue
    target.append(event.type, cloneJson(event.data))
  }

  let baseTurn = 0
  for (let seq = 0; seq < target.seq; seq += 1) {
    const event = target.eventAt(seq)
    if (event !== undefined && Number.isInteger(event.data?.turn) && event.data.turn > baseTurn) baseTurn = event.data.turn
  }

  // The effective system prompt is the last non-empty system row; earlier
  // prompt-update records are historical and are dropped.
  let effectiveSystem
  for (const row of kept) {
    if (row.role !== 'system') continue
    effectiveSystem = row
  }

  const groups = []
  for (const row of kept) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.turn === row.position.turn && last.step === row.position.step) last.rows.push(row)
    else groups.push({ turn: row.position.turn, step: row.position.step, rows: [row] })
  }

  let turnCounter = baseTurn
  let stepCounter = 0
  let currentSourceTurn = null
  let emitted = 0
  for (const group of groups) {
    if (group.turn !== currentSourceTurn) {
      if (currentSourceTurn !== null) target.append('turn/end', { turn: turnCounter, reason: { kind: 'completed' } })
      turnCounter += 1
      stepCounter = 0
      currentSourceTurn = group.turn
      target.append('turn/start', { turn: turnCounter })
    }
    stepCounter += 1
    target.append('step/start', { turn: turnCounter, step: stepCounter })
    for (const row of group.rows) {
      if (row.role === 'system') {
        if (row !== effectiveSystem) continue
        target.append(
          'system/message',
          {
            turn: turnCounter,
            step: stepCounter,
            message: {
              id: row.edited ? newOverrideId() : newMessageId(),
              role: 'system',
              content: row.content,
              source: { kind: 'system-prompt' }
            }
          },
          { surfaceOp: 'append' }
        )
        emitted += 1
        continue
      }
      if (row.role === 'user' || row.role === 'context') {
        target.append(
          'user/message',
          { id: newMessageId(), role: 'user', content: row.content, source: draftUserSource(row.source) },
          { surfaceOp: 'append' }
        )
        emitted += 1
        continue
      }
      if (row.role === 'assistant') {
        const identity = draftModelSource(row.source, sourceEvents)
        target.append(
          'assistant/message',
          {
            turn: turnCounter,
            step: stepCounter,
            message: {
              id: newMessageId(),
              role: 'assistant',
              content: row.content,
              source: { kind: 'model', provider: identity.provider, model: identity.model }
            },
            stream: []
          },
          { surfaceOp: 'append' }
        )
        emitted += 1
        for (const block of row.content) {
          if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
          target.append('tool/call', { turn: turnCounter, step: stepCounter, callId: block.id, name: block.name, arguments: block.arguments })
        }
        continue
      }
      // tool result
      target.append(
        'tool/result',
        {
          turn: turnCounter,
          step: stepCounter,
          message: {
            id: newMessageId(),
            role: 'tool',
            content: row.content,
            source: { kind: 'tool', callId: row.toolCallId },
            toolCallId: row.toolCallId,
            ...row.isError ? { isError: true } : {}
          }
        },
        { surfaceOp: 'append' }
      )
      emitted += 1
    }
    target.append('step/end', { turn: turnCounter, step: stepCounter })
  }
  if (currentSourceTurn !== null) target.append('turn/end', { turn: turnCounter, reason: { kind: 'completed' } })
  return { turns: currentSourceTurn === null ? 0 : turnCounter - baseTurn, records: emitted }
}

//#endregion

/**
 * Read the explicit system prompt override this plugin recorded, if it is the
 * effective prompt. Only the last non-empty `system/message` node decides: when
 * it carries a `history-editor` source the plugin pins the prompt assembly to
 * it, otherwise the assembled prompt stays authoritative.
 * @param {object} session - live Session.
 * @returns {string | undefined} override text, or undefined when absent.
 */
export function systemPromptOverride(session) {
  const nodes = session.surface.nodes
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index])
    if (event === undefined || event.type !== 'system/message') continue
    const text = contentText(event.data?.message?.content)
    if (text.trim() === '') continue
    return isOverrideMessage(event.data?.message) ? text : undefined
  }
  return undefined
}

/** @param {object | undefined} message @returns {boolean} whether the message was written by an override edit. */
function isOverrideMessage(message) {
  return typeof message?.id === 'string' && message.id.startsWith(HISTORY_EDITOR_ID_PREFIX)
}

/**
 * Drop every explicit system prompt override by replacing the marked system
 * nodes with empty system nodes. The next model request then re-renders the
 * assembled prompt into history.
 * @param {object} session - live Session.
 * @returns {{ cleared: number }} number of override nodes cleared.
 */
export function resetSystemPrompt(session) {
  const rows = readSurface(session)
  const marked = rows.filter((row) => {
    if (row.message === null || row.message.role !== 'system') return false
    if (contentText(row.message.content).trim() === '') return false
    return isOverrideMessage(row.event.data?.message)
  })
  if (marked.length === 0) fail('no-override', 'the system prompt has no history-editor override to reset')
  for (const row of marked) {
    const position = rowPosition(row)
    session.append(
      'system/message',
      {
        turn: position.turn,
        step: position.step,
        message: { id: newMessageId(), role: 'system', content: [], source: { kind: 'system-prompt' } }
      },
      { surfaceOp: { op: 'replace', startSeq: row.seq, endSeq: row.seq }, sourceEventSeqs: [row.seq] }
    )
  }
  return { cleared: marked.length }
}

/**
 * Execute one decoded history operation.
 * @param {object} session - live Session.
 * @param {{ op?: unknown, seq?: unknown, seqs?: unknown, role?: unknown, text?: unknown }} payload - decoded operation.
 * @returns {object} operation result summary.
 */
export function executeHistoryOperation(session, payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('bad-request', 'operation payload must be an object')
  }
  const op = payload.op
  if (op === 'edit') return editSurfaceMessage(session, validSeq(payload.seq), payload.text)
  if (op === 'delete') {
    const seqs = payload.seqs !== undefined ? payload.seqs : payload.seq !== undefined ? [payload.seq] : undefined
    return deleteSurfaceMessages(session, seqs)
  }
  if (op === 'append') return appendSurfaceMessage(session, payload.role, payload.text)
  if (op === 'reset-system') return resetSystemPrompt(session)
  fail('bad-request', `unknown operation: ${String(op)}`)
}
