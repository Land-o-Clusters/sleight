# Routines and demonstration recording, 2026-10-10

Branch: `codex/routines-demo`, based on `332e3ca` from `origin/pane/auto-mode`.
We left this Mac's launchd jobs unchanged. Installer tests use private temporary homes and a
simulated launchctl transport. No permission prompt was answered, and no app was restarted.
The [recorded outcomes](2026-10-10-routines-demo-results.json) include subsequent checks and final
gate results. Review requested removal of the four large check logs; results and failed attempts
remain in JSON. The follow-up below supersedes the initial installation and capture behavior.

## Attempts

| Run | Exit | Result |
|---|---:|---|
| Baseline `npm test`, ordinary sandbox | 1 | Interrupted through the retained terminal after existing native fixture timeouts and sandbox failures. Examples: `EPERM` creating `bench/results`, and `listen EPERM` for private fixture sockets. No baseline pass claimed. |
| New routine tests before the code | 1 | Missing module, expected first failing test. |
| First routine code, six tests | 1 | 4/6 failed because the macOS temporary-directory alias was a symlink. Tests now use the canonical temporary path. |
| Routine tests after canonical fixture path | 0 | 6/6. |
| New recorder tests before the code | 1 | Missing module, expected first failing test. |
| Recorder and routine tests | 0 | 11/11. |
| Added installer cleanup and symlink regressions | 1 | 2/8 failed: equal error messages were treated as confirmed cleanup and a dangling log symlink was followed. |
| Corrected cleanup and path checks | 0 | 13/13, including released lock on log-path failure. |
| Replay, recorder and routine tests | 0 | 44/44. |
| Native observer compile and trust preflight, ordinary sandbox | 1 | Stalled with no output. One Ctrl-C on its retained terminal collected the final exit. Capture remained untested. |
| Reviewer's focused tests and temporary-home repro checks | 0 | 13/13 focused tests. Damaged-script removal and removal/run overlap reproduced. |
| Removal regression before the fix | 1 | Damaged scripts could not be removed. |
| Removal correction with replay and recorder tests | 0 | 45/45. |
| Menu opening and duplicate-event regression | 1 | Menu-bar opening was refused before the correction. |
| Interrupted focused runs (2) | Unknown | Terminal handles were unavailable after the conversation interruption. These runs are not counted as passes. |
| Fresh focused run after interruption | 0 | 48/48, including the dialog check and per-input batch splitting. |
| Native compile with host access and the default toolchain | 1 | Timed out, collected SIGTERM with no compiler output. |
| Native compile using the installed full Xcode | Unknown | Interrupted conversation lost the terminal handle. Compiler outcome and child cleanup remain unconfirmed. |
| First prose check | 2 | Missing local Vale styles. |
| Ordinary `vale sync` | 2 | Sandbox refused creating the worktree's style directory. |
| `vale sync` with host access | 0 | Installed the pinned prose rules. |
| Prose check after style installation | 1 | 13 flags, corrected. |
| Prose check after corrections | 1 | One remaining clipped-sentence flag in the replay note. |
| Optional-output recorder regression | 1 | 5/6 passed. The documented app-only command still required a filename. |
| Focused tests after optional-output correction | 0 | 48/48. |
| `node bench/routines-demo-check.mjs --installer` | 0 | Temporary `HOME`, complete printed plist and removal plan, no preview writes, simulated install/remove. No real launchctl call. |
| Fresh native compile, ordinary sandbox | 1 | Compiler rejected the unavailable `kAXSheetsAttribute` constant. Changed to the AX attribute name and a child-sheet check. |
| Native compile and trust preflight after correction | 0 | `observerCompiled: true`, `permissionRequested: false`, `trusted: false`, `listening: false`. No app observation started. |
| Prose check including expanded attempt log | 1 | Wording flags in this table (4), corrected. |
| Bare `npm run check` with host access | 1 | 1,142 passed, 10 failed, one cancelled, 1,153 reported. Existing native fixtures timed out and short process tests missed deadlines under load. One Ctrl-C stopped the failed attempt. Validation and mod checks were not reached. |

