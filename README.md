# Chat History Editor

A persistent DeepSeek Harness plugin that adds a **History** tab to the
conversation view. The tab shows the history the model currently sees as a
**turn-grouped ledger in the style of the Trajectory tab**, and lets you
**edit**, **delete**, and **add** messages in it.

The ledger groups records by Turn, shows each record's role, event sequence,
wall-clock time and a one-line preview, and offers:
- role filters (All / User / Assistant / Tool / Context) with live counts,
- a text search across the current history,
- collapsible Turn sections and expandable records,
- hover actions for edit and two-step delete on every editable record.

## What it does

- **History tab** beside *Chat* and *Trajectory*, rendering the current
  model-visible surface of the session (compaction and other replacements are
  already applied, so what you see is what the next request will carry).
- **Edit** any user-role message in place — a human message, or an injected
  context snapshot such as the runtime (time) context, model selection, or
  working-directory note — rewrite the **system prompt**, and rewrite the last
  assistant message.
- **Delete** a user-role message (including injected context snapshots), an
  assistant message, or a tool result. Deleting a message that takes part in a
  tool call/result pair removes the pair together, so the next request stays
  tool-pairing balanced. The runtime context is regenerated on the next model
  step, so removing or editing it affects the current history only.
- **Add** a user or assistant message at the end of the history.
- **Load earlier history** when the session window has older pages.
- **Trajectory-style ledger** grouping records by Turn, with role filters,
  search, collapsible Turns, expandable records, sequence numbers, and
  timestamps for scanning and operating on long histories.

## Rewrite mode: edit everything, apply as a branch

The History toolbar carries a **Branch rewrite** toggle (persisted in the
browser). It has two behaviors:

| Mode | Behavior |
|---|---|
| Off (default) | Immediate in-place operations: edit user/context/system-prompt rows, delete a balanced range, append at the end. Assistant rows can only be rewritten while they are the last visible row. The Chat transcript stays append-only. |
| On | Every row becomes editable and deletable, and a new message can be inserted above/below any row. Changes stay in a **draft** (marked 待修改/待删除/待插入) until you press **Apply rewrite**: the plugin forks the session at its first event, rebuilds the edited conversation into the new child session, flushes it, and switches the page to it. |

Why a branch: the session log is append-only and the format forbids
`assistant/message` replacements, so editing an assistant message in place (or
inserting mid-history) cannot be expressed in the current log. A rewritten
branch is a normal session whose Chat, Trajectory, and model history all show
the edited conversation; the original session is left untouched and its edits
remain a draft you can discard.

What the rebuild preserves:

- every retained message and its content blocks (text, images, files, tool
  calls), in the drafted order;
- tool call/result pairing (deleting one side strips the dangling other side);
- session-level policy facts replayed from the source log: permission preset,
  sandbox mode, approval policy, model selection, working directory;
- an edited system prompt is written with the `history-editor-` identity so the
  assembly pin keeps it effective in the child.

What it does not copy: non-message session records (title history, goals,
todos, team membership, jobs, feedback, subagent catalogs). The child gets the
same cwd and agent preset as the source through the fork mechanism.

## Design: append-only logs, editable context

The session log is append-only and is the source of truth. This plugin never
rewrites stored events. It appends well-formed *surface* events:

| Operation | Appended events |
|---|---|
| Edit user-role message (human or injected context) | `user/message` replacement of its own surface node; the recorded source kind is preserved |
| Delete messages | empty `developer/message` replacement: a surface node that projects no model message |
| Add message | ordinary surface append at the tail |
| Edit assistant message | fresh `assistant/message` append for the same Turn/Step plus a hidden tombstone for the old node |
| Edit system prompt | `system/message` replacement (identity prefixed `history-editor-`) + a Host assembly pin; **Restore default** clears it with empty system replacements |

Consequences you should know about:

