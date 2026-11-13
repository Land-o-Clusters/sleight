# Driver protocol (Mac and Windows)

The canonical `sleight.driver/1` envelope has a `platform` field for `darwin` or `win32`.
Windows retains its legacy wire encoding as described below.
The Mac helper is one persistent Swift process per MCP server. Windows uses a persistent C# process.
The relay owns approval, forbidden targets,
leases, payment and document policy. The parent must approve each app before using the driver.
This document specifies the phase 0 interface. A method listed here may return `METHOD_NOT_FOUND`
until the code is merged. `ping.methods` reports the implemented set.

## Client and platform bindings

`lib/driver-client.mjs` owns framing, correlation, deadlines, backpressure and child lifetime for both platforms.
`createDriverClient({driverPlatform, platform, ...options})` fixes the driver family separately from the host platform.
The compatibility exports `createMacDriverClient` and `createWindowsDriverClient` fix that family to `darwin` and `win32`.
Construction is inert. A request on a different host platform refuses with `PLATFORM` before preparation.
The [Windows bindings](windows-driver.md) specify HWND identity, UIA, background routes and capture.
The remaining Mac sections specify AX, renderer recovery and Mac input admission.

The native Windows executable still requires the frozen `sleight.windows-driver/1` envelope with no `platform` key.
The shared client selects that encoding for `win32`. Its compatibility entry point retains the old protocol constant.
The Mac encoding already uses `sleight.driver/1` and `platform: "darwin"`.
Sending the canonical envelope to the current Windows executable fails its exact-key validation.
A native Windows migration must update the executable and its wire fixtures together before `platform: "win32"`
can travel over stdio. This refactor retains the current encoding and all platform-specific refusal rules.

Mac construction validates the API minimum, advertised methods, lock policy and failure memo duration.
It handshakes with `ping` and checks the source build before the caller's first request. Windows retains its existing
first-call behavior without an implicit handshake. Mac validates the error-code table, context, delivery and clipboard
fields. Windows retains its existing error envelope. A Mac action timeout reports unknown delivery and read-first recovery.
Windows retains its 350 ms action watchdog grace and its original error fields. Both clients leave action retries to the caller.

## Parent dispatcher

`lib/driver-safety.mjs` supplies `createDriverSafety({platform, ...options})` and a serialized queue capped at eight calls.
Both adapters take a fresh parent read and run parent admission through a shared transaction. It checks Pause immediately
before the driver request, then observes the result.
The platform adapters retain their original validation, inventory, approval, identity and lease ordering.
`lib/mac-safety.mjs` supplies Mac policy, helper inspection, person tokens, site checks and asynchronous lease restoration.
`lib/windows-driver/safety.mjs` re-exports the shared factory's Windows compatibility entry point and lease target.
The Windows adapter retains executable-wide leases and deferred stuck-menu Escape in `finishCell`.
Both adapters require callable `beforeAction` and `checkPause` before any action-related driver access.
Mac production input remains unregistered. Input requires a trusted registrar capability.

The shared headless fixture in `tests/fixtures/driver-fake.mjs` exposes the same window, driver, action sink, cards and
lease log to both adapters. Its sitting rows have `{platform, id, status, elapsedMs, code, calls}`.
`platform` is `darwin` or `win32`, `status` is `pass` or `refused`, and unmeasured elapsed time is `null`.
These rows record synthetic admission outcomes. Native sitting tools still need platform-specific observer and
cleanup evidence, including background delivery, clipboard isolation and input-idle checks.

## Framing and lifetime

Standard input and output carry UTF-8 JSON objects separated by LF. Diagnostics go to stderr,
without document text. The maximum line is 67,108,864 bytes before LF (64 MiB), in either direction.
Encode a complete response before writing any of it. An oversized reply returns `OUTPUT_LIMIT`.
EOF between requests closes cleanly. Invalid UTF-8, incomplete EOF, duplicate JSON keys, an invalid
envelope, a wrong nonce or a repeated or decreasing id closes with exit 65. No desktop operation
runs before envelope and parameter validation.

The parent supplies `SLEIGHT_DRIVER_NONCE`, 32 random bytes written as 64 lowercase hex characters.
Every envelope repeats it. A new process gets a new nonce, and all earlier app and element bindings expire.
Ids are positive increasing JavaScript safe integers. Requests execute serially; the client allows
at most 32 pending calls. Queue time counts against the absolute deadline.

```json
{"protocol":"sleight.driver/1","platform":"darwin","nonce":"<64 hex>","id":1,"method":"getApp","params":{"selector":"Calculator"},"deadline":1793400000000}
{"protocol":"sleight.driver/1","platform":"darwin","nonce":"<64 hex>","id":1,"ok":true,"result":{"window":{},"text":"Window: \"Calculator\", App: Calculator.\n0 standard window Calculator","readId":1,"truncated":false,"elapsedMs":12}}
{"protocol":"sleight.driver/1","platform":"darwin","nonce":"<64 hex>","id":2,"ok":false,"error":{"code":"IDENTITY_CHANGED","message":"Window identity changed.","unhealthy":false}}
```

The request has exactly `protocol, platform, nonce, id, method, params, deadline` plus optional `context`.
`context` contains only `session`, `turn` and `call`, each a string of at most 128 Unicode scalars without controls
or line separators. Error replies echo it. Successful replies omit it. Diagnostics, if emitted, use the call id
and never tree text. The helper doesn't currently emit diagnostics. Successful replies
have exactly `protocol, platform, nonce, id, ok, result`. Failures replace `result` with `error`.
`error` always contains string `code`, string `message`, boolean `unhealthy` and `next`.
`next` is one of `read-again`, `retry-safe`, `stop-tell-user`, `ask-user`, `restart-helper` or `none`.
The client retains context, next and action disposition. It rejects unknown codes and directives as `DRIVER_PROTOCOL`.
An incomplete pointer ancestry refusal adds `pointerRefusal: "incomplete-ancestry"` to `error`, with
`code: "ACTION_UNSUPPORTED"`, `delivery: "not-sent"` and wire `retry: "safe"`. This is the only accepted
`pointerRefusal` value. Other values or combinations fail as `DRIVER_PROTOCOL`. The client preserves the field;
the model formatter uses it to supply the fixed incomplete-tree detail, `retry: "read-first"` and `next: "none"`.
Provider message text never selects that recovery.
A paste contention refusal adds `pasteRefusal: "busy"` to `error`. The client accepts it only for `paste`, with
`code: "AX_UNAVAILABLE"`, `delivery: "not-sent"`, `retry: "safe"` and `unhealthy: false`. Other values or combinations
fail as `DRIVER_PROTOCOL`. Windows rejects the field. The client maps the accepted field to local `DRIVER_BUSY`.
The model receives the existing queue-full sentence, safe retry and `next: "retry-safe"`, independent of provider wording.
The current production semantic adapter has no contention producer. The offline semantic-client adapter exercises this contract.
The default timeout is 5,000 ms. `deadline` is Unix milliseconds, at most 30,000 ms ahead at receipt.
The helper derives a monotonic remaining budget once admitted so clock changes cannot extend work.
AX IPC slices are at most 250 ms and never exceed the remaining budget.

