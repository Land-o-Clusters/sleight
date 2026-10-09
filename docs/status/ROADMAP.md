# sleight roadmap

Everything we intend to do, in order. [STATE.md](STATE.md) says where we are now, and
[LAWS.md](LAWS.md) says what's always true. When the owner adds or corrects anything about the plan,
sleight-arch writes it here in the same turn. When asked for the plan, answer from this file whole.

The tracks run in parallel. Live runs that can take the owner's pointer or keyboard wait until
they're away. Sol works track 4, and sleight-arch works tracks 2 and 3 while the owner is at the Mac.

## 1. Release 1.0 (done: v1.0.0, 2026-10-09)

1. The Chess and simulator head-to-head and a release pass, with the owner away (running 2026-10-09).
2. A controlled Chess check: the same engine drag from the pawn's base and its head on
   `pane/auto-mode`, to tell where the model aims from a regression.
3. If no new failure is sleight's fault, the 1.0.0 steps in STATE, then the owner's install.

## 2. Fixes

Done in 1.1.0 (2026-10-09): `drag` says when it timed out and releases a stuck button, refuses a
covered drag with no text and points to `app.drag`; an un-awaited failed action keeps the session; a
call that meets a restarting helper is resent once; a stale element number goes out as its line; an
app sleight acted on that holds a keyboard tap is named at turn end. Measured and dropped: the 3D
"press the head" hint, which backfired in a small Chess window.

Open, in order of user impact (full list in [known-problems.md](../known-problems.md)):

- Full screen and Split View failed 8 of 21 runs. Detection is built (unreleased, after 1.1.0): an
  app read says so. Left: a pass in real Split View with the Claude app, at release.
- In the simulator, Claude's first tap on a Safari field often doesn't focus it (6 of 6 runs with shrunk
  screenshots), and Claude second-guesses the screenshot's scale there.
- `typeText` after select-all wrote `Engine01engine01`. Send exact text by paste and verify it.
- The TextEdit save lock: the Shift-event fix measured 0/10 hangs, but we don't know why it works.
- Live checks for the unit-tested 1.1.0 changes: the helper resend, the stale-number remap and the
  keyboard-tap notice.
- Smaller ones: a moved word in rich text should keep the formatting it had, `/sleight stop` in the
  desktop app, TextEdit's orphan Save Panel diagnosis, the doctor probing a per-app read, removing a
  stale launchd job without help, per-site flow rules, the `blocked_app` check missing a localized
  Settings title, a live `menu_bar` check, clipboard preservation's 205 to 236 ms, and desktop
  sessions that stay busy.

## 3. Performance (owner's goal: lightning fast)

The owner's bar (2026-10-09) is what people love in Codex's computer use. sleight has to be
lightning quick and stay quick under any load, and the Mac shouldn't feel it running. Codex drives
the same engine, so Codex's own numbers are the target. Anything sleight adds in time or CPU stays
only with a measured reason. In order:

1. Measure what sleight adds. A head-to-head on the same tasks with sleight and Codex, at the
   owner's normal load and with added load, recording time, turns and the CPU seconds of each arm's
   own processes (sleight's relay, mod, helper spawns and pane snapshots against Codex's).