An optional inspector help request returned exit 64:
`CODEX_MACOS_INSPECT_APPROVAL_REQUIRED: use one documented read-only inspector operation with bounded arguments`.
That inspection stopped without a fallback. The documented memory-pressure read returned 1.

The earlier observer attempts left three private temporary cache directories. We did not signal
unidentified processes or remove those directories after losing the original terminal handles.
The shared live-test lock was occupied when this work resumed, so no app-driving check ran.

Review found a removal race, damaged-script removal failure, missing unattended dialog checks,
menu opening and duplicate-event problems, silent failed hit-tests and unsafe SIGTERM completion.
The changes add a shared removal/run lock, independent removal paths, a read before each input,
interaction IDs, supported menu opening, capture refusal on failed hit-tests and termination without
saving. The follow-up adds process ownership and crash recovery while retaining unknown relay groups.

## Limits

The recorder's event-to-script tests use constructed notifications, including Calculator buttons,
TextEdit value changes, secure fields, ambiguity, unsupported input and interrupted streams. They
do not prove that a real app emits every required notification. A passive native trust preflight
does not prove a user demonstration or successful replay. We did not perform a live user demonstration.

The installer tests prove planned plist contents, explicit confirmation, save/remove behavior,
overlap refusal, revocation, pause/resume and cleanup paths through simulated transports. They do
not prove launchd delivery or notification presentation. The first brief prohibited a real installation;
the follow-up authorizes it when the live lock and permissions permit.

## Follow-up

Rebased onto `private/pane/auto-mode` at `e42b974`. The package prose list keeps both sides.
Recording now needs an interactive terminal and filename, notifies on start and stop, and refuses
text fields with prior contents. Installation and removal ask for typed confirmation in the terminal.
Runs require two minutes idle, recheck before each input, log active skips, notify busy skips,
recover locks only after their owners and relay groups are gone, and resolve the installed plugin
through a stable launcher. Detached replay forwards terminal signals.

Ruling: existing window IDs replace app-name acquisition, without a fallback. The installed engine
documents app-name acquisition as launching a missing app. Checking first leaves an exit race.
A Mac engine rejecting window IDs cannot run routines. This compatibility limit
requires a live check when the owner grants permissions. The engine and helper are unchanged.

The [follow-up results](2026-10-10-routines-demo-followup-results.json) record focused checks,
native permission preflight, live-lock refusal and final gates. A native preflight compiled the helper
and returned `trusted: false`, `listening: false`. App observation did not start, and permissions were
neither requested nor answered. A separate live attempt found the shared lock occupied and stopped.
Calculator/TextEdit capture and replay, real routine installation, idle delivery and removal remain
unverified. Large logs were dropped as requested, with their historical result counts retained.

Fresh review found relay collection waiting for descendant-held pipes, and ownership receipt failures
escaping cleanup. Regression tests reproduced both before the fixes. Collection now begins on leader
exit, and lifecycle handlers precede the receipt callback. An uncertain collection preserves the lock.
A launch-in-progress marker also blocks crash recovery when the relay PID was not safely recorded.
The focused selection passes 68/68. The stale-lock note now distinguishes automatic recovery from
manual inspection cases. The ordinary full check exited 1 on sandbox socket and output-write denials.
The first host check passed 1,185/1,186. An unchanged assertion about restarting the app-health helper failed.
Its focused selection then passed 8/8 without edits. The next bare `npm run check` exited 0 with
1,186 Node tests, both manifest validations and the mod checks passing. The failed attempt remains
in the results JSON. Production app-health code and its deadlines are unchanged.

## Idle skip cost, 2026-10-10

Temporary HOME and simulated launchctl. HIDIdleTime was 11.521 s (active).

| Path | Wall ms | CPU user ms | CPU system ms |
|---|---:|---:|---:|
| Before: compile the observer, then skip | 4464.682 | 1.742 | 7.521 |
| After: `ioreg` HID idle, then skip | 74.774 | 4.687 | 2.538 |
| Cached helper open after that compile | 0.203 | 0.114 | 0.085 |

The after path did not call `host()`. A later skip with injected idle 0 (no `ioreg`) was 4.976 ms wall.