A cooperative read budget returns its collected tree with `truncated: true`. A hard deadline,
including a provider call that never returns, returns `DEADLINE_EXCEEDED` with `unhealthy: true`
and retires the process with exit 70. The parent also has a watchdog. It discards the child's maps,
rejects all pending requests and waits for child close before starting another helper.
An unhealthy reply retires the helper even if the reply has `ok: true` and `result.unhealthy: true`.
Input is never replayed. A lost action reply means input may have been delivered. Read before repeating.
Compilation has its own bounded lifetime and precedes the request timer on first use. Before a cache-miss compile,
the adapter uses the existing `appleToolsPresent` check. It refuses `APPLE_TOOLS_MISSING` before calling xcrun,
so missing tools cannot open an install dialog. The client memoizes a preparation failure for 300,000 ms,
including across explicit helper restarts. Construct a new client after repairing the tools to retry immediately.

`ping` and `health` contain integer `apiVersion: 2` and a 64-character SHA-256 `build` identity. The identity hashes
the composed source and its generated protocol constants before the build stamp is inserted. The build record
separately hashes the complete stamped compiler input. Before any requested method, the client sends `ping`,
checks protocol, minimum API version, expected build and every method in its configured `requiredMethods` list.
Failure retires the child with `DRIVER_VERSION_MISMATCH`, unhealthy true. New additive methods raise apiVersion;
changed field shapes change the protocol major. The worker must include each method it uses in requiredMethods. A later unadvertised method also refuses
DRIVER_VERSION_MISMATCH before the client writes that request.

## Inventory and acquisition

| Method | Params | Result |
| --- | --- | --- |
| `ping` | `{}` | `{protocol, apiVersion, build, platform, methods, healthy: true}` |
| `health` | `{}` | `{protocol, apiVersion, build, platform, methods, healthy, accessibility, screenRecording, sessionLocked, onConsole, loginDone, hidIdleSeconds, retainedClipboardRecords?}`; preflight only, no permission prompt |
| `getState` | `{}` | `{apps, windows, errors}` |
| `listApps` | `{}` | `{apps}` |
| `listWindows` | `{}` | `{windows}` |
| `resolveApp` | `{selector, launch?: false}` | `{app, windows}`; metadata only, for parent admission |
| `getApp` | `{selector, launch?: boolean}` | Full tree result; launch defaults to true |
| `verifyWindowIdentity` | binding | `{window}` |

An app record has `id` (bundle id, else canonical bundle path), `name`, `path`, `running`, `pid`,
`processStart` and `useCount`. Nonrunning records use null PID and start time. Inventory joins
NSWorkspace's running apps with the window server list. It does not read document contents.
Phase 0 lists running apps; acquisition can resolve installed apps by bundle id, absolute `.app`
path or exact app name. Bundle ids use Launch Services. Name lookup covers `/Applications`,
`/System/Applications`, `/System/Applications/Utilities` and the user's `Applications` folder. Matching is case insensitive. Several matches
refuse `AMBIGUOUS_APP`. A missing selector returns `APP_NOT_FOUND`.

A window record has `windowId` (decimal string), `pid`, `processStart` (opaque string), `bundleId`,
`app`, `title`, `bounds: {x,y,width,height}`, `onScreen`, `minimized` and `identityVerified`.
Unknown minimized status is null. Process start is derived from the kernel, not title or PID alone.
`apps` is sorted by useCount descending, then name. The helper supplies zero until the worker merges its usage store.
`errors: [{source, code, message}]` records partial inventory failures, with usable arrays retained.
The parent filters unapproved metadata before giving inventory to the worker.

A selector is a nonempty string or `{windowId: "123"}`. Resolve only returns metadata.
`getApp` starts an absent installed app with NSWorkspace's `activates = false`. It does not use an Open panel
or Apple event. Acquisition polls for the first standard AX window within its deadline, reserving 150 ms to reply.
An app without a window then returns `NO_WINDOWS_AVAILABLE`. It does not create a
document or activate the app to repair that condition. Multiple processes refuse; within one PID,
the first matching standard window in window-server order wins. Explicit window selection is supported.

## Bindings and reads

A binding is `{windowId, processStart}`. The driver corroborates the window-server owner PID with
kernel process start, then matches one AX window by window number, or uniquely by PID and bounds
when AX hides the number. A nonempty WindowServer title must also match the AX title. An empty WindowServer title
does not require Screen Recording: the unique bounds match supplies the AX title. Overlapping WindowServer
windows of the same process and bounds refuse when the CG title and AX number are both hidden. An exposed contradictory AX
number never falls back. `identityCorroboration` reports `window-number`, `pid-bounds-ax-title` or `pid-bounds`.
`pid-bounds` marks the weaker match when the CG title is hidden, even when AX supplies a title for display.
AXMinimized fills `minimized` when exposed. An ambiguous or missing correspondence refuses `IDENTITY_UNVERIFIED`.
Each operation rechecks the binding, allowing the title to change.

| Method | Params | Result |
| --- | --- | --- |
| `getAXState` | binding plus optional `depth: 0..64`, `budgetMs: 1..30000`, parent-only `reuseIfUnchanged` | `{window, text, readId, truncated, reused, elapsedMs}` |
| `getScreenshot` | binding | `{window, capture, geometry?, screenshot?}` |
| `getAXStateAndScreenshot` | same as `getAXState` | Tree result plus capture fields under one deadline |
| `resolveElement` | binding plus `readId, target` | `{window, readId, element: {number, role, frame}}` after liveness checks |

The helper always returns a full tree for that read. The worker owns diffs, `disableDiffing`, `emit`
and turn-end baseline resets. A caller's printed slice never replaces the worker's full baseline.
Each full walk replaces that window's element map and increases `readId` across the helper.
There are at most 16 retained window maps. Eviction makes old reads stale. A target is a nonnegative
element number, `{id: "AXIdentifier"}`, `{label: "exact label"}` or `[x,y]` for pointer operations.
Selectors match exactly and uniquely within the latest retained map. Actions include `readId` and
refuse old reads as `STALE_READ`. Liveness checks compare the retained AX object, its role, PID,
current window membership and readable frame. They never rebind a removed element to a replacement
with the same label. A missing or ambiguous target refuses before input.

Before-action read reuse is an A/B option, off by default. `SLEIGHT_GLIDE_READ_REUSE=1` enables it in the trusted parent.
Explicit reads still walk, with `reuseIfUnchanged: 0` to record a candidate. Within the same turn, the parent can ask
for `reuseIfUnchanged: readId` before an action. The worker cannot supply this parameter. Windows input is unchanged.
A hit returns the complete retained text, document envelope and element map with the same `readId` and `reused: true`.
The marker is internal. It preserves the delivered-number map and never grants delivery.
Turn end clears the parent's candidate and delivered numbers. All person, policy, Pause and lease checks still run.

