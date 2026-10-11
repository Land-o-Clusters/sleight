# sleight roadmap

Everything we intend to do, in order. [STATE.md](STATE.md) says where we are now, and
[LAWS.md](LAWS.md) says what's always true. When the owner adds or corrects anything about the plan,
sleight-arch writes it here in the same turn. When asked for the plan, answer from this file whole.

This release is due 2026-10-10 (owner). Codex is out of quota, so Grok and GLM lanes take the code
work in `.dev/prompts/lane-*.md`. sleight-arch merges it and runs the live checks before the release. The tracks run in parallel. Live runs that can take the owner's pointer or keyboard wait until
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
- `typeText` after select-all wrote `Engine01engine01`. The skill now says to paste and compare
  (`05903fa`, 6/6 on the TextEdit tasks). Likely cause (2026-10-10, inferred from tree sizes, not
  confirmed): a pending TextEdit capitalization suggestion took Cmd+A, so nothing was selected. The
  relay's settle read was there, so it isn't sleight's. Confirm with
  `bench/small-fixes-textedit.mjs --quick` (`.dev/research/2026-10-10-select-all-typetext.md`). Its
  "Ambiguous TextEdit process" refusal is fixed (`a021a7c`).
- The TextEdit save lock: the Shift-event fix measured 0/10 hangs, but we don't know why it works.
- Live checks for the unit-tested 1.1.0 changes: `bench/live-checks-1-1.mjs` (`5690bf2`) runs the
  stale-number remap and `menu_bar`. The helper resend and the keyboard-tap notice skip, since
  forcing them would mean killing OpenAI's helper or installing a tap.
