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
