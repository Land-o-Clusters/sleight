# Unsaved review

## Capture and display

Extend `SLEIGHT_STATE_REVIEW=1`, off by default, using the full accessibility trees already
returned by app reads and the guard. Add 0 engine reads, screenshots or per-action writes.
`SLEIGHT_RECEIPTS=1` also saves the comparison in the private turn receipt. The existing pane
shows the same review text, including when receipt files are off.

For each window with attempted input, compare its first full observation with its last full
observation in the turn. A previous turn's final observation can supply the baseline. This is
observed state around the work, not a fresh snapshot immediately before every action. The guard
can reuse a read less than 10 s old and skip reads inside a batch. A person's intervening edits
can appear in the comparison. Extra reads would change cost and attribution without proving
who made an edit, so this slice keeps the existing read schedule.

Capture value lengths for text fields, text entry areas and popup values, selected-text lengths
and selection flags, and normalized checkbox states. Text contents and arbitrary labels or IDs
never appear in the comparison. Match unique controls by role and AX identifier, or by unchanged
structure and label when no identifier exists. Hash nonsecure contents for comparison only;
do not publish the hashes. A text replacement of the same length still counts as a change.
Exclude secure or password nodes and their descendants before hashing or projecting fields.
The native window-level selected-text footer has no field identity, so exclude it whenever a
secure node is present. Rootless, truncated or malformed observations leave field review
unavailable, and an absent footer doesn't prove an empty selection.
The engine's existing raw reply can contain sensitive text; this feature cannot protect the
engine, its transport or an independently enabled raw trace.

Show numbered windows and numbered fields so title redaction does not collapse two windows
into the same displayed name. Each changed field gives its role, property and before/after
state: `checkbox 2, value: unchecked -> checked` or
`text entry area 1, value: [redacted 5 chars] -> [redacted 8 chars]`.
Added, removed or ambiguous controls, missing full trees, failed calls, overlapping calls and
omitted calls must leave field review unavailable or partial. A diff alone gives change counts,
not invented field values. Limit field display to 100 changes per window and report truncation.

## User decisions

Only the user decides keeps and undos. Leaving the app as it is accepts the observed state,
without proving that it saved. Show an enabled native Undo or Revert To Saved control only when the
final observation contains one. The user uses it in the app. This slice sends 0 undo keys and
doesn't offer automatic restoration of app state. One Undo may cover only the last edit, and another
person's work or autosave can change what Undo would do. Saved-file review keeps its separate
user prompt and byte restoration.

The guard runs inside JavaScript Claude writes and can bypass or forge. It is a cooperative
aid, not a security boundary. A before/after comparison is an observation, not proof of action
success, completeness or authorship. Limitations belong in [known problems](../known-problems.md).

## Offline evidence and live handoff

Use recorded TextEdit replies for value changes and constructed trees for checkbox, popup,
selection, secure-field, ambiguity and failure cases. Run every new test on the old code once,
then on the new code. Run `npm run check` and `npm run lint:prose` bare before committing.
No live run belongs to this lane.

The recorded TextEdit tests compare 17 to 18 value characters, including a newline-only edit,
and 17 to 6 selected characters. A synthetic 103-field change displays 100 and reports 3 omitted.
The relay test forwards 3 calls with field review enabled and receipt files disabled, and checks
the redacted comparison in both the metadata and text fallback.

sleight-arch's live check must show an untitled TextEdit edit in the receipt and the pane. Repeat
with a form and with a settings checkbox or popup. Include exactly the acted-on windows. Check a
same-length text replacement and a selection change too. Entered text, selected text, field
labels that echo it and secure fields must be absent from the receipt and review. Two windows
of one app must remain distinguishable. With review off there must be no field comparison;
with review on and receipts off the pane must still show it. Compare traces with both settings
off and on to confirm 0 extra engine reads. A missing or failed final read must say unknown,
and a canvas or pixels-only app such as iPhone Mirroring must say field review unavailable.
Observe any offered native Undo label and verify that nothing invokes it until the user acts.
The user must demonstrate Undo in the app, then Keep by leaving a later change in place; check
the app's resulting state separately from the receipt. Publish every live outcome and timing.
