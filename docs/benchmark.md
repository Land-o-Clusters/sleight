# Benchmark

## Parity battery

The battery catalog has 31 tasks (2026-10-11).

| Kind | Tasks |
|---|---:|
| doc-file | 12 |
| self-message | 5 |
| web-page | 5 |
| app-state | 9 |

Each task is data: app, bundle ID, goal, fixture kind, check kind and owner-present flag. Four shared
fixtures and checks handle the catalog. The runner alternates sleight-first and Codex-first pairs.
Each pair gets the same marker, fixture path or URL and prompt. Document fixtures reset before each
arm. The drivers use Haiku 5.5 at high effort and gpt-6.1-sol at high effort, as in the existing runner.

```bash
node bench/run.mjs --suite battery --dry-run --owner-present
```

This prints 62 planned runs and the owner seed markers before runtime setup. An offline guard test
rejects writes and child processes during this command. Without `--owner-present`, the plan has
17 tasks and 34 runs, and lists the 14 excluded tasks. `--tasks textedit,word` selects task IDs.
`--runs 3` makes three alternating pairs per task. The battery always compares sleight and Codex.

The owner posts each self-message marker once before a live pass. Music, Maps, Photos, Spotify and
Zoom need an owner-seeded visible fixture too. Save the dry plan outside the repo and pass its path
with `--markers` to reuse its markers. Account tasks require `--owner-present`. The arms
only read self-messages and existing account fixtures. They never send, post, delete or change
settings. Notion's local-file task records a failure if local opening is unavailable.

Doc-file setup writes txt, rtf, html, md, docx, xlsx, pptx or a reading-only pdf. Checks read the saved
file, using unzip for OOXML. An edit must retain the random marker, replace PENDING with DONE and
save to the original path and format. A read must return the marker and leave the file hash unchanged.
The iWork tasks use docx, xlsx and pptx. Web tasks read a marker from a server bound to `127.0.0.1`.
Self-message answers must contain the exact marker, a sender and a displayed time. App-state checks
make one scripted engine acquisition and read, with no model, then match the visible marker.

Notes, Reminders and Calendar have declarative scripting descriptors. `--local-fixtures` accepts a
private JSON file such as `{"notes":{"id":"fixture-container-id","local":true}}`. The owner must
identify a local fixture container, with no account data in it. One generic script creates the marker
item there before either arm reads it. Without a supplied local container, the model's prompt requires
an isolated local item and a stop if one is unavailable. Created items remain for the owner to review.
The harness never deletes them.

Live results record pass, total seconds, turns, model API time when available, model-gap time, the
existing CPU footprint and every tool call's waste classes from `bench/turn-study.mjs`. A generic
native observer records window IDs, order, bounds, bundle IDs and the frontmost bundle every 200 ms.
It pumps the NSWorkspace run loop between samples. Each run counts changed-focus samples and samples
where the target overlaps a window of the initially frontmost app. Published results contain metadata,
timings and check codes, without prompts, answers, sender names, window titles or transcript text.
Raw driver streams stay in memory. Codex may retain its own private rollout in its benchmark home.

Cleanup closes retained fixture window references and quits only a process the run launched. A missing
reference, surviving window or unconfirmed driver cleanup stops the pass, preserves the fixture and
keeps the live lock for sleight-arch. The Codex arm uses the existing benchmark's temporary app-approval
transaction, restoring the earlier list even after a stop. `--clean-arms` uses the existing strict
sleight setup and checks that the Codex benchmark home has one server. Results label clean or normal.

