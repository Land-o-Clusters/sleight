# Document approval scope

`SLEIGHT_APPROVAL_SCOPE=document` opts in. Session and once modes keep their behavior.

## Enforced by the relay

- Start with one standalone `let app = await cua.getApp("TextEdit")` call, or select
  a window with `cua.getApp({ windowId: 123 })`. The relay permits this narrow read
  before document approval. The engine still asks permission for the read.
- `document_scope` asks about the last observed Window, App and URL. Acceptance
  lasts for this relay session. Declines and cancels never grant permission.
- The relay forwards action code only while its last observation matches an
  approved identity. It permits one engine call at a time and blocks other tools
  that could act outside the document, including drag and menu bar tools.
- Every action result must contain matching Window and URL headers. Missing,
  ambiguous or changed headers stop further actions and tell Claude to ask the
  user through `document_scope`, after a standalone read if identity is unknown.
- Engine app approvals are answered only for the current document and risk level.
  Higher risk requires another user approval. The relay stores grants in memory
  and returns answers without persistence metadata to the engine.

## Advisory guard inside the engine

The relay prepends a guard that wraps `cua.getApp` and the cached `app`. Before
each usual App action it reads the window again and checks its title, app and URL.
It also appends a full window read to action calls. This catches accidental
window changes before typing, clicking or dragging. It changes the UI diff base.

Claude owns arbitrary JavaScript in the same runtime. It can replace the guard,
keep an unwrapped handle, call another API, or forge output. The guard is advisory.
It is not a security boundary. The relay gate is outside that code, but its
observations come from that runtime and can also be forged.

## Failure limits

An action can change windows after a check, or do several things before the relay
sees its result. The relay detects a result mismatch after that call ran and cannot
undo it. Hostile code can hide the mismatch. Strict document isolation needs an
engine or native helper that checks an immutable target on every operation.

Discovery reads can expose another document's contents. Titles are exact and
case-sensitive. Saved file URLs distinguish files with equal names. Unsaved windows
with identical titles cannot be distinguished by these headers. Renaming, Save As,
dialogs and engine format changes can stop valid work. A closed and reopened
window with the same title and URL inherits its identity. Session restart clears
all grants. Document scope is a mistake guard for cooperative code, not protection
against malicious JavaScript or control through other tools or processes.

## Live check

`node bench/document-scope.mjs` approves only its first temporary TextEdit document. All runs
are in [the results](../benchmarks/2026-10-03-document-scope.json), including failures.
