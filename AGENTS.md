# AGENTS.md

Repository guidance for AI coding agents. Human-facing behavior is documented in
`README.md`; release and publishing steps live in `PUBLISH.md`.

## What this repository is

`dsh-chat-history-editor` is a single DeepSeek Harness (DSH) Cordis bundle, published
on npm under the same name. It has two halves:

- **Host** (`index.js` + `history-ops.js`): runs in the DSH process. Registers the
  `/history` session command and performs surface mutations on a live `Session`.
- **Client** (`client.js`): a Web client module that adds the **History** tab,
  renders the model-visible surface as a ledger, and sends operations through the
  `/history` command.

The History tab edits the history the model sees. With **Branch rewrite** enabled it
also edits/deletes/inserts any row in a draft and applies the result by forking a new
session and rebuilding the transcript into it.

## Layout

| Path | Role |
|---|---|
| `index.js` | Host entry: `/history` command, system-prompt assembly pin, source-log reads |
| `history-ops.js` | All Session surface logic: fold/read, edit, delete, append, tool-pairing planning, branch rebuild, system-prompt override |
| `client.js` | Web module: ledger view, mode toggle, draft state, command execution |
| `cordis.patch.yml` | Bundle patch inserting the Host row |
| `locale/en.json`, `locale/zh.json` | Plugin Manager title/description (keep key sets identical) |
| `test/host.test.mjs` | Host surface/rebuild probes against a real detached `Session` |
| `test/command.test.mjs` | `/history` handler wiring with a stub Cordis context |
| `test/client.test.mjs` | Client module evaluation + pure fold/draft helper checks |
| `test/support.mjs` | Locates the installed DSH so Host probes can import its packages |
| `tools/` | Packaging helpers (`rename`, `check-publish`, `market-index`, `desktop-repair`) |
| `.github/workflows/publish.yml` | Tag-triggered npm publish through OIDC trusted publishing |

## Commands

```bash
npm test                        # all suites; Host probes skip when no DSH is installed
DSH_INSTALL_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm test   # include Host probes
DSH_SKIP_DSH_TESTS=1 npm test   # force the skip path
npm pack --dry-run              # inspect the published tarball (expected: 10 files)
node tools/check-publish.mjs    # publish preflight (also runs in prepublishOnly)
```

Local development install inside a DSH profile:

```text
plugin_manager install_bundle { "target": "/absolute/path/to/this/repo" }
```

The profile links this directory; reload the plugin (or restart DSH) to pick up Host
changes, and refresh the page to load Client changes. The linked install competes with
the npm package if both are present — use one at a time.

## Architecture invariants

Read these before changing behavior. They come from the DSH session format; violating
them can make a session unreadable or break the next model request.

1. **The session log is append-only.** Never rewrite stored events. Only append
   *known* event types (`KNOWN_SESSION_EVENT_TYPES`); plugin-specific records are
   reserved for the owning plugin.
2. **The Chat target is an append-only transcript.** It renders append-origin surface
   events only, so in-place replacements change the model context and this plugin's
   History tab but not the Chat bubbles. Making Chat show rewritten history requires
   the fork-rewrite path, not an edit.
3. **Surface replacements must be complete.** `surfaceOp: { op: 'replace', startSeq,
   endSeq }` needs `sourceEventSeqs` covering every shadowed surface node, and the
   endpoints must be current surface nodes.
4. **`assistant/message` can never replace a node** — the format forbids
   `sourceEventSeqs` on it. An assistant rewrite is “append a new assistant message
   for the same Turn/Step + hide the old node”; it is only order-preserving when the
   old message is the last visible row. Arbitrary-position assistant edits and
   mid-history inserts go through the branch rebuild.
5. **Deletion is an empty `developer/message` replacement.** Empty system/developer/
   assistant content projects no model message. Keep tool pairing balanced: deleting
   one side of a call/result pair must also drop or strip the other side, or the next
   provider request is invalid.
6. **Coordinates must be positive *and* name the open Turn/Step.** Two different
   checks apply on the JSONL read path:
   - `assertV4RowAdmission` requires a positive integer `turn`/`step` on
     `developer/message` and `system/message` (zero makes the session unreadable);
   - `assertReleasedV4Relationships` (`Relationships.requireStep`) requires
     `system/message`, `developer/message`, `assistant/message`/`assistant/attempt`
     and `tool/*` writes to match the **currently open** Turn/Step exactly, and
     rejects the artifact with `… does not match an open turn and step` otherwise.
     `user/message` surface writes are not lifecycle-checked this way.

   The History tab operates while the agent is idle, so no Turn/Step is open: in-place
   writes that depend on an open step (delete tombstones, assistant rewrites, system
   prompt replacements) are **not representable in an append-only log** unless applied
   inside a rewritten branch. Classify such operations as `needs-branch` and route
   them through the fork/rebuild path instead of appending them while idle.