A candidate requires a window observer registered before the full walk. Complete SHA-256 digests on both sides of that
walk must agree with a fingerprint fed from the attributes that walk actually printed, with no observer revision change.
This also rejects a silent change and reversion during rendering. Reuse samples the revision before and after a fresh complete digest,
rechecks window binding, process start, exact bounds, window inventory, and retained root role and frame.
The digest covers the window and menu trees in walk order, including role, subrole, title, value, focus, enabled,
selected, geometry, other printed attributes, settable state and secondary actions. Values are hashed with type and
length prefixes. Digest values are never stored outside the hash. Hash collisions are treated as negligible.
The digest has a 3,000-node, depth-64, 40 ms budget. A missing observer, partial digest, attribute fault, custom read
limit, secure field, document range or canvas means a full walk. Document and secure trees need a separate complete
proof before they can reuse. Native liveness checks still resolve the retained AX object at action time.

Qualification still needs 20 paired three-action Calculator and TextEdit cells from UC2 L2.
Reuse must reach at least 90%, with lower paired p50 latency. A Word set must report its reuse rate.
Offline fixture replay cannot establish
live notification coverage, geometry, reuse rate or latency.

The tree starts with `Window: "<title>", App: <name>.`, then `0 standard window <title>`.
Children follow depth-first, indented by tabs, with consecutive numbers. Unchanged trees keep their
numbers. Role names follow the relay's existing format: `button`, `text`, `text field`,
`text entry area`, `combo box`, `menu`, `menu item`, `sheet`, `dialog`, `container`, `full screen button`, `switch`, `splitter` and standard window.
The role-table test lists all mappings, including subroles and the unknown-role fallback to container.
Optional metadata uses `, Description: <text>`, `, Value: <value>`, `, ID: <id>`, `, Help: <help>`,
`, URL: <url>`, `, Details: <text>`, `, Placeholder: <text>`, `, Selected text: \`<text>\`` and
`, Secondary Actions: <names>`. State flags occupy one comma-joined parenthesized group after the role.
Their order is disabled, focused, selected or selectable, checked, expanded or collapsed, settable, float, boolean.
An empty group `()` separates a role from a label that could extend it or imitate flags, such as `menu () bar x`.
Examples: `(disabled, settable, float)`, `(collapsed, settable)`, `(settable, boolean)`. Static text may put its value directly after `text`.
Menus, sheets, popovers and alerts remain numbered descendants, followed by the app menu bar at depth zero.
Menu-bar titles stay bare when their only states are selectable or collapsed and the title cannot resemble a role.
Other states, including selected, expanded and disabled, retain the role and state group for admission checks.
Between input actions in one cell, a changed sheet, dialog, alert, popover, floating window or menu root stops input
with `IDENTITY_CHANGED step=surface`. Added or removed roots, changed labels and Secondary Actions tails count as changes.
A menu root with collapsed and without expanded may change its disabled flag alone. Menu-item label and enabled-state changes also allow input.
A menu item or menu-bar item gaining selected stops it. A label never supplies a role or state flag.
Secondary names use the app's action description, else an AX-prefix-stripped name split at camel-case boundaries.
AXPress remains the primary click action and is omitted from secondary names. Duplicate printed names are omitted.
The retained map resolves only printed secondary names and rechecks the node's own list; an unlisted or changed
name refuses ACTION_UNSUPPORTED before input.

A read's text ends with `The focused UI element is N <element line>` using this read's number and full line, or
`sleight: no element in this read reports focus.` The fixed focused prefix is retained as the relay's parse token.
Selected text is fenced with backticks, provider newlines become spaces, and a backtick is escaped. A nonempty
selection adds sleight's own sentence: `sleight: the selection may identify the content the user means.`
Provider strings have controls and line separators replaced with spaces and are limited to
16,384 UTF-16 units. Window-title quotes are escaped in the header. Provider text cannot add tree rows.

Secure text fields print `<redacted>`. The walker first batches role and subrole, then omits value,
title, description, help, URL and identifier reads for secure fields and their descendants.
It batches attributes with `AXUIElementCopyMultipleAttributeValues`, retains each emitted AX object,
and marks depth, node, text or time limits with `truncated: true`. Defaults are 3,000 ms, 10,000 nodes,
64 levels and 1 MiB tree text. No omitted element receives a number. A partial tree cannot silently
claim completeness. A read failure clears that window's previous element map. The normal read performs one full inventory bind,
then one target-only WindowServer/PID-start check at completion and verifies the retained AX root's frame and role.
Child attributes share the nonsecure metadata batch. Secure descendants fetch only roles and children. Menu items
skip action-name and settable calls. The walk reserves one quarter of the smaller remaining request or read budget,
with a 5 ms floor and 650 ms cap. It reserves at least 20,000 bytes for its footer, growing the reserve to fit a long
focused line. AX slices also stop at the cooperative walk deadline. The final identity checks retain their reserve.
The reserve is policy. Live short-budget reads and final identity-check latency remain unmeasured.

## Input lanes

All input params are binding plus `readId` and `args`, an array of the App method's positional arguments.
This matches the Windows worker's dispatch shape. RT4 owns pointer, RT5 keyboard, RT6 settle/person,
and RT7 capture. `DriverMain.swift` explicitly installs the file-level `driverRegistrars` list. A lane adds its inert registration
extension there at integration. RT7's capture registrar is installed now. Input lanes register through
`DriverRuntime.registerAction(method:handler:)`. Ordinary handlers use `register(method:handler:)`, which also routes action method names through the action wrapper.
The handler receives `DriverRequest` and `DriverCore`, returns a JSON object or throws `DriverFault`.
Core offers `boundWindow`, `resolveElement` and `readTree`. Handlers must validate all args before input.

| Method | `args` |
| --- | --- |
| `click` | `[target, {mouseButton?: "left"|"right"|"middle", clickCount?: 1..3, key?: ["shift"|"control"|"alt"|"meta"], durationMs?: 1..2000}?]` |
| `doubleClick` | `[target]`, equivalent to left count 2 |
| `rightClick` | `[target]`, equivalent to right count 1 |
| `scroll` | `[target, "up"|"down"|"left"|"right", pages or {pixels: positive number}]` |
| `drag` | `[fromTarget, toTarget]` |
| `typeText` | `[text]`; targetless, uses the bound app's caret |
| `pressKey` | `[chord]`; xdotool names and aliases, including bare modifiers |
| `modifiers` | `[{keys: ["shift"|"control"|"alt"|"meta"], state: "down"|"up"}]` |
| `setValue` | `[target, value]`; settable check, readback; refuses VALUE_NOT_SETTABLE |
| `selectText` | `[target, text, {prefix?, suffix?, selectionType?: "text"|"cursor_before"|"cursor_after"}?]` |
| `performSecondaryAction` | `[target, printedName]`; retained name resolves to that node's AX action |
| `paste` | `[text, {format?: "text"|"md"|"html"}?]`; only qualified plain-text selection insertion is supported |

