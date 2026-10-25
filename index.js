/**
 * Host half of the chat-history-editor bundle.
 *
 * The plugin exposes one operation surface for the History tab: a `/history`
 * session command carrying a JSON operation. The command is the only
 * client-callable entry point a profile plugin can add (the web client's Remote
 * namespaces are fixed at build time), so the History tab calls
 * `ctx.remote.commands.execute()` and the handler below performs the surface
 * mutation through the shared `history-ops` module.
 *
 * The command carries `recordInput: false`: the JSON payload never enters the
 * session log, and only the operation lifecycle row is recorded.
 *
 * @module @local/chat-history-editor
 */

import { HistoryError, executeHistoryOperation, rebuildRewrittenSession, systemPromptOverride } from './history-ops.js'

/** Required services: the command registry and the in-memory session store. */
export const inject = ['commands', 'sessions']

/** Session command name, invoked by the History tab. */
export const COMMAND_NAME = 'history'

/** Shape hint shown by command discovery surfaces. */
const INPUT_HINT = '{"op":"edit|delete|append", ...}'

/**
 * Compose one classified command result from a history operation.
 * @param {() => object} operation - synchronous operation body.
 * @returns {object} a `CommandResult`.
 */
function settle(operation) {
  try {
    operation()
    return { kind: 'success' }
  } catch (error) {
    if (error instanceof HistoryError) return { kind: 'error', text: `[${error.code}] ${error.message}` }
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `[internal] ${message}` }
  }
}

/**
 * Decode the operation payload carried after the command name.
 * @param {unknown} rawInput - text following `/history`.
 * @returns {object | undefined} the decoded payload, or undefined when it is not an object.
 */
function decodePayload(rawInput) {
  if (typeof rawInput !== 'string') return undefined
  let payload
  try {
    payload = JSON.parse(rawInput.trim())
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  return payload
}

/**
 * Read one session's complete log, preferring the live store.
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - source Session identity.
 * @returns {Promise<object[]>} the session events in seq order.
 */
async function sourceEventsOf(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) {
    const events = []
    for (let seq = 0; seq < live.seq; seq += 1) {
      const event = live.eventAt(seq)
      if (event !== undefined) events.push(event)
    }
    return events
  }
  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.readSession === 'function') {
    const snapshot = await query.readSession(sessionId)
    return [...snapshot.events]
  }
  throw new HistoryError('no-source', 'the source session log is unavailable')
}

/**
 * Mount the `/history` command.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 */
export function apply(ctx) {
  /**
   * Resolve the live session for one receiving agent.
   * @param {object} agent - the command's receiving agent.
   * @returns {object | undefined} the live Session, when present.
   */
  const sessionOf = (agent) => {
    if (agent !== null && typeof agent === 'object' && agent.session !== undefined && typeof agent.session.append === 'function') {
      return agent.session
    }
    if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string') return undefined
    return ctx.sessions.get(agent.id)
  }

  /**
   * @param {object} invocation - command invocation supplied by the registry.
   * @returns {object} the command result.
   */
  const handler = (invocation) => {
    const payload = decodePayload(invocation.rawInput)
    if (payload === undefined) return { kind: 'error', text: `[bad-request] /${COMMAND_NAME} expects a JSON operation` }
    const agent = invocation.agent
    let status
    try {
      status = agent !== null && typeof agent === 'object' ? agent.status : undefined
    } catch {
      status = undefined
    }
    if (status === 'running') {
      return { kind: 'error', text: '[busy] wait for the running turn to finish before editing history' }
    }
    const session = sessionOf(agent)
    if (session === undefined) return { kind: 'error', text: '[no-session] the live session is unavailable' }
    if (payload.op === 'rebuild') return rebuildOnBranch(ctx, session, payload)
    return settle(() => executeHistoryOperation(session, payload))
  }

  /**
   * Rewrite one freshly forked child session from a client draft.
   * @param {object} pluginCtx - plugin context.
   * @param {object} session - live child Session.
   * @param {object} payload - decoded rebuild payload.
   * @returns {Promise<object>} a `CommandResult`.
   */
  const rebuildOnBranch = async (pluginCtx, session, payload) => {
    try {
      if (typeof payload.sourceSessionId !== 'string' || payload.sourceSessionId.length === 0) {
        throw new HistoryError('bad-request', 'rebuild requires a sourceSessionId')
      }
      const sourceEvents = await sourceEventsOf(pluginCtx, payload.sourceSessionId)
      rebuildRewrittenSession(session, sourceEvents, payload.draft)
      try {
        await pluginCtx.sessions.flush(session)
      } catch (error) {
        pluginCtx.logger.warn(`chat-history-editor: rewrite flush failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return { kind: 'success' }
    } catch (error) {
      if (error instanceof HistoryError) return { kind: 'error', text: `[${error.code}] ${error.message}` }
      const message = error instanceof Error ? error.message : String(error)
      pluginCtx.logger.warn(`chat-history-editor: rebuild failed: ${message}`)
      return { kind: 'error', text: `[internal] ${message}` }
    }
  }

  // Keep an explicit History-tab system prompt edit effective across requests.
  // The agent loop reconciles its rendered prompt into the surface on every
  // step, so without this pin an edited prompt node would be replaced or
  // superseded by the assembled prompt at the next request. The pin only
  // applies while the last non-empty system node is the edited one.
  ctx.effect(
    () =>
      ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const result = await next()
        const agent = context !== null && typeof context === 'object' ? context.agent : undefined
        const session = agent !== null && typeof agent === 'object' ? agent.session : undefined
        if (session === undefined || session === null) return result
        const override = systemPromptOverride(session)
        if (override === undefined) return result
        return {
          ...result,
          sections: [{ name: 'history-editor:system-prompt', order: -1_000_000, interpolate: false, text: override }]
        }
      }),
    'chat-history-editor: pinned system prompt override'
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: COMMAND_NAME,
        description: 'Edit, delete, or append the model-visible chat history operations requested by the History tab',
        input: { hint: INPUT_HINT },
        recordInput: false,
        handler
      }),
    'chat-history-editor: /history command'
  )
}
