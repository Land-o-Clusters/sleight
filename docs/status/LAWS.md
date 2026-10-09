# sleight laws

What is true always. A line changes only when we learn we were wrong. Measurements and current status
belong in [STATE.md](STATE.md).

## Owner decisions

- The owner pushes changes to `.github/workflows/` and any `*.yml`. The org ruleset
  `no-workflow-edits-without-disabling-this-ruleset` blocks everyone else. Only the owner toggles it.
- Going public, money, scope changes, and redistributing or bundling anything that depends on another
  vendor's app or engine are the owner's call.
- sleight is public (owner, 2026-10-03), and promoting it is cleared: the owner checked the licensing
  of depending on the ChatGPT app's engine (2026-10-05). LCU gets a link and credit in the README, no heads-up, and
  the desktop app's declined prompts aren't reported to Anthropic.
- The project's name is sleight, and its icon is the two-hands image from ChatGPT (2026-10-03).
- sleight launched at 0.x (owner, 2026-10-03) and reached 1.0.0 on 2026-10-09, after it survived
  two ChatGPT engine updates, someone else installed it from the marketplace, the desktop pane's
  picture was verified, and the benchmark compared it with LCU and Codex. The owner approved 1.0 on
  the condition that its head-to-head and release pass ran with them away, with no new failure that's
  sleight's fault.
- The owner's rule for every open-source project of theirs, sleight included (2026-10-03), in order:
  do what competitors do, but better. Improve on them where they haven't. Then build what nobody has.
- No benchmark against Claude's own computer use (owner, 2026-10-04): its shortcomings are why sleight
  exists. The README compares the two from Anthropic's documentation.
- A release means a git tag plus a GitHub release with notes from the changelog (owner, 2026-10-04).
- Sonnet 5.5 at medium effort is the default driver for the benchmark and the docs (owner,
  2026-10-08, after the four-model comparison in `docs/benchmark.md`).
- Codex runs on gpt-6.1-sol (owner, 2026-10-04), except deep performance tuning in the code, which
  may run on gpt-6-astra (owner, 2026-10-07).
- The benchmark grows toward the apps people use (owner, 2026-10-09): varied web pages (sheets,
  docs, dense, interactive, collapsible), Microsoft Office (Word, Excel, PowerPoint), and mail
  apps, where tasks only navigate and never send. Mimestream runs on the owner's own Gmail and only
  opens and reads, and its published results don't include any mail content (owner, 2026-10-09).
- Speed comes before the guard's read between actions in a batch (owner, 2026-10-09): keys,
  typing, paste and coordinate actions after the first action in a call skip it by default, as in
  Codex. The first action and numbered actions keep their check, and `SLEIGHT_GUARD=careful` keeps
  every read. The bar is Codex's speed and footprint under any load.
- Codex time goes to known problems and enhancements, not benchmark runs (owner, 2026-10-04).
  SUPERSEDED (2026-10-09): "one benchmark pass per merge that changes default behavior". The owner
  now wants several fixes and features batched into each release, with one full pass per release. In
  development only the affected tasks run.

## Approvals and safety

- An accepted app approval lasts for one Claude Code session, kept in the relay's memory. The relay never
  sends `persist: "always"` and never remembers a decline. `SLEIGHT_APPROVAL_SCOPE=once` turns it off.
- Apps get approved without a person at the moment of use only two ways: the benchmark's allowlist
  (Calculator, TextEdit, Chess, and Simulator or DeviceHub since 2026-10-07, by name or bundle ID) in benchmark runs,
  plus Safari, Preview, Finder and Helium for the real-use tasks (owner, 2026-10-08) and Word,
  Excel, PowerPoint, Mail and Mimestream for them too (owner, 2026-10-09), and the repo's own
  hang fixture (`org.sleight.reliability-fixture`, owner, 2026-10-08) in its probe, and a list the user writes in
  a file outside any project, read by sleight in every session, headless or not (owner, 2026-10-04).
  No project or plugin can add to either. Claude edits the user's list only on the owner's explicit
  order in chat, names the change and its end date in STATE, and keeps the earlier list (owner,
  2026-10-05). When a safety check blocks an action, the owner does it or it doesn't happen.
- The engine refuses terminals and OpenAI's own apps (ChatGPT, Codex, Atlas). sleight never modifies or
  wraps OpenAI's helper to change that. Users may opt in to drive those apps through sleight's own
  Accessibility path once they consent for each app. Each terminal command is shown to them before it
  runs (owner, 2026-10-04). Users who turn off the helper's refusal themselves
  (`ComputerUseAllowForbiddenTargets`) get the engine's per-app session approval instead, with the
  prompt saying so and settings windows refused. sleight never sets that default (owner, 2026-10-05).