Offline evidence: 13 battery tests pass, including eight document-format roundtrips and the dry-run
side-effect guard. All 13 fail against the starting tree. No battery app has run in this lane. App
opening, script dictionaries, the 200 ms observer and cleanup still need sleight-arch's live check.
Codex does not expose isolated model API time in its CLI stream, so its `modelMs` is null. The separate
model-gap measurement includes host scheduling. [Battery limits](known-problems.md#parity-battery)
list what these checks cannot establish.

## Browser head-to-head

sleight against Codex on the 12 web tasks (grid, editor, dense, spa, nested and infinite pages in
Safari and Helium, native windows), 2 runs each, the owner away, 13:14 to 13:45 UTC on 2026-10-11
([raw](benchmarks/2026-10-11-web-h2h.json)). Claude ran Haiku 5.5 at high and Codex gpt-6.1-sol at
high. The arms differ in model as well as harness. Codex lanes ran their checks on the same Mac
for part of the pass. Both arms passed 24/24. sleight averaged 28.5 s a run (median 24.6 s), Codex
41.8 s (median 43.4 s), and sleight was faster on 11 of 12 tasks.

| Task | sleight s | Codex s | sleight turns | Codex turns |
|---|---|---|---|---|
| safari-grid | 18.8 | 26.0 | 4.5 | 5.5 |
| safari-editor | 28.3 | 45.2 | 6.5 | 8.5 |
| safari-dense | 15.1 | 19.8 | 4 | 5 |
| safari-spa | 29.2 | 43.4 | 11 | 10 |
| safari-nested | 41.9 | 53.2 | 11.5 | 11.5 |
| safari-infinite | 29.2 | 55.4 | 10 | 12.5 |
| helium-grid | 20.6 | 24.9 | 6 | 5.5 |
| helium-editor | 56.8 | 54.5 | 9 | 9.5 |
| helium-dense | 17.8 | 30.9 | 5 | 6.5 |
| helium-spa | 42.8 | 48.6 | 16.5 | 12.5 |
| helium-nested | 21.6 | 38.6 | 8.5 | 10 |
| helium-infinite | 20.5 | 60.5 | 5.5 | 13 |

sleight used more CPU: 5.48 s of its own processes a run against 4.45 s for Codex, counting Claude
Code's process in sleight's arm.

## Earlier benchmarks

`bench/` runs each task through headless `claude -p` and checks it outside the agent, against the file
on disk or the exact answer. sleight and LCU get the same prompt for each task, and the prompts
don't mention a tool by name.

Before each TextEdit task the harness launches TextEdit in the background with launch arguments
that skip restored windows, keep new documents out of iCloud and replace the Open panel with an
untitled document, which it closes. Leftover iCloud "Untitled N.txt" files caused 2 textedit-save
failures when TextEdit restored them and Claude edited them
([2026-10-10-away-2](benchmarks/2026-10-10-away-2.md)).

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

Since 2026-10-10 the Claude arms run on an Anthropic API key when
`~/.config/sleight-bench/anthropic-api-key` exists (mode 600). On the login, passes shared a rate
limit with the owner's usage meter, which got 429s after each pass. A pass stops when this month's
spend, kept in `~/Library/Logs/sleight/bench-api-spend.json`, reaches `SLEIGHT_BENCH_API_CAP_USD`
(default $200, the monthly API credit that comes with the owner's Max plan). `--auth login` runs on
the login, and each results file records which one ran. Mimestream rows don't record a cost, so the
cap doesn't count them. On the key, the arms also get their own Claude Code config folder
(`~/Library/Caches/sleight-bench/claude-config`, linked to the owner's settings and plugins), where
Claude Code couldn't find the owner's login (2026-10-11). Arms also drop the `CLAUDE*` variables of the session that started the pass: with
them, billing counted the arms as the desktop app's Claude Code and the credit refused them.

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
(-25204) and stopped the pass, so powerpoint-edit didn't run. The
[brief-11 report](benchmarks/2026-10-09-real-use-tasks-11.md) records cleanup's new bounded read wait
and its fake-clock proof. Excel and PowerPoint await the architect's rerun.

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
unqualified. The Mail tasks run in the owner's real Mail app, so they run only with the owner
present (`--owner-present`, owner 2026-10-11). Default passes and the head-to-head skip them.

Brief 7b adds `mimestream-label`, `mimestream-message`, `mimestream-thread`, `mimestream-scroll`
and `mimestream-search` on the owner's signed-in Gmail. Select those IDs in a separate sleight pass.
Their results retain only verdicts, seconds, turns and salted answer hashes. The adapter requires
explicit read state and unchanged mailbox counts, preserves Mimestream, and closes only its new
window. These tasks also require `--owner-present`; the helper refuses the request without it
before it touches the app.

### Browser depth fixtures

The browser-task catalog has 16 page kinds across 5 native browsers and 3 extension browsers
(2026-10-11, offline checks only). The 6 earlier kinds and their checks retain their IDs. Firefox's
earlier `firefox-grid` and `firefox-spa` keep their existing setup too. The 10 new kinds are:

| Kind | Required page state |
|---|---|
| `validation` | A rejected draft, then a corrected registration with no errors |
| `controls` | Orchid in a combobox, November 17, 2026 in a date picker, Research in a native select |
| `modal` | Orchid approved with the run's note and its dialog closed |
| `hover` | Orchid archived through its revealed menu, with the menu closed |
| `reorder` | Orchid dragged after Maple, preserving all 5 projects |
| `iframe` | The embedded form submitted, with the outer field blank |
| `shadow` | The open shadow-root form submitted, with the outer field blank |
| `tabs` | A value read in a second tab and submitted only on the first |
| `accordion` | Marine expanded, its code submitted, the other sections collapsed |
| `delayed` | Content loaded after a nonce-derived delay of 1,000 to 3,000 ms, its code submitted |

Native IDs are `<browser>-<kind>`, with browser prefixes `safari`, `helium`, `chrome`, `firefox`
and `arc`. Extension IDs append `-extension` for Helium, Google Chrome and Arc. Each result records
`surface: native` or `surface: extension`. Task instructions differ only in their first sentence.
Native runs use the engine's app API. Extension runs require a connected extension for the named
browser, use `cua.createBrowserTab`, and require `--surfaces browser,computer`. Without that flag,
default selection omits extension variants and explicit selection refuses them before the live lock.

Each loopback server compares exact reported control state, independently of the driver's answer.
Iframe and second-tab pages have separate state endpoints and request records. A first-page snapshot
cannot replace either page's record. All 10 new kinds have offline tests for accepted state, near misses and
their generated event handlers. Browser rendering and real input await sleight-arch's live check.

The live matrix is 80 new task IDs (50 native, 30 extension), once per arm, 160 runs total. Print
the IDs without launching a browser:

```bash
node --input-type=module -e "import {webTasks} from './bench/tasks-web.mjs'; import {depthKinds} from './bench/web-pages/depth.mjs'; console.log(webTasks.filter(t => depthKinds.includes(t.webKind)).map(t => t.id).join(','))"
```

Then sleight-arch runs the complete list with the owner away:

```bash
node bench/run.mjs --suite real --arm sleight,codex --tasks <ids> --runs 1 --owner-away --surfaces browser,computer
```

Publish every run, including setup, permission, task and cleanup failures. Traces must identify the
browser and app or browser API. They must confirm exact accepted state and cleanup of only the owned
windows and tabs. Record turns, model time, total time and own CPU for both arms. No download or upload fixture
is included.

### Shop tasks

`safari-shop` and `helium-shop` drive a local Harbor Market page: ZIP and store, search, filters,
pagination, product options, add to cart, cart, cookie and newsletter popups, and late-loading
options. The check is the server-side store and cart. Both the sleight and Codex arms can run them.

`real-shop-target` and `real-shop-bestbuy` are smoke tasks. Select them with `--tasks` and
`--runs 1` only. They are not in the default real suite or the head-to-head. Safari only. The check
is Claude's answer plus a cart-page screenshot. Sign-in and checkout are out of scope. Decline
non-essential cookies, and stop at a CAPTCHA or bot check. A complete cart passes. A stop at a
human check that the answer names and the screenshot backs is recorded as `outcome: "human-check"`,
not a pass. Everything else fails with the real reason, and a refused click or tool call is a
refusal, never a human check.
### Electron and Firefox

`vscode-edit`, `cursor-edit`, `firefox-form`, `firefox-grid`, `firefox-spa`, `slack-read`,
`discord-read` and `whatsapp-read` are on `--suite real` (owner, 2026-10-10; chat apps open and
read only). One engine read of each app, no input, is in
[2026-10-10-electron-firefox.md](benchmarks/2026-10-10-electron-firefox.md). Slack, Firefox and
WhatsApp were thin (15, 24 and 19 elements). VS Code and Cursor had no text fields. None of the
six had button IDs. The tasks are unit-tested. sleight-arch runs them live. The chat reads work in
the owner's real accounts, so `slack-read`, `discord-read` and `whatsapp-read` run only with the
owner present (`--owner-present`, owner 2026-10-11). Before Claude acts, a separate AX helper reads
the selected conversation title and an explicit author control in its newest message. It requires
one message list, increasing message IDs and a scrollbar at its maximum. Missing evidence stops
with `CHAT_CONVERSATION_UNPROVED`, `CHAT_MESSAGE_LIST_UNPROVED`, `CHAT_NEWEST_UNPROVED` or
`CHAT_AUTHOR_UNPROVED`. It never reads message bodies. An app that was closed starts with
`open -g -b`. Cleanup quits only the recorded PID with the same launch timestamp. Diagnostics keep
launch ownership, frontmost bundle IDs before and after launch, dialog categories, AX role counts
and the results of enabling and restoring `AXManualAccessibility` and `AXEnhancedUserInterface`.
Published rows still contain only verdicts, timings and salted hashes. Offline, 29 new tests failed
on `464e0ba` and passed with this change. Both chat and Electron files passed 42/42 tests. No chat
task has run live with this observer. sleight-arch must run each task once open and once closed,
with the owner watching. Each of the six runs must prove the baseline or record its refusal and
restore AX switches. An already-open app must stay running, and a launched app must quit. Inspect
frontmost changes and any sign-in, update or permission window without answering it.

`iphone-mirroring-settings` reports the iOS version from Settings > General > About in iPhone Mirroring. Select it with `--owner-present`. Default passes and the head-to-head skip it. The benchmark approves iPhone Mirroring only in `--owner-present` runs, since headless runs can't show a prompt. Published rows keep the answer and timings with no screenshot. Every owner-present task (iPhone Mirroring, Mail, Mimestream, chat reads) is skipped by default passes and the head-to-head, and an `--owner-away` pass refuses a selected one before any app operation.

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

Rewriting the engine's sentence itself (`SLEIGHT_FIRST_CALL_BATCH`, `6cd41ba`) did change it. Two
rounds on calculator-menu, textedit-save, textedit-edit and chess-drag, 3 runs each per side, ran off
then on and then on then off (2026-10-09, 22:03 to 22:32 UTC, the owner away, load 5 to 23 from
other projects). Raw results are in `docs/benchmarks/2026-10-09-first-call-batch-*.json`, one
file per side and round.

| Side | Passed | Total s | Turns | Model s | Model s a turn | Engine s |
|---|---:|---:|---:|---:|---:|---:|
| Off | 23/24 | 835 | 208 | 464 | 2.23 | 259 |
| On | 24/24 | 780 | 168 | 366 | 2.18 | 289 |

Turns fell on calculator-menu (34 to 24) and chess-drag (91 to 56), stayed at 42 on textedit-edit,
and rose on textedit-save (41 to 46). The off side's failure was a Chess game left unsaved. One
calculator-menu run on took 81.6 s: the relay's first acquisition of Calculator took 29.5 s, and a
call of seven numbered actions spent 18.6 s in the guard's reads before them. It's the default
since this pass.

With the batching wording's last clause, windows a call opens itself and the split read's reuse
(`7c8e357`, 2026-10-10 01:18 to 01:27 UTC, the owner away, load 7 to 11 with another project's CI
on the Mac), five tasks ran 3 times each and passed 15/15
([`tonight-affected`](benchmarks/2026-10-10-tonight-affected.json)). Per round of the four tasks
above, turns were 48 without Chess against 58 with batching off and 56 with the first wording, and
textedit-save took 15 against 20 and 23. Chess took 43 turns (16, 18 and 9). One calculator-click
run took 87.8 s in 3 turns, 44.5 s of it in 8 guard reads.

With the skill's exact-replacement bullet and the clipboard helper (`05903fa`, 2026-10-10 01:54 UTC,
the owner away, load 24 to 44), textedit-save and textedit-edit passed 6/6
([`exact-text-skill`](benchmarks/2026-10-10-exact-text-skill.json)). textedit-save took 19 turns and
a median 35.2 s against 15 turns and 26.3 s at 01:18, and textedit-edit 21 turns and 24.4 s against
19 and 27.3 s.

The batching wording still left `cua.getState()` as the only native-looking call Claude saw before
its first one, and 50 of 80 runs spent their first turn on it. Wording that names
`cua.getApp("Calculator")` for an app Claude can name (`4ee20df`) ran against it on 2026-10-11
(03:47 to 03:59 UTC, Haiku 5.5 at high, the owner at the Mac, apps in the background), two rounds
alternating, calculator-click, textedit-edit and textedit-save twice each per round
([raw](benchmarks/2026-10-11-firstcall-ab.json)). One default run was skipped when the harness's
`open -g -a TextEdit` failed during setup.

| Wording | Passed | First call `getState` | Turns a run | Model s a run | Model s a turn | Total s a run |
|---|---:|---:|---:|---:|---:|---:|
| Batching | 11/11 | 8/11 | 7.91 | 19.8 | 2.50 | 30.6 |
| Names `getApp` | 12/12 | 0/12 | 7.17 | 16.4 | 2.29 | 27.0 |

calculator-click fell from 4 turns to 3 in every run. Under the new wording, 2 of 12 first calls
called `cua.getAXState()`, which `cua` doesn't have. One textedit-save took 19 turns and 77.7 s. All 8
textedit-save runs sent Go to Folder through the final Return in one call, against 0 of 3 before the
save-sheet note (`49356a7`). The new wording is the default since this A/B.

Trimming results lost (`e212204`, 04:26 to 04:39 UTC, same tasks and setup,
[raw](benchmarks/2026-10-11-result-trim-ab.json)). `SLEIGHT_RESULT_TRIM=1` cut file lists in Save and
Open panels to 10 rows plus a count, and left out a split acquisition's tree when its call returned a
newer full one. It passed 11/12 against 12/12, at 7.92 turns and 30.8 s a run against 7.25 and
26.8 s, though its results were 47,701 characters a run against 64,264. Two of its textedit-save
runs saved into the previous run's folder: the folder each needed sorts last, the trim hid it, and
Claude clicked the nearest one it could see. One of them failed. No result in either arm was large
enough for Claude Code to write it to a file, so the case the trim was for didn't come up. The list
trim is gone. The acquisition-tree drop runs again alone.

An A/B with one change per arm ran next (`7f49b40`, 04:43 to 04:57 UTC, same tasks and setup,
[raw](benchmarks/2026-10-11-three-arm-ab.json)). The default passed 11/11 with one run skipped at
setup, at 6.82 turns, 2.18 s of model time a turn and 23.8 s a run. Leaving out the acquisition's
tree (`SLEIGHT_RESULT_TRIM=1`) passed 12/12 at 6.92 turns, 2.09 s and 24.8 s, a tie, and its results
were no smaller (59,253 characters a run against 58,453). `SLEIGHT_FIRST_CALL_BATCH=sheet` ran one
round: its second was stopped by sleight-arch after 17 s and is left out. Its 6 runs passed at 6.83
turns, 2.55 s and 29.0 s. Each of its changes did what it was for. Both textedit-edit runs sent the
`getApp` call `open_file` named, and both of their saves read "saved: observed" from the file on
disk (0 of 7 before). One textedit-save chained Cmd+N, Make Plain Text and the paste in one call and
finished in 5 calls. Its slowest run, 70.1 s, lost its time to a result written to a file and a menu
opened in one call and used in the next. Its totals need the second round, which runs next.

On the two tasks without a Save sheet it ran with the owner at the Mac (05:09 to 05:16 UTC,
[raw](benchmarks/2026-10-11-sheet-edit-ab.json)). textedit-edit passed 6/6 at 6 turns in every run
and 18.5 s a run, against 5/5 at 6.6 turns and 20.0 s (one default run was skipped at setup).
calculator-click took 3 turns in all 12 runs, at 10.4 s against 11.0 s. `open_file` naming its `getApp` call and a save
observed from the file on disk are the default since.

The full sheet A/B ran with the owner away (12:43 to 13:00 UTC, all three tasks, 2 rounds of 3 runs a
task per arm, [raw](benchmarks/2026-10-11-sheet-ab.json)). A Codex lane ran its checks on the same
Mac during it. Both arms passed 17/17, with one run each skipped at setup. The sheet arm took 7.53
turns and 29.7 s a run against 5.94 turns and 21.5 s. Its textedit-save runs took 8 to 25 turns
(29.9 to 109.4 s) against 7 to 10 turns (33.2 to 39.2 s). The sheet batch lost and is removed.

The skill itself ran against a slim, app-agnostic version (`SKILL-slim.md`, 79 lines against 137, no
app names) and against no sleight rules at all (`b03b5a7`, 05:48 to 05:59 UTC, calculator-click and
textedit-edit, 6 runs a task per arm, the owner at the Mac,
[raw](benchmarks/2026-10-11-skill-ab.json)). The current skill passed 11/11 at 4.55 turns and 14.5 s
a run, the slim one 12/12 at 4.83 and 16.0 s, and none 11/11 at 5.91 and 19.5 s (one run of each of
those two skipped at setup). Without the rules calculator-click took 5 to 9 turns against 3. The slim skill took 4 turns in 2 of its 6 calculator-click runs. It
dropped the current skill's `{ id: "Seven" }` and `{ label: "Multiply" }` examples, the likely cause,
which isn't confirmed. textedit-edit was within a second across all three.

A rerun after the slim skill got placeholder ID and label examples (`ebedb7e`, 12:32 to 12:43 UTC,
the same tasks and counts, the owner away, [raw](benchmarks/2026-10-11-skill-ab-2.json)) passed all
36 runs. Slim (86 lines) and current both took 4.58 turns a run, at 14.5 s and 15.6 s, with 8.0 and
9.2 s of model time. With no sleight rules it took 5.75 turns and 18.6 s, and calculator-click took 4
to 7 turns against 3 for both skills. Slim's calculator-click runs all took 3 turns this time.
On textedit-save (13:00 to 13:14 UTC, 6 runs an arm, the owner away, a Codex lane's checks on the
same Mac, [raw](benchmarks/2026-10-11-skill-ab-save.json)), slim passed 6/6 at 11.33 turns and 38.9 s
a run, current 6/6 at 10.83 turns and 44.7 s, and none 5/6 at 13.00 turns and 46.0 s. Slim's runs
ranged from 36.7 to 41.0 s, current's from 34.6 to 59.1 s.

The head-to-head at the owner's normal load (2026-10-09, the owner away, load 6 to 24, Sonnet 5.5 at
medium against gpt-6.1-sol at medium) alternated sleight and Codex task by task. The default tasks
ran 3 times per arm ([`h2h-normal-default`](benchmarks/2026-10-09-h2h-normal-default.json)) and six
real-use tasks twice ([`h2h-normal-real`](benchmarks/2026-10-09-h2h-normal-real.json)).

| Suite | Arm | Passed | Total s | Turns |
|---|---|---:|---:|---:|
| Default | sleight | 20/21 | 904 | 202 |
| Default | Codex | 16/21 | 1,292 | 238 |
| Real use | sleight | 12/12 | 396 | 119 |
| Real use | Codex | 11/11 | 429 | 99 |

Codex failed textedit-drag 3 of 3 and simulator-form 2 of 3. sleight's one failure was textedit-drag
in round 2, where a batch of Cmd+O, Cmd+Shift+G and a typed path outran TextEdit's Open panel. That
came from `44700ee`, and `db45c94` fixed it from 19:39:18 UTC: the default tasks before simulator-form
in round 2 ran without the fix, and the rest with it. One Codex finder-files run failed in harness
setup (a -25204 read of Finder) and is left out. By median, sleight was faster on calculator-menu,
the TextEdit tasks, preview-pdf (18.5 s against 42.2 s), helium-grid, safari-spa and helium-form, and
Codex on calculator-click (14.9 s against 20.6 s), chess-drag (52.4 s against 60.5 s) and
safari-form (28.1 s against 33.9 s). Turns aren't the same unit, since Claude Code counts its turns
and the Codex arm counts model requests.

The CPU footprint in these files undercounts Codex: its engine server runs in a process group of its
own, which the sampler missed until `2c30446`. Across the 21 default runs, the engine's shared helper
used 50.7 CPU seconds for sleight and 64.8 for Codex, and the host CLI 44.1 (Claude Code) against
23.8 (Codex CLI). sleight's own processes used 47.5, and the owner's other Claude Code plugins, which
load in every run, 21.7.

With `2c30446` counting Codex's engine server, calculator-click, textedit-save and textedit-edit ran
twice per arm at `76cf880` ([`footprint`](benchmarks/2026-10-09-footprint.json), the owner away,
load 20 to 55 from other projects). Both arms passed 6/6. sleight took 206 s and 37 turns, Codex
232 s and 55. sleight used 51.9 CPU seconds, 4.4 of them in the owner's own plugins and hooks (an
`mcp@latest` server, `npm`, Python), and Codex 37.1. Of the 10.4 s left between them, the engine's
node process took 3.8 (9.3 against 5.4), the host CLIs 5.2 (Claude Code 11.3 plus the engine's
`codex sandbox` wrapper 2.4, against 8.5 for Codex CLI and its wrapper, which the sampler doesn't
separate), and `osascript` 1.9. The helper and the apps together used 0.6 less for sleight (20.8
against 21.3). The gap per run was largest on calculator-click (4.7 and 6.6 s against 3.3 and 3.3).

