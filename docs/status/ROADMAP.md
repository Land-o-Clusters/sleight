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

## 2. Next release: fixes

Chess and drag (owner, 2026-10-09: fix even though it isn't a regression):

- `drag` tries the background first on covered non-text apps. Codex's engine drag moved a covered
  Chess pawn (2026-10-09). Measure before changing the default.
- `drag` reports when nothing changed, and the skill says 3D boards take a piece at its visible top
  (every passing Chess run grabbed at y 1175 to 1202, every miss lower).
- `drag.js` once exited "Command failed" with no message (chess-drag run 2, 2026-10-09).

Known problems, in order of user impact (full list in [known-problems.md](../known-problems.md)):

- Device Hub's keyboard tap froze the whole keyboard. The product, not only the benchmark, should
  detect a stalled tap and say which app holds it.
- Full screen and Split View failed 8 of 21 runs. Detect it before acting and say so.
- A failing un-awaited action kills the JS session and every handle (3/3). Parse the code instead
  of matching statement shapes.
- The helper quits after about 20 s idle and the next call can fail. Keep it warm.
- `typeText` after select-all wrote `Engine01engine01`. Send exact text by paste and verify it.
- The TextEdit save lock: the Shift-event fix measured 0/10 hangs, but we don't know why it works.
- Diff reads refuse actions when a page renumbers its elements (8 refusals on CNN).
- Smaller ones: a moved word in rich text should keep the formatting it had, `/sleight stop` in the
  desktop app, TextEdit's orphan Save Panel diagnosis, the doctor probing a per-app read, removing a
  stale launchd job without help, per-site flow rules, the `blocked_app` check missing a localized
  Settings title, a live `menu_bar` check, clipboard preservation's 205 to 236 ms, and desktop
  sessions that stay busy.

## 3. Performance (owner's goal: lightning fast)

- Find the relay spikes: 0.37 s across 21 runs earlier, 9.98 s across 15 in the 2026-10-09
  head-to-head, with 9 runs at 955 to 2,481 ms.
- Stable-controls mode from `docs/design/engine-time.md` cut Calculator's sequence from 3,775 ms
  to 801 ms. Guard reads were 78 of 150 s of engine time in that head-to-head.
- Fewer turns: the skill shows acquiring and acting in one call (each turn costs 2 to 2.7 s of model
  time).
- A warm-up read right after launch, and measure the acquisition-read reuse (`03d9af7`), since one
  cold Calculator read took 16.7 s.
- Measure what the engine's 21,000-character first-call docs cost, then shrink or cache them.
- textedit-save spent 7 to 17.5 s per run in guard reads. Fold the last read into Claude's own.

## 4. Realistic apps (Sol)

- Brief 6 closes two safety gaps and the 10 setup failures, then qualifies five tasks.
- Brief 7 adds localhost web pages of six kinds, Word, Excel and PowerPoint, and Mail on a fixture
  mailbox.
- Brief 7b adds Mimestream on the owner's Gmail. It only reads, and results leave out all mail.
- sleight-arch reviews each round, reruns its checks and merges. simulator-flow runs with the owner
  away.

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