Pointer coordinates are window screenshot pixels with a top-left origin. The input lane checks capture
scale against current window bounds, then posts window-local points to the bound PID from a private
event source. The real pointer and frontmost app remain unchanged. Keys use the same PID binding.

Coordinate clicks include a parent-owned `coordinateReadId` from the last delivered screenshot, separate from
the fresh admission `readId`. The helper retains up to 16 image maps and 64 MiB of encoded image data.
An internal read or an image suppressed by the relay cannot replace that baseline. The deepest retained
frame at the point must identify the same AX object, frame, role, title, description and state at the
posting boundary. Overlapping deepest frames, partial maps and expired images refuse `TARGET_CHANGED`.
The same canvas or other container also requires an exact sRGB hash match of the 48 by 48 point patch,
clipped at the window edge. Pixels never override an AX disagreement. A fresh window-only capture supplies
the comparison. Display-scale drift refuses `CAPTURE_SCALE_INVALID`. Exact pixel equality can refuse
animation and JPEG drift. Live false-refusal rates are unmeasured.
The retained AX map and one fresh walk bracket each input-enabled screenshot. If their objects, frames, state or text differ,
the image remains available to the model but cannot authorize coordinates. Screenshot latency is unmeasured.
The last AX comparison and the press remain separate operations, so a change inside that interval can race them.

Recovery text offers a new capture or a new element number. `{focused:true}` is also supported for click, setValue and selectText.
The focused target must be the unique focused element in the delivered tree, pass the existing numbered
invariant and still report focus in the helper. Numbered targets retain every existing RT11H check.

After an unknown, missing or malformed input reply, the parent refuses subsequent
input to that window with `READ_FIRST_REQUIRED`. A successfully delivered complete read or screenshot of
that window clears the latch. Hidden reads, failed output writes and delayed callbacks for earlier reads
cannot clear it. With compact reads on, use `getAXState({disableDiffing:true})` for a complete recovery read.
Another window remains eligible. Turn end clears the latch. A JavaScript reset preserves it.
Validated `sent-unverified`, `sent-verified` and `not-sent` replies permit subsequent input.

Every action validates identity and checks person takeover immediately before dispatch. No semantic
fallback is implied by success or failure. Pending buttons and modifiers are released on failure.
Click modifiers are flag changes around the click from the same private source. Duration holds the button.
Semantic methods refuse secure targets with SECURE_FIELD. selectText matches case-sensitive text within the value;
several matches without disambiguating prefix or suffix refuse AMBIGUOUS_ELEMENT and report the count.
Runtime paste has no general-pasteboard capability or recovery writer. A qualified adapter inserts plain text
at the selection through AXSelectedText or PID-targeted Unicode events. Qualification receives the exact text.
Line breaks and tabs require selected-text insertion and refuse before any Unicode event. Rich formats and
unqualified targets refuse ACTION_UNSUPPORTED with `delivery: not-sent`. A post-send failure reports unknown
delivery and read-first retry. Unicode observation polls for at most 250 ms without resending input.
Production startup doesn't register semantic handlers or qualify targets. The helper advertises these methods
only when an integrator registers them after qualification.
Pre-input refusals use `textInput: unsupported`, or `unsupported-controls` for Unicode line breaks and tabs.
These tags select fixed recovery text. The formatter never reads provider messages.

Health may include `retainedClipboardRecords`, a nonnegative count of legacy snapshot filenames from metadata-only
inventory. An unavailable or unsafe catalog omits the field. Inventory never opens payloads or deletes records.
The runtime app handle refuses Copy, Cut and Paste shortcuts before a driver request. Explicit paste delegates
to the strict text dispatcher and never falls back to clipboard staging.
The parent refuses click, doubleClick and performSecondaryAction on a retained menu item or button whose label
names Copy or Cut. The separate clipboard-action table covers English, Spanish, French, German, Portuguese,
Italian, Japanese, Chinese and Korean, including Copy Link and Copy Image families. It uses the consequential
classifier's normalizer for case, confusables, combining marks and zero-width characters. The refusal says the
action would overwrite the clipboard. Mixed-script spellings of Copy also refuse when a Greek capital upsilon
folds toward U instead of Y. Menu Paste lets the app read the current clipboard without sleight staging
or restoring data. This finite label table leaves actions with unrecognized clipboard-writing labels outside its coverage.
Coordinate targets have no retained element label and are outside this label check; runtime input remains
unregistered pending qualification.

Input params add `read: "full"|"none"`, default none. With none, the action wrapper neither settles nor reads,
and strips any tree/capture fields. With full, it calls the registered settle handler and then returns a full
read under the original deadline. The input lane calls `request.admitInput()` immediately before its first post
or AX mutation, so later faults cannot claim not-sent. The wrapper refuses a missing settle handler rather than
pretending the observation happened.

An action result contains `{window, delivery, retry, personTookOver, settled}` and may include a new
full read. `delivery` is `not-sent`, `sent-unverified`, `sent-verified` or `unknown`; `retry` is
`safe` only for `not-sent`, otherwise `read-first`. Errors after input include these same disposition
fields in `error`. Core validation refusals imply `not-sent`. A successful post proves delivery only,
so its result is `sent-unverified` until an authorized observation verifies the effect.

## Background keyboard belief

Keyboard input refuses secure event input (`SECURE_INPUT_ACTIVE`) and physically held Shift, Control,
Option, Command or Fn (`PERSON_HOLDS_MODIFIER`). Caps Lock alone is a toggle and does not refuse.
The keyboard records the real frontmost process and its focused AX window. For a background target,
it constructs AppKit activation and deactivation events from the public NSEvent subtypes, verifies
their CGEvent round trips, and posts only to the bound PID. A retained private source supplies each
event family. Each chord event sets its keyboard type from `LMGetKbdType`.

The app's read-only `AXFrontmost` belief is polled every 10 ms, with a 150 ms cap in each direction.
The person guard, deadline and bound process identity are checked before activation and each key.
A sampled change to the real frontmost app or its focused window aborts before the next key.
Deactivation runs after every attempted activation, including timeout and uncertain delivery.
Cleanup checks the original process identity. A recycled PID doesn't receive cleanup events.
A belief that cannot be cleared retires the helper. The activation timeout doesn't send a chord and
returns `KEY_FOCUS_UNAVAILABLE` with `delivery: "not-sent"`. Key delivery counts exclude the belief events.

