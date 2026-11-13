# Windows background driver

WDR1 defines `sleight.windows-driver/1` for the Windows REPL worker. It has 0 Windows runs so far.
The relay must approve and lease a target before a tree read, action or capture. WDR3 supplies background actions.
WDR2 adds the [Windows JavaScript worker](windows-repl.md). Production routes native requests through parent-side
session approval, forbidden-target checks and executable-wide leases. Native behavior remains unverified on Windows.

## Process and framing

The [driver protocol](mac-driver.md) specifies the shared client, parent dispatcher, framing and lifetime.
The Windows bindings here retain their current native encoding and UIA behavior.

`createWindowsDriverClient()` adapts the shared client through `plugins/sleight/lib/windows-driver/client.mjs`.
It prepares `windows-host.mjs` with `kind: 'driver'`. The builder hashes the sources and compiler, validates
the cache ACL and starts a separate `driver-host.exe --driver`. Cursor and consent builds exclude driver sources.
The client does nothing on macOS unless a test injects `platform: 'win32'`.

The existing executable requires `protocol: "sleight.windows-driver/1"` and rejects a `platform` field.
The shared client preserves that wire encoding. The canonical protocol's `platform: "win32"` needs a coordinated
native parser and fixture migration. It is not emitted to the existing executable.
Windows responses have an 8 MiB UTF-8 limit. Request lines retain the shared 64 MiB limit.
On expiry the native driver returns `DEADLINE_EXCEEDED` with `unhealthy: true` and exits 70.
The Windows action watchdog retains 350 ms of grace for native cleanup. The next explicit call waits for child close
and starts a fresh incarnation. No action is replayed.

## Methods

| Method | Parameters | Result |
| --- | --- | --- |
| `ping` | `{}` | `{protocol, methods}` |
| `getState` | `{}` | `{apps, windows}` |
| `listApps` | `{}` | The same inventory as `getState`. |
| `getApp` | `{selector}` | `{window, text, readId, truncated, elapsedMs}` |
| `getAXState` | `{windowId, processStart}` | The same read result, plus geometry facts when available. |
| `getScreenshot` | `{windowId, processStart}` | `{window, capture, geometry?, screenshot?}` |
| `getAXStateAndScreenshot` | `{windowId, processStart}` | A tree read with the capture fields. |
| `verifyWindowIdentity` | `{windowId, processStart}` | `{window}` after observing the bound HWND. |

`selector` is a nonempty string or `{windowId: "<decimal HWND>"}`. String matching is exact,
case-insensitive against app name, image path, AUMID or window title. A name matching multiple
processes refuses with `AMBIGUOUS_APP`. Within one process the first standard window in z-order
wins. The caller can use a window id to select another window. No method launches an app.
String matching skips refused records before checking their private fields. A guessed refused window title and a missing
title both return `WINDOW_NOT_FOUND`. Explicit HWND selection still returns the target's refusal code.

Each window record contains `windowId`, `pid`, `processStart`, `image`, `imageIdentity`, `originalFilename`, `productName`, `aumid`, `app`, `title`,
`className`, `integrity`, `cloaked`, `onCurrentDesktop`, `minimized`, `popup`, `ownerWindowId`
and `refused`. HWND and process creation FILETIME are decimal strings, preserving 64-bit values.
Unknown AUMID and desktop membership are `null`. A failed integrity or process
identity query marks the target refused. `apps` groups windows by PID and process creation time;
each entry has `id` (AUMID or image), `name`, `pid`, `processStart` and `windows`.

