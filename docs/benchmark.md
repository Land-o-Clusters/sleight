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
the benchmark quit it (`open` error -600). One pass per model can't separate a model from that hour's API latency.

From 2026-10-04 on, runs default to Sonnet 5.5 at medium effort (`--model`, `--effort`).

```bash
npm run bench -- --runs 3             # sleight only
npm run bench -- --arm all --runs 3   # sleight and LCU
```

The LCU arm needs LCU registered for Claude Code in a separate folder. `bench/run.mjs` has the steps.

> [!WARNING]
> Headless runs can't show approval prompts, so a benchmark run auto-approves Calculator, TextEdit,
> Chess and the iOS Simulator (Simulator, or DeviceHub from Xcode 27) for either arm, and sleight's `drag` and `hover` in those apps (`bench/approve.mjs`, loaded only through
> `bench/settings.json`). Only run it when you're fine with Claude driving those four apps unattended. `--dry-run` checks the setup without
> launching Claude.