2. Cut the reads Codex doesn't make. A read right after an action waits for the UI to settle
   (about 400 ms, tens of seconds under load). The guard does one before each action after the
   first in a call and one after the call. Done for keys, text, paste and coordinates (`44700ee`,
   owner's call, `SLEIGHT_GUARD=careful` keeps the read). Numbered actions keep it, since it catches
   renumbering. The read after the call saves Claude a turn, so it stays only if the head-to-head
   shows it pays.
3. Stop spawning processes per call. Done for app probes: one long-lived helper per session, about
   33 ms a probe against about 180 ms a spawn (`818f7e7`). Left, from a code audit (2026-10-09, costs
   unmeasured until the footprint run). The pane snapshot decodes a full screenshot in JavaScript
   after each turn that used sleight. A second engine starts at launch to find browser extensions,
   which slows the first call. Local tools spawn `osascript` twice per call, each lease operation
   opens SQLite, and the keyboard-tap scan holds up the turn end. Rank them by the footprint numbers.
4. Fewer turns. Model time is about two thirds of a run, so batching like Claude's own computer use
   is the largest lever left once the reads are cheap. A transcript study (2026-10-09) found 13 to
   20% of calls could have merged with the one before, mostly save-then-close and keys after a
   click. The engine's description says to send only an acquisition first, and 798 of 799 sessions
   did. `SLEIGHT_FIRST_CALL_BATCH=1` (`6cd41ba`) rewrites that sentence; A/B it on the default suite's
   turns, then make it the default or drop it.
5. A release only when the head-to-head shows sleight at Codex's speed and footprint, with the numbers
   published.

Done: the relay "spike" was a timing bug (real relay time is about 0.4 s a pass). Measured and
dropped: a first-call hint (8/12 runs still called `getState` first), trimming the engine's docs
(about 0.1 s a run), and screenshot scaling (`perf/screenshot-scale`, 92 turns against 85 in 9 runs each).

- Background for step 1 (2026-10-09). `load-cost` (no model): without load the guard turned eight
  clicks from 593 ms into 3,609 ms. Under load it stopped 5 of 5 such calls on degraded reads
  (`7d63e48` fixed that). The engine's inventory doesn't list windows, and Astra's native window
  check failed (`674502d`): the engine's JavaScript can't open a socket, and an Accessibility observer
  failed 14 of 20 reads at load 62 to 67. A loaded Mac starves any window check.
- In 887 benchmark transcripts, 62% of `js` calls that act send one action, and 35% of all calls
  only read. Each turn costs 2 to 2.7 s.
- A warm-up read right after launch (one cold Calculator read took 16.7 s).
- textedit-save spent 7 to 17.5 s per run in guard reads. Fold the last read into Claude's own.
- Stable-controls mode (3,775 ms to 801 ms on Calculator) gives up checks, so it stays out unless the
  owner chooses it.

## 4. Realistic apps (Sol)

- Briefs 6 to 10 are built and squash-merged into `pane/auto-mode` (through `309c2c9`).
  Qualification on 2026-10-09 passed Helium, Preview, Finder and TextEdit with Calculator 3/3 each,
  and all 11 web tasks 1/1. Still to qualify are Word, Excel and PowerPoint with brief 10 and
  simulator-flow (owner away), and Mail and Mimestream (owner watching).

## 5. After 1.0, in the owner's order

1. A real-use pass, then the Codex head-to-head on it. The Codex arm runs the real suite
   (`768cbcd`, helium-form 1/1), so this is the head-to-head in track 3, step 1.
2. Fill the [PENDING] lines of the launch post in `~/Desktop/sleight-launch/thread-1.0.md`.
3. Replay: a successful run turns into a script that replays through the engine with no model,
   keeping sleight's guards, so it stops when the app isn't in the state the script expects. First
   version built 2026-10-09 (`sleight-mcp record` and `replay`, `docs/design/replay.md`). Next: replay
   from the desktop app, steps that wait for the app instead of failing, and Claude taking over at
   the step that stopped.

## 6. Features after replay

The owner's rule, in order: do what competitors do but better, then improve where they haven't, then
build what nobody has. Sources are `.dev/research/2026-10-04-competitors.md` and the README roadmap.

- Separate results for "input sent", "the UI changed" and "saved", with a reason when unverified.
- Other hosts, such as Codex CLI, Cursor and any MCP client (LCU's main advantage).
- One lease and consent broker shared by Claude, Codex and other runtimes (without leases, two
  sessions typing into one document doubled the text 5/5).
- Review unsaved changes and app state, not only saved files.
- Approvals scoped to read, control or sensitive actions, with expiry, and a required confirm for
  anything irreversible.
- Scheduled routines built on replay.
- A published table of what works in the background, and receipts of each run's actions with
  redaction.
- Stop that confirms the Mac stopped, element waits, exact window targeting for untitled windows,
  and recording a task from the user's demonstration.
- Windows, tested in a Windows 11 ARM VM (owner's idea, 2026-10-09). Codex computer use reached
  Windows on 2026-05-29, foreground only. First check, in a free UTM VM, whether that engine runs on
  ARM and exposes the same `cua_repl` API. The relay, guards, mod and benchmark could carry over.
  `drag.js`, `menu_bar`, `notifications`, `blocked_app`, the keyboard-tap check and the launchd watch
  are macOS-only. Paid VM software is the owner's call.
