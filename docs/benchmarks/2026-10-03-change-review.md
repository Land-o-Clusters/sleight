# Saved-file review, 2026-10-03

Run `node bench/change-review.mjs` from the worktree. The script starts an MCP
child and closes it after checking two temporary TextEdit files. App and review choices use `ask.js`.
The user clicks the buttons, and the harness checks the resulting saved bytes.
It closes the saved app buffers before review to avoid a later autosave.

The Undo/Keep check passed 1/5 attempts. The first couldn't reach TextEdit from the
sandbox, and the second stopped at a locked Mac. The next two recorded Keep for
both documents, leaving both edited files intact. The final run recorded Undo
for `UNDO-xPSOrn.txt` and Keep for `KEEP-xPSOrn.txt`. Their saved contents were
`UNDO ORIGINAL\n` and `KEEP AGENT CHANGE\n`. Each completed review run also
verified that the relay deleted its private backup directory at session end.

[Results](2026-10-03-change-review.json) include all five attempts and the
relevant relay trace events. Vendor API documentation is omitted. Raw trace
paths remain in the records. This proves saved UTF-8 text in TextEdit, while
package restoration and edit-conflict refusal are covered by unit tests.
