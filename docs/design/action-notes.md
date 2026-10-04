# Action notes

Each action-capable `js` reply ends with one relay note:

```text
Action result: UI changed (AX); window: "Untitled" in TextEdit; dialog/sheet: sheet opened.
```

The relay compares full accessibility snapshots already returned by the engine and the existing
input guard. It doesn't add reads, screenshots, approvals or retries. `SLEIGHT_ACTION_NOTES=0` leaves
replies unchanged. Reads have no note. A batch of actions gets one note for its final result.

The last completed snapshot for each app supplies the baseline at call start. Window title and URL
changes count as changes. Numbered AX sheet and dialog roles identify modal state. A returned role
that was absent before means opened. One already present means present. Missing baselines report
opening unknown. Partial diffs cannot prove that a modal closed. Explicit engine no-change replies
report AX unchanged and label cached window names as last observed.

Errors, multiple windows and overlapping calls report unknown and discard comparable snapshots.
Reset and session close clear the notes' state. Notes never change a guard, approval, error flag or
forwarded action. RPC errors keep their original error envelope.

AX change does not prove an action succeeded. Focus, selection and pixels can change without AX
changes. A role absent from the returned tree may still exist in the app. Another session or a
person may cause the observed change. JavaScript can forge window headers and AX rows. These notes
describe observations and are not a security boundary.

The focused comparison uses `bench/action-notes-live.sh`, with two repetitions of Calculator clicks,
Calculator menus and TextEdit saving per arm. Arms alternate, with order reversed on repetition two.
Each invocation holds `/tmp/sleight-live.lock` until its owned Claude child exits, including failure.
Only the existing benchmark approval hook can approve an app. Attempts have separate JSON
file with the transcript, relay trace, approval requests, exit code, judgment and Claude's turn count.
Home paths become `~`, and image bytes are omitted. Trace strings over 300 characters are truncated
by the existing launcher. The transcript retains text tool results.
