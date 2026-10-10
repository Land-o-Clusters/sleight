# Scheduled routines

A routine replays a saved task without a model. It stops at the first refusal or unknown outcome,
writes a private log and sends a macOS notification. A person decides how to continue.

`sleight-mcp routine add task.json --every 15m` prints the complete launchd plist and paths before
making any change. Type `install` in that terminal to install it. `list`, `remove <id>` (also `--remove`),
`unlock <id>` and `run-now <id>` manage that same saved copy. Intervals accept whole seconds, minutes, hours or
days, from 60 seconds to 31 days. The job runs only in the logged-in user's GUI session; missed
runs do not queue. It does not wake the Mac or run at load.
Removal asks you to type `remove`. Unlock asks you to type `unlock`. Both changes refuse non-terminal stdin. The `--yes` flag is removed.

Scripts and metadata live under `~/Library/Application Support/sleight/routines/<id>/`.
Logs live under `~/Library/Logs/sleight/routines/<id>.jsonl`. Both are private to the user. A run
lock prevents overlap, and a stopped routine is paused until a successful explicit `run-now`.
Removal unloads the job and deletes its saved script and plist, preserving logs.
The lock records its process PID and start time. SQLite admission releases on process death.
Recovery also requires the former PID and every recorded relay group to be gone, or a live PID whose
start time no longer matches. A matching live owner still blocks recovery. Missing or damaged
ownership records and unknown launch ownership need `routine unlock`. Busy runs log and notify.

The first idle check reads `ioreg -c IOHIDSystem` HIDIdleTime (nanoseconds). A skip never compiles
the observer. The Swift helper compiles once per source hash under `~/Library/Caches/sleight/observer`.
Before each input, the compiled check requires two minutes without input in the combined login
session. It checks again after the AX read. An active initial session, or a person returning during
replay, logs a skip and tries at the next interval. A mid-run skip notifies once.
Every selected app must already be running with one window. Acquisition uses `cua.getApp` with that
app's bundle ID, then confirms the window's exact title (and URL when present) from the read before
any input. A mismatch stops the run. A name lookup could still launch an app that exited between the
native check and acquisition. Routines never call activation, focus or window-raise APIs.

Unattended execution accepts a small grammar: one app acquisition per handle, then awaited calls
with literal JSON arguments on those handles. Selectors must use an ID, label or exact tree line.
Coordinates, drags, focus, activation, arbitrary JavaScript and position opt-ins are refused before
starting the relay. The user's fixed preapproved-app file must cover every app at medium risk on
each run. The ordinary relay still enforces its own approvals, risk checks, leases and guards;
routine execution declines every new prompt. Background events never borrow the global pointer or
keyboard. These restrictions reduce mistakes; they do not turn engine JavaScript into a security
boundary.

The plist invokes `~/Library/Application Support/sleight/routine-launcher.mjs` through Node. On each
run, this stable launcher reads the OS user's Claude plugin registry and resolves the current user
install. Missing or ambiguous installs notify and stop. The launcher remains after removing a routine.
Tests use a temporary home and injected terminal confirmation, launchctl and replay. Production
storage, registry and preapproval authority use the OS user's home.

## Work plan

- Add and test a strict routine script parser, interval validation and launchd plan rendering.
- Add private storage, explicit installation/removal, overlap and paused-stop handling, replay and
  notification delivery. Exercise them through temporary storage and simulated launchctl/replay.
- Observe Calculator and TextEdit demonstrations through an AX observer. Check trust without
  prompting, select stable element identifiers, reject secure fields and ambiguous observations,
  and save the existing replay format without replacing a file.
- Wire the CLI, document observation limits, publish every verification attempt, run the two bare
  project checks, rebase onto the public working ref, and push only this branch to the private remote.
