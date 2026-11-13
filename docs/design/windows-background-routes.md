# Windows background routes

Input stays in the approved window. Pointer actions try a matching UIA pattern once on the bound element.
A named doubleClick, rightClick or posted scroll uses the live center only when the window's read map hits
that same element in the same HWND and the center lies inside its host root. A covering popup, sibling or
child refuses with `BACKGROUND_UNAVAILABLE`. It never substitutes a parent, child or sibling.
A plain named click needs its own supported click pattern. Edit, Document, Text and Pane have no click
pattern route. Their refusal explains that an explicit coordinate click from a fresh screenshot is available
where posted input is supported. This keeps a label click from invoking an enclosing control. Coordinates
remain the caller's explicit choice. An attempted input is never retried through a second route.

Scroll uses the target's own Scroll pattern or its checked center for a supported HWND wheel message.
It does not search ancestors for a scrollable control. Scroll refusals say so and tell the caller to name the
scrollable control itself. Chromium and offscreen nodes need their own Scroll pattern.

Typing may use Value only for an empty focused field, since replacing a nonempty value would lose the caret
and selection. UIA focus claims must match the current native thread's focus HWND, within the approved window.
WinUI input bridges that claim focus on other HWNDs are excluded. Multiple matching nodes still refuse.
A windowless WPF editor proves its own UIA focus while sharing its container's native HWND.
Otherwise typeText and pressKey retain their background messages to the proved focus HWND,
including Chromium and offscreen elements. setValue uses Value, then bounded WM_SETTEXT only on a writable
native Edit or RichEdit HWND. The native fallback checks ES_READONLY even when Value is absent.
Paste never reads or writes the system clipboard. It sends characters to a proved focused, writable native
Edit or RichEdit HWND, inserting at its selection. Other HWND classes refuse before input. Paste also refuses
control characters, including tabs and newlines, before input because those messages can trigger commands.
The driver reports partial character progress and never retries uncertain input. Unicode delivery and real
selection behavior need Windows qualification. These text routes still check identity, focus where required,
password status and enabled state. Chromium and offscreen refusals apply to posted pointer input. WPF, OLE
and cross-HWND drags also refuse.

Modifier chords require a unique matching UIA accelerator. Without one, Shift+Tab, Ctrl+Left, Alt+F4 and other
modifier chords return `BACKGROUND_UNAVAILABLE` before posting. A unique accelerator may invoke the element advertising that
accelerator elsewhere in the approved read map. Unmodified keys keep their message route.

A foreground adapter is supplied through the client action's `foreground` option for that call alone. It runs
only after `BACKGROUND_UNAVAILABLE` and a fresh identity check. The native host has no foreground input API.
The adapter result says `route: foreground` and `tookFocus: true`. Connecting an engine adapter to a user-facing
caller is separate integration work.
That integration needs a post-adapter identity check and the same lease and approval checks as background input.
An MSAA provider may map a named child's Legacy default action to an enclosing control. That provider behavior
needs a Windows check. Successful native actions report `foregroundChanged` from before/after foreground HWND samples.
`foregroundExecutable` is a validated basename only when fresh inventory identifies a permitted foreground app.
It is `null` for refused or forbidden apps and when the foreground app cannot be identified. The samples report final
foreground HWND changes without attributing their cause to sleight, but changes that reverse between samples and
focus inside an app remain unmeasured.

Capture tries PrintWindow, Windows.Graphics.Capture and BitBlt per window and records each attempt. Black and
failed frames advance the chain. The RGB check rejects only an entirely black frame. A white, grey, partly
painted or half-black PrintWindow frame can return `ok`, as can a dark frame with one lit channel. The result
notes that complete painting is unverified. Pixels keep the physical client coordinate space. The last route
copies from the target HWND's client DC with SRCCOPY, without CAPTUREBLT or a desktop DC. It requires a window
proved exposed, wholly on a monitor and still exposed with stable geometry after copying. Covered or uncertain
windows refuse that route. Capture limits and identity failures stop the chain.

Work plan:

1. Add fake-driven tests for route order, unsupported actions, ambiguous effects, capture fallback and per-call foreground opt-in.
2. Try each native pattern once, check named pointer centers before posting, and preserve partial-input failures.
3. Add bounded window capture fallbacks with client cropping and resource cleanup.
4. Run focused offline checks, inspect the patch, and record Windows-only gaps in the lane report.

The behavioral source is the public Cua Windows design summarized in the supplied competitor sweep. The
code uses sleight's existing driver and Microsoft API contracts. No competitor source code is used.
