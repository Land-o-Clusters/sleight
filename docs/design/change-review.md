# Change review

Off by default. `SLEIGHT_CHANGE_REVIEW=1` turns it on.

## Capture

The relay tracks Window and URL headers from completed `js` results. Before a
potentially mutating `js` call, it copies the last observed `file://` document
into a private session directory (mode 0700). A directory document is copied
recursively. Later actions and review decisions retain the first copy.
Standalone acquisition, inventory, AX-state and screenshot reads take no lease
or snapshot. Other JavaScript counts as a possible edit. A failed snapshot stops the call before forwarding.

After the action returns, the relay records hashes, file identities, sizes,
permissions and modification/change timestamps for the document and its files.
The result must confirm the same Window and URL. Missing or different headers
leave undo unavailable. A document first discovered after an action is listed
without a before copy, and undo refuses. Read the intended window before editing.

An injected wrapper checks the window before common app actions and requests
a full header afterward. This prevents some mistakes. Arbitrary JavaScript can
bypass it or forge headers. File snapshots and conflict checks run in the relay,
but attribution to an app action still depends on those cooperative observations.

## Decisions

`review_changes` lists every captured or late-discovered file document. UTF-8
text files get a unified diff. Other encodings, binaries and packages get byte counts
and modification dates. `op: "review"` presents each document separately through
`ask.js` on the desktop or an MCP elicitation elsewhere. Keep, Undo and Later
are user choices, and the tool doesn't accept a decision argument from Claude. A declined,
cancelled or incomplete prompt leaves the decision pending. Keep retains the
saved file. Undo restores the session's original saved copy.

Undo checks the complete fingerprint after the prompt and again after staging
the replacement. A changed, missing or redirected path refuses restoration,
including changes made between agent calls. A replacement is staged beside the
document. The current file or package is parked during replacement and restored
if installation fails. Failed rollback reports the parked copy's location.
Snapshots are deleted on session shutdown, including unexpected engine exit.
A forced process kill or machine crash can leave a private temporary directory.

## Limits

Unsaved buffers, app state without file URLs, and menu bar or pointer tools are
outside this capture path. A Save As target has no before copy. Edits outside
sleight are not attributed to it. An outside edit during an action can appear
in that action's saved result. Autosave after the result causes a conflict.
There is no filesystem lock against a writer racing the final rename.
Restoring bytes does not refresh an open app buffer, so reopen the document
before further edits or autosave can overwrite the restored file. macOS copies
preserve file contents, permissions, resource forks, ACLs and extended attributes.
Large diffs can exceed the 16 MiB preview limit and then refuse review.
