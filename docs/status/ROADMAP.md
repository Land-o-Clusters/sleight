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

Done: the relay "spike" was a timing bug (real relay time is about 0.4 s a pass). Measured and
dropped: a first-call hint (8/12 runs still called `getState` first), trimming the engine's docs
(about 0.1 s a run), and screenshot scaling (`perf/screenshot-scale`, 92 turns against 85 in 9 runs each).

- Speed under load (owner, 2026-10-09). The owner's dev Mac always runs big local tests, and
  sleight must hold up there as Codex does. Run the same tasks through sleight and Codex, unloaded
  and under load, and find where sleight's extra time goes: its guard reads, its own Accessibility
  checks (0.5 s deadline) and the relay. On 2026-10-09, at a load average of about 100, one engine
  read took 17 s, and that engine is the one Codex uses too. First measurement (`load-cost`, no
  model): without load the guard turns eight clicks from 593 ms into 3,609 ms, and under load it
  stopped 5 of 5 such calls on a renumbering check, against 0 of 5 without load. The false stops
  were degraded reads (`7d63e48` fixed them, 0 of 5 under load after). The cost is a settle wait of
  about 400 ms per action, tens of seconds under load, and the engine's inventory doesn't list windows to
  check instead. Astra builds a native window check for keys, text and coordinates
  (`.dev/prompts/astra-guard-speed.md`, `codex/guard-speed`).
- Batching (owner, 2026-10-09). Claude's own computer use groups more actions into one call. In 887 benchmark
  transcripts, 62% of `js` calls that act send one action, and 35% of all calls only read. Find
  what keeps Claude from batching (the guard's per-action reads, the skill, the tool description)
  and measure fewer turns before releasing a change.
- Model time is about two thirds of every run, so turns are the lever: each costs 2 to 2.7 s.
- Guard reads after an action wait about 410 ms each for the UI to settle. A cheaper identity check
  (the engine's app inventory answers in 11 to 30 ms) for actions on coordinates, keys or text would keep
  the window check without the full read. Stable-controls mode (3,775 ms to 801 ms on Calculator)
  gives up checks, so it stays out unless the owner chooses it.
- A warm-up read right after launch (one cold Calculator read took 16.7 s).
- textedit-save spent 7 to 17.5 s per run in guard reads. Fold the last read into Claude's own.

## 4. Realistic apps (Sol)

- Briefs 6, 7 and 7b are built. Qualification on 2026-10-09 went 3/3 each for Helium, Preview, Finder and TextEdit with
  Calculator. Safari, helium-dense and word-edit blocked by harness problems.
- Brief 8 fixes those (`4323a41`, done 2026-10-09). sleight-arch then reruns qualification with the owner away.
- Mail and Mimestream run while the owner watches. simulator-flow runs with the owner away.
- sleight-arch reviews, rebases onto `pane/auto-mode` and merges.

## 5. After 1.0, in the owner's order

1. A real-use pass, then the Codex head-to-head on it (needs a Codex arm for the real suite).
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
