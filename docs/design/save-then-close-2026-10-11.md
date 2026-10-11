# Calls between saving a document and closing it (2026-10-11)

Research for ROADMAP track 3 step 4: whether Claude spends calls between saving a document and
closing it, and what would cut the gap there. Evidence: the three textedit-save runs of
2026-10-11T00-43-26-532Z with full call code (`SLEIGHT_TRACE_CODE=1`,
[results](../benchmarks/2026-10-11-textedit-save-traced.json), 3/3 passed, Haiku 5.5 at high), and
the six earlier Haiku runs in 2026-10-10T23-23-27-268Z and 2026-10-10T23-32-58-330Z, the
owner-away-night head-to-head passes (4 of 6 passed). Their code is truncated, so calls there are
known from the guard's window-title arguments and the
[clean-arms](../benchmarks/2026-10-10-h2h-clean-arms.json) and
[normal-setup](../benchmarks/2026-10-10-h2h-normal-setup.json) results.

## The call after the save, before the close

The count is zero in all nine runs. After the action that completes the save, Claude's next call is
the close. The close also begins one call after the save's final action in nine of nine runs: the
two actions never shared a call.

| Run | Save completes in | Close in | Model gap between | Close call |
|---|---|---|---|---|
| 1 | call 8, click OKButton with a full read (1.41 s) | call 9, Cmd+W with a full read (0.61 s) | 1.52 s | 2.13 s gross, 4.9% of 43.7 s |
| 2 | call 8, setValue plus Return with a full read (1.73 s) | call 9, Cmd+W with a full read (0.65 s) | 1.78 s | 2.43 s gross, 6.4% of 37.9 s |
| 3 | call 9, setValue plus Return with a full read (1.42 s) | call 10, Cmd+W with a full read (0.57 s) | 2.40 s | 2.97 s gross, 6.4% of 46.4 s |

The verification read rides inside the save-completing call, not in a call of its own. The read
raced the sheet in two of three runs: after the OK click (run 1) and after the saving Return
(run 2), the returned tree still showed the Save sheet beside the renamed window. Run 3's read came
back clean. The close call's read raced too. After Cmd+W, the returned tree of runs 1 and 2 still
showed the window they just closed, and run 3's showed it gone. The engine's settle wait covers one
action. A save chains several (the Return dismisses the sheet, and the window renames before it
closes).

The verified-results line, the `saved:` field of `resultNote`
(`plugins/sleight/lib/compact-reads.mjs`), stayed off in all three of tonight's runs, and its code
documents why. A read still showing the panel suppresses it (`panelStep`): a false "not confirmed"
there sent Claude to check again in h2h-3 (2026-10-10). Its naming sequence must also sit in one
call (Go to Folder, folder, name), which Claude split across calls in all three runs. The saved
file reached Claude through the window note instead
(`plugins/sleight/lib/relay.mjs`: "this call acted on "Save" in TextEdit. The window it shows now
is "2b7f33b9.txt" in TextEdit (file:///…)"), with the URL, in three of three runs.

The earlier six runs show the same call sequence in their four passes. The close is the last call
and begins one call after the save. The failed runs ended inside the sheet. Their extra calls went
to sheet retries and, in one run, to blind reads after the sheet vanished and the guard couldn't
hold a window. No failed run spent a call confirming a save.

## The cuts already tried

A relay note that the save is confirmed cannot merge the close into the save's call. A note travels
with the result of the call that saved, so the close is a separate call by the time Claude reads
it. The note would also duplicate what Claude already gets: the window note gave the saved file and
its URL in three of three runs tonight.

Wording was tried. `SLEIGHT_FIRST_CALL_BATCH=merge` asked for exactly this in the js description
Claude reads every session ("Cmd+W after Cmd+S when the task closes the document",
`plugins/sleight/lib/relay.mjs`). Save and close shared a call in 0 of 24 merge runs
([merge A/B](../benchmarks/2026-10-10-merge-ab.md)). That side's 20% time cut came from first-call
batching (13.3 against 14.4 turns a run), and its own ask happened in none of the 24 merge runs.
Against the ask stands the engine's own instruction, in the API-docs blob returned with the first
call, which sleight does not control: "Persist until the request is fully completed end-to-end …
verify that the returned UI state visibly shows the requested result". Claude followed it against
sleight's wording in all 24 merge runs.

The default wording's split is also deliberate. It ends the call at Cmd+S on an untitled document
because chaining past a shortcut that opens a window or sheet stopped the lease in 10 of 12 TextEdit
batches (2026-10-09). The guard's later fix, which allows a call to continue into the window its own
shortcut opens, is newer than that clause.

A merged save-plus-close call would also pay a guard read before Cmd+W, because Return doesn't
count as quiet for the action after it. That read takes 0.4 to 1 s, so merging the two calls saves
about 1.5 to 2.5 s a run, 4 to 5 percent of tonight's totals.

## Recommendation

Stay with the current behavior at this boundary. The evidence points the same way on every axis:
the save and the close sit one call apart with zero confirmation calls between them, the window
note's file URL already tells Claude the save happened, and the one wording ask aimed at this exact
merge went 0 for 24 in the A/B. The remaining mechanism, the relay sending the close itself, moves
input initiation from Claude to sleight, a scope change rather than a wording change.

If the 2 to 3 s a run are to be pursued anyway, the closest cut relaxes the default wording's Cmd+S
clause (`FIRST_CALL_BATCH`, `plugins/sleight/lib/relay.mjs`) so it covers the save-then-close case
the way the merge variant does. The rest of the clause stays. The measurement that would prove it
reruns textedit-save with three runs a side, traced (`SLEIGHT_TRACE_CODE=1 SLEIGHT_TRACE_CUT=60000`),
owner away. The primary number is the share of runs where the close shares the save's call (0 of 3
tonight, 0 of 24 in the merge A/B). Turn count, model time per run, model time per turn and total
follow, per the speed-claim rule in LAWS. The bar comes from the merge A/B: a shared call in at
least half the runs, with every run still passing.

The split one step earlier sits inside the sheet. The skill says to save to a path in one call once
the dialog shows. Claude used two calls (run 2) and three (runs 1 and 3) after Cmd+S tonight, which
at the model's 2.5 s a turn costs 6 to 9 s a run. Claude passed over that line in all three runs,
so a wording change there also needs the compliance number first: the share of runs where Go to
Folder through the final Return share one call, before any time claim.