Results include `focusChanged` and `focusRestored`. If the target accidentally becomes the real
frontmost app, restoration checks the recorded process start and refuses after HID mouse-down,
key-down or modifier input since the call began. If the AX window snapshot fails during cleanup,
NSWorkspace supplies the frontmost PID and process start for restoration. The missing AX sample stays unhealthy.
It can activate only that recorded original app. It never activates the target to make a chord work.
The final NSWorkspace identity check runs only when restoration is otherwise eligible. If it fails,
the helper waits 20 ms and retries once. A successful read must identify the target PID. If the AX
snapshot exists, both samples must have the same process start. Person input during the wait prevents restoration.
If both reads fail, the helper calls the restore closure anyway. That closure checks the current
target and the recorded original process before restoring.
An already frontmost target skips the synthetic activation and deactivation pair.
Each belief interval has a 400 ms cooperative stall cap. Text ends a chunk after a complete stroke
once measured fake-active time reaches 200 ms, leaving 150 ms for deactivation polling and 50 ms of margin.
Each new chunk checks the original focus, lease, process identity and person input before posting.
Faults between chunks retain any observed focus change and any restoration from the completed chunk.
`fakeActiveMs` reports the longest interval, with one trace per interval. `charactersDelivered` counts
Unicode scalars in text key-downs whose transport returned, including characters before a later stall.
An uncertain transport can have delivered more. The count is a lower bound on that path.

UC2F adds the opt-in `SLEIGHT_DRIVER_TEXT_BELIEF=fallback` A/B path. Text uses the existing
belief path by default until the live text cells pass. The experiment posts Unicode scalars in chunks of at
most 32 UTF-16 units, with zero modifier flags and only to the bound PID. It does not consult or
change the keyboard layout. Return, line feed and Tab inside text refuse before posting; use a
selected-text insertion route for those characters.

The experiment binds the app's focused text element to the leased window and checks its role,
secure ancestors, enabled state and process before reading its value or selection. Between events
and chunks it checks secure input, person activity, the original foreground window and the original
text element. A changed field or caret stops with `focusChanged: true`. Exact value and UTF-16
selection readback verify each inserted chunk, including replacement of an existing selection.
Readback polls for at most 150 ms per chunk within the request deadline. A strict inserted prefix
reports its verified scalar count in `charactersDelivered` and stops. `charactersPosted` counts
scalars whose key-down transport returned. A missing, changed or unavailable readback stops with
`retry: "read-first"`. An unchanged AX readback leaves queued event delivery unverified, so
an attempted chunk is never resent under belief.

If the bound nonsecure field lacks value or selection readback before the first post, the
experiment chooses belief before sending any text. It retains the field and person checks, uses
the same zero-flag chunks and returns `sent-unverified` with `textBeliefFallback: true`.
On that path `charactersDelivered` has the existing transport-count meaning. An active IME is
reported by `compositionBypassed`. Unicode input bypasses composition without switching the input source.

The optional `bench/runtime-text-probe.mjs --dry-run` prints two TextEdit cells without starting a
helper. The later live sitting runs 10 trials of 2,000 ASCII characters with a 4,400 ms p50 limit,
and 10 trials of `café 日本 🙂`, with exact saved text on every trial. The timer covers the typeText
action, with fixture setup and saving outside it. The existing fixture witness and process receipts
apply along with background and cleanup checks, while full runtime qualification still requires the complete gate.
The headless lane has not measured either live cell or Unicode delivery under an active IME.

For `pressKey` with `read: "full"`, the menu fallback runs only after the first snapshot, on
`KEY_FOCUS_UNAVAILABLE` or `AX_UNAVAILABLE` belief faults. It requires a quiet settle and two equal,
complete trees. The chord's belief step must have failed before any key post, with a
`DriverFocusFault` marked `beliefUnconfirmed`. This covers
activation transport and belief-loop faults after the initial snapshot and input guard, while belief
is being established, including its timeout. Preflight, the initial snapshot, activation-event
allocation and the initial input guard fail directly. Body and cleanup faults never qualify.
Fallback also requires completed cleanup, `uncertain == false` and `unhealthy == false`.
A sampled focus change suppresses the press. If belief established and
the keys were posted, an unchanged tree returns the observed result with the note
`shortcut delivered with no visible change` and presses nothing. This includes Command-V and Command-D.
The retained read bank stores the earlier tree for this
comparison. All available character, virtual-key, modifier and glyph attributes must agree with the
chord. Before posting, the keyboard snapshots the matching item's title, enabled state and mark character.
A change in any of those after the chord suppresses the press. Malformed metadata counts as ambiguity.
Command-Z and Shift-Command-Z never fall back, across all apps.
A fallback AX read failure or lost identity before AXPress preserves a sent chord's observed result.
If a belief-failed call ends without a menu press, it throws `KEY_FOCUS_UNAVAILABLE` with
`delivery: "not-sent"` and `retry: "safe"`.
Zero matches, two matches, a disabled sole match, a truncated tree, held synthetic modifiers or a nonquiet settle skip the press.
The hook rechecks person state, focus and binding after the final menu metadata validation, then invokes AXPress once.
Any earlier focus change suppresses the fallback, even after restoration. The result says
`pressed the matching menu item`, reports `menuFallbackCount: 1`, and includes a fresh post-press read
with `settled: false` and `delivery: "sent-unverified"`. An uncertain press reports one attempt in the error and is never retried.
Command-Q, Command-Control-Q, Command-Shift-Q and Command-Option-Escape refuse in the keyboard itself,
including their held-modifier forms, before any chord or menu action.
Command-Option-H remains eligible under the same checks as other chords. Fallback and posted keys use the same shortcut capability.
An AXPress timeout reports `ACTION_UNCONFIRMED`, with unknown delivery and no retry, even when the app applied it.

Keyboard methods remain unregistered. Registration requires RT26's person and settle implementations
and an adapter preserving keyboard fault disposition and focus diagnostics. The public event round
trip is construct-only evidence. Background delivery, activation side effects and speed still need
the owned-fixture live gate.

## Settle, person and capture

