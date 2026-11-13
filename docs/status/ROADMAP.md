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
4g. Grok hosts in 1.4.0 (owner, 2026-10-20): the Grok Bot app first, and the `grok` CLI too, as for the Codex and Claude
   CLIs. Grok Bot's live checks use the owner's bot "priya", pinned at the top of the app (Grok Bot has no model picker).
   No Grok marketplace listing. Study: ledger/p140/grok-host-STUDY.md, items GB1 to GB16. The Grok Bot app is in
   1.4.0 too (owner, 2026-10-20), through the shell route (GB14), since a bot's own MCP servers run on Grok's hosted box.
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
   v1.3.1 tags then. Owner, 2026-10-20 ~03:10Z: the rewrite also removes all PII from every commit, published history
   included: the owner's real name (author fields and content), username and home paths (in 27 commits on 2026-10-20),
   personal email, plus vp1's `race-1017/` data and root `*-REPORT.md` files (REL1). A dry run on a mirror clone reports
   every match first, and the release history scan must come back empty before the force push. 1.4.0 also gets README and hub
   visuals (generated charts, a demo clip, a diagram), a cleaner hub, GitHub Pages for the interactive results page, an
   agent-first install (point a coding agent at the repo URL and it installs sleight), supported hosts and platforms stated up
   front, and a taste pass over the front page on the assumption that it goes viral. The plan is
   ledger/p140/readme-hub-pages-PLAN.md.
   1.4.0 validation (owner, 2026-10-19, LAWS release-validation rule) is the full check and the release pass on the 1.4.0 build
   (B against 1.3.1's release pass). It adds B rounds of the 10 native held-out tasks x3 (A is today's FS native rounds on
   7b9e6227) and of the Safari and Firefox race and AS-3 tasks x3 (A is today's 1.3.1 rounds), both sides on the new held-out CC
   tasks and on demoid (its race prompt changed), then analytics, Pages and the Codex race fix rechecks. Cursor and the public
   agent-install run follow the push and don't block it. Owner, 2026-10-20 ~11:15Z: with 12% Claude quota left until the
   reset, validation runs Haiku only today; the release-opus group runs after the reset (or sooner if quota allows by end of
   day) and its numbers join the benchmark pages then. Builds and fixes ride Codex today.
   Owner, 2026-10-19 ~19:45Z: every loss gets improved as far as we can before the 1.4.0 B rounds run. Those rounds should show
   the best build. Studies feeding that: model-side thinking and narration (MT), the native and checkout losses (NL, CK) and
   Firefox's before-action guard reads (GR1). Their measured items are built into 1.4.0 before validation starts.
   Owner, 2026-10-19 ~22:50Z: test incrementally rather than betting on the final rounds. Each item gets unit tests and a
   review, then a replay check (tool-side items: the recorded tool calls sent straight to sleight's server, no model,
   switch on and off) or a 1-run traced smoke (model-side items) as soon as its branch is built. Only items that pass merge. Short
   A/Bs run only for model-side items, on their own tasks. The validation B rounds against 1.3.1's A come last.
   Owner, 2026-10-20 ~15:05Z: 1.4.0's release and the history force push are a go, unless the validation shows a time regression
   that weakens the claim. sleight-arch decides that from the scored A/B, then runs the release steps
   and the force push without asking again. GL9 waits until the validation run ends.
   Owner, 2026-10-20 ~18:55Z: 1.4.0 is released with the ghost hand off by default and a known-problems line that it can run
   ahead of slow page writes. GH8 (hand frames paced to real actions) is a fast 1.4.1.
   Owner, 2026-10-20 ~19:25Z: GL9 passed (Calculator through priya), but Grok Bot approvals show only in the menu bar
   glove as a plain alert and repeat. 1.4.0 releases Grok Bot as a preview with those limits in known problems; GB18
   (styled card at once, one card per request, preapproved apps honored) is released in 1.4.1 after a live check with the owner.
   Owner, 2026-10-22 ~00:50Z: 1.4.1 adds HUB1, an automatic refresh of the charts, hub pages, interactive page and README
   results after each completed benchmark pass, with a release check that fails on a stale hub. GB18 passed the owner's
   check (one card with its sound, shown once). The final T1 film take waits until the owner goes to sleep.
   Owner, 2026-10-22: the launch film is a ~30 s short cut (hook, trick, reveal and title, icon) without the race or the
   playbill. The race becomes its own short clip later (T2: sleight turbo against FowlBrowser on one published Chrome task).
   Owner, 2026-10-22 ~03:40Z: Electron qualified (22/22 and 9/9 in one run on ff8be8b0). After the clear, sleight-arch
   finishes the remaining 1.4.1 items and pushes the 1.4.1 release without asking again.
   Owner, 2026-10-22 ~04:25Z: validation for a point release is slim. 1.4.1 runs Chrome turbo x3 and native x1 a side
   (Haiku), with no Opus round, after the fix that lets the cover check see the benchmark Chrome.
   Owner, 2026-10-22 ~05:05Z: 1.4.1 doesn't release if it measures slower than 1.4.0. A slower native result gets dug into first.
   Owner, 2026-10-23. Cursor released Computer Use on This Mac in its desktop app (3.27.12, default Grok 4.7 High). It joins
   the benchmark as an arm: sleight-arch installs an isolated Cursor CLI and a Sol lane (CA1) builds the arm scaffolding, so
   the probe and the qualification run on the owner's "go". Cursor tests default to Grok 4.7 High.
   Owner, 2026-10-24: building mode. Everything the FowlBrowser delta study and the gap study find is built into the next
   build (claude/p143) first, with LR1 (whole-thread reads). The Cursor calibration and qualification and the FowlBrowser
   head-to-head run once, on that build, after it is done.
   Owner, 2026-10-24 ~21:00Z: the p143 build is released as 1.5.0, not 1.4.3, because it adds about a dozen user-facing features.
   As a minor release it gets the full release validation (full check, release pass, A/B against 1.4.2), not the point-release
   subset.
   Owner, 2026-10-25 ~04:40Z, after the A/B sizing study (`ledger/p142/ab-sizing-1.5.0.md`): the 6.5 h interleaved A/B stays
   as planned (Chrome Haiku x5 plus Opus x1, the other groups x3), and the Cursor qualification stays in the same sitting
   during the fix window. The away block is about 11 h.
   Owner, 2026-10-25: the A/B stops early when 1.5.0 regresses in most groups. After every step the queue scores balanced
   runs (`ledger/p142/v150/checkpoint.mjs`). It pauses when, in more than half of at least three groups with 2 or more runs a
   side, 1.5.0 is slower than the detectable limit (8% Chrome, Firefox and AS-3 Firefox; 20% native, Safari, AS-3 Safari
   and CC) or loses 2 or more passes. sleight-arch then rules out a harness cause and traces the regressed tasks. After the
   fixes, the A/B reruns with both sides fresh. Mixed results keep running.
   Owner, 2026-10-25: remote approvals (RA1, LAWS) are built into 1.5.0 now and tested in tonight's runs. Whether the engine
   can drive apps while the Mac is locked is checked in the morning.
   Owner, 2026-10-25 ~07:05Z: nothing in block A tonight. After RA1 merges, tonight's owner-away runs (Mac
   unlocked) cover the Chrome and Helium live checks and the RA1 live test, then the A/B. Block A (person checks, Cursor calibration,
   mail-to-Numbers) and the Cursor qualification move to the morning.
   Owner, 2026-10-25 ~12:00Z: the owner uses the Mac today, so nothing live runs until tonight. The night of
   2026-10-25 retries the owner-away runs on build d8e92587 (the A/B, then the RA1 live test). The previous night stopped at a
   pending approval prompt with nobody there to answer it.
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
10. The agent cursor (owner, 2026-10-26, items VC1 and up). Owner, 2026-10-26 evening: 1.5.0, 1.5.1 and 1.6.0 become one release,
    1.5.0, benched and tested once on the combined build. Superseded on 2026-10-28: 1.5.0 (`claude/p160`) is released first and 1.6.0
    (`claude/p171`) follows with its own validation, Firefox and Safari speed as its focus (LAWS; owner, 2026-10-29: 1.6.0
    validation may start as 1.5.0 releases). An extra day is fine, and there is no deadline for what makes
    it in. Below, "1.5.1" and "1.6.0" name the work, not separate releases. It grows out of the ghost hand's host, planner and
    capture exclusion, and builds now in parallel, while the quiet-box runs wait. Claude subagents may build it, and Codex lanes
    too.
    - A standard, open protocol: one stream of action events (target, action, drag path, approval waits, errors, the "why") that
      anyone's renderer can read, and a character format that anyone's agent can draw for. It is its own protocol, not Codex
      pets, but Codex v2 pets import as they are.
    - sleight includes no other vendor's pets or art. It does include its own prebuilt characters, drawn in code, because
      they are what people come for (owner, 2026-10-26 evening), and an easy way for people to share characters with each other, such as a
      marketplace.
    - The import wizard says clearly which extra animations a pet needs for the full set of events, and what it falls back to
      without them.
    - The default is a ring, designed to be distinctive and tied to sleight's brand, so people remember sleight by it. It is a
      separate design from the ghost hand.
    - The owner picked concept A, Split Seam, from the four ring concepts (2026-10-26), with moves taken from the others,
      such as concept D's wrap onto the target and concept B's pixel animation for thinking and waiting. It should be fun and
      full of motion, since most people keep the default.
    - The guard fix for the Claude-shell bypasses found in v1.3.0 to v1.4.2 goes into 1.5.1, right after 1.5.0 (owner,
      2026-10-26, as long as 1.5.1 follows within about two days).
    - High-stakes settings changes (turbo on, permission unblock and sites, adding allowed apps, routines) need a
      confirmation that sleight's own engine path can't give, built in 1.5.1 (owner, 2026-10-26). A change that only takes
      access away is exempt. The guard hook and the launcher's terminal check stay as the first two layers. A command typed by
      an agent into a terminal window it opened has the same process ancestry as one a person typed.
    - Owner, 2026-10-26 afternoon. The thread is drawing followers, so the cursor and characters get more ambitious. People
      want characters they can play with, set up in one click at little cost. sleight should also work on Windows PCs.
      A Windows feasibility study (ledger/vc/W1-windows-study.md) and a companion prior-art study (R5) come first.
    - Owner, 2026-10-26 evening: start Windows now as Codex lanes on branch `claude/win`, since the work is long and light on
      compute. The parts that don't need a Windows machine start first; testing waits for a VM, the owner's call.
    - Owner, 2026-10-26 night: sleight builds its own background driver for native Windows apps (UI Automation patterns
      and window messages), with OpenAI's foreground-only Windows engine at most an optional fallback. A design study
      (WD1) comes first and doesn't need a Windows machine. The first VM sitting, on the free Windows Insider Preview for ARM,
      probes OpenAI's engine and runs the Windows host and cards. Known gaps to design around: coordinate clicks in
      Chromium apps, WPF drags and elevated apps.
    - Owner, 2026-10-31: on Windows the goal is compatibility and a decent user experience. In the
      first VM sitting, OpenAI's Windows engine took 3.1 to 3.3 s per window read, against 13 to 26 ms for a raw
      accessibility read in the same VM. Windows speed is measured and reported, but it doesn't gate Windows work.
    - Owner, 2026-10-27 ~23:50 local: the release A/B doesn't wait for the attended sitting. 1.5.0 freezes on a clean full
      check tonight, and the A/B starts as soon as Puddle returns the Mac. The sitting items (own-Cursor calibration,
      mail-to-Numbers, the browser person cards, hardware pause and picker clicks, the settings menu) run whenever the owner
      is around. A fix they need reruns only the groups it can affect.
    - Owner, 2026-10-27 00:20 local, after Chrome round 1 read B 30% slower (157 vs 204 s on 8 tasks, form-checkout 21 vs
      56 s): 1.5.0 should be flat or faster than 1.4.2, and a 30% slowdown won't be released. The feature-complete RC gives
      room to tune it down. Astra study PF1 (`ledger/vc/PF1-perf-study.md`) runs now. Fable studies are also OK.
    - Owner, 2026-10-27 12:00 local: after the release A/B, revisit "flat or faster". A tolerance of about 2 to 5% for
      model noise and the environment is probably fair, but the number comes from measurement, and it must not let
      releases drift slower one small step at a time. Astra study NT1 (`ledger/vc/NT1-noise-floor-study.md`) measured it:
      a 2 to 5% cutoff at today's counts false-alarms 14 to 38% of the time. The owner agreed (2026-10-27 afternoon) to
      sleight-arch's recommendations, now in LAWS: keep the release A/B, cap drift against a fixed 1.4.2 reference, cut
      noise with replay, turn counts, quiet windows and load logs. After the 1.5.0 release, one A/A calibration pilot runs on
      Chrome Haiku and Firefox only (about 14 Mac hours over two or three overnight windows, about 31 runs a side), and the
      release A/B schedule stays at 5 to 6 hours. The FowlBrowser rematch's install runs at the next attended sitting.
    - Owner, 2026-10-30 ~09:30Z: run the 1.5.0 release (sleight-arch tags and pushes). The harness presses Cmd+N through
      sleight before each Cursor entry turn. The owner downloads the Windows build today, and 1.6.0 validation starts at
      once unless building is left.
    - Owner, 2026-10-30 ~04:00Z: the Cursor bank gets one more window. If that window hits a new kind of harness failure,
      1.5.0 releases without the Cursor results, and they publish with 1.6.0.
    - Owner, 2026-10-27 ~23:10 local: 1.5.0 isn't released until everything is sorted. That includes the Cursor arm run
      and the FowlBrowser rematch (both need the owner's sitting), the Chrome Opus and Safari slowdowns (study AS3, the Opus
      pilot), the RS1 fixes and the Chrome rerun on the KT1 build. DI1 becomes an advisory for 1.4.2 users, not a 1.4.3.
      FR1's hole (a CR, U+2028 or U+2029 ended a `//` comment early in code inspection, so an unlisted action could pass the
      flow plan, in tags v1.2.0 to v1.4.2) joins that advisory (owner, 2026-10-31).
    - Owner, 2026-10-26 night, before 1.5.0 goes public. A short speed check comes before the 6 h A/B, so a build that is
      slow everywhere is found in under an hour. The FowlBrowser head-to-head runs against FowlBrowser's newest version, and a
      competitor sweep checks the claims are still current. The results hub's numbers and charts regenerate with every
      release. The README is updated for 1.5.0 with GIFs and demos of the cursor and characters. A release video follows,
      planned with loc arch.
    - Settings without a running session go into 1.5.0 (owner, 2026-10-26 night, SM1): `sleight-mcp menu` opens the menu
      bar item on its own, and an opt-in `sleight` command on PATH. The shell guard covers the new name.
    - The character sprite is hidden by default. sleight offers an overlay mode for it (its design is open).
    - Owner, 2026-10-27 ~00:45 local: the viral video that started the agent cursor shows a giant character hanging off
      windows, and 1.5.0's perch is a 96 by 104 pt character. A Fable design study (ST1) designs a stage size and the
      bigger poses, and it must watch the actual video from that post, all of it. Our art style matters less than people
      being able to make their own. Characters stay out of the benchmarks, but they get their own performance and function
      tests (frame pacing, CPU and WindowServer cost on a quiet screen, behavior checks), because the brand is reliability
      and good engineering. Ideas for interacting with characters go past the video (improve, not copy), and the cast
      adds funny, everyday, non-anime characters for people who aren't into anime, at both sprite and stage size.
    - The ring turns on by default once an A/B measures no slowdown, as the ghost hand's LAWS line requires (sleight-arch's
      reading).
