# Real-use harness corrections, 2026-10-09

sleight-arch ran the supplied qualification with the owner away, first at `00d9d62`, then at
`3ac2a33`. The [full results](2026-10-09-real-use-tasks-8.json) retain all five result files,
including the interrupted pass. Their terminal exit codes were not supplied. Sol didn't run live tasks
for this revision. Mail and Mimestream wait until the owner can watch them.

Round 6 passed helium-form, preview-pdf, finder-files and textedit-calculator 3/3 each. Safari failed
setup 3/3. The profile Start Page correction then reached creation, but found zero address fields.
Round 7 failed helium-grid once, then passed it on the next pass. The checker correctly rejected
sorting before the edit took effect. helium-editor was interrupted once, then passed. helium-dense opened
the requested article, but cleanup rejected the changed URL and stopped the pass. Word stopped
mid-task on an unrecognized app dialog, leaving its unsaved fixture open. Excel and PowerPoint did
not run. The Word transcript ends at Replace All, after amber became violet. A replacement result
dialog is likely, but its title and buttons were not recorded. Its identity remains unconfirmed.

## Changes

- Browser cleanup accepts navigation within the same loopback origin and nonce path. It rejects
  another scheme, host, port or nonce, including path traversal. Acquisition still requires the
  initial fixture identity and a unique creation event.
- Safari searches only the retained window's browser toolbar for a URL field. It accepts address
  labels exposed on text fields or combo boxes, requires a writable value and AXConfirm, excludes
  web content, and refuses zero or multiple candidates before navigation. Native Safari behavior
  still needs qualification.
- Safari retains the creation-event reference before metadata or blank-page checks can fail.
  Setup recovery closes that reference when its URL is blank or within the fixture. It checks
  creation uniqueness again before recovery. A later second event, missing reference or foreign
  origin leaves cleanup unconfirmed. Existing blank windows from old passes have no retained
  references and were left alone.
- App result dialogs remain available to Claude. Activation, sign-in and permission evidence in
  titles, buttons or bounded static dialog text stops the run. Those categories take priority over
  welcome text. Records include dialog titles and button names. Static text and editable field values are
  excluded from records. System permission observation and private Mimestream publication are
  unchanged. The harness does not dismiss dialogs itself.

## Finder timing

Means over three successful trials per pass:

| Measure | Round 5 | Round 6 |
|---|---|---|
| Total seconds | 57.2 | 112.5 |
| Turns | 9.3 | 21.7 |
| Model seconds | 21.5 | 61.0 |
| Model seconds per turn | 2.31 | 2.82 |
| Engine seconds | 6.4 | 14.3 |
| Local tool seconds | 24.2 | 33.1 |
| Relay seconds | 2.04 | 0.05 |

The extra model time accounts for 39.5 seconds of the 55.7-second increase in Claude's reported
duration. Round 6's transcripts contain repeated rename, menu and move attempts. Each trial first
called local drag without a window ID and was refused as ambiguous. Later drags stopped at covered
points in 4 cases, and 3 used the foreground fallback because Helium covered those points. The three
trials spent 19.2, 39.0 and 40.9 seconds in local tools.

Finder reads increased in number as Claude tried more actions. Guard reads averaged 313 ms in
round 5 and 243 ms in round 6, with zero read failures in either pass. The evidence points to extra
Claude turns and drag attempts, with more total engine work, rather than slower Finder reads or a
harness wait. Finder's harness is unchanged. Round 5's raw transcripts are absent from the current
evidence bank. Its published timing supplies the comparison. No transcripts or images are published.

## Verification

Native regressions use fake window references, URLs and toolbar trees. They cover navigation,
address ambiguity, blank-window recovery and late creation ambiguity without accessing apps.
Dialog regressions cover result continuation, title/button records, sensitive static text and
permission priority. The result file records failed development attempts as well as passing checks.

`npm run check` exited 0 with 890 unit tests, two plugin validations and 11 mod tests passing.
`npm run lint:prose` exited 0 across 52 files. The ordinary sandbox check exited 1 on localhost
listener and fixture-output denials before the scoped host check passed. Earlier prose and
regression failures remain in the result file. Review found two ownership/dialog issues, both
corrected and reviewed again with no remaining Critical or Important findings.

Live qualification of these corrections remains for sleight-arch, who also owns review and merge.