Inventory skips invisible, zero-size and ordinary tool windows. Cloaked windows remain listed
with their exposure facts so a window on another virtual desktop can be selected explicitly.
Visible owned popups, including class `#32768`, remain in inventory. Elevated targets are listed
with `refused: "ELEVATED_TARGET"`. Tree reads refuse them. Session mismatches and missing process
identity also refuse. Minimized packaged windows refuse with `MINIMIZED_PACKAGED_WINDOW`.
Refused window records set title, image, AUMID, app and class name to `null`. Their app group also
omits its name and image-derived id. HWND, PID, creation time and refusal facts remain available.
The parent dispatcher withholds unapproved titles, paths, executable file identities, PE names and window classes before inventory reaches the worker.
The driver compares numeric integrity RIDs and refuses targets above its own level or at High or above, even when the driver runs elevated.
Its own integrity is cached once per process. After the process handle opens,
access denial during token opening or reading preserves `ELEVATED_TARGET`. Other token failures return
`TARGET_UNAVAILABLE`. An unreadable driver token refuses as `TARGET_UNAVAILABLE`.
Access denial alone cannot distinguish an elevated app from a protected process with an unreadable token.
`imageIdentity` is the executable file's creation FILETIME and size, joined by a colon as decimal strings.

Errors use `ok: false` and `error: {code, message, unhealthy}`. Codes include `INVALID_PARAMS`,
`METHOD_NOT_FOUND`, `WINDOW_NOT_FOUND`, `AMBIGUOUS_APP`, `IDENTITY_CHANGED`, `ELEVATED_TARGET`,
`TARGET_UNAVAILABLE`, `MINIMIZED_PACKAGED_WINDOW`, `UIA_UNAVAILABLE`, `OUTPUT_LIMIT` and `DEADLINE_EXCEEDED`.
The client rejects with an Error containing `code` and `unhealthy`. An ordinary method refusal keeps
the child usable. A malformed envelope closes it. WDR3 adds 11 actions. WDR4 adds capture and identity methods.
Production admission runs in `driver-safety.mjs`, outside the worker's eval realm.
Responses have an 8 MiB UTF-8 limit before LF. Serialization or size failures return a correlated
`OUTPUT_LIMIT` error with `unhealthy: false`, and the driver remains usable. Encoding finishes
before any response bytes are written.

## Parent admission

`driver-safety.mjs`, re-exported by `windows-driver/safety.mjs`, checks every native request outside the JavaScript worker. The first tree or capture
requires session approval and an executable-wide input lease, including owned popups. Windows has no Always allow
choice. The prompt strips control and format characters and bounds the displayed executable name and folder;
approval memory retains the full app identity across turns and REPL resets. The key includes lowercase AUMID or image
path, the image path itself, and `imageIdentity`. A replacement with a different creation time or size needs a new
card, and identity checks refuse it on an existing handle. A replacement that preserves both values has the same
key. Later requests renew the lease and recheck the bound window.

Forbidden-target checks use the executable path, PE original filename and product name, AUMID and window class.
Terminals, ChatGPT, Codex and Atlas refuse unless the user set `SLEIGHT_ALLOW_FORBIDDEN_TARGETS=1`; their settings
windows still refuse. Claude, Cursor, Copilot and VS Code receive an approval warning. Other-session and own-host
windows refuse. `ApplicationFrameHost.exe` and frame/core-window classes without an AUMID refuse with
`HOSTED_APP_UNRESOLVED`. A renamed unpackaged terminal without matching identity metadata can escape the name check.
The confinement fixture compiles `DragScript` under `SLEIGHT_TEST_SEAMS`, which `windows-host.mjs` never
defines, so a production binary has no `DragScript` field. `PackagedFrameTestGate.Admit` remains in that
binary, and a test is the only writer that sets it true.

Actions take a fresh parent-side UIA read before payment, flow and document-scope admission. The parent chooses
the read id and resolved action arguments. Guard inputs and authoritative results come from parent driver observations;
worker display text cannot replace them. An absent action policy refuses with `WINDOWS_SAFETY_UNAVAILABLE` before
driver dispatch. The extra identity verification and tree read per action remain unmeasured on Windows.

## Tree reads

