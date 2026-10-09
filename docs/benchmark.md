# Benchmark

`bench/` runs each task through headless `claude -p` and checks it outside the agent, against the file
on disk or the exact answer. sleight and LCU get the same prompt for each task, and the prompts
don't mention a tool by name.

Comparison with [LCU](https://github.com/amontlabs/lcu) 0.8.8, which drives the same engine, on
2026-10-03. Each task ran 3 times per arm on Claude Code 2.1.288 and its default model (Opus 5.5).
Each arm ran from an empty folder with only its own tool loaded. Both folders were inside this repo,
though, so both arms also loaded its CLAUDE.md and project memory (found 2026-10-05):

| Task | sleight | LCU | sleight median | LCU median |
|---|---|---|---|---|
| Calculator, clicking | 3/3 | 3/3 | 22 s | 14 s |
| Calculator, Scientific mode via menu | 3/3 | 3/3 | 24 s | 19 s |
| TextEdit, save a new file | 3/3 | 3/3 | 54 s | 63 s |
| TextEdit, edit a file | 3/3 | 3/3 | 34 s | 46 s |
| TextEdit, move a word by drag and drop | 0/3 | 0/3 | 43 s | 43 s |
| Chess, drag a pawn and save the game | 3/3 | 3/3 | 68 s | 75 s |

Both passed 15 of 18 and failed every text drag the same way (see [Known problems](known-problems.md)).
That was before sleight's `drag` tool. The local tool passed the text drag task 3/3 before the
window/content guards on 2026-10-04 (Sonnet 5.5,
[`2026-10-04-drag-tool.json`](benchmarks/2026-10-04-drag-tool.json)).
With 3 runs per task, the speed differences are noise. The valid runs came to $16.00 at API prices.
Logged in through a claude.ai plan, runs use plan limits rather than money.

Getting a fair comparison took three tries, and every run is published. In the first (12/15 each,
[`2026-10-03-sleight-vs-lcu.json`](benchmarks/2026-10-03-sleight-vs-lcu.json)) the sleight arm
ran inside this repo and read the project's memory. The Chess runs
([`2026-10-03-chess-drag.json`](benchmarks/2026-10-03-chess-drag.json)) piled up Chess windows
until it hung. Then a user-level sleight install leaked into the LCU arm and failed four of its runs
([`2026-10-03-fair-rerun.json`](benchmarks/2026-10-03-fair-rerun.json) has those and the
rerun). The benchmark now checks before every run that each arm loads only its own tool and runs
from a folder outside any git repo.
LCU warned that this engine version is one it hasn't tested, and so is ours.

The release check for 0.7.0 on 2026-10-05 (Sonnet 5.5, medium) passed 16 of 18 from a clean arm
folder: 3/3 on every task except chess-drag, 1/3. Both Chess failures dragged the pawn to e5
instead of e4, an illegal move, so the board didn't change. textedit-drag passed 3/3 in that pass
and 3/3 in a rerun. Getting there took three earlier passes, which found a helper that wouldn't
launch, two harness problems and the leaking arm folder.
[The write-up](benchmarks/2026-10-05-release-0.7.0.md) has every run.

`simulator-form` (2026-10-07) is a mobile end-to-end test. Safari in an iPhone simulator opens a
form served from the benchmark's own process, and Claude types a nonce and taps Submit. The check
is what the server received. It passed 3/3 on an iPhone 18 Pro with iOS 27.0 in Xcode 27's
DeviceHub, which replaces Simulator.app: median 39.6 s and 8 turns, Sonnet 5.5 at medium. The pass
before it failed 0/3 in the harness, because the engine asks to approve "Device Hub" with a space and
the allowlist lacked it. Both passes are in
[`2026-10-07-simulator-form.json`](benchmarks/2026-10-07-simulator-form.json). The task needs Xcode
and an iOS runtime (`xcodebuild -downloadPlatform iOS`, 8 GB). Without them its runs are skipped.

## Real-use tasks

The [initial report](benchmarks/2026-10-08-real-use-tasks.md) and
[Known problems](known-problems.md) retain the earlier failed qualification passes.

The round-6 [report](benchmarks/2026-10-09-real-use-tasks-6.md) retains the fixture-only diagnostics.
sleight-arch later ran its 15 slots with the owner away. Simulator is excluded.
Safari's blank-window setup requires `--owner-away`, as does activation when background document
Close commands are disabled. Use that flag only after the owner confirms they are away.

| Task | Passed | Setup failures | Unstarted | Median s |
|---|---|---|---|---|
| safari-form | 0 | 3 | 0 | n/a |
| helium-form | 3 | 0 | 0 | 30.4 |
| preview-pdf | 3 | 0 | 0 | 19.7 |
| finder-files | 3 | 0 | 0 | 121.5 |
| textedit-calculator | 3 | 0 | 0 | 43.6 |

The [brief-8 report](benchmarks/2026-10-09-real-use-tasks-8.md) records that qualification and the
later failures in Safari, browser navigation and Word. The
[brief-9 report](benchmarks/2026-10-09-real-use-tasks-9.md) records the architect's rerun: all 11 web
tasks passed once each after the Safari correction. Word saved but failed ZIP validation; Excel
failed cold setup and quit confirmation. The [brief-10 report](benchmarks/2026-10-09-real-use-tasks-10.md)
records the next Office pass. Word's first AX read failed without retries because it was already
running, and Excel stopped correctly on its activation screen. Initial-read retries now cover both
running cases and await another architect rerun.

After brief 9, the Office rerun ([`real-use-office-10`](benchmarks/2026-10-09-real-use-office-10.json),
one run each, the owner away) failed before any model call. Word, left running by the earlier pass,
didn't answer its first focused-window read (-25204) with the Mac's load near 124. Excel showed its
first-run screen ("Start Using Excel"), which the harness classed as activation and stopped on
without touching. PowerPoint didn't run.

After brief 10 and the owner's click past Excel's welcome screen, the Office rerun
([`real-use-office-11`](benchmarks/2026-10-09-real-use-office-11.json), one run each, the owner away)
passed word-edit in 42.2 s and 10 turns, with Word's own dialogs recorded and left to Claude.
excel-edit made and saved its edits, then cleanup's read of Excel's focused window timed out
(-25204) and stopped the pass, so powerpoint-edit didn't run. Cleanup reads don't retry yet.

The Codex arm now runs the real suite. Its first run, helium-form on gpt-6.1-sol at medium, passed in
36.5 s and 8 model requests with 6 engine calls, and the engine's "Always allow" list was restored
byte for byte afterwards ([`codex-real-first`](benchmarks/2026-10-09-codex-real-first.json)).

The round-5 [report](benchmarks/2026-10-08-real-use-tasks-5.md) records 16 of 18 slots, 6 passes,
10 setup failures and 2 unstarted Simulator slots. All 6 model trials passed.

### Round 7

The [report](benchmarks/2026-10-09-real-use-tasks-7.md) lists 20 new tasks, each with one requested
Sonnet 5.5 medium trial. The browser IDs pair `safari-` and `helium-` with `grid`, `editor`, `dense`,
`spa`, `nested` and `infinite`. Office adds `word-edit`, `excel-edit` and `powerpoint-edit`.
Mail adds `mail-folder`, `mail-message`, `mail-thread`, `mail-attachment` and `mail-search` in a
local invented mailbox. All 20 dry fixtures ran. The architect's later desktop pass passed 11 web
tasks once each. Word continued past its Replace All result dialog and saved; its checker then
rejected a ZIP entry. Excel stopped during cold setup, and PowerPoint did not run. Office remains
unqualified. Mail waits until the owner can watch it.

Brief 7b adds `mimestream-label`, `mimestream-message`, `mimestream-thread`, `mimestream-scroll`
and `mimestream-search` on the owner's signed-in Gmail. Select those IDs in a separate sleight pass.
Their results retain only verdicts, seconds, turns and salted answer hashes. The adapter requires
explicit read state and unchanged mailbox counts, preserves Mimestream, and closes only its new
window. Live qualification waits until the owner can watch it.

## Time per run

Each run's result now splits its time. Claude Code reports the time spent in the model API, and
sleight's trace times each tool call in the engine, in sleight's own local tools (`drag`, `hover`)
and in the relay. The rest is Claude Code itself, mostly startup. The first timing pass, on
2026-10-07 with Sonnet 5.5 at medium effort, 3 runs per task
([`2026-10-07-timing.json`](benchmarks/2026-10-07-timing.json)), put 65.4% of the time in the
model, 23.6% in the engine, 4.8% in local tools, 6.2% in Claude Code and 0.1% in the relay (14 to
51 ms per run). Medians per task:

| Task | Passed | Total s | Model s | Engine s | Turns |
|---|---|---|---|---|---|
| calculator-click | 3/3 | 20.7 | 14.2 | 4.6 | 9 |
| calculator-menu | 3/3 | 38.1 | 26.9 | 5.3 | 15 |
| textedit-save | 3/3 | 68.8 | 47.1 | 18.5 | 24 |
| textedit-edit | 3/3 | 29.1 | 17.1 | 8.8 | 12 |
| textedit-drag | 0/3 | 67.3 | 39.0 | 3.6 | 16 |
| chess-drag | 3/3 | 58.2 | 34.3 | 15.9 | 18 |
| simulator-form | 3/3 | 28.9 | 19.4 | 7.1 | 8 |

The owner was using the Mac during the pass, with another sleight session driving iPhone
Mirroring. textedit-drag failed 0/3 because the Claude app and Grok Bot covered the TextEdit
window, and `drag` refuses to press where another window covers the point. 8 of the 21 runs had
at least one call refused by sleight's guards, each costing Claude an extra turn.

With element IDs and labels in the skill (0.13.0), a second pass on the same settings
([`2026-10-07-element-ids.json`](benchmarks/2026-10-07-element-ids.json)) had 7 refused calls
instead of 14, 5 runs with a refusal instead of 8, and 281 turns instead of 300. calculator-menu
went from a median of 15 turns to 7 and calculator-click from 9 to 6. It passed 19/21 against
18/21. Total time rose from 902 s to 1,172 s, mostly in the model: 2.59 s per turn against 1.96 s,
and one 5-turn Calculator run spent 54 s waiting on the model. chess-drag failed 2/3: in one run
Grok Bot and the Claude app covered the board, and in the other `drag` couldn't match the Chess
window to an accessibility window.

In those two passes 94 of 437 calls returned an error, and each one cost Claude a turn. Apart from
covered windows, 0.13.1 fixes the four biggest causes:

- A Save panel's Go to Folder sheet stopped the input lease (18 errors).
- Claude called `js`'s parameter `command` (6).
- A read right after ⌘W failed because the last window had closed (7).
- The benchmark arm refused sleight's other tools (8).

The pass after it
([`2026-10-07-errors.json`](benchmarks/2026-10-07-errors.json)) passed 21/21 with errors in 23 of
181 calls (12.7%, from 21.5%). Against the first timing pass it took 260 turns instead of 300, 470 s
of model time instead of 589, and 825 s in total instead of 902, at 1.81 s of model time per turn
against 1.96. textedit-save didn't get faster (median 27 turns).

0.13.2 keeps the input lease after sleight stops an action, and its skill shows a Save As in one
call. Its pass ([`2026-10-08-save-in-one-call.json`](benchmarks/2026-10-08-save-in-one-call.json),
on ChatGPT engine 26.1002.52244) passed 20/21 and took 213 turns instead of 260, 131 calls instead
of 181, 436 s of model time instead of 470 and 687 s in total instead of 825. Model time per turn
rose from 1.81 s to 2.05 s. textedit-save took 16, 12 and 20 turns (median 16, from 27). Errors fell
to 15 of 131 calls (11.5%), 8 of them in the one failure: chess-drag's first run, where the engine
answered `noWindowsAvailable` for a freshly launched Chess window and `drag` called it off screen.

The same code then ran with three other models, one pass each, 3 runs per task, back to back on
2026-10-08, unattended (whether the owner was using the Mac isn't recorded):

| Model | Passed | Turns | Calls | Model s per turn | Total s | Files |
|---|---|---|---|---|---|---|
| Sonnet 5.5, medium | 20/21 | 213 | 131 | 2.05 | 687 | [`save-in-one-call`](benchmarks/2026-10-08-save-in-one-call.json) |
| Haiku 5.5, medium | 20/21 | 235 | 151 | 1.54 | 625 | [`haiku-medium`](benchmarks/2026-10-08-haiku-medium.json) |
| Sonnet 5.5, low | 21/21 | 199 | 131 | 2.31 | 827 | [`sonnet-low`](benchmarks/2026-10-08-sonnet-low.json) |
| Opus 5.5, medium | 21/21 | 223 | 118 | 2.41 | 808 | [`opus-medium`](benchmarks/2026-10-08-opus-medium.json) |

Haiku was fastest in total because its turns were shortest, though it took the most. Its one
failure was sleight's. The input lease didn't count `let app = await cua.getApp(…); app` as an
acquisition, and its advice didn't get Haiku out of that. 0.13.3 fixes
that, and its pass ([`acquisition-echo`](benchmarks/2026-10-08-acquisition-echo.json)) passed 21/21
on Sonnet 5.5 medium. Claude Code 2.1.289 calls `claude-haiku-5-5` an unrecognized model, so Haiku's
cost figures aren't shown here.

0.13.4's guard change ([`guard-reads`](benchmarks/2026-10-08-guard-reads.json)) passed all 20 runs
that started, in 195 turns and 121 calls, with 190 s in the engine against 191 s before. Model time
per turn was 2.51 s. chess-drag's first run was skipped: macOS failed to relaunch Chess right after
the benchmark quit it (`open` error -600).

0.13.5 (`getScreenshot()` reuses the engine's AX read, one `typeText` for contiguous text) passed
21/21 ([`engine-time-pass`](benchmarks/2026-10-08-engine-time-pass.json)) in 212 turns and 877 s,
with 275 s in the engine. calculator-click runs 1 and 2 took 83 s of that and 26 turns, while
Calculator's AX tree kept changing after launch. The other six tasks took 188 s in the engine against
173 s in the previous pass.

0.14.0 removes two turns that every run paid before its first action: loading the skill, and the
tool search that replaced it. Its pass ([`turns`](benchmarks/2026-10-08-turns.json)) passed 21/21 in
157 turns instead of 195, with 426 s of model time instead of 490 and 717 s in total instead of 756,
at 2.71 s of model time per turn against 2.51.

0.14.1 (Sol's hang diagnosis and Chess relaunch) passed 21/21
([`reliability-pass`](benchmarks/2026-10-08-reliability-pass.json)) in 157 turns and 586 s, with 332 s
of model time at 2.12 s per turn and no refused calls.

0.15.0 lets Claude acquire an app and act in one call. Its pass
([`acquire-and-act`](benchmarks/2026-10-08-acquire-and-act.json)) passed 21/21 in 156 turns and 638 s.
Claude never combined the two in these tasks. The pass checks that nothing broke and doesn't measure a
saving.

0.15.1 halves the skill and adds the fixes a trace of the slow tasks found. Its pass
([`skill-trim`](benchmarks/2026-10-08-skill-trim.json)) passed 21/21 in 140 turns and 531 s, with 271 s
of model time at 1.93 s per turn and 7.11M cached tokens read instead of 8.30M.

0.15.2 keeps the lease on a window that retitles itself and loads every tool up front. Its pass
([`retitle`](benchmarks/2026-10-08-retitle.json)) passed 21/21 in 123 turns, with 101 calls, none
refused and no tool searches. It took 582 s at 2.64 s of model time per turn. The full passes that ran on the way are published too, with their caveats:

- [`skill-trim-first`](benchmarks/2026-10-08-skill-trim-first.json), 0.15.1 before its last fix:
  21/21 in 140 turns. A combined call re-acquiring the simulator app threw in 2 runs. A Codex
  thread's Safari task also ran during it, because the runner didn't take the live lock yet.
- [`retitle-calculator-unresponsive`](benchmarks/2026-10-08-retitle-calculator-unresponsive.json),
  the Chess change: 21/21 in 157 turns and 923 s. Calculator stopped answering accessibility reads
  (12 to 15 s each, and `AXError.cannotComplete`) while two system dialogs were on screen.
- [`retitle-tools-deferred`](benchmarks/2026-10-08-retitle-tools-deferred.json), the Chess change
  with sleight's local tools still deferred: 21/21 in 139 turns, with 3 tool searches before drags.

The Codex thread's Safari run also overlapped `skill-trim` itself. The smoke tests on the turns
branch (calculator-click and textedit-save, 3 runs each, twice) weren't kept, because their
results were in a worktree that was removed.

Passes on the way to 0.16.0, before its drag change:

- [`await-stopped`](benchmarks/2026-10-08-await-stopped.json), the `await` check: stopped after 5
  runs, 2/5. All three TextEdit runs failed on reads that timed out, after an untitled document a
  failed run had left kept a Save sheet open. The runner now closes such documents between runs.
- [`covered-drags`](benchmarks/2026-10-08-covered-drags.json), the desktop pane changes: 18/21 in
  152 turns and 1,077 s, 2.30 s of model time per turn. The owner was using the Mac, and Claude or
  another app covered TextEdit at the drag points in every textedit-drag run, so `drag` took the
  foreground path and textedit-drag failed 0/3. Its window samples show TextEdit on the current Space
  throughout. One chess-drag run hit the runner's 5-minute limit after saving a correct game, so it
  passed without a turn count.

A head-to-head on the Calculator and TextEdit tasks
([`h2h-background`](benchmarks/2026-10-09-h2h-background.json), 3 runs each, Sonnet 5.5 against
gpt-6.1-sol, both at medium) went 15/15 for sleight in 101 turns and 446 s, and 12/15 for native
Codex in 129 model requests and 732 s. Codex failed textedit-drag 3/3: its background mouse drags
left the word where it was, as the engine's own drag did in every TextEdit text move we measured.
sleight moved it 3/3 with its `drag` tool. On the other four tasks both passed 3/3, with medians
within 11 s of each other. The models differ, so this compares the two products, not the
harnesses alone. The owner was using the Mac, and the sleight arm ran unreleased code with the
Accessibility text move (`ff3f406`). Chess and the simulator weren't run, because they can need the
pointer or the keyboard.

The first core head-to-head with native Codex computer use
([`h2h-core-stopped`](benchmarks/2026-10-09-h2h-core-stopped.json), Sonnet 5.5 against gpt-6.1-sol,
both at medium) was stopped after 19 of 42 runs, when the owner's keyboard stopped working (see
[Known problems](known-problems.md)). sleight passed 10/10 in 82 turns and 319 s; Codex passed 8/9
in 87 model requests and 406 s, failing its first textedit-drag. That's too few runs to compare.

0.16.0's pass ([`release-0.16.0`](benchmarks/2026-10-09-release-0.16.0.json)) passed 20/21 in 178
turns and 1,355 s, at 2.34 s of model time per turn. textedit-drag passed 3/3, with `drag` reading
Claude's screenshot pixels at the screenshot's scale. chess-drag passed 2/3. Its failed run hit the
5-minute limit with the game unsaved. A second, untitled Chess window sat over the game, so 6 of
Claude's 13 drags were refused as covered. The first calculator-click run took 99.5 s, 71 s of it in
the engine, right after Calculator launched. The owner was using the Mac during the pass.

The 1.0.0 head-to-head on Chess and the simulator
([`h2h-chess-simulator`](benchmarks/2026-10-09-h2h-chess-simulator.json), 3 runs each, Sonnet 5.5
against gpt-6.1-sol, both at medium) ran with the owner away. simulator-form passed 3/3 for both.
chess-drag went 0/3 for sleight and 2/3 for Codex. In every run of both arms, a drag that pressed
the pawn low on its body or on its square left it on e2. Codex's two passes came after it pressed on
the pawn's head, on its fourth try in one. The Claude app's window covered the Chess board, so
sleight's `drag` fell back to the foreground. The engine's own drag through the same covered window
moved the pawn for Codex. Once, `drag.js` ran past its 30 s limit and returned only "Command failed".
The relay times in these files are too high: the parser charged a split acquisition's engine time to
the relay (fixed after this pass).

1.0.0's pass ([`release-1.0.0`](benchmarks/2026-10-09-release-1.0.0.json)) passed 19/21 in 165 turns
and 912 s, at 2.59 s of model time per turn, with the owner away and the Claude app's window on
screen. chess-drag passed 2/3. Its failed run pressed only below the pawn's head. simulator-form passed
2/3: in its failed run Claude's first tap missed the field, and none of its four later taps and
typing put text in it.

1.1.0's pass ([`release-1.1.0`](benchmarks/2026-10-09-release-1.1.0.json)) passed 20/21 in 1,469 s,
with the owner away. Two chess-drag runs saved the right game and then ran into the 5-minute limit,
because Claude checked for the file with Claude Code's Glob, which never returned. simulator-form
failed once the way it did in 1.0.0: a first tap off the field, then no text from later taps. Relay
time, measured right now, was 0.4 s for the pass. chess-drag then ran 3 times with a skill hint to
press a 3D piece at its head, which missed in this small window, where the e-pawn's head sits behind the
king ([`chess-glob`](benchmarks/2026-10-09-chess-glob.json): 3/3, two of them at the limit). With the
hint replaced and Glob, Grep and Read disallowed, it passed 3/3 in 52 to 60 s and 10 to 12 turns
([`chess-no-glob`](benchmarks/2026-10-09-chess-no-glob.json)).

A branch that shrinks screenshots to 1,568 px and scales coordinates back was compared with 1.1.0 on
chess-drag, simulator-form and textedit-drag, 3 runs each, with the owner away
([`shots-base`](benchmarks/2026-10-09-shots-base.json), [`shots-scaled`](benchmarks/2026-10-09-shots-scaled.json)).
Both passed 9/9, in 85 turns and 475 s before and 92 turns and 485 s after. Only the simulator's
screenshots were over the limit. On the branch, Claude's first tap was at the right point of the
smaller image, yet it never focused the field (0 of 6 runs, with
[`shots-scaled-tap`](benchmarks/2026-10-09-shots-scaled-tap.json), where a skill line to tap and
type in separate calls didn't help). The branch (`perf/screenshot-scale`) stays unmerged.

A hint in the `js` tool's description to acquire the app in the first call, instead of calling
`cua.getState()` first, didn't change what Claude did
([`first-call-hint`](benchmarks/2026-10-09-first-call-hint.json), calculator-click, calculator-menu,
textedit-edit and textedit-save, 3 runs each, with the owner away). 8 of 12 runs still opened with
`cua.getState()`, against 30 of 36 before, and the 12 runs took 80 turns against 68 in the 1.0.0 pass.
It's reverted.

`bench/load-cost.mjs` times the same Calculator calls with no model, once sent straight to
the engine (which is what Codex does) and once through sleight. Each ran 5 times
([`load-cost`](benchmarks/2026-10-09-load-cost.json), 2026-10-09, with the owner away). At the Mac's own
load (about 10), eight clicks by number in one call took a median of 593 ms straight and 3,609 ms
through sleight, and one click took 75 ms against 501 ms. The guard's full read before each action
is that difference. With 20 CPU-bound workers added (load 10 to 45, overlapping another project's
timed tests), times swung too widely to compare medians: eight clicks went from 1,376 to 36,735 ms
straight to the engine. sleight's guard stopped all 5 eight-click calls under load, because a read
between clicks showed a different element at the next number, and none without load.

After the guard learned to match those degraded lines, a rerun sent each call through both paths in
turn, so both saw the same load ([`load-cost-interleaved`](benchmarks/2026-10-09-load-cost-interleaved.json)).
Other projects' tests kept the load near 20 before workers were added.

| Workers | Load | Call | Engine only, median | sleight, median | sleight stops |
|---:|---:|---|---:|---:|---:|
| 0 | 20 to 24 | eight clicks | 839 ms | 3,965 ms | 0/5 |
| 0 | 20 | one click | 87 ms | 841 ms | 0/5 |
| 20 | 22 to 79 | eight clicks | 23.3 s | 58.2 s | 0/5 |
| 20 | 96 to 121 | one click | 159 ms | 38.0 s | 0/5 |
| 20 | 135 | full read | 111 ms | 48 ms | 0/5 |

A read right after an action is what grows. With the guard's timing on, at loads of 42 to 53, its
read before a click took 38 to 83 ms and its read after took 389 to 427 ms, the same with a 2 s
pause between calls. The engine waits for the UI to settle after input, and on a loaded Mac that wait
ran to tens of seconds. A read with no input before it stayed near 100 ms even at load 135.

After `44700ee` (no read before keys, text, paste and coordinates after a call's first action),
a click followed by three keys took a median of 515 ms through sleight against 355 ms straight to the
engine, at load 8 to 9 with 5 runs each ([`load-cost-after-skip`](benchmarks/2026-10-09-load-cost-after-skip.json)).
Astra's run before the change measured 1,728 ms against 295 ms. One click (490 against 107 ms) and
eight numbered clicks (3,364 against 753 ms) still read, as numbered actions should. Three of five
sleight reads failed the script's own value check, because a read through sleight returns a diff
without the input field.

With the guard reading before the first action after an acquisition again, since the inventory it
relied on doesn't list windows, calculator-click passed in 3 turns and 14.1 s and textedit-edit in 6 turns and
23.5 s, one run each ([`reuse-smoke`](benchmarks/2026-10-09-reuse-smoke.json)).

textedit-drag ran once with a fixture app in full screen in front of TextEdit, after the relay
learned to say so, with the owner away. Both runs failed, as they should: a drag fails on
another Space. In the first, the check ran once per turn and caught TextEdit's Open panel, which
was on the full-screen Space, so no note came. Claude stopped when `drag` refused the off-screen
window, after 16 turns
([`full-screen-first`](benchmarks/2026-10-09-full-screen-first.json)). With the check on every app
read, the note came with Claude's first read, and Claude stopped after 12 turns and asked the user
to leave full screen ([`full-screen-every-read`](benchmarks/2026-10-09-full-screen-every-read.json)).
That run's first read got a scratch TextEdit window left from a hand check. The Mac's load
average was about 100 from other processes during both.

| Task | Median turns, 0.13.4 | 0.14.0 |
|---|---:|---:|
| calculator-click | 5 | 4 |
| calculator-menu | 7 | 4 |
| textedit-save | 16 | 10 |
| textedit-edit | 9 | 7 |
| textedit-drag | 11 | 8 |
| chess-drag | 15.5 | 13 |
| simulator-form | 7 | 5 | One pass per model can't separate a model from that hour's API latency.

From 2026-10-04 on, runs default to Sonnet 5.5 at medium effort (`--model`, `--effort`).

```bash
npm run bench -- --runs 3             # sleight only
npm run bench -- --arm all --runs 3   # sleight and LCU
```

The LCU arm needs LCU registered for Claude Code in a separate folder. `bench/run.mjs` has the steps.

Claude arms run with Bash, Write, Edit, Glob, Grep, Read, Skill and the web tools disallowed, since a user's settings can
allow them and a check could then pass without the app. Until 2026-10-09 they were allowed: no run
wrote a checked file through them (716 transcripts checked), but Claude often opened the task's file
with `open` from Bash instead of the app's Open panel. Glob, Grep and Read joined the list after the
1.1.0 pass, where Claude looked for its saved Chess game with Glob, which never returned, and 3
chess-drag runs that had saved the right game ran into the 5-minute limit. Skill joined after a
simulator run called another plugin's skill: the user's plugins load in benchmark runs.

The `codex` arm runs native Codex computer use through `codex exec`, for a head-to-head
(`--arm sleight,codex`). It uses its own Codex home, `~/.codex-bench` (log in once with
`CODEX_HOME=~/.codex-bench codex login`), which configures only the engine server, so a user's
AGENTS.md, memories, plugins and hooks stay out. Codex runs in a read-only sandbox with its shell
off, and a shell command or file edit fails the run. Headless Codex can't answer app prompts, so
for a pass with this arm the runner sets the engine's "Always allow" list to the benchmark apps
and puts the previous list back when it exits. Model requests come from Codex's session log, and
the two arms' token counts aren't comparable.

A live run waits for and holds `/tmp/sleight-live.lock`, the lock every live check takes, so nothing
else drives apps during a pass. `--dry-run` doesn't take it.

> [!WARNING]
> Headless runs can't show approval prompts, so a benchmark run auto-approves Calculator, TextEdit,
> Chess and the iOS Simulator (Simulator, or DeviceHub from Xcode 27) for either arm, and sleight's `drag` and `hover` in those apps (`bench/approve.mjs`, loaded only through
> `bench/settings.json`). Only run it when you're fine with Claude driving those four apps unattended. `--dry-run` checks the setup without
> launching Claude. The real suite also drives Safari, Preview, Finder and Helium, and the same
> hook accepts those apps by name and bundle ID (owner, 2026-10-08).
