# Other MCP hosts

sleight's launcher speaks stdio MCP independently of Claude Code. The base client needs
`initialize`, `notifications/initialized`, `tools/list` and `tools/call`. It does not need a mod,
plugin variables, a skill loader or host session IDs. This covers ROADMAP track 6's host path.

## Host assumptions

| Claude Code integration | What a plain client lacks | sleight's behavior |
|---|---|---|
| Form elicitation for app approvals | Optional `elicitation/create` support | On initialize, missing or URL-only capability selects the launcher's native panel. Empty legacy elicitation or `form: {}` keeps client prompts. The relay advertises form support to the engine when it supplies the panel. |
| Desktop Code tab detection | `CLAUDE_CODE_ENTRYPOINT` | Desktop detection still forces the panel because that host silently declines forms. Other clients use capabilities. `SLEIGHT_APPROVAL_PROMPT=dialog` forces the panel. `client` disables fallback and cancels if forms are unsupported. |
| Stop hook and `turn_ended` | A model-turn completion event | The existing idle timer ends a used engine turn after 30 seconds without a pending call. EOF drains the turn before collecting the engine. The timer waits for a pending approval's tool call to finish. |
| Mod, pane and status line | Claude Code's hook and UI APIs | The MCP server never imports the mod. Tools run without its pane, status line, `/sleight stop` and origin-based refusal of model calls to `turn_ended`. That tool remains listed as internal. The client can omit it. |
| `anthropic/alwaysLoad` and engine `_meta` keys | Claude's tool search conventions | The client may ignore these opaque metadata fields. The relay adds session/turn metadata and approval persistence for the engine. |
| Registered skill | Claude's slash command and skill loader | The launcher reads the skill relative to itself and appends its body to the first engine documentation reply. With a missing or unreadable file, calls continue using the engine's API docs alone. |
| `${CLAUDE_PLUGIN_ROOT}` | Plugin manifest interpolation | It is used only in Claude's manifest. Other clients configure the launcher's absolute path. The shell launcher finds `launch.mjs` relative to itself and resolves the installed engine on each startup. |
| Claude session identity | Claude-specific session and transcript IDs | Each launcher process generates its own session UUID and each engine turn its own turn UUID. Accepted approvals end with that process, even if the client shares it across chats. Replay by Claude transcript ID remains Claude-specific. Other clients can replay a script file. |

All existing approval ceilings, user-owned preapprovals and input guards remain in place. Declines,
cancellations and prompt failures grant nothing. Browser approvals use the same panel fallback.
Local tool, document, review and flow prompts use the selected provider too. A headless host without
form support needs a person at the Mac for an unapproved app. A panel timeout refuses it.

## Proof and limits

`bench/other-hosts-client.mjs` is a separate stdio client with empty capabilities. It rejects every
optional server request with JSON-RPC `-32601`. The relay supplies the host metadata and turn cleanup.
The default probe performs arithmetic in the engine. After the idle wait it calls again, then
closes stdin and waits for the owned server to exit, without acquiring an app.

`tests/other-hosts-client.test.mjs` runs that client through the real relay with a protocol engine
fixture. It checks approval fallback, session reuse, turn rotation, internal cleanup replies and
EOF collection. Unit tests also cover legacy and modern form capabilities, URL-only capability,
risk escalation, declines, cancellation and failed dialogs. The fixture replaces the native panel
callback, so this does not claim that a person saw or answered a real panel.

Run the app-free engine probe with `node bench/other-hosts-client.mjs`. For a traced, locked run
that publishes a small receipt, use `node bench/other-hosts-live.mjs`. Every attempted run goes in
[the run report](../benchmarks/2026-10-09-other-hosts.md), failures included. Cursor and Codex model
trials belong to sleight-arch. They remain untested here.

Configuration references were read on 2026-10-09. See [Cursor MCP](https://cursor.com/help/customization/mcp)
and [Codex MCP](https://developers.openai.com/codex/mcp) for registration. The protocol describes
[MCP form capabilities](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).
[LCU](https://github.com/amontlabs/lcu) already documents use across harnesses. These changes retain
sleight's relay and approval rules on the same base protocol.