11. Engine-path speed in Firefox and Safari is a 1.6.0 focus (owner, 2026-10-28). The 1.5.0 bank rel3 had Firefox about 7%
    slower than 1.4.2 by mean over two banks (model-side: more turns, re-acquiring the app, `getState` first) and Safari
    about 10% slower in both banks. Goal: flat or faster against 1.4.2 and against the best-ever record. Studies:
    `ledger/vc/rel3-firefox-trace.md`, `rel3-firefox-text-diff.md`, `rel3-safari-trace.md`. Also a best-ever record per bench
    task (lowest median passing time ever, with build, engine and date), kept internal, not published (owner, 2026-10-28).
    Study SF1 (`ledger/vc/SF1-safari-firefox-speed-study.md`, offline) put the completed rel3 release scores at +2.74% Firefox
    and +10.57% Safari against 1.4.2. Its seven items run as Sol lanes from 2026-10-28: SF2 (result budget on multiline
    native trees, tool-side), SF3 (form renumbering recovery), SF4 (first-window guidance), SF5 (RQ1's acquisition counter),
    SF6 (malformed keyboard and text calls), SF7 (new-tab stops, tool-side). SF8 (duplicate acquisition trees) starts after
    SF5's counts. Model-side items wait for an owner-scheduled screening A/B (two ABBA blocks, two held-out tasks per
    browser, 32 attempts per factor). The owner dropped SF3 and SF4's screening A/B for 1.6.0, with no held-out forms, so both
    stay off (owner, 2026-10-31).