- sleight's `menu_bar`, `notifications` and `drag` tools act outside the engine, through macOS
  Accessibility and posted mouse events (owner's scope calls, 2026-10-03 and 2026-10-04). Each app's icon needs the user's approval, as do notifications,
  with the same session memory as engine approvals. Every action on an app waits for that approval.
- sleight's mod may approve, in Claude Code's `tool.check`, only its own pane snapshot (the exact code
  it built) and `turn_ended`, matched by `next.origin.plugin === 'sleight'`, which the host sets. It
  never approves a call Claude made (owner, 2026-10-08).
- sleight's branding uses only its own marks, never another company's logo or mascot.

## The engine

- The engine diffs UI state against the latest read of an app, whoever made it. So the pane snapshots
  only between turns, and the next prompt tells Claude to do a full read.
- The engine refuses terminal apps. Real pointer activity in an app counts as a person taking over.
- The engine's helper serves every Codex and sleight session on the Mac, and Codex runs inside the
  ChatGPT app. Restarting ChatGPT ends every Codex thread, so it's the owner's call, never a test step.
- macOS picks a drag's drop target from what's on screen at the drop point. A drag posted to an app in
  the background never drops into a window another app covers there.
- The engine doesn't remember a session's approvals. In Codex the host does, so here the relay does. It
  does honor the "Always allow" list ChatGPT keeps (`ComputerUseAppApprovals.json`), with no prompt to
  sleight. That file is the user's ChatGPT setting: sleight reads it at most, and the owner decides any change.

## Method

- Run every check bare, capture its exit code, commit only on 0. Commit with the pathspec on the commit.
- Live behavior is proven by a live run, judged from the relay trace and the transcript, not the screen.
- Benchmark results are published in full: every run, failures included, with the raw results file
  in `docs/benchmarks/` and the caveats stated (owner, 2026-10-03). We never pick runs after seeing
  them: every full pass is published, intermediate and noisy ones too.
- A pass measures sleight only while a regular desktop shows the benchmark apps' Space and the screen
  is clear of system dialogs. Any other pass is published with that caveat.
- The owner's installed sleight is a copy keyed by version, refreshed only by `claude plugin update`.
  Before asking the owner to check anything in a session, update it and confirm its `gitCommitSha`.
- Codex agents build on `codex/*` branches in their own worktrees and never push to `main`. sleight-arch
  reviews each branch (design note, safety paths, evidence for personal data), squash-merges it onto
  `main` so scrubbed history stays off it, and releases. Conflicts in the relay's core go back to
  the branch's author to rebase. Hand merges there broke the relay twice.
- A Codex report is a claim until sleight-arch reproduces it under normal use: the owner at the Mac,
  other apps open. Results measured while the owner was away say so.
- Live checks that drive apps hold `/tmp/sleight-live.lock`, taken with `mkdir`, released on exit. A
  command that can't take it stops there (`mkdir … || exit 1`), so nothing after it runs.
- A run that can take the owner's pointer or keyboard happens only while the owner is away from the
  Mac (owner, 2026-10-09). Chess drags and the simulator can, and so can any foreground fallback.
- A benchmark run quits every app it launched, so no keyboard event tap is still installed after it. When the owner
  reports a dead keyboard or pointer, stop every live run first, then look (2026-10-09).
- Claude arms run without tools that reach outside the app or search files (Bash, Write, Edit, Glob,
  Grep, Read, Skill, the web tools). The user's own plugins and settings load in a run, and each of
  these has once changed or stalled a run (Glob never returned, 2026-10-09).
- Benchmark cleanup closes only windows it holds a reference to, never one found by title. It leaves any
  other window open and names it to the owner.
- A skill or prompt change that alters what Claude does is released only after the affected tasks ran with
  it: a hint that read well (press a 3D piece at its head) cost Chess runs (2026-10-09).
- Benchmark arms run from folders outside any git repo. Claude Code loads CLAUDE.md from parent
  folders and keys project memory by the git root, so a folder inside this repo leaks both.
- The marketplace installs from the default branch, so `main` is what new users get. Keep it releasable:
  a default that fails the benchmark goes back to opt-in at once.
- Window titles can include the owner's name (Chess games do). Scrub evidence and screenshots of them.
- Recordings and screenshots capture individual windows (`screencapture -l`), never the whole screen
  or a display region: messages, notifications and other apps on it are private. Open and Save panels
  show the home folder, so their frames are left out.
- The plugin folder contains only code the plugin runs. Research prototypes go in `bench/`.
- Published results and logs show home paths as `~`. Check raw logs for personal data before publishing.
- A guard that runs inside the engine's JavaScript can't be a security boundary, because Claude writes
  that code. Features built on one say so plainly; only the user decides approvals, keeps and undos.
- A speed claim gives turns, model time and model time per turn with the total. The model API's
  latency changes from pass to pass, so total time alone can show a change that isn't sleight's.
- Every release rereads README.md whole and fixes any number, version or behavior that's no longer
  true (owner, 2026-10-09). A claim tied to a release or a pass names it.
- Docs pass `npm run lint:prose` with zero flags. Limitations go in `docs/known-problems.md` when we find
  them.