`settle` takes binding plus optional `quietMs` (default 120), `capMs` (default 1,500), `afterReadId`,
`extendForBusy` (default true), `busyCapMs` (default 5,000), `includeScroll` (default false) and
`waitForWindow` (default false). Durations are whole milliseconds from 1 to 30,000.
It returns `{window, settled, reason, elapsedMs, personTookOver, busyElements, digestComplete, observer}`.
Reasons are `quiet`, `cap`, `matching-captures`, `busy-cap`, `person-active` or `person-took-over`.
A settled result also reports `quietBasis`: `digest`, `notification`, `notification-none` or `captures`.
`digestComplete` describes the latest walk. `observer` says whether notification registration succeeded.
RT26 counts visible progress indicators and busy elements once per node. `busyElements` reports the largest
count seen. Busy state prevents a quiet result. With `extendForBusy`, seeing a busy element extends the cap
to the larger of `capMs` and `busyCapMs`. Clearing busy state starts a fresh quiet window.
The worker skips settle between idle reads and calls it only after an action on that binding since the last read.
AXObserver value, children, focus, window, sheet, menu, layout and busy notifications reset the quiet window.
Its source runs on the request thread's run loop and is removed when settle returns or throws.
A bounded tree digest poll runs every 50 ms. Digest reads leave the retained element map and `readId` intact,
skip secure controls' values and descendants, and cap the walk at 3,000 nodes, depth 64 and a 40 ms budget.
Partial prefix digests still reset quiet when they change, but only two complete walks can establish digest
change evidence. A partial walk followed by a complete walk starts a fresh quiet interval without adding
evidence. Nodes without AXPosition or AXSize still contribute attributes and descendants; their geometry is
omitted, and they do not count as visible busy elements. Missing geometry marks the walk faulted and incomplete.
A persistently frameless node prevents settle from finishing before `cap`, even with a clean observer.
A vanished element marks the walk incomplete and
counts as AX change. AX faults never qualify as budget limits. A digest fault leaves the read's retained
settle baseline empty, while the read still performs its final identity and deadline checks.
Frame reads that return `STALE_ELEMENT` or `AX_UNAVAILABLE`, including a messaging timeout, mark the walk
faulted and incomplete, so a later successful frame read cannot supply digest change evidence across that fault.
A complete digest with change evidence can settle on the `digest` basis. Otherwise, observed notifications
use the `notification` basis. An incomplete walk can settle only when it reached a count, depth, child-count or
pre-call time limit, had no AX fault, and has an observer. Without a notification, that walk first tries two
matching window captures at least 100 ms apart (`captures` basis). If Screen Recording is unavailable, it
can use the weaker `notification-none` basis after the quiet interval when zero notifications arrived.
An incomplete walk caused by an AX fault or cycle remains unsettled until a later eligible walk.
`includeScroll` adds scroll notifications and scroll-bar values to the quiet rule. Ordinary changes to the
content tree still count with that option off. A complete tree with no change evidence also needs the
capture pair. Capture compares ephemeral pixel hashes, with window identity checked before and after.
Screen Recording access is queried without a permission request. A missing grant returns
`SCREEN_RECORDING_REQUIRED` unless the incomplete walk qualifies for notification quiet.
Other capture faults propagate. A cap is reported as unsettled and has no `quietBasis`.
The request deadline bounds every wait, including a busy extension or primary-window wait.
`waitForWindow` requires `afterReadId`. It polls at 50 ms for a new standard primary window from the same
process incarnation, excluding window IDs present at that read. It returns that ID as `primaryWindowId`.
The result's `window` remains the original binding. The parent must acquire and read the new window before input.
No new primary window before the cap returns `settled: false, reason: "cap"`.
`personState` takes a binding and returns `{window, personTookOver, reason, token}`. The opaque token
records the latest sample. Input must pass `personToken` beside `args` when its guard is integrated. A changed sample refuses
`PERSON_TOOK_OVER` with `delivery: "not-sent"`. Tokens expire with the helper incarnation.
There are no unsolicited stdout events. The parent samples or receives signals in normal replies.
The detector compares monotonic last-HID-event timestamps, reads the frontmost app PID on the main queue,
and samples the top window under the pointer. Off-main requests wait at most 50 ms for that PID read;
timeout refuses that check with `PERSON_TOOK_OVER`, `reason: "person-unknown"`, `personTookOver: false`
and `unhealthy: false`, preserving the helper, retained reads and tokens. Before input admission the refusal
reports not-sent/safe, including during settle, and its message says no input was sent.
After admission it reports unknown/read-first. The pointer adapter honors an explicit `personTookOver: false`
on this refusal. A completed read with an unavailable
PID still makes the helper unhealthy. It does not sample a front window. The PID can be up to 50 ms older
than the HID timestamp and pointer sample. New HID input counts when the target was or is frontmost or
under the pointer. A foreground or window-order change alone does not claim human input.
`personState` and settle report HID activity less than 500 ms old in that target as `person-active`.
Before input admission, initial activity waits inside the same request. Input needs 1,000 ms since the last HID
event involving the target, sampled every 20 ms. The wait stops at the smaller of 8,000 ms and the remaining
request budget minus 150 ms. A pointer parked over the target after motion keeps the wait active, including
when another app is frontmost. Typing elsewhere with the pointer elsewhere does not start a wait.
A takeover since the previous request refuses, so waiting mostly helps the first action in a window.
Only the first input guard can wait. The default 5,000 ms request advertises a cap near 4,850 ms, but the
required 500 ms for validation leaves about 4,350 ms useful waiting time.
At the cap, input refuses `PERSON_TOOK_OVER`, not-sent/safe. The pointer case says the pointer is over the window.
New HID input after the initial guard remains a sticky takeover for the request, including after admission.
Private-source posts do not advance the HID timestamp.

After waiting, the parent rechecks Pause, app approval, policy and the lease. Turn interruption cancels the pending request.
The helper then checks the session lock, process and window binding, bounds, secure input for key and
semantic input, held modifiers, and the retained read again. A complete digest must still match, including focus,
enabled state, text and geometry. A changed or incomplete read refuses `STALE_READ`; the action never chooses a
replacement element or caret. The regular per-event guards still run before posting. The final HID check has the
existing 3 ms timestamp tolerance. Sampling and posting are not atomic.
Coordinate waits compare the whole window region, so unrelated changes or an incomplete digest can refuse `STALE_READ`.

When a wait occurs, success and failure replies include `waitedForPersonMs` and `personWaitCapMs`.
Request copies share the receipt.
The parent prints one conditional line: `sleight waited N ms for the person to pause`. The helper's private event
pipe emits a waiting status with detail `person`. It doesn't send text, keystrokes or labels with that status.
Offline fake-clock tests cover a 2 s typing burst, the quiet interval, cap, deadline reserve, fresh safety checks,
and independent actions. Live acceptance still requires 10 of 10 owner-present fixture clicks after typing stops,
0 owner keystrokes delivered to the wrong window and no wait past 8 s. The takeover refusal narrows which cases
can wait, and this acceptance check remains pending.
Unavailable samples fail closed. Tokens bind PID, process start and window ID to this helper incarnation;
the helper retains the latest 64 tokens. A token never bypasses the activity check.
Input integration must call `core.checkPersonBeforeInput(request)` before admission. That helper refuses a
missing or invalid token with `INVALID_PARAMS`. The guarded input registrar calls it. The per-event guard remains
`core.checkPerson(request)`, before and after each post and during delays. Both check the session lock and
binding again, and report not-sent/safe before admission or unknown/read-first afterward. Request copies
share one watch, including copies made before the watch exists. Settle stores its watch on that request;
the original request's token supplies the baseline even when a settle copy initializes the watch first.
`request.admitInput()` stays at the actual posting boundary. Pointer and keyboard registration remain for RT8,
including their fault adapters. RT26 registers only `settle` and `personState`.

These defaults and native adapters have offline fixture coverage. Live acceptance still needs probe 7 at
20/20, Calculator and TextEdit post-input read p50 at or below their paired engine arms, idle reads within
10%, and takeover detection at 10/10 with the owner away.