The header is `Window: "<title>", App: <app>.`, followed by tab-indented lines
`<number> <role> <label>`. A standard window starts at 0. Descendants have consecutive numbers
in depth-first tree order. Owned popup roots follow the standard window as `menu` (`#32768`) or `dialog` subtrees
with unique numbers in the same map. Optional fields use `, ID: <id>`, `, Help: <help>` and
`, Secondary Actions: <names>`. Values use `, Value: <value>`. Embedded controls and line
separators become spaces. A provider string cannot add another numbered line.
Each provider string is limited to 16,384 UTF-16 code units. Selection, toggle, expansion, focus
and enabled states appear in parentheses. Numeric range values use the `Value:` field.

`ElementFromHandleBuildCache` fetches one root element. A control-view walker fetches its first child
and next siblings individually with build-cache methods and `TreeScope_Element`. Properties are read
from the cache. No fetch requests a subtree or materializes a child array. The cache holds control type, name,
id, help, value, states, rectangle, native handle, runtime id, keys and pattern availability.
`AutomationElementMode_Full` (1) retains live element references and runtime ids in the latest read map for WDR3.
The UIA connection and transaction timeouts are set, and automatic pattern focus is disabled.
See Microsoft's [cache request contract](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients)
and [IUIAutomation2](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nn-uiautomationclient-iuiautomation2).

Password elements print `<redacted>` in place of provider labels and values. Their help text is
omitted. Unknown password flags mask Edit, Document, ComboBox, Custom, Pane and unknown control types.
Other known types use the provider's default password flag. An unsupported variant there means false.
An unsupported enabled flag means enabled. Explicit password and disabled flags still apply to every type.
The driver never writes a tree to disk. Offscreen list-item subtrees are pruned before numbering.

Each read visits at most 3,000 elements across all roots, including pruned list items, makes at most
6,000 fetch calls, and descends at most 32 levels. Fetching stops 2,250 ms before the request deadline
to reserve one provider transaction and identity/response work. These cooperative limits return
`partialTree: true` and `truncated: true`, with no restart or replay. Refused or minimized packaged
popups are skipped and mark the tree partial. A hung COM call can still exceed its timeout and
trigger the hard deadline. Windows must measure whether providers honor the UIA timeouts.

Tree text is capped at 1 MiB of UTF-8, including its header and separators. Numbering stops before a
line would cross that cap or the 3,000-line cap. A capped read returns `truncated: true`; omitted
elements have no number in the latest map. Identity compares HWND, PID, process creation time, image, PE names and AUMID,
while the header uses the fresh title. A title change alone does not invalidate a read.
Inventory is enumerated once per request. The final identity check observes only the target HWND.

The driver caches each element's ProcessId and prunes foreign-process subtrees before reading labels or values.
Live pattern access checks the element and its ancestors too. Providers in another process can lose content.

The parent checks session approval, forbidden targets, identity and leases before reads and captures.
On the VM, compile the COM declarations and run `--driver-selftest`. Follow with 20 reads each of Notepad and
Calculator, recording p50. Mac protocol tests cannot prove provider behavior or read speed.
Run the headless synthetic-provider suite in `tests/windows-driver-native.test.mjs`. It covers 172
provider rows, identity changes, output limits and wide/deep trees without activating UIA.
Then prove that a retained element can read a non-cached property. Count unsupported password and
enabled flags by control type in Notepad and Calculator, compare walker output with control-view
expectations, and measure partial reads of Chromium and a 5,000-item Explorer folder. Record the
refusal code for elevated Notepad, a cloaked window on another virtual desktop and a minimized UWP app.

## Background actions (WDR3)

All 11 actions take `{windowId, processStart, readId, args}`. The trusted parent adds `clipboardBlocked`, an array of
at most 3,000 row numbers whose labels the shared clipboard rule refuses. Other extra fields refuse. This array belongs
to the same `readId`. The safety dispatcher replaces any worker-supplied value after its fresh read. A native action
without a label verdict refuses before input. The direct client adapter derives it only from an acknowledged matching read.
`readId` is the latest full or partial read in this driver incarnation. Reading another window invalidates the old map.
An action invalidates its input map before it attempts input, including when a provider later throws.
The caller must read again after an action error. Successful requests return a fresh read and its new `readId`.
The C# parser validates the whole argument vector independently of Node and the worker.

