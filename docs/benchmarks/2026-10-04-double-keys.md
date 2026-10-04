# Two-engine typing investigation (2026-10-04)

Worktree: `~/Projects/sleight-wt/double-keys`, branch `codex/double-keys`.
Base: `4409f1c`. Foreground trials await an owner-agreed away window. No live trial has run.
The duplicate-keystroke cause remains unknown. Plugin behavior is unchanged.

## Checks so far

The baseline passed 157/157 unit tests. With the added checks, `npm run check` passed 161/161 unit
tests, both manifest validations and 8/8 mod tests (exit 0). Fragmented typing requests with repeated
approval prompts forwarded one action. Repeated app reads and proxy wrapping invoked typing once
per call. The approval check exercised the probe's use of the benchmark's existing allowlist.
The direct-client check verified turn metadata rotation and collected its owned protocol fixture
with exit 0. These unit checks run without the native helper.
These checks cover sleight's framing and guard paths, but cannot exclude native event duplication.

The first proxy check failed because its fixture omitted the saved document URL. Adding a real
temporary file and its URL made it exercise the intended guard. The failed attempt is retained in
[`2026-10-04-double-keys-attempts.json`](2026-10-04-double-keys-attempts.json).

## Live probe

During the agreed away window, from the worktree:

```bash
sh bench/double-keys-live.sh "OWNER_AGREED_WINDOW"
```

The wrapper waits for `/tmp/sleight-live.lock` with the owner's `mkdir` loop and releases it on exit.
The probe uses the current engine version with one unique temporary TextEdit document.
It runs three trials per condition:

- One sleight engine, TextEdit behind Calculator.
- A second engine attached to TextEdit but idle, with Calculator in front.
- Sleight types behind Calculator while the direct client presses keys in Calculator.
- Both clients type distinct tokens in the same foreground TextEdit document.
- The same clients type in foreground TextEdit in sequence.

The second client talks directly to its own engine server, with session and turn metadata.
Sleight uses its real relay and input leases. The direct client takes no sleight lease, as Codex
would not. Both answer app prompts through `bench/approve.mjs`. Any other prompt is declined.
Foreground means the fixture activates that app. Input uses the engine's bound-app API, so this
does not cover physical mouse or keyboard input from a person.
The fixture reads the document through TextEdit's scripting interface, independently of engine
observations. Reads, request IDs, forwarded calls, replies, errors and teardown go into a new
timestamped JSON file in `docs/benchmarks/`. Home paths become `~`. Failed trials are retained.

If duplicates appear, compare each submitted request with the relay's `to-server` trace and the
document contents. A second run with `--raw-only` removes sleight from both clients. Duplication
there would place the cause outside the relay. A clean serialized condition would support avoiding
overlapping actions as a workaround, within these measured conditions.

The runner ends each owned engine turn and closes its server. Cleanup deadlines signal only those
owned servers. It closes only its temporary document, leaves other TextEdit documents alone, and
never quits ChatGPT or signals the shared helper. Any forced server exit must be reported; it could
affect the helper, given the timeout incident recorded in the README.

## Remaining work

Run the foreground trials with the owner away, inspect every result, and narrow any reproduction.
Add a failing unit test before any plugin fix. If neither client reproduces the old observation,
publish that limit and retain the Known problems entry. Do not attribute it to the engine without
a direct-client reproduction.