After tonight's cuts (helper lanes, cached extension check, the split read's reuse, first-call
batching; `6e21846`, 2026-10-10 02:10 UTC, the owner away, load 22 to 30 from another project's test
suite), the same six runs a side ([`footprint-2`](benchmarks/2026-10-10-footprint-2.json)) passed 6/6
each. sleight took 154 s and 35 turns, Codex 239 s and 59. sleight used 45.8 CPU seconds of its own
(50.1 with the owner's plugins) against Codex's 38.7, a gap of 7.1 against 10.4 before. The engine's
node process still took 3.3 more (8.8 against 5.5), and `osascript` 2.2, mostly the per-read app
probe.

A loaded pass added 20 CPU-bound workers (load 12 at the start, 137 at the end) and ran four
default tasks, alternating the arms, until it was stopped at 20:38 UTC to leave the Mac quiet for
another project ([`h2h-loaded`](benchmarks/2026-10-09-h2h-loaded.json)). It ran 9 of the planned 16 runs.

| Task | sleight | Codex |
|---|---|---|
| calculator-click | 0/2 (300 s and 286 s limits) | 1/1, 115.8 s |
| calculator-menu | 0/1 (300 s limit) | 0/1 (300 s limit) |
| textedit-save | 1/1, 61.5 s | 1/1, 52.7 s |
| textedit-edit | 1/1, 27.1 s | 1/1, 86.3 s |

In the first sleight run the guard's read before each call's first action took 17 to 57 s, seconds
after Claude's own read took 1.9 s, and clicks by ID found nothing in reads that had dropped their
IDs. `c2bd713`, live from about 20:25 UTC, reuses Claude's read for that first action and matches
bare lines. The TextEdit runs and the second calculator-click ran with it. That calculator-click,
at load near 137, still timed out: the acquisition took 28 s and failed once, Claude's own full read
took 72.8 s, and a batch of seven clicks by ID read before each and took 137 s. Under this load
every read costs tens of seconds, and clicks by ID need one each.

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

From 2026-10-04 to 2026-10-10, runs defaulted to Sonnet 5.5 at medium effort, and since then to Haiku
5.5 at high (`--model`, `--effort`). Haiku's costs come from its token counts at API prices, since
Claude Code 2.1.289 doesn't recognize the model and reported about 60 times its price.

```bash
npm run bench -- --runs 3             # sleight only
npm run bench -- --arm all --runs 3   # sleight and LCU
```

The LCU arm needs LCU registered for Claude Code in a folder outside any git repo. `node
bench/lcu-arm-setup.mjs` creates it from the runtime already installed (`lcu setup`, the folder
`LCU_ARM_DIR`, default `~/Library/Caches/sleight-bench/lcu-arm`) and verifies it with `lcu doctor`.

`--clean-arms` publishes the CPU comparison without the owner's setup, which LAWS says runs
alongside the normal one: the sleight arm loads only sleight's server and mod (strict MCP
configuration, empty setting sources) against the Codex home's engine-only server list, and the
results record `armSetup: "clean"` or `"normal"`. The summary table splits each arm's own CPU into
sleight's processes, the engine, the client CLI and other group processes.

