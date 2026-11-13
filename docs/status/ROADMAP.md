# sleight roadmap

Everything we intend, in order. Always-true decisions are in [LAWS.md](LAWS.md), current state in [STATE.md](STATE.md), and the
history of every finished item in git and the CHANGELOG. Rewritten 2026-10-15 from an item-by-item audit of the old roadmap
against git, the ledger and the code. Any owner correction about the plan is written here the same turn.

## Goal

The world's fastest computer use plugin for Mac, proven by a published head-to-head (LAWS), and the most thorough one in measured
facts (owner, 2026-10-15). Every claim is a measurement. Work goes to the biggest measured lever first: `bench/fowl/anatomy.mjs` splits
each round into start, model and tool time, result characters and turns. Haiku 5.5 runs every incremental change, because it shows
how forgiving an interface is, and Opus runs once at the end of a batch.

## 1. Release 1.3.0 (waits only on turbo v3)

Everything except turbo is release-ready and merged (owner, 2026-10-14). That covers public CI and the benchmark preflights, plus
the release-pass and claim-suite runners. The release notes (RL1) wait on `codex/rl1`.

1. Done: turbo v3 is finished on `private/v3-gate` at `66ada2bd`. Its commits since AD1 are listed in the gate records.
2. Done 2026-10-16: the Haiku gate passed on `66ada2bd` (docs/benchmarks/2026-10-16-gate.md, last section). Turbo's median was
   547 s with 0 errors in all 5 rounds, against FowlBrowser's 720 s, 76%. Both 26/26 under the owner's scoring, 0 focus events,
   0 ToolSearch. Earlier rounds that night missed the 575 s target (603 s and 607 s) until the `find` alternation fix.
3. Done 2026-10-16: the Opus head-to-head on `66ada2bd` (docs/benchmarks/2026-10-16-opus.md). Turbo 675 s against FowlBrowser's
   885 s, 76%, faster in all 5 rounds.
4. Merge `v3-gate` into `pane/auto-mode`, then V8 and V8R (the v1/v2 removal and slimming, 15.4 MB to 8.2 MB). `arch/release-cand`
   `cb20a697` is `66ada2bd` plus V8 and V8R (8,640 KB). Its focused and real-page tests pass, and its full check is pending. Turbo v3 lacks
   the hookup animation LAWS names for connecting. Its connected state shows through the consent host's menu bar item with Pause and
   Disconnect. V8R removed the unwired view model, `indicator.mjs`, which can be restored from `c407cb94`. Then the release
   pass, slimmed to the browser gate and the Opus round on the release commit (about an hour; native and claim are covered by
   the 2026-10-16 claim baseline, owner), RP1's CHANGELOG and README changes (approved by the owner 2026-10-16), turbo as the default (owner, 2026-10-16), and the
   1.3.0 tag on the owner's call. After 1.3.0, Electron, the native claim and the video, sleight moves to maintenance and benchmarking
   as competitors improve (owner, 2026-10-16).
4b. GPT inside sleight against Codex's own computer use (owner, 2026-10-19): the same model on the same tasks, Codex with sleight as
   its plugin against Codex out of the box, so the claim can say whether sleight makes GPT faster too. Browser race: codex-sleight
   (gpt-6-luna) and codex-sleight-sol x3 each, against the codex rounds already run and a new codex-sol baseline x3, in Safari and
   Firefox, on the final build with the engine-path payment gate. Native claim tasks need a sleight-in-Codex native arm, which the
   claim runner doesn't have yet. The result is published whichever way it goes. The luna pair (codex-sleight against codex)
   runs for the 1.3.0 tag, and the Sol pair (codex-sleight-sol against a new codex-sol baseline) for 1.3.1 (owner, 2026-10-19).
