# Replay

A run Claude finished can run again with no model. `record` reads the Claude Code transcript and
keeps the sleight calls that succeeded, in order. `replay` starts a fresh sleight relay, the same one
Claude Code runs, sends each call and stops at the first error.

```bash
sleight-mcp record <transcript.jsonl | session id> task.json
sleight-mcp replay task.json
```

## Safety

- An element number points at an element only in the tree Claude saw. Recording turns each literal number
  into what names that element in the tree Claude saw: its AX ID if no other element there has it,
  else its label, else its whole line. The window guard finds that element again in its own read
  before the action, and stops when it finds none or several.
- The guard still checks the window's title, app and URL before each action, and the input lease and
  approvals still apply.
- Screen coordinates, `drag` points and computed element numbers depend on where windows are. A
  script with any of them refuses to start unless you pass `--allow-positions`.
- Reads that only showed Claude the window are dropped. The guard reads for itself.
- Approvals go to the terminal you run it from. Without a terminal, only apps on your pre-approved
  list run.

## Measured

On Calculator (2026-10-09), a recorded run of 3 calls (open View, choose Scientific, compute 2^10)
replayed in 5.5 s against 17 s for the run Claude made. Starting from 0 it left 1,024 on the display.
Replays that started at 1,024 ended there too (2/2), which shows they ran, not that they computed it. Started with 7 entered, Calculator shows Clear instead of All
Clear, and the replay stopped at that click without pressing anything.

## Limits

- The app must start where the recorded run started. A different document, mode or entry stops the
  replay. A script repeats one run. It doesn't adapt the way Claude does.
- An element's line includes its value, so a line-matched element whose value changed stops the step.
- Only `js` and `drag` calls replay. Recording lists the other tools it skipped.