12. sleight's own runtime (owner, 2026-10-31, LAWS). agent-desktop (vercel-labs, Apache-2.0, launched 2026-10-30) is the
    possible base. The ChatGPT engine stays until the runtime is as fast or faster with feature parity. Steps, in order:
    - AD1, a Fable study of agent-desktop with a fork-feasibility section (`ledger/vc/AD1-agent-desktop-study.md`).
    - AD2, its benchmark arm, then the head-to-head on the 9 native tasks (Puddle's window 2026-10-31 02:30Z to 04:00Z) and a
      per-action latency probe of the engine and agent-desktop on the same actions.
    - RT1, a Fable architecture study after AD1: fork, bundle or a sleight-owned backend, how the relay calls it, background
      input without focus, and whether the Windows driver (item 10) folds in. It ends with a parity checklist taken from
      sleight's tool surface.
    - Sol lanes per RT1 item, each proved by replay or a traced smoke, and the release-suite A/B against the engine path as the
      gate.
    - `ledger/vc/GE2-engine-open-questions.md` lists what we still can't explain about the engine, for the owner's next
      study (owner, 2026-10-31). Every lane and probe sitting adds to it. The owner started that study on 2026-10-31.
    - Releases (owner, 2026-10-31): 2.0 makes the runtime the default once it passes the parity and speed gate above.
      The opt-in preview beside the engine path, first planned as 1.7, is folded into 1.6.0 (owner, 2026-10-31 evening),
      so one release A/B covers both. 1.6.0 then waits for the preview's build rows (RT9 to RT12, RT14 to RT16), the
      live input gates and the owner's runtime sitting. The engine path stays the default in 1.6.0.
    - Owner, 2026-11-01 ~01:30Z: build every remaining 1.6.0 row and the 2.0 parity rows now, in parallel, keeping
      review quality, so release validation is spent on fixes only. That covers wiring the merged pieces, RT17, RT19's
      parity tests, the runtime's renumbering remap and an action event feed for the hand.
    - RT31, input into virtual machine windows, in the 1.6.0 preview if its study's owner questions are answered in time,
      otherwise after it (owner, 2026-10-31). On engine 26.1027.30824, clicks and keys sent
      to a UTM 5.0.8 Windows guest's window moved the guest pointer but delivered no click and no key, in 3 of 3 tries
      (text, single key presses, a 150 ms held click). Diagnosis comes first: read UTM's input code (Apache-2.0) and probe
      what its view receives, then make sleight's own runtime deliver input there, in the background where UTM allows
      it. If only a foreground or captured-input path works, it is opt-in and says so. Parallels and VMware Fusion get the
      same probe. The engine can't do this today, so it isn't part of 2.0's parity gate.
12b. Settings the shell can't forge (sleight-arch, 2026-10-31, after GD1 to GD8). The Bash guard reads command text, and eight
    review rounds showed it doesn't converge: each round closed exact spellings and the next review re-spelled them, while
    stricter rounds refused ordinary commands (GD6 13.4%, GD8 24 of 35 `eval "$(tool init)"` lines). 1.6.0 includes GD7 and says
    so in known-problems. The fix is structural: sleight's grant and settings files are sealed with a key that only the signed
    helper can use (a keychain item limited to that signed app). sleight then doesn't trust a file that Claude writes through Bash
    or an interpreter. It waits for the Apple Developer signing (weekend of 2026-11-01), and then the guard can shrink to what it catches
    cheaply. Owner, 2026-11-01: go with Fable's SG2 answers (`ledger/vc/SG2-sealed-settings-invariant.md` section 5, now in
    LAWS). The plumbing builds now (lane SG2) and only reports until a signed build turns enforcement on.
13. Demo recordings after 1.6.0 is released (owner, 2026-10-31): one of the full character features, one of the Windows
    driver, and side-by-sides of sleight against other arms on the same task. The Fable plan (DV1,
    `ledger/vc/DV1-demo-recordings-plan.md`, done 2026-10-31) has the shot lists, the capture method within LAWS, build items
    DR1 to DR11 and 11 owner questions, all answered as recommended (owner, 2026-10-31). No published race run has footage, so the side-by-sides need
    fresh filmed rounds (3 runs per arm per task) published as their own family, never replacing the claim numbers. Each
    side-by-side shows each arm's median run by a rule fixed before looking, uncut and at the same speed.

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

The Anthropic directory listing, scoped approvals (`docs/design/scoped-approvals.md`) and the stable-controls mode (LAWS).
Windows was unparked on 2026-10-26 (item 10).

## 5. Waiting on the owner

- AS-8 and AS-9: owner qualification and diagnostic runs.