- Edits change the **model context**, not the Chat tab. Chat is the append-only
  transcript of what actually happened: its definitions deliberately render only
  append-origin events and ignore surface replacements, so a replacement never
  erases conversation the user already saw. This is by design in the shipped
  Chat target, not something a plugin can override; making Chat show a rewritten
  history would require rewriting the log (a new forked session), not an edit.
  The History ledger is therefore the authoritative view of the model-visible
  state, and it updates immediately after every operation.
- Assistant messages cannot be *replaced* by the surface protocol
  (`assistant/message` cannot cite `sourceEventSeqs`), so an assistant rewrite is
  implemented as “append the rewritten message to the same Turn/Step, hide the
  old node”. In the History tab this replaces the message in place; only the
  **last** assistant message can be rewritten, because the appended node lands
  at the end of the model-visible order.
- The delete operation writes one hidden replacement node per contiguous range.
  Those nodes project no message and are hidden by the History tab.
- A **system prompt edit** replaces the rendered prompt node and pins
  `system-prompt/assemble` to the edited text, so the agent loop cannot reconcile
  the assembled prompt back over it on the next request. This overrides the whole
  assembled prompt (persona, skill guidance, harness identity) and stays in
  effect until **Restore default** is used, which empties the override nodes so
  the next request re-renders the assembly.
- Every written event carries a canonical **positive `turn`/`step`**. The JSONL
  read path admits `developer/message` and `system/message` only with positive
  coordinates, so a zero coordinate would make a session unreadable on resume.
  Both host probes assert this with the real read-path admission validator.

## How the UI reaches the Host

The web client's Remote namespaces are fixed at build time, so a profile plugin
cannot add one. The History tab therefore calls the Host through the one
supported client-callable extension point: a session command.

- Host half registers `/history` with `recordInput: false` (the JSON payload
  never enters the session log; only the command lifecycle row is recorded).
- The History tab runs
  `ctx.remote.commands.execute(sessionId, '/history {…}', [])` and maps the
  classified `[code] detail` failure text to the active locale.
- Every operation is implemented once in `history-ops.js` as a Session surface
  mutation; the command handler is a thin validated wrapper.

Operations are refused while a turn is running. (Maintenance work such as an
automatic compaction maps to the idle status and may still append concurrently;
every append is atomic, so the log stays consistent.)

## Files

| File | Role |
|---|---|
| `index.js` | Host entry: registers the `/history` command |
| `history-ops.js` | Session surface mutations (edit / delete / add, tool-pairing planning) |
| `client.js` | Client module: History tab, surface fold, command execution |
| `cordis.patch.yml` | Bundle patch inserting the Host row |
| `locale/*.json` | Plugin Manager title and description |
| `icon.svg` | Plugin artwork |

## Known decisions

- **`session.eventAt()` exception.** The Host reads each current surface node's
  event with `session.eventAt(seq)`, which the Session package marks deprecated
  in favor of `ctx.sessionProjections` units. A fold unit cannot supply the
  per-node event payload this editor needs (role, content, tool-call ids), and
  the call is a read of the already-loaded in-memory log; this plugin therefore
  records the exception. `session.surface.nodes` is treated as read-only.
- **Maintenance writes.** The busy guard inspects `agent.status`; a maintenance
  phase reports `idle`, so an automatic compaction append can interleave with a
  history edit. Both paths append atomically, so the log and surface stay
  consistent.

## Install

```text
plugin_manager install_bundle { "target": "dsh-chat-history-editor" }        # 已发布到 npm 后
plugin_manager install_bundle { "target": "<absolute path to this directory>" }  # 本地开发（link）
```

Then open a conversation and switch the view ring from *Chat* to *History*.

## Publishing

See [PUBLISH.md](PUBLISH.md) for the npm release flow, install targets, update and
compatibility rules, a self-hosted plugin-market index, and private
distribution. The repository is
<https://github.com/flyheart/dsh-chat-history-editor>; tagging `v*` runs the
GitHub Actions publish workflow. Two helper scripts live in `tools/`: `rename.mjs` renames the
package consistently across the manifest, bundle patch, Client module id, and
test; `market-index.mjs` generates and validates a format-1 market index.
