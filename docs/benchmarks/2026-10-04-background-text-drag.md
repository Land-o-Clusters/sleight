# Background TextEdit drag follow-up

Research on `codex/background-drag-2`, based on `4409f1c`, 2026-10-04. macOS 27.0
(26A428), Apple Silicon. The prototype moved selected text in TextEdit in five of
five event-posting trials. All pointer samples were identical in 4/5. TextEdit stayed
inactive in all five. Each successful readback was `beta gammaalpha`, with a newline.
That proves movement, but does not pass the benchmark's exact three-word result.

## Drop geometry

The [original fixture](2026-10-03-background-drag.md) queried `AXBoundsForRange(16, 0)`
for the end of the line. In this run it returned a drop point at window coordinates
`(118.9609375, 25.5)`, while the selected glyphs were centered at y = 38.5. The new
runner uses the final visible glyph, `AXBoundsForRange(15, 1)`, placing the drop at
`(118.9609375, 38.5)`. It refuses missing bounds or glyphs on different lines.
Both points are retained in every selection record.

The original helper already posted to the target PID. A 500 ms hold succeeded with
the corrected point. Longer holds and omitting Command also moved the text in their
single trials. Whether the fixture error caused every earlier failure is unknown.
The earlier report also notes possible document ambiguity.

## Attempts

Every command, stdout, stderr, exit status, selection, request, pointer sample and
readback is retained. Failed preparation and the sandbox attempt are included.

| Attempt | Text moved | Pointer samples unchanged | TextEdit inactive | Exit |
|---|---|---|---|---|
| [First build](2026-10-04-background-text-drag-build-failure.json) | No app call | Not sampled | Not sampled | 1 |
| [Sandbox](2026-10-04-background-text-drag-sandbox.json) | App lookup failed | Not sampled | Not sampled | 1 |
| [PID, 500 ms](2026-10-04-background-text-drag-live.json) | Yes | Yes | Yes | 0 |
| PID, 2 s | Yes | Yes | Yes | 0 |
| PID, 5 s | Yes | Yes | Yes | 0 |
| PID, 2 s, no Command | Yes | Yes | Yes | 0 |
| PSN, 2 s | Yes | No | Yes | 0 |
| AX action inventory | No | Not sampled | Yes | 0 |
| [Geometry comparison, cancelled while waiting](2026-10-04-background-text-drag-geometry-wait.json) | No app call | Not sampled | Not sampled | 1 |

The first build used the C spelling of `CGEventPostToPSN`. Swift required
`CGEvent.postToPSN(processSerialNumber:)`. No lock or app action preceded that failure.
The sandbox could not find TextEdit. Its close attempt also failed. Host execution
then completed all six trials and closed all six temporary documents. Its runner
exited 0. PSN posting moved the word but pointer samples changed, so that trial cannot
prove cursor preservation. We cannot attribute the movement to posting or real use.

The AX text area advertised only `AXShowMenu`. It advertised neither `AXDrag` nor
`AXDrop`, so no AX drag action was performed. The local SDK describes obsolete
`AXPick` as selection, so it was not used as a substitute.

The paired comparison compiled both helpers (exit 0), then waited several minutes
for another session's live lock. One Ctrl-C through its original terminal ended
the launcher (exit 1) before either trial started. It did not acquire or remove
the other session's lock. Preparation evidence is retained. This investigation
ended there. An old-point versus corrected-point comparison remains unmeasured.

## Scope and safety

The research stays in `bench/`. The MCP tool still uses its existing foreground
path. The helper retains target-PID and exact-window checks, bounded timings,
front-app-change refusal, and a prepared window-targeted release on interruption.
PSN release uses the same posting API as its press. It never posts HID events,
activates TextEdit or warps the pointer. The window-local setter remains a private ABI.

`bench/background-text-drag-followup.sh` compiles outside the live lock, then uses
the owner's `mkdir /tmp/sleight-live.lock` loop. Its exit trap removes only its lock.
The runner calls `bench/approve.mjs` for TextEdit. Each selection is bound to its exact
document URL and window ID. Cleanup closes only its temporary documents without saving
and stops the batch on a close failure. It doesn't start an engine process or restart ChatGPT.
Results replace home paths with `~`. Temporary evidence banks remain available.

To repeat the six native trials, or just the geometry comparison:

```sh
sh bench/background-text-drag-followup.sh
sh bench/background-text-drag-followup.sh --geometry-pair
```

The runner writes each attempt before opening its document and saves results after
every child command. Compilation failure exits before locking. No `bench/run.mjs`
pass was run. Arbitrary callers of the Swift prototype must take the same live lock.

Review added cancellation checks between app stages and immediately before child
spawning. Cleanup is still allowed after cancellation. These changes were tested
without app access, after the published live trials. The exit verdict now treats
unexpected trial errors as failure even when another trial moved text.

## Limits and checks

This covers one short plain-text line and one macOS build. It does not establish
reliability during real pointer use, across apps, on multiline selections, or after
an engine update. Missing whitespace remains a Known problem in the README.

Test-first runs failed as expected before the option and geometry changes (exit 1,
four failures), before the result judge (exit 1, one failure), and before the native
compile fix (exit 1, one failure). The focused JavaScript suite then passed 7/7;
the native compile and no-app validation test passed 1/1. Review tests first failed
(exit 1, two cancellation failures, then exit 1, one verdict failure). After the
fixes, the focused suite passed 11/11. Baseline: 157/157 unit tests, exit 0.
The first `npm run check` exited 0 (163 Node tests, manifest validation, 8 mod tests).
After review, `npm run check` exited 0 (167 Node tests, manifest validation, 8 mod tests).
`vale sync` exited 0 after the missing-style failure. Prose lint attempts:

| Run | Exit | Result |
|---|---|---|
| 1 | 2 | Missing style pack |
| 2 | 1 | Wording flags: 5 |
| 3 | 1 | Wording flags: 1 |
| 4 | 0 | Zero flags |
| 5 | 1 | Cancellation note flags: 2 |
| 6 | 1 | Lint exit list flags: 1 |
| 7 | 1 | Lint table flags: 2 |
| 8 | 0 | Zero flags in 15 files |
| 9 | 0 | Zero flags after review changes |
| 10 | 0 | Zero flags after recording the final check |

`git diff --check` exited 0.