- Smaller ones: a moved word in rich text should keep the formatting it had, `/sleight stop` in the
  desktop app, TextEdit's orphan Save Panel diagnosis, a live `menu_bar` check, and desktop sessions
  that stay busy. Done 2026-10-10: the doctor's per-app read (`83188cf`, `ac9f0d2`), per-site flow
  rules (`83188cf`), localized Settings titles in `blocked_app` and the clipboard helper (`05903fa`).
  Stays manual: removing the helper's stale launchd job, since that changes OpenAI's helper state
  (doctor prints the command).

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
   renumbering. The read after the call stays (study 2026-10-10, 93 runs). Codex makes it after
   527 of 527 acting calls, the lease needed it in 17 of 59 calls, and it costs a mean 1.3 s a run.
   Done 2026-10-10 (`12042e8`): a call that only acquires and prints the app counts as that read,
   and a call's first key, typing or coordinate action reuses Claude's full read when it's under
   10 s old (owner's call). Cutting the guard's reads of Save and Open sheets (5.2 s a run in
   textedit-save) isn't possible on engine 26.1007.21159, which has no partial read (`d008140`).
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
   did. Rewriting that sentence is the default since 2026-10-09, after an A/B cut turns from 208 to
   168 in 24 runs a side (`docs/benchmark.md`). Merging later calls (save-then-close, keys after a
   click) is still open: wording that asked for it (`SLEIGHT_FIRST_CALL_BATCH=merge`) cut total time
   20% in 24 runs against 18 on Haiku, but save and close never shared a call, so it stays opt-in
   (`docs/benchmarks/2026-10-10-merge-ab.md`). The cost of guard reads before each numbered action
   in a batch is open too.
5. A release only when the head-to-head shows sleight at Codex's speed and footprint, with the numbers
   published. On 2026-10-10 (Haiku, engine 26.1007.21159) time and turns were at
   parity (263 s against 257 s, 61 turns each) and CPU wasn't (76.5 s against 60.2 s over six runs),
   with the excess in the engine helper and engine node, where guard reads land
   (`docs/benchmarks/2026-10-10-h2h-footprint-haiku.md`). With the benchmark's folder trimmed and
   the guard's first-action reuse (`a104a0d`): 190 s against 176 s, 44 turns against 45, own CPU
   58.4 s against 47.2 s (`2026-10-10-h2h-footprint-haiku-3.json`). Guard reads were 23.3 s:
   15.0 s in textedit-save's sheet and 7.5 s in Calculator, about 430 ms before each click in a
   batch, which Codex doesn't read. Those reads stay, because the engine takes only element numbers
   (LAWS). At `d575dcf` sleight led on total time and turns (313.3 s and 79 against 340.2 s and 83)
   and still trailed on own CPU (78.2 s against 54.3 s, with the owner's plugins loaded) and on
   calculator-click. There, in 2 of 3 runs, the batch result read "no change" after 7 clicks, and
   Claude read again (`docs/benchmarks/2026-10-10-h2h-afternoon.md`). Next: find that result's
   cause from full traces. Then run the quiet-box CPU comparison.

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
- textedit-save spent 7 to 17.5 s per run in guard reads. Folding the last read into Claude's own
  is already how the guard works. The sheet reads above are most of the rest.
- Stable-controls mode (3,775 ms to 801 ms on Calculator) gives up checks, so it stays out unless the
  owner chooses it.

## 4. Realistic apps (Sol)

- Briefs 6 to 10 are built and squash-merged into `pane/auto-mode` (through `309c2c9`).
  Qualification on 2026-10-09 passed Helium, Preview, Finder and TextEdit with Calculator 3/3 each,
  and all 11 web tasks 1/1. Word, Excel and PowerPoint passed 1/1 each (Excel and PowerPoint on
  2026-10-09 at `76cf880`). Still to qualify are simulator-flow (owner away), and Mail and
  Mimestream (owner watching).

## 5. After 1.0, in the owner's order

1. A real-use pass, then the Codex head-to-head on it. The Codex arm runs the real suite
   (`768cbcd`, helium-form 1/1), so this is the head-to-head in track 3, step 1.
2. Fill the [PENDING] lines of the launch post in `~/Desktop/sleight-launch/thread-1.0.md` (done
   2026-10-09 with the real-use head-to-head).
3. Replay: a successful run turns into a script that replays through the engine with no model,
   keeping sleight's guards, so it stops when the app isn't in the state the script expects. First
   version built 2026-10-09 (`sleight-mcp record` and `replay`, `docs/design/replay.md`). Done
   2026-10-10 (`e12aef4`): steps that wait for the app, and Claude taking over at the step that
   stopped. Replay from the desktop app merged on 2026-10-10.

## 5b. Before this release (owner, 2026-10-10)

1. Match and beat Codex in the head-to-head on time, turns and own CPU. The `let app` failure and the
   lease refusals are fixed (`80b5abc`), and the Save-panel lines are next.
2. A CPU comparison on a quiet box, with clean arms and the owner's normal setup, both published.
3. Shopping tasks: a local shop page (ZIP store lookup, search, add 3 items to cart) in both
   browsers, and one-run real-site smoke tasks.
4. Electron and Gecko: tasks for VS Code, Cursor, Firefox, and read-only Slack, Discord and
   WhatsApp. iPhone Mirroring with the owner at the Mac: the task is built (`1c0b4b5`) and needs
   `--owner-present`.
5. A head-to-head with LCU again after these are merged. LCU 0.11.2 is installed (owner's OK,
   2026-10-10), and its arm is outside the repo (`bench/lcu-arm-setup.mjs`).
6. Anthropic's directory listing (owner, 2026-10-10). Submission is at claude.ai/directory/manage
   from the public repo. The plugin folder passes the mechanical checks (50 files, the largest 142
   KB, an MIT license field). Unknown: how review treats the ChatGPT engine dependency, and whether
   the mod's self-approval of its own pane snapshot reads as changing Claude's permissions. A
   privacy policy link is required: `docs/privacy.md` (2026-10-10). The owner chose not to ask
   Anthropic for now (2026-10-10).
7. Less setup in the ChatGPT app (owner, 2026-10-10). Today a user installs ChatGPT and turns on
   Computer Use in Codex once, which installs the helper and gets macOS permissions. The app
   needn't run after that. Found 2026-10-10: `codex plugin add` can't install the computer-use
   plugin (the CLI reserves the `openai-bundled` marketplace, which the ChatGPT app seeds into
   `~/.codex/.tmp`). The helper is inside ChatGPT.app with OpenAI's own installer
   (`Codex Computer Use Installer install|uninstall|status`; `status` printed "OK: installed" here),
   and the engine's command is in the app bundle too. So `sleight-mcp setup` could run that
   installer and open the two permission panes, with no Codex session. In a fresh macOS user with
   no `~/.codex` (puddle-census, 2026-10-10), `status` already said "OK: installed", and `install`
   asked for administrator access (Touch ID or password), then exited 0 without creating
   `~/.codex/computer-use`. The engine didn't start there, because the probe left out its
   node_repl path. Probe v2 sets the engine's whole environment and uses the helper inside
   ChatGPT.app where it is. In puddle-census, never signed in, it initialized the engine, listed
   its tools and answered the first call (the engine's docs). Probe v3 adds a `listApps` call,
   which listed apps there too. Built 2026-10-10 (`5a4a8c4`): `sleight-mcp setup`, and an engine
   started from ChatGPT.app when there's no Codex plugin, computer-only because the browser API
   needs a Codex sign-in. Left: a live `setup` run in a fresh macOS user. macOS permissions always
   need the user's click.

## 6. Features after replay

When a competing plugin is released (the owner expects one, 2026-10-10), sleight answers with a same-day
head-to-head, published in full, through a generic benchmark arm for any plugin or MCP server
(merged 2026-10-10, `5b7a16e`). Its paired live run waits for the owner to be away. Whether to release on speed before footprint parity is the
owner's call at that moment.

The owner's rule, in order: do what competitors do but better, then improve where they haven't, then
build what nobody has. Sources are `.dev/research/2026-10-04-competitors.md` and the README roadmap.

- Separate results for "input sent", "the UI changed" and "saved", with a reason when unverified.
  Merged 2026-10-10 (`f3d2790`, `8646071`), live 6/6 on Calculator and TextEdit, and 2/2 each on
  Chess and Safari-form with the owner away (`docs/benchmarks/2026-10-10-away.md`). A save named
  through Go to Folder and the panel's name field now reads as that file (`71c45ff`).
- Done 2026-10-10 (`6ca6639`): sleight runs from Cursor or any MCP client, with Claude first in the docs.
- One lease and consent broker shared by Claude, Codex and other runtimes (without leases, two
  sessions typing into one document doubled the text 5/5).
- Review unsaved changes and app state, not only saved files.
- Shelved (owner, 2026-10-10): scoped approvals (separate read and control grants, expiry, and a
  required confirm for anything irreversible). The design (`docs/design/scoped-approvals.md`)
  found a guard in Claude's JavaScript can't guarantee the confirm, and a TextEdit save would need 3
  prompts instead of 1.
- Scheduled routines built on replay.
- Done 2026-10-10: a published table of what works in the background (`docs/background.md`).
  Receipts of each run's actions with redaction: `codex/review-receipts`.
- Stop that confirms the Mac stopped, element waits and exact window targeting for untitled windows
  merged 2026-10-10 (`6291251`), with their live checks before release. Recording a task from the
  user's demonstration merged with routines (`da78144`). Its live check is open.
- Windows (owner's idea, 2026-10-09). Codex computer use reached Windows on 2026-05-29, foreground
  only. The relay, guards, mod and benchmark could carry over. `drag.js`, `menu_bar`,
  `notifications`, `blocked_app`, the keyboard-tap check and the launchd watch are macOS-only
  (`docs/design/windows.md`). Research on 2026-10-10 didn't find a public report of it working on ARM64,
  and one of it failing at startup there (Codex #52133). In a VMware VM screenshots timed out
  (#51589). An outside stdio client did start `cua-repl.mjs` and list apps, but only with the
  running ChatGPT app's native pipe directory (#45948). Plan (2026-10-10): the owner's 2020 Intel
  MacBook Pro (16 GB) runs VMware Fusion, free, with Windows 11 Enterprise's free 90-day x64
  evaluation. Boot Camp is the fallback if the engine fails in the VM. The owner registers,
  downloads, installs ChatGPT and turns on OpenSSH. sleight-arch runs the spike over SSH: engine
  start, app list, screenshot, one approved action.
