# sleight laws

What is true always. A line changes only when we learn we were wrong. Measurements and current status
belong in [STATE.md](STATE.md).

## Owner decisions

- The owner pushes changes to `.github/workflows/` and any `*.yml`. The org ruleset
  `no-workflow-edits-without-disabling-this-ruleset` blocks everyone else. Only the owner toggles it.
- Going public, money, scope changes, and redistributing or bundling anything that depends on another
  vendor's app or engine are the owner's call.
- sleight is public (owner, 2026-10-03). LCU gets a link and credit in the README, no heads-up, and
  the desktop app's declined prompts aren't reported to Anthropic.
- The project's name is sleight, and its icon is the two-hands image from ChatGPT (2026-10-03).
- sleight launches at 0.x (owner, 2026-10-03). 1.0 waits until it has survived two or three ChatGPT
  engine updates, someone else has installed it from the marketplace, the desktop pane's picture is
  verified, and the benchmark compares it with another tool.

- The owner's rule for every open-source project of theirs, sleight included (2026-10-03), in order:
  do what competitors do, but better. Improve on them where they haven't. Then build what nobody has.

## Approvals and safety

- An accepted app approval lasts for one Claude Code session, kept in the relay's memory. The relay never
  sends `persist: "always"` and never remembers a decline. `SLEIGHT_APPROVAL_SCOPE=once` turns it off.
- Apps get approved without a person only through the benchmark's allowlist (Calculator, TextEdit, and Chess since 2026-10-03), and
  only in benchmark runs. When a safety check blocks an action, the owner does it or it doesn't happen.
- sleight's `menu_bar` and `notifications` tools act outside the engine, through macOS Accessibility
  (owner's scope call, 2026-10-03). Each app's icon needs the user's approval, as do notifications,
  with the same session memory as engine approvals. Every action on an app waits for that approval.
- sleight's branding uses only its own marks, never another company's logo or mascot.

## The engine

- The engine diffs UI state against the latest read of an app, whoever made it. So the pane snapshots
  only between turns, and the next prompt tells Claude to do a full read.
- The engine refuses terminal apps. Real pointer activity in an app counts as a person taking over.
- The engine doesn't remember approvals. In Codex the host does, so here the relay does.

## Method

- Run every check bare, capture its exit code, commit only on 0. Commit with the pathspec on the commit.
- Live behavior is proven by a live run, judged from the relay trace and the transcript, not the screen.
- Benchmark results are published in full: every run, failures included, with the raw results file
  in `docs/benchmarks/` and the caveats stated (owner, 2026-10-03). We never pick runs after seeing
  them.
- Docs pass `npm run lint:prose` with zero flags. Limitations go in the README's "Known problems" when we
  find them.
