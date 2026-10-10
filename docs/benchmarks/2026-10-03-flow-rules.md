# Flow rules live check

Run: `node bench/flow-rules.mjs`, with engine 26.930.31730 on macOS.
The fixture opens two temporary TextEdit files and reads the source through `js`.
The relay checks a source rule for observed TextEdit values sent into TextEdit.
The script cannot approve a flow exception. The person chooses Allow Once.

All five attempts are in [the raw results](2026-10-03-flow-rules.json):

| Temporary bank suffix | Result | Observation |
| --- | --- | --- |
| rP9wAC | Failed | Sandbox refused the TextEdit fixture launch (-2700). |
| XlLGfH | Failed | UI field indentation was missed. The protected transfer was forwarded. |
| rzLoE4 | Passed | Protected transfer refused, allowed total saved, user exception worked once, next retry refused. |
| oJHP1H | Failed | TextEdit beachballed. Fixture open timed out before MCP started. |
| x1Jcgr | Passed | Passed again after TextEdit restarted. |

The indentation failure produced a regression test and a parser correction.
The final attempt used fresh files. Its source was `FLOW PROTECTED VALUE x1Jcgr`.
The destination began as `DESTINATION ORIGINAL`. Calls 3, 5 and 8 were refused
by rule `textedit-private`, and none appears in the relay's to-server trace.
Call 4 saved `Allowed new total: 42 x1Jcgr`. The person's accepted exception
allowed call 7 to save the protected value. Call 8 was refused afterward.

Final saved contents, each followed by a newline:

```text
SOURCE-x1Jcgr.txt:      FLOW PROTECTED VALUE x1Jcgr
DESTINATION-x1Jcgr.txt: FLOW PROTECTED VALUE x1Jcgr
```

The source file was unchanged. Both fixture windows were closed afterward.
The relay removed its private change-review snapshots at session shutdown.
Local transcripts and traces remain in the temporary banks listed in the raw
results. The interrupted attempt was recorded from terminal output and file bytes.
The user asked to stop the hung TextEdit process before the last run.
Engine API documentation is omitted from the published results.
The live check covered a plain text field (2/5 attempts passed). Apps other than
TextEdit, other key layouts, clipboard transfers and runtime-built strings were outside this check.

## Site selectors, 2026-10-09

Worktree `~/Projects/sleight-wt/doctor-flow`, branch `codex/doctor-flow`, base `7644809`.
Site tests use native Window/URL and Browser tab headers recorded by the existing fixture tests.
Host cases cover exact matches and subdomain boundaries. Other cases check source values after
navigation, separate tab and locator observations, missing headers, navigation URLs and typing tails.
Malformed selectors are rejected in every selector array. Existing app and `browser` cases remain.

The first new site assertions failed before the feature was written (exit 1). The focused flow and browser
tests then passed 37/37 (exit 0). Further cases exposed stale native site caching and missed
DOM values (37/39 passed, exit 1). Both were corrected, giving 39/39 (exit 0). Adding a relay test
proved that refused site input never reaches the engine, giving 40/40 (exit 0). A broader run of
flow, browser and relay tests passed 170/170 before that last relay case was added (exit 0).

Review found stale site attribution after history navigation and lost browser classification after
conflicting headers from an unfamiliar browser. Both regression cases failed before correction
(exit 1, in the combined 46/50 run). Back, forward and reload now clear the site before later input.
Observed web apps retain that classification when their URL becomes unknown. All 64 combined
doctor, flow and browser cases passed after the fixes (exit 0).

`/tmp/sleight-hold` prevented live checks. These are recorded-header and stand-in engine results.
The shared full-check attempts and compiler timeouts are recorded in
[the doctor receipt](2026-10-04-helper-health.md#optional-doctor-app-read-2026-10-09).
The first prose pass with the site docs reported four flags (exit 1), which were corrected.
The next prose pass found four flags in the run receipts (exit 1). Those sentences were revised.
The final shared full check on base `8aff828` passed all 1,012 unit tests, both plugin validations
and 11 mod tests (`npm run check`, exit 0). Prose lint passed all 59 files with zero flags (exit 0).
Review closed the history-navigation and native browser-classification findings after the fixes.