| Method | `args` |
| --- | --- |
| `click`, `doubleClick`, `rightClick` | `[target]` |
| `setValue` | `[target, text]` |
| `typeText`, `pressKey` | `[text]` |
| `paste` | `[text, {format: "text"}?]` |
| `scroll` | `[target, {direction: "up" or "down" or "left" or "right", amount?: 1..100}]` |
| `selectText` | `[target, text]` |
| `performSecondaryAction` | `[target, action]` |
| `drag` | `[from, to, {durationMs?: 500..2000, steps?: 2..64}?]` |

A target is a numbered element, `{id}`, `{label}`, `{line}`, or `[x,y]` in physical pixels from the main window's client
origin. Selectors resolve only within the last read, with exact matching and an ambiguity refusal. A line selector must match
the printed line, excluding its indentation. Coordinates resolve the deepest rectangle in that window's cached map;
a current rectangle check rejects a moved target. A covered window uses its own map, since a global screen hit test would
select the covering app. Owned popup roots take priority in inventory z-order, then depth within that root.
Posted element clicks use the live rectangle's center.

Before input, the driver checks HWND, PID, process creation time and image against the read. It then compares the live
element runtime ID and walks its current ancestors to prove membership in the observed window or its owned popup.
Disabled elements refuse. Password state is checked again, with WDR1's fail-closed policy. Password targets refuse all
WDR3 actions until a later sign-in policy and credential channel exist. These checks bind an action to a read;
they run alongside the parent's session approvals and executable-wide leases.

Successful actions return `foregroundChanged` by comparing foreground HWND samples before the action and after
settle and the final read. `foregroundExecutable` is a validated basename of at most 260 UTF-16 units with no
path separators or control characters. It is `null` when fresh parent inventory cannot identify a permitted foreground app,
including refused and forbidden apps. These fields replace the constant `tookFocus: false`. They neither attribute the change to sleight nor
detect a change that reverses between samples. Failed actions retain their existing error response.

Clicks try Invoke, Toggle, SelectionItem.Select, Expand/Collapse and LegacyIAccessible.DoDefaultAction in that order.
Edit, Document, Text and Pane controls go directly to posted mouse input. A Legacy pattern with an empty
CurrentDefaultAction advances to posted input too. A pattern invocation that throws never triggers another input attempt.
Microsoft assigns `UIA_E_NOTSUPPORTED` to `0x80040204`. Disabled and timeout errors propagate.
See the [UIA error codes](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-error-codes).
Double and right clicks use posted mouse messages. Secondary actions accept Invoke, Toggle, Select, Expand, Collapse,
ScrollIntoView and DoDefaultAction. `setValue` uses a writable Value pattern, and selection uses the Text pattern's
document range and exact, case-sensitive `FindText`, selecting its first match. Scroll tries the nearest ancestor with
a Scroll pattern, then posted wheel messages. Amount is a count of small scroll increments, default 3.

When no pattern handles a click, messages go to the nearest native HWND in the element's ancestry. The driver starts
per-monitor DPI aware v2. It converts both the physical point and physical client origin through
`PhysicalToLogicalPointForPerMonitorDPI` for that destination HWND, then subtracts the converted origin.
Wheel coordinates stay in the destination's logical screen space. Packed coordinates must fit signed 16-bit values.
The model tests cover 100, 125, 150 and 200 percent, plus a negative screen origin. Windows API behavior is unverified.