Capture preflights Screen Recording without requesting it. Failure returns `SCREEN_RECORDING_REQUIRED`.
`screenshot` is `{data: "<base64>", mimeType: "image/png"}`. `capture` has `{status, note}`.
`status` is `ok`. Unavailable capture is an error. `geometry` has `{windowBounds, pixelWidth, pixelHeight, scaleX, scaleY}`
with bounds in global top-left points and image dimensions in Retina pixels. The note states the frame
and scale. Capture targets only the bound window, including when covered, and excludes sleight's hand
and overlay windows. A combined read verifies identity before and after both parts. A capture failure
returns an error for the combined read. PNG is capped at 40 MiB (about 53 MiB base64); OUTPUT_LIMIT also enforces
the complete 64 MiB envelope cap. RT7 uses desktop-independent single-window capture and excludes separate child
windows on macOS 14.2 or newer. Sheet/menu coverage, minimized windows, other Spaces and periodic system capture
alerts still need live checks. Capture doesn't fall back to a display or region.

## Session and stop

One DriverSession supplies health's nullable lock, console, login and HID idle values. Health is never desktop-guarded.
Health reports the raw dictionary lock value, so its first sample after unlock can report false while desktop admission
still requires confirmation. Lock and unlock notifications hold the desktop guard until two active, unlocked dictionary
samples are at least 100 ms apart. The first desktop request after unlock takes that second sample in the same call.
It schedules at most 100 ms of sleep and refuses if confirmation exceeds its 150 ms elapsed budget. It never loops waiting
for unlock. At each request checkpoint, the driver samples the dictionary before allowing further work. This catches
locks whose notifications were missed. A lock observed during a request ends it even if unlock is confirmed before completion.
The resulting SCREEN_LOCKED error keeps the original fault's disposition and unhealthy flag, so an unhealthy ending
still retires the helper.
Reads, captures and input refuse SCREEN_LOCKED when locked. Unknown session state, inactive console/login or invalid
idle refuses DRIVER_INTERNAL, unhealthy true. `allowLocked` is an optional strict JSON boolean, default false.
The client rejects that key in raw request params. It builds it only from its constructor's boolean driveLocked
owner policy and an explicit desktop-parameter allowlist. The worker must derive the policy from its owner-only
SLEIGHT_DRIVE_LOCKED setting. It is absent from model tool schemas. Input convenience methods pick only binding,
read id, person token and args from caller objects. The override preserves console/login and takeover checks.
An absent `CGSSessionScreenIsLocked` key is read as unlocked when console and login flags are valid. This is RT24's
unmeasured assumption. The owner's sitting log must confirm the key's presence and value while locked and after unlock
on each supported macOS version. If the locked dictionary omits the key, two samples can incorrectly lift the lock guard.

Every admitted handler, including its final deadline check, runs in withRequestPower. Fake fixtures use fake
providers. The assertion keeps the system awake until the handler completes and releases on success or error. A watchdog
exit also releases it. Display sleep remains allowed.

The Glide engine shows a Stop control in sleight's consent host while an input call runs, including when cursor
artwork is off. The parent waits for the host's ready acknowledgment before dispatch. The control uses a nonactivating
panel with capture sharing disabled. Its placement uses the consent card's screen-relative anchor in a free rectangle
outside the driven window. With no such rectangle, input is refused. The host checks placement every 25 ms and stops
if the window disappears or no free rectangle remains. Placement during window movement and capture exclusion still
need live qualification.

Only a person's pointer or key input on Stop is accepted. The control refuses Accessibility press through both APIs. Posted events,
repeated keys and replayed pointer events refuse through the consent host's provenance checks. There is no global key
listener or Input Monitoring grant.

The host's nonce-bound, per-call token reaches the parent over its existing frame pipe. The parent's stop control frame
uses the helper nonce and active call id. The stdin reader processes it outside the serial action queue, so it reaches
an in-flight call. Request copies share cancellation. Pointer spacing, keyboard posts, capture waits, settle waits and
local-tool sleeps check cancellation at intervals of at most 20 ms. The compound kernel accepts the same throwing stop
check between transitions. Compound input remains unregistered. The stepped JXA drag uses a private temporary stop flag
installed by its parent runner, with checks before mutations and during waits.

Stop returns `USER_STOPPED`, `next: stop-tell-user`. Input cleanup releases held buttons and keys, including modifiers
retained from an earlier call. It bypasses cancellation only for those releases and retains process identity checks.
No text repair, fallback input or new pointer move follows Stop. The Stop control and attributed `/sleight stop` latch
input until the next person prompt attributed by the mod, or a new session. Turn end, including an attributed mod end,
helper restart and `js_reset` leave Stop latched. A prompt arriving before the stopped call finishes does not resume it.
Where person prompts cannot be attributed, Stop lasts for the session and the refusal says to start a new session.
Nothing the model can call clears Stop. Esc/Interrupt ends the action and releases input without latching Stop.

The qualification target is 10 of 10 fixture stops within 500 ms with every held button and modifier released. Offline
fake-provider checks cover cancellation and release ordering. They do not qualify OS dispatch or screenshot exclusion.
`bench/glide-stop-live.mjs --dry-run` describes the attended probe without opening a fixture or posting input.

## Closed errors

protocol-codes.json is the code authority. The build generates the Swift lookup from it and the client imports it.
Message wording belongs to RT20. The unhealthy column is the minimum retirement flag; a transport or deadline
failure can also retire a child. Disposition is required on input-related codes and on any error returned by an
action. Before admitInput it is not-sent/safe; afterward it is unknown/read-first unless the input lane supplies
more precise fields. Errors from reads have no delivery/retry fields.

The rows marked engine-path only describe the engine's clipboard preservation errors. The own runtime never writes
or restores the pasteboard. Its count-only watcher also emits `CLIPBOARD_CHANGED`, with `next: stop-tell-user` and
`retry: read-first`. It preserves the action's delivery evidence and doesn't read clipboard contents.