## One away sitting

`node bench/away-sitting.mjs --dry-run` prints 13 steps from STATE's away list at `d21965c`.
It reads the list and past result files without launching a harness, starting a watcher or taking
the live lock. A changed list stops planning until its command mapping is reviewed.

```bash
node bench/away-sitting.mjs --dry-run
node bench/away-sitting.mjs --dry-run --only textedit-drag,best-buy
node bench/away-sitting.mjs --dry-run --from save-delivery
```

The plan gives each command, estimated minutes and its raw timing source. Head-to-head estimates
are 8.9 and 8.2 min, from the clean and normal runs on 2026-10-10, failures included.
Setup and cleanup can add time. The owner's 75 to 90 min window remains unmeasured as a whole.
Steps stay in STATE order even when `--only` names them in another order.

sleight-arch runs `node bench/away-sitting.mjs --owner-away` after every lane has merged and the
owner grants the complete window. `--only` and `--from` also select live steps. A hold or existing
live lock stops before the first step. Each harness acquires and releases its lock. A lock left
after a step stops the sitting for inspection. This runner leaves it in place.

Live mode requires `.dev/passes/front-watch.sh` in the worktree and the existing
`~/Library/Caches/sleight-bench/keyboard-taps` binary, built from `bench/keyboard-taps.swift`.
The foreground watcher establishes a baseline before any step. Every later change of foreground app name,
any enabled keyboard filter tap, watcher failure or new hold cancels the active child process
group and prevents another step. The harness first receives SIGINT and has 30 s for its cleanup.
Forced termination marks app and detached engine cleanup unconfirmed. Ordinary command failures
advance to the next step. Each completed
or refused step prints one JSON line with start, end, exit code, result files and a private receipt.
Child output stays in private `/private/tmp/sleight-away-*` logs for review before publication.