Typing and keys require exactly one focused element in the read and a fresh focus check. `GetGUIThreadInfo` finds the
target thread's focus HWND, which must still belong to that window and be related to the focused UIA element
by HWND ancestry. A fresh UIA lookup of that HWND must pass the password and focus checks.
A null thread focus refuses with `NO_BACKGROUND_FOCUS`. There is no fallback to another HWND before VM qualification.
Typing probes `WM_UNICHAR` with a 100 ms timeout;
it sends Unicode code points when supported, otherwise UTF-16 `WM_CHAR` units. Newlines send Return down, carriage
return and Return up. The post-action result includes `valueChanged` when the same runtime ID exposes a changed value.
`typeText` accepts at most 4,000 UTF-16 units. C0 controls other than tab, CR and LF refuse in both validators.
Identity is checked every 64 units. A responsiveness check runs after each chunk of about 256 posts and the final chunk.
CR/LF groups finish together, so a chunk can have 258 messages. `WM_NULL` is a responsiveness probe, not proof that
posted input drained. A failed post with `ERROR_NOT_ENOUGH_QUOTA` retries at most 10 times with 10 ms waits,
rechecking identity and budget. Other failures never retry. Failures report `typed=N` source UTF-16 units whose
character messages were posted, plus the successful post count. CRLF counts as 2 source units, even though it sends
one Return group. A failed Return key-down can have an effect before its character message is counted.
Success returns `typed` too. These counts describe posted input and do not prove what the app accepted.
The driver never retries text by appending through Value, since that could duplicate partial input or ignore the caret.

Keys use named virtual keys or `VkKeyScanExW`, with scan codes from `MapVirtualKeyExW` on the target thread's layout.
`ctrl` and `control` mean Control, `option` means Alt, and `super`, `meta` and `win` mean the Windows key.
The driver resolves each key before selecting a route, using the focused target thread's layout. It refuses Control/Win
plus C or X, Control+Insert, Shift+Delete, PrintScreen with any modifiers, and Win+Shift+S. Strict paste also refuses
Control+V and Shift+Insert. Extra modifiers and layout-supplied modifiers participate in the same check. Named keys
include `printscreen`. Posted input consumes the checked virtual key, modifiers and layout without resolving them again.
A unique matching AcceleratorKey can use the click ladder only after key and target admission. Otherwise modifier chords
refuse, except Alt with optional Shift, which uses system-key messages. Bare keys remain available. While a menu is open,
a matching AccessKey on a refused item stops bare or Alt mnemonics before input. Alt plus a letter is refused where the app
doesn't expose an AccessKey (probably browsers' Alt+D, unmeasured). Posted modifiers leave the recipient's keyboard state
unchanged, so their actual menu behavior still needs Windows qualification.
Key-up and mouse-up cleanup runs after a cooperative budget refusal.
New input and settle stop 2,750 ms before the deadline, leaving 500 ms for the final read before its own 2,250 ms reserve.
A missed deadline sets cooperative cancellation and gives the worker 300 ms for cleanup before retirement.
The action client's watchdog allows 350 ms for that response. A hung provider can still outlast cleanup.
A hard typing deadline reports a progress snapshot at retirement, including whether cleanup completed.

Paste leaves the system clipboard untouched. It posts `WM_UNICHAR` or `WM_CHAR` to a writable Edit or RichEdit HWND
that still has the target window's background focus. It refuses C0 controls, tabs, newlines and DEL before posting,
since character messages for those values can invoke commands. Both paste and typeText accept at most 4,000 UTF-16 units.
Paste uses the same bounded text pump and partial-progress reporting described above. It never retries through Ctrl+V
or a clipboard route. Posted counts and a fresh tree leave delivery unconfirmed. Windows qualification is still pending.

Posted fallbacks refuse offscreen targets and detected Chromium windows. Patterns remain available there.
Posted drags refuse detected WPF, Explorer and Office windows, and endpoints with different native HWNDs.
Other drags hold the button for 500 ms, post at most 64 moves, then release it in cleanup. This does not support OLE
drag and drop, hover, IME composition or the foreground fallback. Every posted drag returns
`limits: ["ole-drag-not-supported"]`, since toolkit names cannot identify every OLE drag.
WDR8 and WDR9 own the later toolkit work.

## Clipboard admission and detection