| Code | Next | Unhealthy | Disposition |
| --- | --- | --- | --- |
| `ACCESSIBILITY_REQUIRED` | `ask-user` | no | on-action |
| `ACTION_UNCONFIRMED` | `read-again` | no | required |
| `ACTION_UNSUPPORTED` | `none` | no | required |
| `AMBIGUOUS_APP` | `none` | no | on-action |
| `AMBIGUOUS_ELEMENT` | `read-again` | no | on-action |
| `APP_NOT_FOUND` | `none` | no | on-action |
| `AX_TIMEOUT` | `retry-safe` | yes | on-action |
| `AX_UNAVAILABLE` | `retry-safe` | no | on-action |
| `CAPTURE_ENCODING_FAILED` | `none` | no | on-action |
| `CAPTURE_GEOMETRY_CHANGED` | `read-again` | no | on-action |
| `CAPTURE_SCALE_INVALID` | `none` | no | on-action |
| `CAPTURE_SIZE_LIMIT` | `none` | no | on-action |
| `CAPTURE_TARGET_INVALID` | `none` | no | on-action |
| `CAPTURE_UNAVAILABLE` | `retry-safe` | no | on-action |
| `CAPTURE_UNSUPPORTED` | `none` | no | on-action |
| `CLIPBOARD_CHANGED` (engine-path only) | `read-again` | no | required |
| `CLIPBOARD_RESTORE_FAILED` (engine-path only) | `stop-tell-user` | no | required |
| `DEADLINE_EXCEEDED` | `restart-helper` | yes | on-action |
| `DRIVER_INTERNAL` | `restart-helper` | yes | on-action |
| `DRIVER_PROTOCOL` | `restart-helper` | yes | on-action |
| `DRIVER_VERSION_MISMATCH` | `restart-helper` | yes | on-action |
| `ELEMENT_DISABLED` | `none` | no | required |
| `IDENTITY_CHANGED` | `read-again` | no | on-action |
| `IDENTITY_UNVERIFIED` | `read-again` | no | on-action |
| `KEY_FOCUS_UNAVAILABLE` | `read-again` | no | required |
| `INVALID_PARAMS` | `none` | no | on-action |
| `LAUNCH_FAILED` | `none` | no | on-action |
| `METHOD_NOT_FOUND` | `none` | no | on-action |
| `NO_WINDOWS_AVAILABLE` | `none` | no | on-action |
| `OUTPUT_LIMIT` | `none` | no | on-action |
| `PASTE_UNCONFIRMED_CLIPBOARD_HELD` (engine-path only) | `stop-tell-user` | no | required |
| `PERSON_TOOK_OVER` | `stop-tell-user` | no | required |
| `PERSON_HOLDS_MODIFIER` | `stop-tell-user` | no | required |
| `SCREEN_LOCKED` | `ask-user` | no | on-action |
| `SCREEN_RECORDING_REQUIRED` | `ask-user` | no | on-action |
| `SECURE_FIELD` | `none` | no | required |
| `SECURE_INPUT_ACTIVE` | `stop-tell-user` | no | required |
| `STALE_ELEMENT` | `read-again` | no | on-action |
| `STALE_READ` | `read-again` | no | on-action |
| `TARGET_CHANGED` | `read-again` | no | required |
| `READ_FIRST_REQUIRED` | `read-again` | no | required |
| `USER_STOPPED` | `stop-tell-user` | no | on-action |
| `VALUE_NOT_SETTABLE` | `none` | no | required |
| `WINDOW_NOT_FOUND` | `read-again` | no | on-action |

## Compounds

The compound core remains unregistered, with zero production mechanism qualifications. A menu request
first follows its literal title path from the proved app menu bar through each owned submenu. Dormant
children and disabled twins count toward ambiguity. A present leaf uses one AXPress after the same
authority, lease, person and process checks. The compound never presses a parent. The result reports that the item
was pressed through Accessibility without opening the menu.

Only an absent leaf permits the existing open-then-choose sequence. An ambiguous path, incomplete read,
unknown effect contract or changed recipient stops before input. Apps may update a menu item's enabled
state only when its menu opens. For that reason a leaf shown as disabled in the unopened tree still gets
one qualified press, in any app. The live probe records how many such presses had no effect because the
item was disabled. If its required effect is absent in the following complete read,
the result is `ACTION_UNCONFIRMED`, retains that read and invalidates continuation. It never presses
again or tries the open-menu path after dispatch. Consequential labels still require the ordinary
action path. The existing independent Escape rule applies to menus left open by the fallback.

`node bench/runtime-compound-probe.mjs --dry-run` prints deferred trials for Calculator View > Scientific
(10/10), TextEdit File > New (10/10) and Word Format > Font (5/5 or a written fallback), 25 in total. Each requires an
independent witness counting app windows every 50 ms, with zero menu windows observed from the baseline
through the next read. These cells are disabled and separate from the 29 active runtime probe cells.
No live result or speed improvement has been measured for this mechanism.

## Signing and distribution

The default remains compile at first use. `scripts/helper-release.mjs` prepares a signed arm64
helper from a clean checkout. Its record contains the source hash and the same build ID checked
by the client handshake. Ad-hoc signing (`--identity -`) doesn't require a keychain. Developer ID signing
requires an explicit team and a dedicated keychain. Notary submission requires `--submit`;
missing credentials are recorded as a no-op.

A bundled helper is accepted only against a reviewed literal release pin in `mac-driver/host.mjs`.
Verification checks source/build identity, exact binary hash, arm64 architecture, code signature,
signing identifier and Apple Developer ID team. No pin is configured yet. A missing or refused
prebuilt falls back to the existing compiler and its Apple tools precheck. Each spawn rechecks
the receipt's bytes. This uses the host-grant model.
The fresh-user check must confirm attribution for the signed helper.
[The signing handoff](helper-signing-ci.md) contains the proposed CI workflow,
ordered owner steps and the fresh-user Calculator runbook. The fresh-user check has not run.

## Integration and qualification

`DriverCore.swift` owns AX and retained maps. `DriverProtocol.swift` owns framing and the serial loop.
`DriverInventory.swift` owns app/window metadata. `DriverMain.swift` supplies the entry point and
registers core methods. Other lanes can add their registration in their own extension files through
`register` when integration wires them in. Core does not activate input, observer or capture
handlers merely because another file compiles. `build.mjs` composes core sources and calls the existing
native compiler with a separate source map. `client.mjs` is inert until a request and refuses off darwin.
The adapter stages the merged Swift as `glide-engine.swift` and the unchanged `peer-host.c` beside it.
The bare `glide-engine` artifact contains the Glide engine's entry point. The consent UI stays in
`consent-host`. The source keys and binary names differ. Private source staging is
removed after preparation. An old cached `mac-driver/<key>/consent-host` is refused as a target and
rebuilt under a new key on first use. No build record or launch receipt migrates.
Each spawn checks the current source hashes, build record and binary hash again. The build tests
inject the compiler API, while the native tests compile the composed source directly with `swiftc`.
The real compiler/cache test builds both fixed artifacts in a private temporary bank, checks the real record and
validates a cache hit. It never starts a production driver on the desktop. Fixture entry points compile only
with SLEIGHT_DRIVER_FIXTURES. Production rejects `--fixture` before constructing its core.

This protocol has no live qualification yet. sleight-arch must run 20 full reads each of Calculator,
TextEdit, Finder, Safari, Word, Excel and VS Code, retain success/truncation counts and p50/p90 timings,
and compare each class with the speed map. The latency bar is RT13's paired same-day engine arm. The earlier 43 to 48 ms idle range checks the harness. Measure a 10 KB
reply's pipe time separately against 5 ms. RT6 and RT7 own the 416 ms post-input and combined-capture
checks. The engine remains the default until the mechanism probes and model A/B pass RT1's rules.
