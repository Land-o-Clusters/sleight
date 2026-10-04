# Clipboard

The native engine's `app.paste` saves and restores readable pasteboard bytes. Our probe found text,
PNG/TIFF, two file items and RTF/HTML/text restored in 4/4 fixtures. A replacement copy during paste
survived and the engine reported a conflict. Engine text entry and both drags did not change the
general pasteboard in the trials. Those paths keep the engine's behavior.

Copy/Cut shortcuts left their result on the user's clipboard. The relay snapshots every readable item and format before forwarding a
literal `pressKey` with a Command modifier and C or X. After a successful action with exactly one new pasteboard generation, it saves
the copied items in session memory and restores the previous bytes. V uses the session copy if one
exists, then restores the user's current clipboard, including when the engine throws. Without a
session copy, V keeps its native behavior. Ordinary keys and `app.paste` stay native.

Native paste and clipboard shortcuts reserve a shared SQLite transaction for their JavaScript request,
from the first snapshot through restoration. Another sleight session gets a busy error before input. SQLite releases the
reservation when the action ends or the process exits. Tools outside sleight do not take it.

The AppKit helper reads and writes bytes, without opening apps or reading referenced files. Payloads
travel through subprocess stdin/stdout and stay in memory. They are absent from relay output and
traces. It validates representations before clearing and reads back every item before exiting. Snapshots
are capped at 64 MiB. It rejects
unreadable formats and file promises. If a successful Copy creates unreadable data, the helper returns
its generation without payloads. An attributable generation still permits restoring the original,
but the private copy is discarded and an error is returned. Restoration checks the current generation after preparing the
items. A changed generation leaves the current clipboard alone and reports an error.
If a helper write fails after clearing, it returns the owned generation and the guard attempts one
restoration before reporting the failure. A lost helper or failed recovery cannot restore the bytes.

This is a cooperative guard in the engine's mutable JavaScript realm. Arbitrary code can bypass it.
It covers shortcuts on native app handles, not menu actions or browser handles. A successful Copy
that writes once is inferred to own that generation. An outside copy can be mistaken for it if
the app did not copy. A failed action or two new generations cannot be attributed, so restoration
refuses. macOS has no atomic compare-and-restore; a write between the last check and clear can still
be lost. The engine's paste has its own conflict check.

The engine sandbox denied SQLite, clipboard access from its JXA child, loopback HTTP and file writes.
The relay runs the helper and stores private copies. A proxy on native app handles verifies that
the prepared clipboard action matches the actual method and runs once. Use one clipboard action
per JavaScript request, with a literal shortcut key. Separate Cut and Paste requests retain the
private copy. Computed shortcuts and repeated clipboard actions stop before that input. Other
code in the request can run before a refusal. Ordinary declarations remain at the top level.

Private copies last until a successful reset or session exit. Closing a session stops input still
in preparation and waits for restoration. It then releases the reservation and discards its copy. The launcher
awaits that cleanup before exiting after an engine failure. A process crash during private Paste can leave the
temporary copy on the clipboard. File URLs restore references; they cannot recreate deleted files or
providers that promise future files. Apps may change the clipboard through other actions. Small
TextEdit probes do not establish coverage for every app.

[The measurements](../benchmarks/2026-10-04-clipboard.md) include every attempt and failure.