7. **The system prompt override uses the `history-editor-` message-id prefix**, not a
   custom source kind: the format requires `system/message` sources to be
   `system-prompt`. `index.js` pins `system-prompt/assemble` to that text so the agent
   loop cannot reconcile the assembled prompt back over it; `reset-system` clears it
   with empty system replacements.
8. **Branch rebuild synthesizes a fresh log** in a forked child (fork at `atSeq: 0`):
   policy events are replayed, then canonical turns/steps/messages/tool calls/tool
   results are appended with client-supplied draft rows, and the page switches to the
   child. Do not renumber or mutate source-session events.
9. **Host↔Client transport is the `/history` session command.** A profile plugin
   cannot add a Client Remote namespace (the set is fixed at build time), so the
   Client calls `ctx.remote.commands.execute(sessionId, '/history {…}', [])`. Keep
   `recordInput: false`; the JSON payload must not enter the session log.
10. **Dependency boundaries.** The Host half imports only Node builtins (`node:crypto`).
    Do not import `@deepseek-ai/*` packages in the bundle. The Client module may only
    `require('react')`, and its module id must equal the package name.

## Testing requirements

- Every new operation needs a Host test that drives a real detached `Session`, asserts
  the `deriveMessages()` change, runs `assertV4RowAdmission` on every event, and calls
  `Session.create(seed)` to prove the log is restorable (`assertRestorable`).
- Validate the **full released read path**, not just per-row admission:
  `assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES)` (or an equivalent
  JSONL write/read round-trip) must accept the log. Per-row admission alone accepts
  writes the lifecycle relationship validator later rejects with “does not match an
  open turn and step”, which only surfaces when a real session is resumed.
- Operations that need an open Turn/Step must be tested for the `needs-branch`
  classification when invoked while idle, and covered through the rebuild suite.
- Rebuild changes additionally assert message order/roles, tool-call stripping, and
  system-prompt override detection.
- Client pure helpers (fold, draft merge/payload, predicates, error localization) are
  tested by evaluating `client.js` in a stub module loader. Keep the zh/en dictionary
  key sets identical — `test/client.test.mjs` fails otherwise.
- Never weaken a test to make a change pass. Host probes may skip only when no DSH
  installation is available.

## Code style

- Plain ESM, no build step, no TypeScript, no JSX. JSDoc on exported functions.
- `history-ops.js` stays free of DSH imports so it can be driven by a plain `Session`.
- Errors are classified (`HistoryError` code) and surface to the Client as
  `[code] detail` text; localize known codes in the Client.
- Client UI uses `h()` and one injected `<style>` tag with the `che-` class prefix.
  Use theme tokens (`--dsw-alias-*`) for surfaces/text/borders; only artwork may use
  literal colors.
- Draft payloads from the Client are untrusted: validate roles/content, reject
  non-lossless JSON, and keep the size/row caps in `rebuildRewrittenSession`.
- Do not log message content, draft payloads, tokens, or session data.

## Release and publishing

- Releases are tag-driven: bump `version`, push `main`, push `vX.Y.Z`. The workflow
  runs `npm test`, publishes through npm **OIDC trusted publishing**, waits for
  registry propagation, and verifies the version is visible.
- Never add `NODE_AUTH_TOKEN`/`NPM_TOKEN` or a bypass-2FA token to the workflow; never
  commit npm tokens. The npm account has 2FA enabled and a trusted publisher
  configured for this repo/workflow.
- `prepublishOnly` runs `tools/check-publish.mjs` (private flag, placeholder name,
  Client module id, `engines.dsh`, required files) and the test suite. Keep the
  tarball file list intentional; update `files` when adding shipped files.
- Renaming the package requires `node tools/rename.mjs <name>` — it updates
  `package.json`, the bundle patch row, the Client module/CSS ids, and the client test.
- Registry visibility lags 1–2 minutes; the workflow retries. If the publish succeeded
  but verification was too early, re-run the failed job instead of releasing again.
- **Do not create tags, publish npm versions, or trigger release workflows unless the
  user explicitly asks.** Do not change npm trusted-publisher/2FA settings from CI.

## Do not

- Edit the bundle row name in `cordis.patch.yml` by hand (use `tools/rename.mjs`).
- Introduce new session event types or plugin records.
- Use `pnpm`/`npm install` against the profile or hand-edit profile files; install via
  `plugin_manager`.
- Assume Chat reflects replacements, or “fix” that inside Chat's definitions.
- Widen `engines.dsh` casually — it gates loading in existing DSH installations and is
  documented in `PUBLISH.md`.
- Remove the `session.eventAt()` read exception in `history-ops.js` without a
  supported replacement that still yields per-node role/content/tool-call data.

## Before finishing a change

1. `npm test` (with `DSH_INSTALL_ROOT` when validating Host changes).
2. `node tools/check-publish.mjs` and `npm pack --dry-run` for manifest/packaging changes.
3. Update `README.md` for user-visible behavior and `PUBLISH.md` for release changes.
4. Report verification limits honestly; browser/visual checks require the user's page.
