# Preapproved apps

The user's private `~/Library/Application Support/sleight/preapproved.json` can approve apps before a
Claude session starts. Both interactive and headless sessions use it. A project cannot select the
path or provide entries through settings or environment variables.

The loader resolves the OS account when loading, using its home and ignoring `HOME`.
It checks owner, write permissions, regular
file status and symlinks, opens with `O_NOFOLLOW`, then checks the open descriptor's identity and
permissions again. A missing file doesn't grant approval. An invalid file stops startup. Version 1 has an
`apps` array of exact `app` identifiers and `riskLevel` ceilings (`low`, `medium`, `high`). Unknown
fields, duplicate apps and wildcards are refused. The parsed map is private and unchanged until exit.
Ownership checks cannot distinguish the user from other processes running as that user. The skill
forbids Claude creating or editing the list, but the loader cannot enforce that instruction.

The relay checks the list before its normal engine approval prompt and before session memory for
local `drag` and `menu_bar`. Local pointer tools require `high`. Every matched request is
audited before the accept, without an engine persistence setting. Declines and higher-risk prompts
keep their existing behavior. Document scope, reviews, flow exceptions and notification permission
remain user decisions. The engine's built-in blocks still apply.

A nonempty list enables a separate grant audit at `~/Library/Logs/sleight/preapproved-<pid>.jsonl`.
It contains timestamps, process IDs and the app, risk, tool and source fields only, rotates at 64 KiB,
and keeps one prior file per process. Distinct process files keep simultaneous relays from replacing
each other's records during rotation. Full relay tracing remains opt-in through `SLEIGHT_TRACE`.
Each grant produces stderr output and an audit record before the relay accepts it. Explicit traces
also receive a `preapproved-app` event. A failed audit or grant trace write falls back to asking,
including when session memory already holds an approval. The grant also appears in tool results,
including failures. When engine calls overlap, their results all carry the note, since an elicitation
does not identify its initiating request. A local result contains only its own grants.

Tests cover the loader's trust checks and startup snapshot, settings trying to add Mail, risk ceilings,
engine prompts with and without session persistence, local pointer tools, audit output and result
notes. `bench/preapproved-live.sh` takes the shared live lock for one Calculator trial and releases it
on exit. Its driver uses a fresh headless Claude session, no approval hook, only this branch's MCP
server and no built-in tools. It publishes all launched attempts under `docs/benchmarks/`.