`action-labels.mjs` owns both platforms' 9-language table and normalizer. Windows applies it to resolved element labels
for clicks, double clicks, secondary actions and focused Return/Space. The pattern name is not the element label.
The parent also sends the row-number verdict to native admission, covering coordinate hits, submenu/context-menu items,
right clicks, drag endpoints and accelerator-selected elements. The native check reads the live AcceleratorKey and refuses
Copy/Cut equivalents before any pattern or posted input. A renamed live target invalidates the parent's label verdict.
Menu Paste activation stays allowed, matching WCB1 case 11 and the Mac. Explicit clipboard-paste chords refuse.
Unlisted labels remain advisory coverage. `Copyright` and `Copywriter` stay allowed. The existing normalizer folds
`Link kopiëren` to the German entry and refuses it. `Kopieer` is unlisted. Tree lines omit both menu key properties.

`DriverClipboard.cs` contains the only clipboard API boundary, a content-free `GetClipboardSequenceNumber` read. It runs
after the first action budget check, before settle/input, and after settle and the result read. A changed counter yields
`clipboardChanged: true`, with the action's delivery disposition. The Windows client adapter maps that typed result to the
Mac's existing `CLIPBOARD_CHANGED` sentence, `retry: read-first` and `next: stop-tell-user`. The parent dispatcher also
handles it for injected drivers. Failures after admission compare too. The driver never replays input.

The watcher remembers the last finished counter and person-input timestamp from `GetLastInputInfo`. A later counter change
without person input refuses the next action before input, once per change, with `reason: since-last-action`. Person input
between actions permits a fresh baseline. The comparison uses inequality, including counter reset. A counter of 0 read with no
error, before any nonzero read, is the baseline: on the one Windows 11 ARM guest we measured, the counter stays 0 until
the first copy after sign-in. A 0 read with an error, a 0 after a nonzero read, or an unavailable counter refuses input.
Access is judged only from the counter read's error code. The driver never opens the clipboard. Failure after input has unknown delivery and requires a read first. Stuck-menu Escape
uses the same admission and comparison. Restarting the driver discards its old baseline.

Clipboard refusals cross the frozen Windows transport as typed result fields; the Windows adapter turns them into errors
before the worker sees a result. This retains delivery fields without changing the shared transport or its Mac branch.
The seven WCB1 defaults are named in the Windows clipboard module and native rule, with a parity test for their values.
No contents, formats, snapshots or restoration APIs belong to this path. A source-scan test pins the one sequence boundary
and refuses other clipboard APIs in native and Windows parent sources.

Native compilation and app behavior remain unverified. The VM sitting must measure scheduled-task counter access,
Notepad/Explorer/Edge accelerator strings and copy lag, German labels, Dvorak/Russian mappings, selection-copy timing,
history/cloud changes, and 50 runs of each of 2 actions for counter-read cost. Fakes cannot supply those numbers.

## Settle and results

The driver subscribes to structure and property changes on the read's window and popup subtrees before input.
Properties are Name, ToggleState, IsOffscreen and BoundingRectangle. Value is omitted to avoid marshalling document text
on each keystroke. Focus events cache ProcessId at subscription and filter by that cached PID without live UIA calls.
After input, 120 ms without a relevant event ends the wait, with a 1,500 ms cap. Silent providers or subscription
failures use two complete cached snapshots at least 100 ms apart. Partial snapshots cannot prove stability.
Subscriptions are removed before releasing the old read map. The callbacks keep only event counts and times.

An action result adds `action`, `route`, `limits`, `confirmation: "unconfirmed"` and
`settle: {mode, settled, elapsedMs, events}` to the normal full read. Settle modes are `event-quiet`, `poll-stable`,
`cap` and `budget`. The cap returns `settled: false` so callers can inspect the returned tree with an unsettled result.
Tree changes help the caller inspect the outcome and leave `confirmation` unconfirmed.
The relay's existing compactor handles that full tree.

