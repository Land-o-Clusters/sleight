# sleight laws

What is true always. A line changes only when we learn we were wrong. Measurements and current status
belong in [STATE.md](STATE.md).

## Owner decisions

- The owner pushes changes to `.github/workflows/` and any `*.yml`. The org ruleset
  `no-workflow-edits-without-disabling-this-ruleset` blocks everyone else. Only the owner toggles it.
- Going public, money, scope changes, and redistributing or bundling anything that depends on another
  vendor's app or engine are the owner's call.
- The project's name is sleight, and its icon is the two-hands image from ChatGPT (2026-10-03).

## Approvals and safety

- An accepted app approval lasts for one Claude Code session, kept in the relay's memory. The relay never
  sends `persist: "always"` and never remembers a decline. `SLEIGHT_APPROVAL_SCOPE=once` turns it off.
- Apps get approved without a person only through the benchmark's allowlist (Calculator, TextEdit), and
  only in benchmark runs. When a safety check blocks an action, the owner does it or it doesn't happen.
- sleight's branding uses only its own marks, never another company's logo or mascot.

## The engine

- The engine diffs UI state against the latest read of an app, whoever made it. So the pane snapshots
  only between turns, and the next prompt tells Claude to do a full read.
- The engine refuses terminal apps. Real pointer activity in an app counts as a person taking over.
- The engine doesn't remember approvals. In Codex the host does, so here the relay does.

## Method

- Run every check bare, capture its exit code, commit only on 0. Commit with the pathspec on the commit.
- Live behavior is proven by a live run, judged from the relay trace and the transcript, not the screen.
- Docs pass `npm run lint:prose` with zero flags. Limitations go in the README's "Known problems" when we
  find them.