The plan uses `bench/reliability-live.mjs chess-after` for computed Chess points, simulator-form
with 3 runs, delivery-check before the full save-lock experiment, select-all with `--quick`, both
live checks, both shop smoke tasks and a separate Best Buy run, excluding owner-present tasks.
Codex steps are refused because their existing harness rewrites ChatGPT's approval list.
There is no dedicated quiet-box command on this branch. All three produce exit 126 and remain
visible in the plan. These [limits](known-problems.md#the-real-use-benchmark-harness)
need resolution before the whole sitting can finish.

On 2026-10-11, all 8 runner tests failed before the runner existed and passed after it was added.
The dry-run subprocess also passed with Node denying writes, network access and child processes.
No live sitting ran on this branch. sleight-arch must verify hold refusal, failure continuation,
watcher cancellation with all owned children collected, result attribution and unchanged approval
lists. The save delivery must finish within 2 s; the full run must count hangs and preserve its
lock on uncertain cleanup. Live behavior remains unverified.

## Benchmarking another plugin

Point at a local Claude Code plugin or an MCP configuration for an already installed server:

```bash
PLUGIN_ARM_RIVAL_DIR=/absolute/path/to/plugin node bench/run.mjs --arm plugin:rival,sleight --tasks calculator-click --runs 1
MCP_ARM_RIVAL_CONFIG=/absolute/path/to/mcp.json node bench/run.mjs --arm mcp:rival,sleight --tasks calculator-click --runs 1
```

Names use lowercase letters, digits, hyphens or `_`. Environment variable names replace
hyphens with `_`, so `mcp:sleight-plain` reads `MCP_ARM_SLEIGHT_PLAIN_CONFIG`. Add `--dry-run`
to discover tools and record the command without a model call. Use absolute executable and script
paths in an MCP configuration's `mcpServers` object.

Each arm gets its own folder outside any git repo. User settings, built-in tools, skills and unrelated
MCP servers are excluded. Every Claude arm in these comparisons uses empty setting sources and built-in
tools, strict MCP configuration, disabled slash commands and streaming JSON. Session persistence is disabled.
Each arm gets the same PermissionRequest deny hook and approval stop marker. Plugins declaring hooks,
LSP servers or agents through manifest fields or automatic paths are refused, as are plugin settings
that select an agent or agent status command. Other plugins load from their local folder; their MCP registrations are also
passed explicitly because Claude Code's strict MCP option suppresses plugin registrations. Setup
reads the servers' `tools/list` catalogs through Claude Code's initialization event. It rejects other
servers or tools. Only discovered names are allowed. Task prompts, external checks, five-minute
limits, disallowed tools and per-run CPU sampling use the same runner as sleight.
Server processes receive only `PATH`, `HOME`, `TMPDIR`, `LANG` and their declared variables. Claude
keeps its benchmark API authentication. Its key and OAuth variables are excluded from those servers.
Account connectors are disabled. Only plugin-root interpolation is supported. Competitor code still
runs as the user with full file and network access. The harness is not a security sandbox.
Comparisons containing a generic arm use retained app observers for every arm. Default tasks keep
their prompts and checks, seed their files, and preserve existing app windows. They omit the older
TextEdit and Chess reset routines. Chess and Simulator require `--owner-away`.

The existing app allowlist handles MCP elicitation requests. Unknown forms, URL approvals and ordinary
tool permission requests stop the run. App and macOS permission observers also stop it. Approval
records and task checks decide other tool errors. Wording alone does not stop one arm differently.
Approval dialogs must be left for the operator. A live run takes `/tmp/sleight-live.lock`
and stops if `/tmp/sleight-hold` appears.

The result's `armMetadata` records the plugin's manifest name and version, source commit
when available, a SHA-256 of its local package, and the discovered server and tool names. Provenance
uses `git rev-parse` only to avoid competitor fsmonitors. The result omits dirty state. MCP
arms record a configuration hash and hashes of the installed executable and local script packages,
including their versions and commits when available. Plugin hashes also cover external configured
server packages. Dependencies and build output inside those packages are included; only Git metadata
is excluded. Each artifact records whether the hash covers a package directory or an entry file.
External system libraries and programs selected at runtime by a launcher are outside these hashes.
Configuration secrets are excluded. Remote MCP servers and installer commands are refused because
the runner cannot identify their installed code. Configure a local stdio executable instead.
Dry runs include the isolated command. Preflight failures are retained as failed rows. Final-answer
wording does not decide a verdict. The task check and approval records do. The publication helper
replaces foreign catalogs, app inventories and private identities with counts.

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

`node bench/live-checks-1-1.mjs stale-number|keyboard-tap|helper-resend|menu-bar --owner-away` writes `docs/benchmarks/2026-10-10-live-checks-<name>-<stamp>.json`. `--dry-run` prints the plan. It does not take the lock, and it does not launch an app.
`keyboard-tap` skips, because `bench/keyboard-taps.swift` lists taps and does not install one. `helper-resend` skips, because forcing that race means killing OpenAI's helper. `menu-bar` opens Clock or Control Center from the status-item list. It closes that item before it exits.
`menu-bar` needs Accessibility for the app that runs the session (Terminal, iTerm or Claude). A denial is reported as `needs the owner to grant Accessibility to <process path>` instead of a failure; grant that app access under System Settings → Privacy & Security → Accessibility, then run the check again.

> [!WARNING]
> Headless runs can't show approval prompts, so a benchmark run auto-approves Calculator, TextEdit,
> Chess and the iOS Simulator (Simulator, or DeviceHub from Xcode 27) for either arm, and sleight's `drag` and `hover` in those apps (`bench/approve.mjs`, loaded only through
> `bench/settings.json`). Only run it when you're fine with Claude driving those four apps unattended. `--dry-run` checks the setup without
> launching Claude. The real suite also drives Safari, Preview, Finder and Helium, and the same
> hook accepts those apps by name and bundle ID (owner, 2026-10-08).
