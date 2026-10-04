# Two-engine typing investigation (2026-10-04)

Worktree: `~/Projects/sleight-wt/double-keys`, branch `codex/double-keys`.
Base: `4409f1c`. The owner stepped away on 2026-10-04 and authorized foreground trials.
The duplicate-keystroke cause remains unknown. Plugin behavior is unchanged.

## Live results

Engine `26.930.31730`, TextEdit and Calculator, 2026-10-04 at 11:33 and 13:28 EDT. The completed
runs passed their character checks in 30/30 trials, three per condition and input method.
The relay submitted and forwarded 15 typeText calls and 15 keypress calls. The keypress variant
sends each token character with pressKey, then Escape to dismiss suggestions. Neither extra nor
missing characters appeared.

| Condition | typeText counts | Keypress counts | Buffer order |
|---|---|---|---|
| One engine, TextEdit behind Calculator | 3/3 | 3/3 | Exact |
| Second engine attached to TextEdit but idle | 3/3 | 3/3 | Exact |
| Direct client pressing Calculator keys in the foreground | 3/3 | 3/3 | Exact |
| Both clients typing in foreground TextEdit | 3/3 | 3/3 | Direct client first in 6/6 |
| Both clients typing in foreground TextEdit in sequence | 3/3 | 3/3 | Exact |

Concurrent requests for `E0|` and `F0|` produced `F0|E0|`. Each token appeared
once. The test permits unordered concurrent input and retains its `exact: false` result.
Serial requests produced `G0|H0|` in the requested order. Taking turns avoided this ordering race
in six cases across both input methods, though that does not establish a workaround for the earlier
doubled-keystroke report. The keypress variant produced `fe` for concurrent `e` and `f`,
and `gh` for sequential `g` and `h`.

Raw attempts, in execution order:

- [Sandbox attempt](2026-10-04-double-keys-1791126272009.json), exit 1 before typing. JXA could
  not resolve the app. The retry required scoped host access.
- [First host attempt](2026-10-04-double-keys-1791127014039.json), exit 1 before typing. The
  probe assigned `app` before declaring it in the strict engine session. Its owned server exited
  0, and the fixture closed. A unit test reproduced the failure before the probe was corrected to
  declare the handle with `var`.
- [Corrected typeText attempt](2026-10-04-double-keys-1791128043845.json), exit 0. Both owned
  servers exited 0 without a signal, and the fixture closed.
- [First keypress attempt](2026-10-04-double-keys-1791130725653.json), exit 1. Its first
  pressKey("a") succeeded. The engine's UI read showed one `a` and a suggestion list, but the
  independent scripting read timed out with AppleEvent error -1712. The scripting close also
  stalled. One Ctrl-C through the retained terminal interrupted it, saved this report and released
  the lock. The owned engine had already exited 0 without a signal. This trial cannot establish
  character counts independently and is excluded from the 30 completed trials.
- [Fixture cleanup](2026-10-04-double-keys-cleanup-1791134794409.json), exit 0. During its own
  locked run, the relay verified the exact temporary document URL, pressed Escape and closed that
  document through TextEdit scripting with a 30-second deadline. Its engine exited 0 without a signal.
- [Keypress with Escape](2026-10-04-double-keys-1791134909666.json), exit 0. Both owned servers
  exited 0 without a signal, and the fixture closed.

The lock wrapper launched these attempts and released the lock after each run. The timeout's cause
is unknown. Dismissing suggestions let cleanup and the next keypress run complete, but this sequence
does not isolate the timeout's cause. Foreground here means an activated app receiving the engine's
bound-app input. Physical keyboard or mouse input from a person is outside this probe.

## Checks

The baseline passed 157/157 unit tests. With the probe checks, `npm run check` passed 164/164 unit
tests, both manifest validations and 8/8 mod tests (exit 0). Fragmented typing requests with repeated
approval prompts forwarded one action. Repeated app reads and proxy wrapping invoked typing once
per call. The approval check exercised the probe's use of the benchmark's existing allowlist.
The direct-client check verified turn metadata rotation and collected its owned protocol fixture
with exit 0. These unit checks run without the native helper.
These checks cover sleight's framing and guard paths, but cannot exclude native event duplication.
Probe checks also reproduce the strict-session handle failure, verify the generated key sequence,
and reject cleanup paths outside the temporary fixture format. `npm run lint:prose` exited 0.

The first proxy check failed because its fixture omitted the saved document URL. Adding a real
temporary file and its URL made it exercise the intended guard. The failed attempt is retained in
[`2026-10-04-double-keys-attempts.json`](2026-10-04-double-keys-attempts.json).

## Live probe

During the agreed away window, from the worktree:

```bash
sh bench/double-keys-live.sh "OWNER_AGREED_WINDOW"
```

Add `--keypress-only` for the character-keypress-then-Escape variant. If a fixture's scripting close
stalls, use `--cleanup-fixture /private/tmp/sleight-double-keys-BANK/double-keys.txt` during the agreed
window. Cleanup refuses to press Escape unless the observed TextEdit window has that exact URL.

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

## Unresolved limits

The duplicate-event observation did not recur. There is no evidence here to justify a plugin fix
or assign the cause to the engine. The earlier observation lacks a recorded input method and
foreground event sequence, so these results cannot identify its cause. An independent scripting
read without dismissing suggestions remains unverified for the keypress case. The README retains
both limitations. A further investigation needs the original foreground action sequence and input
method, plus its request and event trace. The full benchmark was left to sleight-arch.
