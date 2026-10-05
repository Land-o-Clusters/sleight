# Clipboard

The native engine's `app.paste` saves and restores readable pasteboard bytes. Our probe found text,
PNG/TIFF, two file items and RTF/HTML/text restored in 4/4 fixtures. A replacement copy during paste
survived and the engine reported a conflict. Engine text entry and both drags did not change the
general pasteboard in the trials. Those paths keep the engine's behavior.

Copy/Cut shortcuts use the user's clipboard by default. A copy intended for menu Paste, `pbpaste`
or a browser remains on that clipboard. The result tells Claude that sleight did not restore it.

Set `SLEIGHT_CLIPBOARD=preserve` in the user's environment to enable preservation. In that mode the
relay snapshots every readable item before a literal Copy/Cut shortcut. After one attributable
pasteboard generation it stores the copy in session memory and restores the previous bytes. Paste
uses the private copy and restores the current user clipboard, including after an engine error.
Each preserved Copy/Cut result explains that menu Paste, `pbpaste` and browser pastes cannot use
that private copy. A session without a private copy uses native Paste.

Deferred restoration cannot reliably identify whether a later menu or browser paste used Claude's
copy. Those actions are outside the app proxy, so preservation is opt-in. A deliberate copy for the
user belongs in a native session. Claude must not use another clipboard path to bypass preservation.

If the user's snapshot fails, including promised data or a size above 64 MiB, the shortcut runs
natively. Its result says the clipboard was not preserved and tells Claude never to modify the user's
clipboard to get around the fallback. The guard discards any old private copy and leaves the current
clipboard intact until the native shortcut runs. Native Paste uses those current contents.

Preservation mode reserves a shared SQLite transaction for the JavaScript request. Another preserving
session gets a busy error before input. The reservation ends after restoration or process exit.
Native sessions and other tools do not take it, so an outside copy can still interrupt preservation.

The AppKit helper reads and writes bytes, without opening apps or reading referenced files. Payloads
travel through subprocess stdin/stdout and stay in memory. They are absent from relay output and
traces. It validates representations before clearing and reads back every item before exiting. Snapshots
are capped at 64 MiB. It cannot snapshot unreadable formats or file promises. If a successful Copy creates unreadable data, the helper returns
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
private copy. Computed shortcuts and repeated clipboard actions stop before that input. Clipboard messages tell
Claude to split the call and retry, without a change-review refusal. Other
code in the request can run before a refusal. Ordinary declarations remain at the top level.

Private copies last until a successful reset or session exit. A reset reply during a clipboard call
waits for its cleanup before discarding the copy. A reset during preflight prevents input into the
new JavaScript realm. Closing a session stops input still
in preparation and waits for restoration. It then releases the reservation and discards its copy. The launcher
awaits that cleanup before exiting after an engine failure. A process crash during private Paste can leave the
temporary copy on the clipboard. File URLs restore references; they cannot recreate deleted files or
providers that promise future files. Apps may change the clipboard through other actions. Small
TextEdit probes do not establish coverage for every app.

[The measurements](../benchmarks/2026-10-04-clipboard.md) include every attempt and failure.
