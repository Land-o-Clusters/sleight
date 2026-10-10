# Generic benchmark arms, 2026-10-10

Local stdio MCP discovery passed with ten own tools. Plugins with hooks, LSP servers or agents are
refused before launch. A plugin declaring agent selection or an agent status command is also refused.

The earlier Calculator attempt failed 0/1 in 75.7 seconds (4.37 CPU seconds). All 15 window samples
were off-screen. The trace shows `cgWindowNotFound`, a refused lease and an interrupted retry.
Permission observation failed. The driver was collected with exit 143 and a clean process group.
It returned no completed answer or model turn count.

The committed comparison at 07:59:27 UTC could not acquire `/tmp/sleight-live.lock`.
Neither arm drove an app. The paired Calculator result remains unmeasured. The round-three run and
full check are held by the Puddle window that sleight-arch reserved at 08:19 UTC. Its architect must
close the window before testing resumes. The new changes are uncommitted and unpushed.

Round-three focused tests passed 64/64, and the Calculator gate tests passed 2/2.
An independent reviewer checked the source, and the privacy audit passed for all 19 JSON evidence
files. Bare prose lint exited 0 across 74 files. The full package check and paired live run are pending.

## Trust and comparison rules

Competitor code runs as the current user with full file and network access. The MCP launcher forwards
only `PATH`, `HOME`, `TMPDIR`, `LANG` and declared variables, with no ambient credential or loader
forwarding. This is not a security sandbox: server code can still read files and credentials.

Every Claude arm in a generic comparison uses strict MCP configuration, empty built-in tools and
setting sources, disabled slash commands and session persistence, and the same PermissionRequest
deny hook. Unknown elicitation, structured permission denials, explicit engine refusals, permission
windows, observer failures and a hold stop either arm. Other tool-error wording is left to the task
check and approval log. Defaults are Haiku 5.5/high. API-key identity is checked for each arm.

Live runs retain app references and hold the shared lock until driver collection. The Calculator
comparison requires a window on the current Space, one-minute load below 20 and no hold. An occupied
lock stops the attempt without app input.

Published evidence filters foreign connector catalogs, app inventories, thinking blocks, private
identities and rate-limit events, including nested transcript copies. Home paths use `~`.
The [check receipt](2026-10-10-plugin-arm-checks.json) retains failed check attempts and exact counts.

## Attempts

Times are UTC.

| Attempt | Exit | Evidence and result |
|---|---:|---|
| Initial sandbox attempts | 1 | [Record](2026-10-10-plugin-arm-sandbox.json), filesystem/socket denials. The interrupted unit suite was collected. |
| 05:32:27 plugin dry | 1 | [Raw](2026-10-10T05-32-27-938Z-plugin-arm-plugin-dry.json), strict mode suppressed plugin MCP registration. |
| 05:33:02 plugin dry | 1 | [Raw](2026-10-10T05-33-02-093Z-plugin-arm-plugin-dry.json), same missing catalog with diagnostics. |
| 05:33:43 MCP dry | 1 | [Raw](2026-10-10T05-33-43-484Z-plugin-arm-mcp-dry.json), incorrect hyphen normalization. |
| 05:34:20 catalog probe | 0 | [Raw](2026-10-10T05-34-20-516Z-plugin-arm-catalog.json), four initialization-only configurations. Non-strict settings exposed unrelated connector names. |
| 05:35:49 plugin dry | 0 | [Raw](2026-10-10T05-35-49-516Z-plugin-arm-plugin-dry.json), explicit plugin-qualified registration found ten own tools. |
| 05:36:18 MCP dry | 0 | [Raw](2026-10-10T05-36-18-863Z-plugin-arm-mcp-dry.json), ten own tools. |
| 05:37:49 MCP live | 1 | [Raw and relay trace](2026-10-10T05-37-49-725Z-plugin-arm-mcp-live.json), [transcript](2026-10-10-plugin-arm-live-transcript.json), off-screen Calculator and observer failure. |
| 05:56:13 plugin dry | 1 | [Raw](2026-10-10T05-56-13-828Z-plugin-arm-plugin-dry.json), system observer failed before Claude started. |
| 05:58:06 MCP dry | 1 | [Raw](2026-10-10T05-58-06-787Z-plugin-arm-mcp-dry.json), system observer failed before Claude started. |
| 05:59:16 final plugin dry | 0 | [Raw](2026-10-10T05-59-16-909Z-plugin-arm-plugin-dry.json), ten own tools, guarded fixture policy, initialization only. |
| 06:00:43 final MCP dry | 0 | [Raw](2026-10-10T06-00-43-649Z-plugin-arm-mcp-dry.json), ten own tools, guarded fixture policy, initialization only. |
| 07:39:45 revised plugin dry | 1 | [Raw](2026-10-10T07-39-45-897Z-plugin-arm-plugin-dry.json), sandbox result and publication writes denied. |
| 07:40:00 revised MCP dry | 1 | [Raw](2026-10-10T07-40-00-994Z-plugin-arm-mcp-dry.json), sandbox result and publication writes denied. |
| 07:40:34 revised MCP dry | 0 | [Raw](2026-10-10T07-40-34-193Z-plugin-arm-mcp-dry.json), ten own tools with scrubbed server environment. |
| 07:41:32 revised plugin dry | 1 | [Raw](2026-10-10T07-41-32-433Z-plugin-arm-plugin-dry.json), expected configuration refusal for automatic module hooks. |
| 07:59:27 committed MCP comparison | 1 | [Raw](2026-10-10T07-59-27-338Z-plugin-arm-mcp-live.json), another run held the shared live lock. Both task drivers were skipped. |
| 15:51:38 `mcp:sleight-plain,sleight`, sleight-arch | 1 | [Raw](2026-10-10T15-51-38-982Z-plugin-arm-gate.json), the gate refused before any arm ran. Calculator had no window on the current Space. |
| 15:51:51 same, Calculator open | 1 | [Raw](2026-10-10T15-51-51-500Z-plugin-arm-gate.json), same refusal. Calculator's window was on another Space. The paired run waits for the owner to be away. |

Sandbox denials, native compilation timeouts, observer failures and the clipboard fixture failures
remain in the check receipt. The unrelated clipboard test edits and review working notes are removed.