4f. Engine compatibility after every ChatGPT update, in 1.3.1 (owner, 2026-10-19): ChatGPT updates several times a week, so full
   benchmarks rerun periodically, with the engine version recorded on every result, and an automated check for breaking
   changes runs after every update. It builds on `scripts/watch.sh` (daily launchd job: doctor, API docs diff, one task on a
   version change). The static half (new release detected, engine API and schemas diffed against sleight's contract) runs off
   this Mac, on a GitHub-hosted runner or the owner's Linux CI box. The live smoke runs on this Mac (owner, 2026-10-19).
   Public Actions logs don't show engine source or docs. Workflow files are the owner's to push.
4c. sleight as a Codex plugin in 1.3.0 (owner, 2026-10-19: in 1.3.0 if possible): one repo for both hosts, the repo as a
   Codex marketplace, the skill delivered in Codex, approvals per LAWS, doctor and setup aware of Codex. The menu bar dropdown
   names the host each connected session runs in (Claude Code, Codex, Cursor, with version, from the MCP client's own
   introduction), and the model only where the host reports it. sleight never guesses a model. Publishing stays the owner's call.
   In 1.4.0 (owner, 2026-10-19): local performance analytics in the dropdown and a command, such as seconds per action and reads
   saved, and turbo against the engine path, kept on this Mac, built on so1's action log, nothing sent anywhere. Reads saved
   counts reads Claude asked for that went out as changed lines or were left out, and the engine browser path's per-action
   seconds stay an estimate kept out of the menu row (owner took sleight-arch's recommendations, 2026-10-19).
4e. Turbo inside Codex in 1.3.1 (owner, 2026-10-19): a way to tie each turbo turn to the user's own message that the model can't
   forge, since Codex's hooks can't hold the mod's private token. Building on `claude/codex-turbo`. AS-3 also comes in 1.3.1 as
   one tool, `browser_open`, behind `SLEIGHT_BROWSER_CORE=1` until its race A/B saves at least 30 s a round with every task still passing.
4d. Cursor plugin support in 1.4.0 (owner, 2026-10-19): sleight already runs in Cursor as an MCP server, with approval prompts
   naming Cursor (docs/other-hosts.md). 1.4.0 makes it a first-class Cursor install in the same way 4c does for Codex. The server
   and skill come from the same source as the other hosts and install through Cursor's own packaging, Cursor's sessions get the
   skill's guidance, and doctor and the dropdown's host line know Cursor. A study of Cursor's plugin and rules format comes first.
5a. Benchmark presentation and the README rewrite (owner, 2026-10-19), before the claim post, since the post links to them. One
   benchmark hub in `docs/results/`, generated by one script from the raw results files. A rerun regenerates every number. It holds
   a page per benchmark family (native claim, app claim, browser turbo against FowlBrowser, the Safari and Firefox race, the A/Bs),
   each opening with its method (model and effort, runs per arm, the scoring and loss rules, arm versions, what was excluded and why);
   an insights page on what the runs taught us (model variation run to run and Haiku against Opus, the tuning that paid and the
   tuning that didn't, engine quirks); and one interactive page (sortable, filterable tables and per-task charts from a generated
   data file, plain HTML and JavaScript) that the README links to. The hub's pages also hold plain Markdown tables for GitHub, which
   doesn't run a repo's JavaScript, and serving the interactive page (GitHub Pages or another host) is the owner's call at release. Then the
   README rewrite on the final numbers. Everything people read goes through the humanizer skill and Vale.
5. Then the claim post (owner publishes) and the launch video (`docs/design/video-storyboard.md`). The video isn't tied to
   1.3.0 and can come with any later release (owner, 2026-10-19). No work on the film, art included,
   starts until the claim suite (2.2), native apps included, backs the claim that sleight is the fastest at computer use on macOS, in the world. The film costs
   too much time and tokens to make for a narrower claim (owner, 2026-10-16). Its billing then repeats the claim post's words.
   The owner greenlit the art on 2026-10-18 with the claim measured (native "fastest", 8 of 9). Numbers and captures lock after
   the 1.3.0 runs.
   The art-direction architect the owner boots (LoC architect) directs the art. sleight-arch supplies single-window captures of the
   trick (in an away window), the race from a published run, and the numbers.

Before the gate, the owner reloads FowlBrowser's extension in Helium and runs the sleight-arm login. Chrome's Allow and
`ledger/claim-suite-owner-checklist.md` are the owner's too.

1c. Race order (owner, 2026-10-18). Firefox finishes first, every arm included, and then the race plan's Chrome, Helium and Safari
   steps run in its order. When Firefox finishes, studies start on every task sleight still loses (native,
   app and race), and only those get fixes.

1d. Owner, 2026-10-18 morning: study and fix Firefox's mdn and form losses; finish Chrome (turbo reruns on the fixed build, then
   the competitor rounds), then put Safari through its rounds. The claim then covers turbo in real Chrome and Helium windows and the
   engine-path race in Firefox and Safari, beside the native app claim and the Electron app tasks.

1b. Heads-down first (owner, 2026-10-17): build every token, turn and reliability fix found on 2026-10-16 (TT1N to TT4, TK1 to
   TK3, TS1 to TS5), merge and freeze, then one combined A/B (old vs new sleight, claim plus held-out tasks), then the all-arms
   claim run (5 runs where any arm fails, scored by `bench/claim-score.mjs`), then the release pass and the tag. The tag moves
   later so 1.3.0 includes the fixes and the claim measures the released build.
   The all-arms claim run is done (2026-10-17, sleight fastest on 5 of 9). Before publishing it, sleight fixes the three tasks its
   own results lost (preview-read, textedit-calculator, excel-edit) and reruns only its arm: about an hour of fixes and tests
   beat stretching the claim to cover them (owner, 2026-10-17).
   The opt-in flags A/B (2026-10-17) made small native tasks faster and Office slower. Flags that hurt a class of window are
   switched off by a categorical rule measured from the window at run time, never by app name (owner, 2026-10-17). A Fable study
   picks the signal from the A/B traces, then a live check confirms it before any flag becomes a default.
   No shortcuts on the claim (owner, 2026-10-17): every fix the live runs surface (IT2 field focus, FL1 notice wording, XD1
   cross-window drag, the Excel tab swap, HY1C hygiene, the claude-cu arm) lands before sleight's final claim run, and the tag
   follows the claim. Lanes build in parallel while the Mac runs the claim's live work, so neither waits on the other.
   Safari's race uses a dedicated Safari profile, "sleight benchmark", which the owner made on 2026-10-17, with Safari quit
   before each round as for Chrome (owner, 2026-10-17). The world sleight arm is logged in (owner, same day).
   Before browser numbers are published, one gate round runs turbo on a real, isolated Helium or Chrome profile instead of the
   headless Chromium, so the quoted number is the product path. The owner's chosen headline is "fastest plugin on macOS"
   (2026-10-17). It is publishable only if sleight leads the native claim run and turbo leads lcu, Cua, Peekaboo and Codex on browser
   tasks in a real window (about 150 to 250 lines of gate harness and an estimated 2 to 8 hour away window). An unqualified headline
   needs Safari and Firefox raced too, where sleight runs on the engine path. That race comes before the launch post, not
   before the tag. Turbo for Firefox, Safari and other Chromium browsers was studied (2026-10-17). Safari turbo is dropped, and Safari stays on the engine path (owner, 2026-10-19). Each must be as
   smooth as Chrome's consent, with no forced restart, relaunch or extension install (owner). Studies, 2026-10-17. Firefox
   (157) can't meet that today. Its CDP support ended in 141, and WebDriver BiDi needs a launch flag and has no consent page.
   Safari's one fit is a hybrid behind Develop > Allow JavaScript from Apple Events (page script for reads and fills, the engine
   for real input), about 600 to 1,000 lines by estimate, an option for after 1.3.0. Other Chromium browsers likely inherit the
   consent page: BR3 builds the browser table unqualified, and each is qualified by a live check with the owner after 1.3.0
   (Brave, Edge, Vivaldi and Chrome Beta installed by Homebrew cask on the owner's OK, 2026-10-17). After the fixes, sleight
   races its competitors in Firefox and Safari (BR2), and the published claim wording follows that result (owner, 2026-10-17). A half that loses is published with scoped wording instead (browser claims only
   for turbo, stated per browser).

## 2. After 1.3.0, in the owner's order

Owner, 2026-10-18 21:4xZ: all remaining building finishes now, beside the race. Validation follows, and sleight holds at 1.3.1
while the owner uses it, before deciding what comes next. 1.3.1 also takes two features from the 2026-10-18 parity study (owner), a Permissions view
(one place to see and revoke approvals, with app and site blocks) and verified per-action outcomes with an opt-in
action log. Local OCR stays out. Everything below that is build work was dispatched that night (ledger, POST-1.3.0
BUILD). What remains after it is validation: live runs, A/Bs and the owner's watched checks.

Post-release work builds on branches now and merges after the tag (owner, 2026-10-14). On 2026-10-18 the owner had the build rows started at once in lanes on the `post-130` branch (Electron EPV3-1 to EPV3-3, the Q1 reviews, the small queued items), with a Fable design and performance pass for the ghost hand (`ledger/fable-1018-ghost-hand.md`). The ready ones (Q1-7 to Q1-17, AS-4) went into the claim build the same night, and the claim measures them (owner, 2026-10-18). Later that night the owner folded Electron into 1.3.0, and then decided (F3, 2026-10-18, LAWS) that 1.3.0's app tasks run on the native path and Electron turbo comes in 1.3.1 with the relaunch flow. EPV3 builds in parallel lanes against Fable's contracts
(`ledger/epv3-contracts.md`), and the claim suite gains app tasks in VS Code, Slack (the owner's throwaway account) and Spotify (owner, 2026-10-18 02:15Z, replacing Cursor). The ghost hand comes in 1.3.1. Meanwhile the
native claim and the browser race run as Mac load allows, so that Electron's runs are the last benchmark left.

1. Electron on turbo v3: EPV3-1 to EPV3-8 (`ledger/electron-v3-plan.md`), carrying over EP-2's cleanup and EP-6's build
   qualification. EPV3-1 is building on `arch/epv3-1` since 2026-10-15, and the rest follow in the plan's order.
2. The full claim suite comes before the parity battery (owner, 2026-10-15). It runs every arm on the same tasks (Claude in Chrome, Claude's own computer use on the newest Claude Desktop,
   FowlBrowser, Codex, LCU, Cua, Peekaboo), published with failures. Runs use the owner's Anthropic account login, not API
   credits (owner, 2026-10-15). Since 2026-10-16 (owner) it is 12 tasks, 3 runs per arm (5 where within 20% of the slower arm's time, one top-up round after sleight's final run; owner, 2026-10-17), and arms are
   rerun only when they change (LAWS). The first baseline is about 4 hours, in one away window. After that each new
   competitor or sleight refresh is about an hour. The browser comparison stays in the gate's harness (`bench/fowl/rounds.sh
   --world`) with a Codex arm added there, and the native claim is the native tasks (owner, 2026-10-16). Browser tasks run only against turbo (owner, 2026-10-17); racing lcu, Cua and Peekaboo on turbo's browser tasks is being scoped, and the claim states which browsers it covers (turbo covers Chrome and Helium, and Safari and Firefox use the engine path). The FowlBrowser gate also runs in real browser windows (owner, 2026-10-17: every gate round so far used a launched test browser), with Claude in Chrome added as an arm. The lcu arm gets lcu's
   own Claude Code plugin, installed into the arm's isolated config only (owner OK, 2026-10-16).
3. The Q1 error-message fixes. Q1-1 to Q1-6 are reviewed, and Q1-7 to Q1-17 are in review since 2026-10-15.
4. Speed. The measured gap to FowlBrowser on Haiku 5.5 is mostly time before the first action (67%) and result size (3x larger),
   with code streaming 26% (`ledger/opus-less-code-report.md`), so those come first. Turbo's five tools already cut code per action
   for the browser. IN1 to IN4 proceed on sleight-arch's calls (owner, 2026-10-15): IN1 narrowed to default browser snapshots,
   IN3's design reviewed by sleight-arch, and IN2 and IN4 measured headless or in an away window.
   The skill (94 lines, up from 86 in 1.2.0) gets pruned with an A/B after the tag, not before the gate (owner, 2026-10-15).
   Tracked items (owner, 2026-10-17: don't let these be forgotten like the 2026-10-11 turn study), in
   `~/Projects/sleight-wt/ledger/queue/speed/`: TK1 to TK3 cut tokens per turn (a compact first acquisition, the engine docs sent
   once and shorter, the skill's placement; TK2 closed 2026-10-17, since every nonempty docs section held APIs Haiku used), and TS1 to TS5 fix one turn-study class each. TT1N to TT4 (lease, relay, drag, compact reads) are building now. Each is done
   only when merged and measured by a Haiku A/B on held-out native tasks plus the claim tasks. Model time is about 85% of a run,
   and sleight's first result is about 25,000 characters against Peekaboo's 4,600.
5. The parity battery runs about 25 popular apps side by side with Codex. The harness is built, and 3 of 34 runs are done.
1.4.0 builds now on its own branch, `claude/p140` from the 1.3.1 integration branch (owner, 2026-10-19 04:0xZ): local performance
   analytics (4c), Cursor plugin support (4d) and the AM1 speed map (item 6), one Opus builder each on `claude/p140-*`.
   Owner, 2026-10-19 ~15:20Z: 1.3.1 keeps the flag A/Bs and AS-3, and sleight-arch pushes 1.3.1 public as soon as it is ready
   (the release push is approved). The Codex race fixes from the Sol pair (CR1 a check that nothing covers the bench window, CR2 a popup the
   leased window opened joins the lease, CR3 inject-mail grader and a rescore of every arm) go into 1.4.0. All 1.4.0 building
   and its validation prep finish now, so 1.4.0's validation and release start right after 1.3.1 is out.
   Owner, 2026-10-19 ~15:40Z: commits are authored as penguinspecz with the GitHub no-reply address (the repo had committed as
   `penguinspecz <34923421+penguinspecz@users.noreply.github.com>` since 2026-10-12, which GitHub credited to a stranger's account), and the history is rewritten to credit those
   commits to penguinspecz, with a force push of the public `main` and the tags. sleight-arch rewrites every branch at once
   when 1.3.1 is ready and no builder is mid-flight, and records the old-to-new commit map. Owner, 2026-10-19 ~22:35Z: 1.3.1 pushes
   without it, and the rewrite runs at the next quiet point after 1.4.0's lanes merge, force-pushing main and the v1.3.0 and
   v1.3.1 tags then. 1.4.0 also gets README and hub
   visuals (generated charts, a demo clip, a diagram), a cleaner hub, GitHub Pages for the interactive results page, an
   agent-first install (point a coding agent at the repo URL and it installs sleight), supported hosts and platforms stated up
   front, and a taste pass over the front page on the assumption that it goes viral. The plan is
   ledger/p140/readme-hub-pages-PLAN.md.
   1.4.0 validation (owner, 2026-10-19, LAWS release-validation rule) is the full check and the release pass on the 1.4.0 build
   (B against 1.3.1's release pass). It adds B rounds of the 10 native held-out tasks x3 (A is today's FS native rounds on
   7b9e6227) and of the Safari and Firefox race and AS-3 tasks x3 (A is today's 1.3.1 rounds), both sides on the new held-out CC
   tasks and on demoid (its race prompt changed), then analytics, Pages and the Codex race fix rechecks. Cursor and the public
   agent-install run follow the push and don't block it.
   Owner, 2026-10-19 ~19:45Z: every loss gets improved as far as we can before the 1.4.0 B rounds run. Those rounds should show
   the best build. Studies feeding that: model-side thinking and narration (MT), the native and checkout losses (NL, CK) and
   Firefox's before-action guard reads (GR1). Their measured items are built into 1.4.0 before validation starts.
6. The AM1 speed map of app classes, in 1.4.0 (owner, 2026-10-19). Its VS Code and Word fixtures still fail setup (AM1E designs the
   wait for a late accessibility tree).
7. The ghost hand (owner, 2026-10-16): when sleight acts in a background app, a small translucent hand glides to the point in
   the target window, flourishes on the action and fades. It never moves the pointer, takes focus or catches clicks. It is drawn
   by the existing consent-host helper, on by default with an off switch, kept out of benchmark timing, and its CPU cost is
   measured. LoC's art director designs the hand to match the video. About a day, after the tag. Building since 2026-10-18 (H1 to
   H4 on `claude/p130-gh-*`), a Fable art director drawing the final art, and a Ghost Hand toggle in the menu bar dropdown (owner).
   Later, one shared host shows the glove and its toggle whenever sleight is active (today only while turbo is connected).
8. The open items from the 2026-10-17/18 studies, listed with sources and done criteria in `ledger/LEDGER.md`, section
   "OPEN ITEMS from the 2026-10-17/18 studies" (Word branch steering, the dialog continuation's stopped remainders, typing receipts,
   preview and drag paths, harness loose ends, the ghost hand plan).
9. Smaller queued work, checked against the ledger 2026-10-19: NP-8 superseded, CH1 and AS-4 to AS-7 done. FM3 (switches the
   engine can't read, covered clicks) is being ported to 1.3.0, since Safari and Firefox stay on the engine path. AS-3 (compact
   engine-path browser tools) is scoped for 1.3.1 (owner, 2026-10-19). AS-8 (opening tabs through macOS), AS-9 (parallel engine
   sessions) and TB2 (a turbo arm through the installed loader) wait as described in STATE.

## 3. Live checks still owed

Unit-tested fixes that no live run has confirmed yet, or that failed their last live run. Each is listed in `docs/known-problems.md`.

- Full Screen and Split View handling. Detection is merged, and the Split View pass is open.
- The simulator's first tap (the 2026-10-11 sitting's simulator-form failed, later in fixture setup).
- iPhone Mirroring scroll-to-swipe and settle wait.
- `typeText` after select-all, and the TextEdit save lock (cause unknown).
- `menu_bar` (the sitting's result file and commit disagree) and stale-number (failed).
- The Target and Best Buy shop tasks (failed in the sitting).
- Mail, Mimestream and the chat tasks, with the owner watching (LAWS).
- Desktop sessions staying busy after `/sleight stop` (mod fix, unit-tested only).
- `sleight-mcp setup` in a fresh macOS user, and native Codex taking part in the lease broker.
- Recording a task from the user's demonstration.

## 4. Parked or shelved by the owner

Windows (plan in `docs/design/windows.md`), the Anthropic directory listing, scoped approvals (`docs/design/scoped-approvals.md`)
and the stable-controls mode (LAWS).

## 5. Waiting on the owner

- AS-8 and AS-9: owner qualification and diagnostic runs.
