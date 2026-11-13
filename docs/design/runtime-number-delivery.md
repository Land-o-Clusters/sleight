# Runtime element numbers and delivery

The Mac preview keeps read state in the parent MCP server. A helper reply updates
what the parent knows about the window. Numbers become usable after the parent
successfully writes the complete tree, or its own complete diff, to the model at a cell boundary.

`createMacReadState` retains the latest full tree and its read id for each certified
window and process start, with a limit of 16 windows. Input on number N requires
exact equality of the current and delivered trees' numbered lines 0 through N,
in order, plus every descendant line of N. The comparison includes full text,
numbers, indentation and state flags. Any difference refuses numeric input with
`STALE_READ`, `delivery=not-sent` and `retry=safe`, and tells the model to read again.
Changes strictly after the target's subtree allow that target. The helper also
checks its retained AX objects for liveness before input.

A focus change counts as a difference. In `click(1); setValue(1, 'Alice')`, a click
that adds `focused` to line 1 makes the setValue refuse. Read and deliver the
focused tree in a new cell before using that number again. Several actions may
share a cell when the compared lines are identical.

`runtime-select.mjs` serializes the number check, native dispatch and returned
read. Internal reads never widen the delivered map. A cell that clicks Add and
then clicks 3 refuses the second click if Add inserted a different element at 3.
That includes direct worker IPC, computed numbers and aliased methods.

The parent retains canonical observations for relay guards. At `displayResult`,
it removes those guard-only trees and returns the output requested by the cell.
Cap and guard notices after a removed tree remain visible. Only exact full trees
that match parent observations from that cell can establish a delivered map. With
repeat-read compaction enabled, the parent prepares a diff from that complete
output and commits the same full map after successful delivery.
A hidden read followed by `void 0` displays no tree. A sliced
print displays its slice and establishes no new numbers. The evaluator prints a
read returned as the cell's value even with `emit:false`. Its full tree then counts
as delivered. Reprinting a stored string in a later cell establishes no new map.
A relay cap or refusal that removes the full canonical evidence also prevents
that cell from advancing the map.

`displayResult` prepares output but doesn't grant numbers. The relay must call
`nativeSession.recordDelivery(msg.result, error)` from `clientOut.write`'s callback,
with the exact returned result object and the write error. Only a successful
callback advances delivery. Failed, absent and old-turn callbacks grant nothing.
The Mac delivery transport wires this callback through the relay's final output.

The number check exempts named read and inventory methods. Every other method
checks its first argument and `target`. Drag also checks its second endpoint.
Coordinate tuples and named selectors keep their existing meaning. `{id}` and
`{label}` resolution, ambiguity refusal and liveness checks remain in the helper.
Selecting by label resolves the element that currently has that label.

Both the `turn_ended` tool and the relay's turn lifecycle call `endTurn`. Old-turn
observations cannot restore numbers. A reset clears all read and delivery state.
Malformed reads, duplicate read ids and truncated trees cannot authorize numbers.

## Repeat reads

The Glide engine returns full trees to evaluated code. Model display also stays
full by default. `SLEIGHT_GLIDE_COMPACT_READS=1`, sampled at server startup, enables
changed lines at the parent's final display boundary. It imports the ChatGPT
path's compactor without changing that module. The diff retains the window header
and root, removed lines and added lines with current numbers. An unchanged read
uses the existing no-change sentence. The parent sends the full tree when a diff
exceeds 60% of its size.
Secure fields retain the helper's `<redacted>` text.

The baseline is the last successfully delivered full observation for that window
and process start. Hidden, sliced and capped reads cannot advance it. A worker's
diff cannot replace it. Scratch state follows multiple reads in one result in display order.
An outstanding final write makes later output full until acknowledged; an older
callback cannot roll back a newer delivered map. Turn end, reset, invalidation and
helper failure revoke the corresponding state. Different window identities never
share compaction history, even when their titles or text match.

`getAXState({disableDiffing:true})` and the combined read keep their model display
full. The parent consumes this display preference before native dispatch. Truncated
reads, ambiguous window attribution, degraded button metadata and failed results
stay full. These rules preserve the full-tree baseline used for number safety.

Run `node scripts/runtime-read-replay.mjs` for an offline character count over the
recorded Calculator pairs in `tests/fixtures/rt11f-replay.json` and the Excel bank
in `tests/fixtures/excel-reacquire.json`. The replay excludes sliced and diff-only
Excel blocks from complete observations. It compares both backends' display
characters and checks false added lines and missing current numbered lines.
It measures no model turns or latency. A gate A/B must show task turn counts at
or below the ChatGPT path before changing the default.

## Validation limits

The tests use recorded trees, synthetic trees, restricted Node workers and fake
native replies. No live AX object, native input, screenshot or model-driven task
was tested for this change. Labels containing the relay's reserved guard markers
still fail with `DRIVER_PROTOCOL`. The ChatGPT path's returned read strings and
the Glide engine's model turn counts remain unverified.
