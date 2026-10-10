# Generic benchmark arms

`plugin:name` loads a local Claude Code plugin. `mcp:name` loads installed stdio servers from a local
MCP configuration. Each gets a separate directory outside Git and only its discovered MCP tools.
Every Claude arm in a generic comparison uses `--strict-mcp-config`, `--setting-sources ''`,
`--tools ''`, `--disable-slash-commands`, `--permission-prompts none`, `--no-session-persistence` and `stream-json`. Strict MCP
configuration suppresses plugin registrations in the installed Claude Code version. The runner
registers the same plugin-qualified servers explicitly. Defaults are Haiku 5.5 at high effort.
The API-key preflight applies to every Claude arm. Claude receives the benchmark API key, while
`ENABLE_CLAUDEAI_MCP_SERVERS=false` excludes account connectors.

The server launcher clears ambient variables through `/usr/bin/env -i` before starting Node.
It passes only `PATH`, `HOME`, `TMPDIR`, `LANG` and the server's explicitly declared variables.
An arm may declare its own variables, but cannot interpolate ambient credentials from Claude's
environment. Only `${CLAUDE_PLUGIN_ROOT}` is expanded. Other interpolation is refused. A private
descriptor holds the exact environment and original interpreter path, preserving virtualenv behavior.

Running a competitor's code trusts it as the current user, with full file and network access.
Environment filtering controls forwarding. Competitor code can still read files or credentials.
Plugin hooks execute with that same authority, so this runner refuses any manifest `hooks` field and
automatic `hooks/hooks.json`, including module hooks. It also refuses manifest LSP servers and agents,
automatic `.lsp.json` and `agents/`, and plugin settings that select an agent or agent status command.
Configuration refusals are recorded as failed
rows before Claude, fixtures or the live lock start. The harness is not a security sandbox.

The result records manifest identity, Git revision when available, package hashes, configuration
hashes and the discovered catalog. Hashes include dependencies and build output within identified
packages, plus configured external entry artifacts and Python virtual environments. They exclude Git
metadata. Provenance reads only `git rev-parse`; it never runs `git status` in a competitor folder,
where a configured fsmonitor could execute code. The result omits dirty state. System libraries and
programs selected at runtime by a launcher remain outside this identity. Remote deployments and
installer commands are refused.

A pass containing a generic arm uses retained app fixtures for every arm, including sleight. Default
task prompts and checks stay the same. File seeds are prepared without the older TextEdit and Chess
reset routines. Existing app windows remain open. Only retained references and tracked launched
processes are eligible for cleanup. Chess and Simulator require the owner-away flag. Historical
default-suite timing is not directly comparable with this setup.

MCP elicitation grants only known benchmark app messages with a supported empty or session/once form.
Unknown requests write a stop marker. Every Claude arm in the comparison denies ordinary tool permission
requests and stops on structured denial records or the marker. The driver also stops on explicit engine
refusals. Other tool-error wording is left to the task check and approval log. Before starting
Claude for a live run, it observes macOS permission windows. Retained helpers then observe app dialogs. A hold
file or observer failure stops work. Collection finishes before the pass releases its shared lock.
Task checks and approval records decide the result. Final-answer wording does not trigger a stop.
Successful tool content mentioning permissions is also allowed. Both sleight and generic arms reject leaked servers.

Dry discovery stops Claude at initialization, before a model call or task setup. It checks server
isolation and elicitation stops without starting app fixtures or the macOS permission observer.
This permits command validation when the host observer cannot finish within its existing deadline.

The committed-path Calculator proof compares one generic MCP run with one sleight run in the same
pass. Under the shared mkdir lock, it checks that the hold is absent and the one-minute load is below
20. It also requires a visible Calculator window on the current Space before preflight and each
driver. It never activates Calculator.
An occupied lock or failed observation stops the proof. Published evidence replaces foreign connector
catalogs, app inventories, rate-limit events and private identities with filtered occurrence counts, including nested
transcripts. Counts can include repeated copies of the same observation.

The production plugin and engine are unchanged. Tests cover command construction, foreign catalogs,
package changes, approval schemas, streamed refusals, hold races, fixture ownership and app dialogs.
The [evidence report](../benchmarks/2026-10-10-plugin-arm.md) includes every benchmark attempt.
