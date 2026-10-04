# TextEdit spacing and unnamed menu controls

Branch `codex/drag-polish`, worktree `~/Projects/sleight-wt/text-drag-menu-names`, 2026-10-04.

## Design and safety

The drag helper snapshots the TextEdit text area under the source point, after activation and the
existing cover check. After mouse-up, it adds a preceding space only when the whole before/after text
proves a unique, complete word moved to a joined line end. The moved word must remain selected.
Only TextEdit's bundle ID takes this path. Other apps keep the existing drag behavior.

The repair replaces AXSelectedText with the same word preceded by one space and reads the whole
text back to confirm it. It does not use the clipboard or type keys. Missing AX access, repeated
words, partial words, punctuation, multiword selections, unchanged text and other edits skip repair.
An unsupported or unconfirmed AX write returns `spacingError`, asking the caller to read the document.
This is a text match, not protection against a concurrent edit between the AX read and write.

The menu reader keeps semantic names. An unnamed control gets its role and position relative to
the window, so moving the window doesn't change the name. If AX omits a position, its role and
element number are the fallback. The existing numeric `press` interface stays in place.

The focused harness uses the production relay, local tool handler, input leases and benchmark
approval hook. It doesn't start an engine process. All app actions use temporary TextEdit documents, with
exact-path cleanup. The shell owns `/tmp/sleight-live.lock` only during a run, and removes it on exit,
including failures. The owner said they would be away in three minutes; the first run began after
that delay. ChatGPT was not quit or restarted. No `bench/run.mjs` pass was run.

The benchmark approval hook now recognizes menu-bar requests for its existing three-app allowlist.
Tests refuse other apps and notification requests. Production approval handling is unchanged.

## Attempts

| Attempt | Result | Exit |
| --- | --- | --- |
| Baseline unit suite | 157/157 | 0 |
| Initial regressions | 0/4, missing spacing helper and empty control names | 1 |
| First spacing and naming regressions | 4/4 | 0 |
| AX repair regressions | 6/6 | 0 |
| Press mapping regressions | 7/7 | 0 |
| Benchmark menu approval regression before hook change | 0/1 | 1 |
| Combined regressions after hook change | 8/8 | 0 |
| Partial-word regression before source boundary check | 6/7 | 1 |
| Combined regressions after source boundary check | 8/8 | 0 |
| [Live attempt 1](2026-10-04-drag-polish-attempt-1.json) | Sandbox blocked TextEdit and Apple Events; 0/3 reached drag | 1 |
| [Live attempt 2](2026-10-04-drag-polish-attempt-2.json) | 0/3; unchanged text, newline caret gave the wrong drop row; harness shutdown also failed | 13 |
| [Live attempt 3](2026-10-04-drag-polish-attempt-3.json) | 0/3; changing the source glyph didn't correct the drop row | 1 |
| [Live attempt 4](2026-10-04-drag-polish-attempt-4.json) | 2/3 exact results after measuring the final glyph; both confirmed one space inserted | 1 |
| First prose lint | Missing worktree-local Vale styles | 2 |
| `vale sync` | Downloaded the pinned style pack | 0 |
| `npm run check` | 165 unit tests, plugin validation and 8 mod tests passed | 0 |
| Prose lint after adding the report | 3 wording errors | 1 |
| Prose lint after wording fixes | 0 errors, warnings or suggestions | 0 |
| [Menu attempt 1](2026-10-04-drag-polish-menu-attempt-1.json) | Interrupted while waiting for another session's lock; no app run | 1 |
| Lock cleanup test before waiting for the owned child | Failed: lock released before child cleanup | 1 |
| Lock cleanup test with the child wait restored | Passed, lock kept through cleanup | 0 |
| Final `npm run check` | 166 unit tests, plugin validation and 8 mod tests passed | 0 |
| Prose lint after adding the cleanup review | 1 wording error | 1 |
| Final prose lint | 0 errors, warnings or suggestions | 0 |

The raw files include relay requests, replies, approval decisions and exact fixture reads. Attempt 2
has no final harness field because its shutdown awaited a reply from an engine it never started;
the terminal reported exit 13. Later runs close the local relay directly. All fixture documents from
the host runs closed without a reported cleanup error.

Attempt 4's first trial ended as `\n beta gamma\n`: the word was removed, and the spacing guard did
not change that text. Trials 2 and 3 ended as `beta gamma alpha\n`. This fixes the verified
spacing case, but does not make text dragging reliable. The failed drag remains in Known problems.

The menu live command waited for another session's lock and was interrupted through its retained
terminal handle before starting Node. It didn't request an app approval or drive an app. The ordinary
TextEdit window diagnostic in the harness does not count as an unnamed-popover test or a live press
test. Live popover behavior remains unverified and is recorded in Known problems.

Review found a cleanup gap if a live run was interrupted. The shell now forwards termination to its
owned Node child, waits for document cleanup, then releases the lock. Node records interruption and
stops before opening another trial. A unit test uses a private lock and a bounded stand-in child;
removing the child wait makes the test fail. The reviewer checked the production safety paths and
the cleanup fixes, and marked the branch ready for architect review.
