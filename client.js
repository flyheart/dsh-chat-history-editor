window.__ModuleLoader__.load({
  id: 'dsh-chat-history-editor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'chat-history-editor'
    /** Host command that performs every mutation (the only client-callable extension point). */
    const HOST_COMMAND = 'history'
    /** Style tag identity, so repeated module materialization installs one tag. */
    const CSS_ID = 'dsh-chat-history-editor/views.css'
    /** Message-producing event types, mirroring the Session surface vocabulary. */
    const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
    /** Identity prefix marking an explicit system prompt override written by the Host plugin. */
    const HISTORY_EDITOR_ID_PREFIX = 'history-editor-'
    /** Longest inline preview before a row offers expand/collapse. */
    const COLLAPSE_CHARS = 600
    /** Failure codes the Host classifies and this UI can localize. */
    const ERROR_CODES = new Set([
      'bad-request',
      'busy',
      'no-session',
      'not-found',
      'not-editable',
      'not-deletable',
      'context-message',
      'system-prompt',
      'assistant-not-last',
      'paired',
      'empty',
      'too-long',
      'too-large',
      'no-override',
      'no-source',
      'internal'
    ])

    //#region history projection (pure)

    /** @param {readonly object[] | undefined} content @returns {string} */
    function contentText(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('\n')
    }

    /**
     * Fold a contiguous session event window into current surface nodes.
     * A replacement splices the node range it shadows; unknown endpoints are
     * skipped because their node is outside the loaded window.
     * @param {readonly object[]} entries - `SessionEventWindow.entries`.
     * @returns {Array<{ seq: number, event: object }>} surface nodes in model order.
     */
    function foldSurfaceEntries(entries) {
      /** @type {Array<{ seq: number, event: object, turn: number, step: number }>} */
      const nodes = []
      let turn = 0
      let step = 1
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
        const event = entry.event
        if (event === null || typeof event !== 'object') continue
        if (event.type === 'turn/start') {
          turn = Number.isInteger(event.data?.turn) ? event.data.turn : turn
          step = 1
          continue
        }
        if (event.type === 'step/start') {
          step = Number.isInteger(event.data?.step) ? event.data.step : step
          continue
        }
        if (!SURFACE_TYPES.has(event.type)) continue
        const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
        const position = {
          turn: Number.isInteger(data.turn) ? data.turn : turn,
          step: Number.isInteger(data.step) ? data.step : step
        }
        const op = event.surfaceOp
        if (op === undefined || op === 'append') {
          nodes.push({ seq: event.seq, event, ...position })
          continue
        }
        if (op === null || typeof op !== 'object' || op.op !== 'replace') continue
        let start = -1
        let end = -1
        for (let index = 0; index < nodes.length; index += 1) {
          if (nodes[index].seq === op.startSeq) start = index
          if (nodes[index].seq === op.endSeq) end = index
        }
        if (end === -1) continue
        // The loaded window is a contiguous suffix: a range whose startSeq
        // predates it shadows every loaded node up to endSeq.
        const from = start === -1 ? 0 : start
        if (from > end) continue
        const inherited = nodes[from] ?? nodes[end]
        nodes.splice(from, end - from + 1, {
          seq: event.seq,
          event,
          turn: Number.isInteger(data.turn) ? data.turn : inherited?.turn ?? turn,
          step: Number.isInteger(data.step) ? data.step : inherited?.step ?? step
        })
      }
      return nodes
    }

    /**
     * Project one surface event to a display row, or null when it produces no
     * model message (empty system/developer/assistant content, tombstones).
     * @param {{ seq: number, event: object }} node - surface node.
     * @returns {object | null} display row.
     */
    function surfaceRowOf(node) {
      const event = node.event
      const data = event.data
      if (data === null || typeof data !== 'object') return null
      switch (event.type) {
        case 'system/message': {
          const blocks = Array.isArray(data.message?.content) ? data.message.content : []
          const text = contentText(blocks)
          if (text === '') return null
          const id = data.message?.id
          return {
            seq: node.seq,
            role: 'system',
            text,
            blocks,
            source: data.message?.source,
            sourceKind: data.message?.source?.kind,
            override: typeof id === 'string' && id.startsWith(HISTORY_EDITOR_ID_PREFIX),
            eventType: event.type
          }
        }
        case 'developer/message': {
          const blocks = Array.isArray(data.message?.content) ? data.message.content : []
          const text = contentText(blocks)
          return text === ''
            ? null
            : { seq: node.seq, role: 'context', text, blocks, source: data.message?.source, sourceKind: data.message?.source?.kind, eventType: event.type }
        }
        case 'user/message': {
          const blocks = Array.isArray(data.content) ? data.content : []
          const text = contentText(blocks)
          if (data.source?.kind === 'user') {
            return text === ''
              ? { seq: node.seq, role: 'user', text, blocks, placeholder: true, source: data.source, sourceKind: 'user', eventType: event.type }
              : { seq: node.seq, role: 'user', text, blocks, source: data.source, sourceKind: 'user', eventType: event.type }
          }
          return { seq: node.seq, role: 'context', text, blocks, source: data.source, sourceKind: data.source?.kind, eventType: event.type }
        }
        case 'assistant/message': {
          const blocks = Array.isArray(data.message?.content) ? data.message.content : []
          const text = contentText(blocks)
          let toolCalls = 0
          for (const block of blocks) if (block !== null && typeof block === 'object' && block.type === 'tool-call') toolCalls += 1
          if (text === '' && toolCalls === 0) return null
          return { seq: node.seq, role: 'assistant', text, blocks, toolCalls, source: data.message?.source, eventType: event.type }
        }
        case 'tool/result': {
          const blocks = Array.isArray(data.message?.content) ? data.message.content : []
          const text = contentText(blocks)
          const message = data.message
          return {
            seq: node.seq,
            role: 'tool',
            text,
            blocks,
            toolCallId: typeof message?.toolCallId === 'string' ? message.toolCallId : message?.source?.callId,
            isError: message?.isError === true,
            eventType: event.type
          }
        }
        default:
          return null
      }
    }

    /**
     * Build the display rows the model currently sees.
     * @param {readonly object[]} entries - contiguous session event window entries.
     * @returns {object[]} display rows in model order.
     */
    function buildHistoryRows(entries) {
      const rows = []
      for (const node of foldSurfaceEntries(entries)) {
        const row = surfaceRowOf(node)
        if (row === null) continue
        rows.push({
          ...row,
          turn: Number.isInteger(node.turn) ? node.turn : 0,
          step: Number.isInteger(node.step) ? node.step : 1,
          time: typeof node.event.time === 'number' ? node.event.time : 0
        })
      }
      return rows
    }

    /** @param {object} row @param {number} index @param {object[]} rows @returns {boolean} */
    function canEditRow(row, index, rows) {
      if (row.role === 'user') return true
      if (row.role === 'system') return true
      if (row.role === 'assistant') return index === rows.length - 1
      // Injected context snapshots backed by a user/message event (runtime
      // context, model selection, working directory, ...) are rewritable; the
      // Host keeps their recorded source kind.
      return row.role === 'context' && row.eventType === 'user/message'
    }

    /** @param {object} row @returns {boolean} */
    function canDeleteRow(row) {
      if (row.role === 'user' || row.role === 'assistant' || row.role === 'tool') return true
      return row.role === 'context' && row.eventType === 'user/message'
    }

    /**
     * Group consecutive display rows into Turn sections.
     * @param {object[]} rows - display rows in model order.
     * @returns {Array<{ turn: number, rows: object[] }>} contiguous Turn groups.
     */
    function groupByTurn(rows) {
      const groups = []
      for (const row of rows) {
        const turn = Number.isInteger(row.turn) ? row.turn : 0
        const last = groups[groups.length - 1]
        if (last !== undefined && last.turn === turn) last.rows.push(row)
        else groups.push({ turn, rows: [row] })
      }
      return groups
    }

    /**
     * Format one event timestamp as a local wall clock.
     * @param {unknown} time - epoch milliseconds carried by the surface event.
     * @returns {string} HH:MM:SS, or an empty string when the value is invalid.
     */
    function formatClock(time) {
      if (typeof time !== 'number' || !Number.isFinite(time)) return ''
      const date = new Date(time)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /**
     * Collapse message text into a single-line preview.
     * @param {string} text - full message text.
     * @param {number} max - maximum preview length.
     * @returns {string} single-line preview.
     */
    function previewText(text, max) {
      const flattened = String(text).replace(/\s+/g, ' ').trim()
      return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened
    }

    /**
     * Map a Host failure text to a localized message.
     * @param {(key: string, params?: object) => string} t - namespace translator.
     * @param {string} text - `[code] detail` text from the command result.
     * @returns {string} localized message.
     */
    function localizeError(t, text) {
      const raw = typeof text === 'string' ? text : ''
      const match = /^\[([a-z0-9-]+)\]\s*([\s\S]*)$/.exec(raw)
      if (match === null) return raw === '' ? t('error.failed', { detail: '' }) : raw
      const code = match[1]
      if (!ERROR_CODES.has(code)) return match[2] === '' ? raw : match[2]
      return t(`error.${code}`, { detail: match[2] })
    }

    /** Friendly labels for the injected-context source kinds a user meets most. */
    const CONTEXT_KIND_KEYS = {
      'time-context': 'context.timeContext',
      'runtime-context': 'context.runtimeContext',
      'model-selection': 'context.modelSelection',
      'working-directory': 'context.workingDirectory',
      'plan-mode': 'context.planMode',
      'user-approval': 'context.userApproval',
      'session-reference': 'context.sessionReference',
      'skill-invocation': 'context.skillInvocation',
      'agent-instructions': 'context.agentInstructions',
      'tool-registry': 'context.toolRegistry',
      goal: 'context.goal',
      schedule: 'context.schedule',
      'compact-checkpoint': 'context.compactionCheckpoint'
    }

    /**
     * Localized label for one injected-context source kind.
     * @param {(key: string) => string} t - namespace translator.
     * @param {unknown} kind - recorded message source kind.
     * @returns {string} friendly label, or the raw kind.
     */
    function contextKindLabel(t, kind) {
      if (typeof kind !== 'string' || kind === '') return ''
      const key = CONTEXT_KIND_KEYS[kind]
      return key === undefined ? kind : t(key)
    }

    //#endregion

    //#region locale dictionaries

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'view.title': '历史',
      'view.hint': '这是模型当前可见的历史（压缩等替换已合并），修改会立即改变模型上下文；Chat 页签保留追加式聊天记录，不会随之改写。',
      'view.loadEarlier': '加载更早历史',
      'mode.off': '分支改写：关',
      'mode.on': '分支改写：开',
      'mode.hint': '开启后所有消息都可修改/删除/在任意位置插入；点“应用改写”会生成新分支会话',
      'mode.draftHint': '分支改写模式：所有消息都可修改、删除，也可在任意位置插入；改动先进入草稿，点“应用改写”生成新分支。',
      'draft.count': '{count} 项未应用的改动',
      'draft.apply': '应用改写（新建分支）',
      'draft.applying': '正在生成分支…',
      'draft.discard': '放弃改动',
      'action.insertAfter': '在下方插入',
      'action.insertTop': '在开头插入',
      'action.removeInsert': '移除插入',
      'action.undoDelete': '撤销删除',
      'action.undoEdit': '撤销修改',
      'insert.title': '插入消息',
      'insert.placeholder': '输入要插入的消息内容',
      'insert.submit': '插入到此处',
      'add.toDraft': '加入草稿（末尾）',
      'add.draftHint': '加入草稿末尾；要插到中间请用每行的“在下方插入”。',
      'edit.draftHint': '草稿修改：点“应用改写”后才会生效。',
      'meta.inserted': '待插入',
      'meta.edited': '已修改',
      'meta.deleted': '待删除',
      'notice.rewritten': '已生成改写分支，正在打开…',
      'error.too-large': '改动内容过大，请分批应用',
      'error.no-source': '找不到源会话日志，请重新打开会话后再试',
      'view.loadingEarlier': '正在加载…',
      'role.user': '用户',
      'role.assistant': '助手',
      'role.tool': '工具结果',
      'role.context': '上下文',
      'role.system': '系统提示',
      'add.title': '新增消息',
      'add.placeholder': '输入要加入历史的消息内容',
      'add.submit': '添加到历史',
      'add.userHint': '作为用户消息追加到历史末尾，模型下一步会看到它。',
      'add.assistantHint': '作为助手消息追加到末尾，可用于预填模型回答。',
      'empty': '当前历史为空',
      'empty.hint': '在下方新增一条消息，或直接在对话中聊天。',
      'action.edit': '修改',
      'action.delete': '删除',
      'action.save': '保存',
      'action.cancel': '取消',
      'action.resetSystem': '恢复默认',
      'action.confirmReset': '确认恢复默认',
      'action.confirmDelete': '确认删除',
      'action.expand': '展开',
      'action.collapse': '收起',
      'context.timeContext': '时间上下文',
      'context.runtimeContext': '运行时上下文',
      'context.modelSelection': '模型选择',
      'context.workingDirectory': '工作目录',
      'context.planMode': '计划模式',
      'context.userApproval': '用户审批',
      'context.sessionReference': '会话引用',
      'context.skillInvocation': '技能调用',
      'context.agentInstructions': '代理指令',
      'context.toolRegistry': '工具变更',
      'context.goal': '目标',
      'context.schedule': '计划任务',
      'context.compactionCheckpoint': '压缩摘要',
      'edit.title': '修改消息',
      'edit.assistantHint': '助手消息按追加语义重写：内容会替换最后一条助手消息的上下文。',
      'edit.pending': '正在应用…',
      'notice.saved': '已更新模型上下文',
      'notice.systemSaved': '已更新系统提示词，将在下一次请求生效',
      'notice.systemReset': '已恢复默认系统提示词，将在下一次请求生效',
      'notice.deleted': '已从模型上下文中删除',
      'notice.deletedRuntime': '已从当前历史移除；运行时上下文会在下一步重新注入',
      'notice.deletedTime': '已从当前历史移除；时间上下文会在下一次到期时重新注入',
      'notice.added': '已加入历史',
      'notice.running': '当前回复进行中，本轮结束后才能修改历史。',
      'meta.toolCalls': '{count} 个工具调用',
      'meta.source': '来源：{kind}',
      'meta.runtimeRegenerated': '每步重新注入',
      'meta.timeRegenerated': '按间隔重新注入',
      'meta.systemPrompt': '提示词组装',
      'meta.systemOverride': '自定义提示词（覆盖组装）',
      'edit.contextHint': '这是系统注入的上下文；修改只在当前历史生效，下一步可能会被重新生成。',
      'edit.systemHint': '系统提示词是提示词组装结果；修改后会覆盖组装内容（人设、技能说明等）并一直生效，直到点“恢复默认”。',
      'meta.placeholder': '（无文本内容）',
      'error.transport': '连接失败：{detail}（{code}）',
      'error.command-unavailable': '历史命令不可用，请确认插件已启用并重启会话',
      'error.failed': '操作失败：{detail}',
      'error.bad-request': '请求参数无效，请重试',
      'error.busy': '当前回复进行中，请等本轮结束后再试',
      'error.no-session': '找不到活动会话，请重新打开该会话',
      'error.not-found': '该消息已不在当前历史中，请刷新后重试',
      'error.not-editable': '该消息不支持修改',
      'error.no-override': '当前没有可恢复的自定义系统提示词',
      'error.not-deletable': '上下文注入记录不能单独删除',
      'error.context-message': '上下文注入消息不能修改，可以删除',
      'error.system-prompt': '系统提示不能在这里操作',
      'error.assistant-not-last': '只能修改最后一条助手消息；其他助手消息请删除后新增',
      'error.paired': '该消息与工具调用配对，无法单独删除',
      'error.empty': '内容不能为空',
      'error.too-long': '内容过长，请精简后再保存',
      'error.internal': '内部错误：{detail}',
      'filter.label': '按角色筛选',
      'filter.all': '全部',
      'filter.user': '用户',
      'filter.assistant': '助手',
      'filter.tool': '工具',
      'filter.context': '上下文',
      'search.placeholder': '搜索历史内容',
      'turn.label': '第 {turn} 轮',
      'turn.start': '会话开始',
      'turn.count': '{count} 条',
      'meta.turnStep': '第 {turn} 轮 · 第 {step} 步',
      'emptyFiltered': '没有匹配的消息',
      'emptyFiltered.hint': '调整筛选条件或搜索关键字。'
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'view.title': 'History',
      'view.hint': 'The history the model currently sees (compaction and other replacements applied). Edits change the model context immediately; the Chat tab keeps its append-only transcript and is not rewritten.',
      'view.loadEarlier': 'Load earlier history',
      'mode.off': 'Branch rewrite: off',
      'mode.on': 'Branch rewrite: on',
      'mode.hint': 'When on, every message can be edited, deleted, or inserted anywhere; Apply forks a new branch session',
      'mode.draftHint': 'Branch rewrite mode: every message is editable and insertable anywhere. Changes stay in a draft until Apply forks a new branch.',
      'draft.count': '{count} unapplied changes',
      'draft.apply': 'Apply rewrite (new branch)',
      'draft.applying': 'Creating branch…',
      'draft.discard': 'Discard changes',
      'action.insertAfter': 'Insert below',
      'action.insertTop': 'Insert at top',
      'action.removeInsert': 'Remove insertion',
      'action.undoDelete': 'Undo delete',
      'action.undoEdit': 'Undo edit',
      'insert.title': 'Insert a message',
      'insert.placeholder': 'Message text to insert here',
      'insert.submit': 'Insert here',
      'add.toDraft': 'Add to draft (end)',
      'add.draftHint': 'Adds to the end of the draft; use a row’s “Insert below” to place it mid-history.',
      'edit.draftHint': 'Draft edit: it takes effect when you apply the rewrite.',
      'meta.inserted': 'pending insert',
      'meta.edited': 'edited',
      'meta.deleted': 'pending delete',
      'notice.rewritten': 'Rewrite branch created; opening it…',
      'error.too-large': 'The changes are too large; apply them in smaller batches',
      'error.no-source': 'The source session log is unavailable; reopen the session and retry',
      'view.loadingEarlier': 'Loading…',
      'role.user': 'User',
      'role.assistant': 'Assistant',
      'role.tool': 'Tool result',
      'role.context': 'Context',
      'role.system': 'System prompt',
      'add.title': 'Add a message',
      'add.placeholder': 'Message text to add to the history',
      'add.submit': 'Add to history',
      'add.userHint': 'Appends a user message to the end of the history; the model sees it on its next step.',
      'add.assistantHint': 'Appends an assistant message to the end of the history; useful to prefill a reply.',
      'empty': 'The history is empty',
      'empty.hint': 'Add a message below, or start chatting in the conversation.',
      'action.edit': 'Edit',
      'action.delete': 'Delete',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.resetSystem': 'Restore default',
      'action.confirmReset': 'Confirm restore',
      'action.confirmDelete': 'Confirm delete',
      'action.expand': 'Expand',
      'action.collapse': 'Collapse',
      'context.timeContext': 'Time context',
      'context.runtimeContext': 'Runtime context',
      'context.modelSelection': 'Model selection',
      'context.workingDirectory': 'Working directory',
      'context.planMode': 'Plan mode',
      'context.userApproval': 'User approval',
      'context.sessionReference': 'Session reference',
      'context.skillInvocation': 'Skill invocation',
      'context.agentInstructions': 'Agent instructions',
      'context.toolRegistry': 'Tool changes',
      'context.goal': 'Goal',
      'context.schedule': 'Scheduled task',
      'context.compactionCheckpoint': 'Compaction summary',
      'edit.title': 'Edit message',
      'edit.assistantHint': 'Assistant messages rewrite by append: the content replaces the last assistant message in the model context.',
      'edit.pending': 'Applying…',
      'notice.saved': 'Model context updated',
      'notice.systemSaved': 'System prompt updated; it applies on the next request',
      'notice.systemReset': 'Default system prompt restored; it applies on the next request',
      'notice.deleted': 'Removed from the model context',
      'notice.deletedRuntime': 'Removed from the current history; the runtime context is re-injected on the next step',
      'notice.deletedTime': 'Removed from the current history; the time context is re-injected when its interval is due',
      'notice.added': 'Added to the history',
      'notice.running': 'A reply is running; history editing is available when this turn finishes.',
      'meta.toolCalls': '{count} tool calls',
      'meta.source': 'source: {kind}',
      'meta.runtimeRegenerated': 're-injected each step',
      'meta.timeRegenerated': 're-injected on its interval',
      'meta.systemPrompt': 'prompt assembly',
      'meta.systemOverride': 'custom prompt (overrides assembly)',
      'edit.contextHint': 'This is system-injected context; the edit applies to the current history and may be regenerated on the next step.',
      'edit.systemHint': 'The system prompt is the rendered assembly; an edit overrides the assembled content (persona, skill guidance, ...) and stays in effect until you restore the default.',
      'meta.placeholder': '(no text content)',
      'error.transport': 'Connection failed: {detail} ({code})',
      'error.command-unavailable': 'The history command is unavailable; check that the plugin is enabled and reopen the session',
      'error.failed': 'Operation failed: {detail}',
      'error.bad-request': 'The request was invalid; try again',
      'error.busy': 'A reply is running; try again when this turn finishes',
      'error.no-session': 'The live session is unavailable; reopen the session',
      'error.not-found': 'That message is no longer in the current history; refresh and retry',
      'error.not-editable': 'That message cannot be edited',
      'error.no-override': 'There is no custom system prompt to restore',
      'error.not-deletable': 'Context injection records cannot be removed individually',
      'error.context-message': 'Injected context messages cannot be edited; delete them instead',
      'error.system-prompt': 'The system prompt cannot be changed here',
      'error.assistant-not-last': 'Only the last assistant message can be rewritten; delete and add for other assistant messages',
      'error.paired': 'That message is paired with a tool call and cannot be removed alone',
      'error.empty': 'The content must not be blank',
      'error.too-long': 'The content is too long; shorten it and save again',
      'error.internal': 'Internal error: {detail}',
      'filter.label': 'Filter by role',
      'filter.all': 'All',
      'filter.user': 'User',
      'filter.assistant': 'Assistant',
      'filter.tool': 'Tool',
      'filter.context': 'Context',
      'search.placeholder': 'Search history',
      'turn.label': 'Turn {turn}',
      'turn.start': 'Session start',
      'turn.count': '{count} rows',
      'meta.turnStep': 'Turn {turn} · Step {step}',
      'emptyFiltered': 'No matching messages',
      'emptyFiltered.hint': 'Adjust the filter or search query.'
    }

    //#endregion

    //#region styles

    const css = [
      '.che-root{box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.che-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 16px 6px}',
      '.che-filters{display:inline-flex;gap:4px;flex-wrap:wrap}',
      '.che-filter{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:3px 9px;border-radius:999px;cursor:pointer}',
      '.che-filter:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.che-filter[data-active="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.che-filterCount{font-size:11px;opacity:.72;font-variant-numeric:tabular-nums}',
      '.che-search{flex:1;min-width:150px;margin-left:auto;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:4px 9px;outline:none}',
      '.che-search:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.che-hint{padding:0 16px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.che-noticeBar{padding:5px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1)}',
      '.che-noticeBar[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.che-noticeBar[data-kind="success"]{color:var(--dsw-alias-state-success-primary)}',
      '.che-add{display:flex;flex-direction:column;gap:6px;padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.che-addRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.che-addTitle{font-size:12px;font-weight:600;line-height:18px;flex:none}',
      '.che-addHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);flex:1;min-width:120px}',
      '.che-roles{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);flex:none}',
      '.che-role{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:3px 10px;border-radius:7px;cursor:pointer}',
      '.che-role[data-active="true"]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.che-textarea{box-sizing:border-box;width:100%;resize:vertical;min-height:44px;max-height:200px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none}',
      '.che-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.che-primary{border:0;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;line-height:18px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);cursor:pointer;white-space:nowrap;flex:none}',
      '.che-primary:disabled{opacity:.5;cursor:default}',
      '.che-button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;padding:4px 10px;border-radius:8px;cursor:pointer;flex:none}',
      '.che-button:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.che-button:disabled{opacity:.55;cursor:default}',
      '.che-list{flex:1;min-height:0;overflow-y:auto;padding:6px 16px calc(var(--dsh-composer-height,152px) + 16px);display:flex;flex-direction:column;gap:10px}',
      '.che-empty{margin:28px auto 0;max-width:440px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.che-turn{display:flex;flex-direction:column;gap:2px}',
      '.che-turnHead{display:flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:4px 2px;cursor:pointer;text-align:left}',
      '.che-turnHead:hover .che-turnTitle{color:var(--dsw-alias-label-primary)}',
      '.che-caret{width:12px;font-size:10px;color:var(--dsw-alias-label-secondary);flex:none}',
      '.che-turnTitle{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.che-turnMeta,.che-turnTime{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.che-turnTime{margin-left:auto}',
      '.che-turnBody{border-left:1px solid var(--dsw-alias-border-l1);margin-left:6px;padding-left:12px;display:flex;flex-direction:column;gap:2px}',
      '.che-record{display:flex;flex-direction:column;border-radius:8px;min-width:0}',
      '.che-record:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.che-record[data-editing="true"]:hover{background:transparent}',
      '.che-recordHead{display:flex;align-items:center;gap:8px;padding:4px 6px;min-height:26px;min-width:0}',
      '.che-dot{width:6px;height:6px;border-radius:999px;flex:none;background:var(--dsw-alias-label-secondary)}',
      '.che-dot[data-role="user"]{background:var(--dsw-alias-brand-primary)}',
      '.che-dot[data-role="assistant"]{background:var(--dsw-alias-state-success-primary)}',
      '.che-dot[data-role="tool"]{background:var(--dsw-alias-border-l2)}',
      '.che-dot[data-role="context"]{background:var(--dsw-alias-state-warn-primary)}',
      '.che-dot[data-role="system"]{background:var(--dsw-alias-state-idle-primary)}',
      '.che-roleTag{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);flex:none}',
      '.che-roleTag[data-role="user"]{border-color:var(--dsw-alias-brand-primary)}',
      '.che-roleTag[data-role="assistant"]{border-color:var(--dsw-alias-state-success-primary)}',
      '.che-seq{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none}',
      '.che-clock{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none}',
      '.che-snippet{flex:1;min-width:0;border:0;background:transparent;text-align:left;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.che-snippet:hover{color:var(--dsw-alias-label-primary)}',
      '.che-record[data-role="context"] .che-snippet,.che-record[data-role="system"] .che-snippet{color:var(--dsw-alias-label-secondary)}',
      '.che-actions{display:flex;align-items:center;gap:2px;flex:none}',
      '.che-link{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:2px 6px;border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.che-link:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.che-link[data-danger="true"]{color:var(--dsw-alias-state-error-primary)}',
      '.che-link:disabled{opacity:.5;cursor:default}',
      '.che-recordBody{padding:2px 6px 8px 20px;display:flex;flex-direction:column;gap:4px}',
      '.che-recordText{font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px;max-height:320px;overflow:auto}',
      '.che-recordMeta{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.che-edit{padding:4px 6px 8px 20px;display:flex;flex-direction:column;gap:6px}',
      '.che-editActions{display:flex;justify-content:flex-end;gap:8px}',
      '.che-editHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.che-mode{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:3px 10px;border-radius:999px;cursor:pointer;white-space:nowrap}',
      '.che-mode[data-active="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.che-draftBar{display:flex;align-items:center;gap:10px;padding:6px 16px;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.che-draftInfo{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.che-insertForm{display:flex;flex-direction:column;gap:6px;margin:4px 0 4px 20px;padding:8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.che-record[data-deleted="true"]{opacity:.55}',
      '.che-record[data-deleted="true"] .che-snippet{text-decoration:line-through}',
      '.che-record[data-inserted="true"]{border:1px dashed var(--dsw-alias-brand-primary)}',
      '.che-record[data-edited="true"] .che-snippet{color:var(--dsw-alias-brand-primary)}',
      '.che-recordText[data-deleted="true"]{text-decoration:line-through;color:var(--dsw-alias-label-secondary)}'
    ].join('')

    /** Install the plugin stylesheet once for this page. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`)
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-chat-history-editor'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = css
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    //#endregion

    //#region history source

    /**
     * Derive a stable snapshot source for one session event window.
     * @param {{ getSnapshot: () => object, subscribe: (listener: () => void) => () => void }} eventSource - session event window source.
     * @returns {{ getSnapshot: () => { rows: object[], hasMore: boolean }, subscribe: (listener: () => void) => () => void }}
     */
    function createHistorySource(eventSource) {
      let cachedWindow
      let cachedValue = { rows: [], hasMore: false }
      const getSnapshot = () => {
        const window = eventSource.getSnapshot()
        if (window !== cachedWindow) {
          cachedWindow = window
          cachedValue = { rows: buildHistoryRows(window.entries ?? []), hasMore: window.hasMore === true }
        }
        return cachedValue
      }
      return { getSnapshot, subscribe: (listener) => eventSource.subscribe(listener) }
    }

    //#endregion

    //#region view

    /**
     * Read one observable source with React's external-store hook.
     * @param {{ getSnapshot: () => object, subscribe: (listener: () => void) => () => void }} source - observable snapshot.
     * @returns {object} current snapshot.
     */
    function useSnapshot(source) {
      return React.useSyncExternalStore(source.subscribe, source.getSnapshot)
    }

    /** Role filters offered by the ledger toolbar. */
    const ROLE_FILTERS = ['all', 'user', 'assistant', 'tool', 'context']

    /** localStorage key for the rewrite-mode preference. */
    const FORK_MODE_KEY = 'chat-history-editor/fork-mode'

    /** @returns {boolean} the persisted rewrite-mode preference. */
    function readForkMode() {
      try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(FORK_MODE_KEY) === 'on'
      } catch {
        return false
      }
    }

    /** @param {boolean} value - whether rewrite mode is on. */
    function writeForkMode(value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(FORK_MODE_KEY, value ? 'on' : 'off')
      } catch {
        // A browser that refuses storage keeps the in-memory preference only.
      }
    }

    /**
     * Replace the text blocks of one row with one edited text block, preserving
     * every non-text block (images, files, tool calls, ...).
     * @param {object[] | undefined} blocks - original content blocks.
     * @param {string} text - replacement text.
     * @returns {object[]} next content blocks.
     */
    function editedBlocks(blocks, text) {
      const kept = (blocks ?? []).filter((block) => block !== null && typeof block === 'object' && block.type !== 'text')
      return [{ type: 'text', text }, ...kept]
    }

    /**
     * Merge draft edits, deletions, and insertions over the current rows.
     * Insertions anchor after one row sequence, at the top, or at the end.
     * @param {object[]} rows - current display rows.
     * @param {Map<number, string>} edits - draft text by row sequence.
     * @param {Set<number>} deleted - draft deletions by row sequence.
     * @param {Array<{ id: string, afterSeq: number | 'top' | 'end', role: string, text: string }>} inserts - draft insertions.
     * @returns {object[]} rows to render and apply.
     */
    function mergeDraftRows(rows, edits, deleted, inserts) {
      if (rows.length === 0) return []
      const first = rows[0]
      const last = rows[rows.length - 1]
      const place = (insert) => {
        const anchor =
          insert.afterSeq === 'top'
            ? first
            : insert.afterSeq === 'end'
              ? last
              : rows.find((row) => row.seq === insert.afterSeq) ?? last
        return {
          seq: `insert:${insert.id}`,
          insertId: insert.id,
          role: insert.role,
          text: insert.text,
          toolCalls: 0,
          turn: anchor.turn ?? 1,
          step: anchor.step ?? 1
        }
      }
      const byAnchor = new Map()
      for (const insert of inserts) {
        const list = byAnchor.get(insert.afterSeq) ?? []
        list.push(insert)
        byAnchor.set(insert.afterSeq, list)
      }
      const out = []
      for (const insert of byAnchor.get('top') ?? []) out.push(place(insert))
      for (const row of rows) {
        out.push({
          ...row,
          draftEdited: edits.has(row.seq),
          draftText: edits.get(row.seq),
          draftDeleted: deleted.has(row.seq)
        })
        for (const insert of byAnchor.get(row.seq) ?? []) out.push(place(insert))
      }
      for (const insert of byAnchor.get('end') ?? []) out.push(place(insert))
      return out
    }

    /**
     * Serialize merged draft rows into the Host rewrite payload.
     * @param {object[]} viewRows - merged draft rows.
     * @returns {object[]} serialized draft rows.
     */
    function buildDraftRowsPayload(viewRows) {
      const payload = []
      for (const row of viewRows) {
        if (row.draftDeleted === true) continue
        if (row.insertId !== undefined) {
          payload.push({
            role: row.role,
            content: [{ type: 'text', text: row.text }],
            position: { turn: row.turn, step: row.step },
            edited: true
          })
          continue
        }
        const edited = row.draftEdited === true
        payload.push({
          role: row.role,
          content: edited ? editedBlocks(row.blocks, row.draftText) : row.blocks,
          ...row.source === undefined ? {} : { source: row.source },
          ...row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId },
          ...row.isError === true ? { isError: true } : {},
          position: { turn: row.turn, step: row.step },
          ...edited ? { edited: true } : {}
        })
      }
      return payload
    }

    /**
     * The History tab: a Trajectory-style ledger over the model-visible
     * surface with inline edit, delete, and append actions. With rewrite mode
     * enabled, every row becomes a draft edit and "apply" writes the edited
     * conversation into a freshly forked branch session.
     * @param {object} props - slot props.
     * @returns {object} the rendered view.
     */
    function HistoryView(props) {
      const t = props.t
      const snapshot = useSnapshot(props.history)
      const rows = snapshot.rows
      const running = props.useSession((state) => state.running === true)
      const [editing, setEditing] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [confirmSeq, setConfirmSeq] = React.useState(null)
      const [confirmReset, setConfirmReset] = React.useState(false)
      const [addRole, setAddRole] = React.useState('user')
      const [addText, setAddText] = React.useState('')
      const [pending, setPending] = React.useState(false)
      const [loadingOlder, setLoadingOlder] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [expanded, setExpanded] = React.useState(() => new Set())
      const [collapsedTurns, setCollapsedTurns] = React.useState(() => new Set())
      const [roleFilter, setRoleFilter] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [forkMode, setForkMode] = React.useState(() => readForkMode())
      const [draftEdits, setDraftEdits] = React.useState(() => new Map())
      const [draftDeleted, setDraftDeleted] = React.useState(() => new Set())
      const [draftInserts, setDraftInserts] = React.useState([])
      const [insertTarget, setInsertTarget] = React.useState(null)
      const [applying, setApplying] = React.useState(false)
      const listRef = React.useRef(null)
      const scrolledRef = React.useRef(false)
      const insertSeqRef = React.useRef(0)
      const busy = running || pending || applying
      const dirtyCount = draftEdits.size + draftDeleted.size + draftInserts.length

      React.useEffect(() => {
        if (scrolledRef.current || rows.length === 0) return
        scrolledRef.current = true
        const node = listRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [rows])

      const viewRows = React.useMemo(
        () => (forkMode ? mergeDraftRows(rows, draftEdits, draftDeleted, draftInserts) : rows),
        [forkMode, rows, draftEdits, draftDeleted, draftInserts]
      )

      const indexBySeq = React.useMemo(() => {
        const index = new Map()
        rows.forEach((row, position) => index.set(row.seq, position))
        return index
      }, [rows])

      const counts = React.useMemo(() => {
        const next = { all: viewRows.length, user: 0, assistant: 0, tool: 0, context: 0, system: 0 }
        for (const row of viewRows) next[row.role] = (next[row.role] ?? 0) + 1
        return next
      }, [viewRows])

      const visibleRows = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        return viewRows.filter((row) => {
          if (roleFilter !== 'all' && row.role !== roleFilter) return false
          if (needle === '') return true
          const text = row.draftText ?? row.text
          return text.toLowerCase().includes(needle)
        })
      }, [viewRows, roleFilter, query])

      const groups = React.useMemo(() => groupByTurn(visibleRows), [visibleRows])

      const toggleExpanded = (seq) => {
        setExpanded((current) => {
          const next = new Set(current)
          if (next.has(seq)) next.delete(seq)
          else next.add(seq)
          return next
        })
      }

      const toggleTurn = (turn) => {
        setCollapsedTurns((current) => {
          const next = new Set(current)
          if (next.has(turn)) next.delete(turn)
          else next.add(turn)
          return next
        })
      }

      const scrollToTail = () => {
        const node = listRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }

      const discardDraft = () => {
        setDraftEdits(new Map())
        setDraftDeleted(new Set())
        setDraftInserts([])
        setInsertTarget(null)
        setEditing(null)
      }

      const toggleForkMode = () => {
        if (busy) return
        const next = !forkMode
        setForkMode(next)
        writeForkMode(next)
        discardDraft()
        setNotice(null)
      }

      const apply = async (payload, successKey) => {
        if (busy) return false
        setPending(true)
        setNotice(null)
        try {
          const result = await props.execute(payload)
          if (!result.ok) {
            setNotice({ kind: 'error', text: result.message })
            return false
          }
          setNotice({ kind: 'success', text: t(successKey) })
          return true
        } catch (error) {
          setNotice({ kind: 'error', text: localizeError(t, error instanceof Error ? `[internal] ${error.message}` : '[internal] unknown failure') })
          return false
        } finally {
          setPending(false)
        }
      }

      const beginEdit = (row) => {
        setConfirmSeq(null)
        setEditing({ seq: row.seq })
        setDraft(row.draftText ?? row.text)
      }

      const saveEdit = async () => {
        if (editing === null) return
        if (forkMode) {
          setDraftEdits((current) => {
            const next = new Map(current)
            next.set(editing.seq, draft)
            return next
          })
          setEditing(null)
          return
        }
        const saved = await apply({ op: 'edit', seq: editing.seq, text: draft }, 'notice.saved')
        if (saved) setEditing(null)
      }

      const deleteRow = async (row) => {
        setConfirmSeq(null)
        const noticeKey =
          row.sourceKind === 'runtime-context'
            ? 'notice.deletedRuntime'
            : row.sourceKind === 'time-context'
              ? 'notice.deletedTime'
              : 'notice.deleted'
        await apply({ op: 'delete', seqs: [row.seq] }, noticeKey)
      }

      const resetSystemPrompt = async () => {
        setConfirmReset(false)
        await apply({ op: 'reset-system' }, 'notice.systemReset')
      }

      const markDraftDeleted = (seq) => {
        setDraftDeleted((current) => {
          const next = new Set(current)
          next.add(seq)
          return next
        })
        setDraftEdits((current) => {
          if (!current.has(seq)) return current
          const next = new Map(current)
          next.delete(seq)
          return next
        })
        setEditing(null)
      }

      const undoDraftDeleted = (seq) => {
        setDraftDeleted((current) => {
          const next = new Set(current)
          next.delete(seq)
          return next
        })
      }

      const undoDraftEdit = (seq) => {
        setDraftEdits((current) => {
          if (!current.has(seq)) return current
          const next = new Map(current)
          next.delete(seq)
          return next
        })
      }

      const commitInsert = () => {
        if (insertTarget === null || insertTarget.text.trim() === '') return
        insertSeqRef.current += 1
        setDraftInserts((current) => [
          ...current,
          { id: String(insertSeqRef.current), afterSeq: insertTarget.afterSeq, role: insertTarget.role, text: insertTarget.text }
        ])
        setInsertTarget(null)
      }

      const removeInsert = (id) => {
        setDraftInserts((current) => current.filter((insert) => insert.id !== id))
      }

      const applyRewrite = async () => {
        if (busy || dirtyCount === 0) return
        const draftRows = buildDraftRowsPayload(viewRows)
        setApplying(true)
        setNotice(null)
        let childId
        try {
          childId = await props.forkSession(0)
          const result = await props.execute(
            { op: 'rebuild', sourceSessionId: props.sessionId, draft: { rows: draftRows } },
            childId
          )
          if (!result.ok) {
            try {
              await props.archiveSession(childId)
            } catch {
              // Best-effort cleanup of the unusable child.
            }
            setNotice({ kind: 'error', text: result.message })
            return
          }
          discardDraft()
          setNotice({ kind: 'success', text: t('notice.rewritten') })
          props.openSession(childId)
        } catch (error) {
          if (childId !== undefined) {
            try {
              await props.archiveSession(childId)
            } catch {
              // Best-effort cleanup of the unusable child.
            }
          }
          setNotice({ kind: 'error', text: localizeError(t, error instanceof Error ? `[internal] ${error.message}` : '[internal] unknown failure') })
        } finally {
          setApplying(false)
        }
      }

      const submitAdd = async (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        if (addText.trim() === '' || busy) return
        if (forkMode) {
          insertSeqRef.current += 1
          setDraftInserts((current) => [...current, { id: String(insertSeqRef.current), afterSeq: 'end', role: addRole, text: addText }])
          setAddText('')
          return
        }
        const added = await apply({ op: 'append', role: addRole, text: addText }, 'notice.added')
        if (added) {
          setAddText('')
          scrollToTail()
        }
      }

      const loadEarlier = async () => {
        if (loadingOlder) return
        setLoadingOlder(true)
        setNotice(null)
        try {
          await props.loadOlder()
        } catch {
          setNotice({ kind: 'error', text: t('error.failed', { detail: '' }) })
        } finally {
          setLoadingOlder(false)
        }
      }

      const onEditKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          setEditing(null)
          return
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          saveEdit()
        }
      }

      const onAddKeyDown = (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          submitAdd()
        }
      }

      const renderInsertForm = (afterSeq) => {
        if (insertTarget === null || insertTarget.afterSeq !== afterSeq) return null
        return h(
          'div',
          { className: 'che-insertForm' },
          h(
            'div',
            { className: 'che-addRow' },
            h('span', { className: 'che-addTitle' }, t('insert.title')),
            h(
              'span',
              { className: 'che-roles' },
              h(
                'button',
                { type: 'button', className: 'che-role', 'data-active': insertTarget.role === 'user' ? 'true' : 'false', onClick: () => setInsertTarget({ ...insertTarget, role: 'user' }) },
                t('role.user')
              ),
              h(
                'button',
                { type: 'button', className: 'che-role', 'data-active': insertTarget.role === 'assistant' ? 'true' : 'false', onClick: () => setInsertTarget({ ...insertTarget, role: 'assistant' }) },
                t('role.assistant')
              )
            )
          ),
          h('textarea', {
            className: 'che-textarea',
            rows: 2,
            value: insertTarget.text,
            placeholder: t('insert.placeholder'),
            onChange: (event) => setInsertTarget({ ...insertTarget, text: event.target.value })
          }),
          h(
            'div',
            { className: 'che-editActions' },
            h('button', { type: 'button', className: 'che-button', onClick: () => setInsertTarget(null) }, t('action.cancel')),
            h('button', { type: 'button', className: 'che-primary', disabled: insertTarget.text.trim() === '', onClick: commitInsert }, t('insert.submit'))
          )
        )
      }

      const renderRecord = (row) => {
        const isInserted = row.insertId !== undefined
        const isDraftDeleted = row.draftDeleted === true
        const isDraftEdited = row.draftEdited === true
        const isEditing = editing !== null && editing.seq === row.seq
        const rowIndex = indexBySeq.get(row.seq) ?? -1
        const editable = isInserted ? false : forkMode ? true : canEditRow(row, rowIndex, rows)
        const deletable = isInserted ? false : canDeleteRow(row)
        const armed = confirmSeq === row.seq
        const isExpanded = expanded.has(row.seq)
        const clock = formatClock(row.time)
        const shownText = isDraftDeleted ? row.text : isDraftEdited ? row.draftText : row.text === '' ? t('meta.placeholder') : row.text
        const meta = []
        if (isInserted) meta.push(t('meta.inserted'))
        if (isDraftEdited) meta.push(t('meta.edited'))
        if (isDraftDeleted) meta.push(t('meta.deleted'))
        if (row.turn > 0) meta.push(t('meta.turnStep', { turn: row.turn, step: row.step }))
        if (row.role === 'assistant' && row.toolCalls > 0) meta.push(t('meta.toolCalls', { count: row.toolCalls }))
        if (row.role === 'context' && typeof row.sourceKind === 'string') {
          meta.push(t('meta.source', { kind: contextKindLabel(t, row.sourceKind) }))
          if (row.sourceKind === 'runtime-context') meta.push(t('meta.runtimeRegenerated'))
          if (row.sourceKind === 'time-context') meta.push(t('meta.timeRegenerated'))
        }
        if (row.role === 'system') meta.push(row.override === true ? t('meta.systemOverride') : t('meta.systemPrompt'))

        const actions = []
        if (forkMode) {
          if (isInserted) {
            actions.push(h('button', { key: 'remove', type: 'button', className: 'che-link', 'data-danger': 'true', onClick: () => removeInsert(row.insertId) }, t('action.removeInsert')))
          } else if (isDraftDeleted) {
            actions.push(h('button', { key: 'undo', type: 'button', className: 'che-link', onClick: () => undoDraftDeleted(row.seq) }, t('action.undoDelete')))
          } else {
            if (!isEditing) {
              actions.push(h('button', { key: 'edit', type: 'button', className: 'che-link', disabled: busy, onClick: () => beginEdit(row) }, t('action.edit')))
            }
            if (isDraftEdited) {
              actions.push(h('button', { key: 'undo-edit', type: 'button', className: 'che-link', onClick: () => undoDraftEdit(row.seq) }, t('action.undoEdit')))
            }
            actions.push(h('button', { key: 'delete', type: 'button', className: 'che-link', 'data-danger': 'true', onClick: () => markDraftDeleted(row.seq) }, t('action.delete')))
            actions.push(
              h(
                'button',
                { key: 'insert', type: 'button', className: 'che-link', onClick: () => setInsertTarget({ afterSeq: row.seq, role: 'user', text: '' }) },
                t('action.insertAfter')
              )
            )
          }
        } else {
          if (row.role === 'system' && row.override === true && !isEditing) {
            actions.push(
              confirmReset
                ? h(
                    React.Fragment,
                    { key: 'reset-confirm' },
                    h('button', { type: 'button', className: 'che-link', 'data-danger': 'true', disabled: busy, onClick: resetSystemPrompt }, t('action.confirmReset')),
                    h('button', { type: 'button', className: 'che-link', onClick: () => setConfirmReset(false) }, t('action.cancel'))
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'che-link',
                      disabled: busy,
                      onClick: () => {
                        setConfirmSeq(null)
                        setConfirmReset(true)
                      }
                    },
                    t('action.resetSystem')
                  )
            )
          }
          if (editable && !isEditing) {
            actions.push(h('button', { type: 'button', className: 'che-link', disabled: busy, onClick: () => beginEdit(row) }, t('action.edit')))
          }
          if (deletable) {
            actions.push(
              armed
                ? h(
                    React.Fragment,
                    { key: 'delete-confirm' },
                    h('button', { type: 'button', className: 'che-link', 'data-danger': 'true', onClick: () => deleteRow(row) }, t('action.confirmDelete')),
                    h('button', { type: 'button', className: 'che-link', onClick: () => setConfirmSeq(null) }, t('action.cancel'))
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'che-link',
                      'data-danger': 'true',
                      disabled: busy,
                      onClick: () => {
                        setEditing(null)
                        setConfirmSeq(row.seq)
                      }
                    },
                    t('action.delete')
                  )
            )
          }
        }

        const body = isEditing
          ? h(
              'div',
              { className: 'che-edit' },
              h('textarea', {
                className: 'che-textarea',
                value: draft,
                rows: 4,
                disabled: pending,
                'aria-label': t('edit.title'),
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: onEditKeyDown
              }),
              row.role === 'assistant'
                ? h('div', { className: 'che-editHint' }, t('edit.assistantHint'))
                : row.role === 'context'
                  ? h('div', { className: 'che-editHint' }, t('edit.contextHint'))
                  : row.role === 'system'
                    ? h('div', { className: 'che-editHint' }, t('edit.systemHint'))
                    : null,
              forkMode ? h('div', { className: 'che-editHint' }, t('edit.draftHint')) : null,
              h(
                'div',
                { className: 'che-editActions' },
                h('button', { type: 'button', className: 'che-button', onClick: () => setEditing(null), disabled: pending }, t('action.cancel')),
                h(
                  'button',
                  { type: 'button', className: 'che-primary', disabled: pending || draft.trim() === '', onClick: saveEdit },
                  pending ? t('edit.pending') : t('action.save')
                )
              )
            )
          : isExpanded || isDraftDeleted
            ? h(
                'div',
                { className: 'che-recordBody' },
                h('div', { className: 'che-recordText', 'data-deleted': isDraftDeleted ? 'true' : 'false' }, shownText),
                meta.length > 0 ? h('div', { className: 'che-recordMeta' }, meta.map((entry, index) => h('span', { key: `${row.seq}-meta-${index}` }, entry))) : null
              )
            : null

        return h(
          'div',
          {
            className: 'che-record',
            'data-role': row.role,
            'data-editing': isEditing ? 'true' : 'false',
            'data-inserted': isInserted ? 'true' : 'false',
            'data-deleted': isDraftDeleted ? 'true' : 'false',
            'data-edited': isDraftEdited ? 'true' : 'false',
            key: row.seq,
            role: 'listitem'
          },
          h(
            'div',
            { className: 'che-recordHead' },
            h('span', { className: 'che-dot', 'data-role': row.role, 'aria-hidden': true }),
            h('span', { className: 'che-roleTag', 'data-role': row.role }, t(`role.${row.role}`)),
            isInserted ? null : h('span', { className: 'che-seq' }, `#${row.seq}`),
            clock === '' || isInserted ? null : h('span', { className: 'che-clock' }, clock),
            h(
              'button',
              { type: 'button', className: 'che-snippet', title: t(isExpanded ? 'action.collapse' : 'action.expand'), onClick: () => toggleExpanded(row.seq) },
              previewText(shownText, isExpanded ? 220 : 110)
            ),
            h('span', { className: 'che-actions' }, actions)
          ),
          body,
          renderInsertForm(row.seq)
        )
      }

      const renderTurn = (group) => {
        const collapsed = collapsedTurns.has(group.turn)
        const clock = formatClock(group.rows[0]?.time)
        return h(
          'section',
          { className: 'che-turn', key: `turn-${group.turn}` },
          h(
            'button',
            { type: 'button', className: 'che-turnHead', 'aria-expanded': collapsed ? 'false' : 'true', onClick: () => toggleTurn(group.turn) },
            h('span', { className: 'che-caret', 'data-collapsed': collapsed ? 'true' : 'false' }, collapsed ? '▸' : '▾'),
            h('span', { className: 'che-turnTitle' }, group.turn > 0 ? t('turn.label', { turn: group.turn }) : t('turn.start')),
            h('span', { className: 'che-turnMeta' }, t('turn.count', { count: group.rows.length })),
            clock === '' ? null : h('span', { className: 'che-turnTime' }, clock)
          ),
          collapsed ? null : h('div', { className: 'che-turnBody' }, group.rows.map(renderRecord))
        )
      }

      return h(
        'div',
        { className: 'che-root', 'data-conversation-composer-overlay': '' },
        h(
          'div',
          { className: 'che-bar' },
          h(
            'div',
            { className: 'che-filters', role: 'group', 'aria-label': t('filter.label') },
            ROLE_FILTERS.map((role) =>
              h(
                'button',
                {
                  key: role,
                  type: 'button',
                  className: 'che-filter',
                  'data-active': roleFilter === role ? 'true' : 'false',
                  onClick: () => setRoleFilter(role)
                },
                t(`filter.${role}`),
                h('span', { className: 'che-filterCount' }, String(role === 'all' ? counts.all : counts[role] ?? 0))
              )
            )
          ),
          h('input', {
            className: 'che-search',
            type: 'search',
            value: query,
            placeholder: t('search.placeholder'),
            'aria-label': t('search.placeholder'),
            onChange: (event) => setQuery(event.target.value)
          }),
          snapshot.hasMore
            ? h('button', { type: 'button', className: 'che-button', disabled: loadingOlder, onClick: loadEarlier }, loadingOlder ? t('view.loadingEarlier') : t('view.loadEarlier'))
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'che-mode',
              'data-active': forkMode ? 'true' : 'false',
              title: t('mode.hint'),
              disabled: busy,
              onClick: toggleForkMode
            },
            forkMode ? t('mode.on') : t('mode.off')
          ),
          forkMode
            ? h(
                'button',
                { type: 'button', className: 'che-button', disabled: busy, onClick: () => setInsertTarget({ afterSeq: 'top', role: 'user', text: '' }) },
                t('action.insertTop')
              )
            : null
        ),
        h('div', { className: 'che-hint' }, running ? t('notice.running') : forkMode ? t('mode.draftHint') : t('view.hint')),
        notice !== null ? h('div', { className: 'che-noticeBar', 'data-kind': notice.kind, role: 'status' }, notice.text) : null,
        forkMode && dirtyCount > 0
          ? h(
              'div',
              { className: 'che-draftBar' },
              h('span', { className: 'che-draftInfo' }, t('draft.count', { count: dirtyCount })),
              h('button', { type: 'button', className: 'che-button', disabled: applying, onClick: discardDraft }, t('draft.discard')),
              h('button', { type: 'button', className: 'che-primary', disabled: busy, onClick: applyRewrite }, applying ? t('draft.applying') : t('draft.apply'))
            )
          : null,
        h(
          'form',
          { className: 'che-add', onSubmit: submitAdd },
          h(
            'div',
            { className: 'che-addRow' },
            h('span', { className: 'che-addTitle' }, t('add.title')),
            h(
              'span',
              { className: 'che-roles' },
              h(
                'button',
                { type: 'button', className: 'che-role', 'data-active': addRole === 'user' ? 'true' : 'false', disabled: busy, onClick: () => setAddRole('user') },
                t('role.user')
              ),
              h(
                'button',
                { type: 'button', className: 'che-role', 'data-active': addRole === 'assistant' ? 'true' : 'false', disabled: busy, onClick: () => setAddRole('assistant') },
                t('role.assistant')
              )
            ),
            h('span', { className: 'che-addHint' }, forkMode ? t('add.draftHint') : addRole === 'user' ? t('add.userHint') : t('add.assistantHint')),
            h('button', { type: 'submit', className: 'che-primary', disabled: busy || addText.trim() === '' }, forkMode ? t('add.toDraft') : t('add.submit'))
          ),
          h('textarea', {
            className: 'che-textarea',
            value: addText,
            rows: 2,
            disabled: busy,
            placeholder: t('add.placeholder'),
            'aria-label': t('add.title'),
            onChange: (event) => setAddText(event.target.value),
            onKeyDown: onAddKeyDown
          })
        ),
        h(
          'div',
          { className: 'che-list', ref: listRef, role: 'list' },
          rows.length === 0
            ? h('div', { className: 'che-empty' }, h('div', null, t('empty')), h('div', null, t('empty.hint')))
            : h(
                React.Fragment,
                null,
                renderInsertForm('top'),
                visibleRows.length === 0
                  ? h('div', { className: 'che-empty' }, h('div', null, t('emptyFiltered')), h('div', null, t('emptyFiltered.hint')))
                  : groups.map(renderTurn)
              )
        )
      )
    }

    //#endregion

    //#region plugin

    /** Required client services: slots, session bindings, locale, and the fixed command Remote. */
    const inject = ['slots', 'remote', 'remote.commands', 'sessions', 'locale', 'uiWorkspace', 'workspaces']

    /**
     * Client plugin body: install styles and dictionaries, then register the
     * History tab beside Chat and Trajectory.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'chat-history-editor: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chat-history-editor: dictionaries')
      const t = ctx.locale.bind(NS)
      const sources = new WeakMap()

      /**
       * Build one session's injected props: live history source, older-page
       * loader, and the Host-command executor.
       * @param {string} sessionId - viewed Session identity.
       * @returns {object} injected slot props.
       */
      const provide = (sessionId) => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) throw new Error(`chat-history-editor: session "${sessionId}" is unavailable`)
        let history = sources.get(binding)
        if (history === undefined) {
          history = createHistorySource(binding.eventSource)
          sources.set(binding, history)
        }
        const session = binding.session
        const runCommand = async (payload, targetId) => {
          const line = `/${HOST_COMMAND} ${JSON.stringify(payload)}`
          const result = await ctx.remote.commands.execute(targetId, line, [])
          if (!result.ok) {
            return { ok: false, message: t('error.transport', { detail: result.error.message, code: result.error.code }) }
          }
          if (result.value === undefined) return { ok: false, message: t('error.command-unavailable') }
          const outcome = result.value.result
          if (outcome.kind === 'success') return { ok: true }
          return { ok: false, message: localizeError(t, outcome.text) }
        }
        return {
          history,
          loadOlder: () => session.loadOlder(),
          execute: (payload, targetId) => runCommand(payload, targetId === undefined ? sessionId : targetId),
          forkSession: (atSeq) => ctx.sessions.fork({ sessionId, ...atSeq === undefined ? {} : { atSeq }, increaseTitle: false }),
          archiveSession: (targetId) => ctx.workspaces.archiveSession(targetId, { stopActivity: true }),
          openSession: (targetId) => ctx.uiWorkspace.openSession(targetId)
        }
      }

      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'history-editor',
            order: 20,
            locale: NS,
            label: () => t('view.title'),
            inject: provide
          },
          HistoryView
        )
      )
    }

    return {
      inject,
      apply,
      __test: {
        contentText,
        foldSurfaceEntries,
        surfaceRowOf,
        buildHistoryRows,
        mergeDraftRows,
        buildDraftRowsPayload,
        editedBlocks,
        groupByTurn,
        formatClock,
        previewText,
        canEditRow,
        canDeleteRow,
        localizeError,
        zh,
        en
      }
    }
  }
})