The Mac tests exercise the wire, worker and scripted providers. The fake's ladder, settle and DPI models do not execute
the C# code. On Windows, the headless native test calls production parser, ladder, chord, settle and
coordinate functions, direct text routing, queue retries and partial typing, alongside WDR1's 777 assertions.
The action suite requires at least 200 passing assertions. Both native suites remain unrun here.
`--driver-selftest` includes 18 headless checks and doesn't activate UIA.
Compile with in-box C# 5, run both synthetic suites and the selftest, then perform WD1 section 5's 20-run sitting.
Record Calculator, Notepad and WPF text, chord and Value results per toolkit, foreground observations, and p50/p90.
There have been 0 native Windows action runs and 0 Windows performance measurements for WDR3.
First check whether covered Notepad retains a nonzero thread focus HWND. Then verify that a refused `ctrl+s` leaves
its document unchanged, a refused paste leaves the target unchanged, an admitted paste inserts only the supplied
text without using the clipboard, and a queue-full typing failure reports its posted progress. Repeat across Win32, WPF and WinUI.

Provider HRESULTs map to `STALE_ELEMENT` (0x80040201), `ELEMENT_DISABLED` (0x80040200),
`PROVIDER_TIMEOUT` (0x80131505), `ACCESS_DENIED` (0x80070005) and `ACTION_REFUSED` (0x80131509).
Unknown provider errors remain `UIA_UNAVAILABLE`. Failures after input include `"input may have landed"` and ask the caller to read again
before repeating. Failures in settle or the final read use `ACTION_UNCONFIRMED` and retain the cause code in the message.

## Capture and identity (WDR4)

With 0 Windows runs, the native capture and its in-box `System.Drawing.dll` reference remain uncompiled.
The driver build includes `DriverCapture.cs` and `DriverIdentity.cs`. Cursor and consent builds exclude both.
The driver fixes capture flags, output routing, DPI queries and image sizes internally. It validates the exact
parameter keys, decimal HWND and positive signed-64-bit FILETIME before observing a window. A missing creation
time refuses. This also applies to forged worker IPC that bypasses the `cua` layer.

Every tree read and capture checks HWND, PID, creation time, executable path and AUMID around the operation.
The title is mutable metadata. The Windows `verifyWindowIdentity` export in `windows-repl/identity.mjs` accepts
`windowId` or `window` as a decimal string, plus a decimal-string `processStart`; it compares PID, image and AUMID
too when the expected record includes them. It leaves the Mac verifier unchanged. App handles check returned
identity before emitting a tree or image.

Own-host checks use the account's native LocalAppData known folder, without an environment override.
Images inside `sleight\turbo-host` or `sleight\cursor-host` refuse as `OWN_HOST`. The driver hashes its own image
and the `cursor-host.exe`, `person-host.exe` and `driver-host.exe` images in those roots and their immediate bank
directories. A matching image at another path also refuses. The catalog refreshes once per request, with limits
of 256 bank directories, 32 MiB per image and 128 MiB hashed in total. Reparse points, unreadable images or an
exceeded limit refuse as `TARGET_UNAVAILABLE`. Same-user replacement races and the hashing cost need Windows checks.
Refused inventory rows continue to hide titles, paths, app names and AUMIDs.

The worker thread uses per-monitor-v2 DPI awareness for native observations. `DriverCapture.cs` tries three routes
for the bound HWND, in order: `PrintWindow`, `Windows.Graphics.Capture`, then `BitBlt` from the target's client DC.
The `BitBlt` route is allowed only when no window covers the target. WGC may show a capture border; border behavior
still needs Windows measurements. The first route calls
[`PrintWindow`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow) for the bound HWND
with `PW_CLIENTONLY | PW_RENDERFULLCONTENT` (flags 3). The latter flag is an SDK value outside that page's documented
options, so toolkit behavior remains unverified. A top-down 32-bit DIB stores the client-area pixels.
The driver clears its pixel buffer before rendering. PNG encoding treats RGB as opaque, since classic GDI painting need not fill alpha bytes.
Cleanup restores the selected object, deletes the DIB and deletes the memory DC in `finally`.
Each route targets one HWND. The result's `capture.method` identifies the route used.

Dimensions are at most 8,192 pixels per side and 16,777,216 pixels total (64 MiB of DIB pixels). PNG writes stop at
4 MiB, before base64 conversion. The response retains its existing 8 MiB limit. A size refusal is `CAPTURE_LIMIT`.
Native allocation failures use `CAPTURE_UNAVAILABLE`. A changed client origin, size, outer rectangle or DPI during
capture refuses as `GEOMETRY_CHANGED`. An identity change refuses as `IDENTITY_CHANGED`. The existing request
deadline bounds a hung synchronous `PrintWindow` by retiring the driver, without retrying the capture.

An `ok` capture has `capture: {status, method, width, height, dpi, scale, coordinateSpace}` and
`screenshot: {mimeType: "image/png", data: "<base64>"}`. Width and height are physical client pixels.
Minimized classic windows return a `minimized` note. Minimized packaged windows retain their existing refusal.
Cloaked windows and other virtual desktops return a `cloaked` note. An all-black RGB render returns `black`,
which can also be valid black app content. A false native return yields `failed`. These notes have no screenshot.
The `cua` capture methods emit the note and return `null`, or keep the tree and return `{state, screenshot: null}`
for a combined read. `emit: false` suppresses both image and note output.

A combined request reads UIA first, then captures the same bound HWND. Its final window record and header use the
last title. The tree and pixels are sequential observations and do not form an atomic app snapshot.

## Hand geometry facts

Reads and successful captures return `geometry` with `clientOrigin`, `clientSize`, outer `rect`, `dpi`, `scale`,
`coordinateSpace: "physical-client-pixels"`, `exposure`, `covers` and physical monitor rectangles in `monitors`.
Geometry failure on a tree read returns
`{exposure: "unknown"}` and keeps the tree. Geometry failure on a capture refuses.
The origin and rectangles are physical desktop pixels and preserve negative monitor origins. Screenshot point
`[x,y]` maps to `[clientOrigin[0]+x, clientOrigin[1]+y]`, with no scale multiplication. Art scale is `dpi/96`.

Cover rectangles come from visible, non-minimized and uncloaked top-level windows ahead of the target in z-order,
using DWM frame bounds with a window-rectangle fallback. No process is exempted. A partial overlap marks the whole
window `covered`. Point projection checks the rectangles at that point. Enumeration stops at 4,096 windows;
an unavailable observation or incomplete enumeration leaves exposure `unknown`. These conservative rectangles can
count transparent regions as cover. Monitor enumeration stops at 32 rectangles and fails closed if incomplete.
Points outside those rectangles are offscreen even within a partly visible client area. Minimized, other-desktop
and offscreen states suppress exposed drawing.

`cursorGeometry(window, geometry, clientPoint)` returns the public cursor fields for hand events. It includes
only the executable basename, optional AUMID, HWND, PID, geometry and display scale, omitting titles and paths.
Unknown or invalid facts, refused identities and HWNDs beyond cursor v1's safe integer range don't produce a point.
The parent dispatcher owns admission and uses the Windows identity adapter before forwarding native requests.

The headless `windows-driver-capture-native.test.mjs` compiles synthetic identity, PNG-pixel and geometry checks.
It doesn't create windows or instantiate UIA. On the VM, compile the production driver and run its selftest,
then capture covered Notepad, Calculator and Edge 20 times each. Check 100%, 125%, 150% and 200% DPI, a monitor with
a negative origin, resize/move races, minimized and cloaked notes, elevated and own-host refusals, copied-host hashes,
black-render apps, ring exclusion, GDI handle cleanup, deadline retirement and unchanged foreground focus.
Record the per-app counts and capture p50/p90 in `docs/benchmarks/` before calling WDR4 qualified.
