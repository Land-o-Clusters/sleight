# Windows JavaScript worker

WDR2 connects the Windows `js` and `js_reset` tools to sleight's relay. The Mac launcher keeps its engine path.
The WDR2 desktop tests use a fake driver. No Windows machine has run this code.

## Processes and admission

`windows-launch.mjs` serves MCP through `createRelay()`. Its backend starts one Node child lazily for JavaScript.
The child uses `node:repl`'s evaluator and VM context over in-memory streams. It retains bindings between cells,
supports top-level await and exposes `cua`, `nodeRepl` and `sleight`. Timers and console output belong to the current cell.
Node's REPL semantics apply, including its treatment of declarations in a cell with top-level await.
The context contains ECMAScript intrinsics and six added globals: `cua`, `nodeRepl`, `sleight`, `console`,
`setTimeout` and `clearTimeout`. REPL builtin-module getters and Node globals are removed. A worker module-resolution
hook refuses later imports, including `import()` from the REPL and an escaped host Function.

The parent creates the worker with the restricted `win32Environment()`, `--permission`, one `--allow-fs-read` grant
for `lib/repl/`, and hidden console windows. Writes, network, children, worker threads and addons are denied.
The worker does not inherit loader variables or account credentials. It sends driver requests to its parent over Node IPC.
The parent checks the current cell and method, then calls its admission callback before forwarding to the driver client.
The worker never receives that callback or its approval state.

Constructor and prototype walks can still reach the host `process`, including through a driver error.
The permission checks restrict that process's supported resource APIs. Node explicitly disclaims security guarantees
against malicious code. The VM and permissions must not be presented as a security sandbox.
The [permission documentation](https://nodejs.org/api/permissions.html) describes that limit.

`--permission` is stable since Node 22.13 and 23.5. Network denial arrived in Node 25.0, so this worker refuses runtimes
without `--allow-net` support before forking. It also checks its permissions before accepting cells.
See the [network permission flag](https://nodejs.org/api/cli.html#--allow-net).
The Windows launcher still discovers Node 24 or later in the account's Program Files known folders, then absolute PATH
entries, rejecting reparse points and project ancestors. It doesn't search OpenAI app bundles. The worker inherits that exact
executable through `fork()`. A selected Node 24 can run the launcher but the JavaScript worker refuses it.
The launcher does not search again for a newer Node after that refusal.

Production routes native requests through the parent-side `createWindowsSafety()` dispatcher. Before the first tree
or capture, it checks the target, obtains session approval and reserves an executable-wide lease, including popups.
The approval prompt shows a cleaned executable name and folder. Memory uses the full app identity. Windows has no
Always allow choice. Reads and actions recheck identity and renew the lease. Inventory hides unapproved titles and paths.
Terminals and OpenAI apps refuse unless the user set `SLEIGHT_ALLOW_FORBIDDEN_TARGETS=1`. Their settings still refuse.
Claude, Cursor, Copilot and VS Code receive a warning. Own-host, other-session and unresolved frame-host windows refuse.
Elevated targets refuse too. The [driver contract](windows-driver.md) describes identity and refusal details.

Before each action, the parent reads a fresh tree and applies payment, flow and document-scope admission. Only the
parent's driver observations supply guard inputs and authoritative results. Worker display text cannot replace them.
A missing action policy or a client admission callback that returns false refuses with `WINDOWS_SAFETY_UNAVAILABLE`.
Tests inject admission and the fake driver explicitly. This wiring still needs Windows qualification before release.

## Cells and results

One cell runs at a time. Concurrent cells return `REPL_BUSY`. Code is limited to 1 MiB.
`timeout_ms` accepts integers from 1 to 120,000; the default is 30,000 ms.
The parent enforces the deadline even when JavaScript spins or awaits a promise that never settles.
It stops its worker, restarts the driver and waits for the old worker to close before another cell starts.
After two seconds without close it sends SIGKILL through its owned child handle, then waits for close.
It never retries the expired code. The next call cannot use earlier bindings or app handles.
`js_reset` follows the same cleanup path and may interrupt a pending cell.

`nodeRepl.write(value)` collects a text item. Objects become JSON. Other values use their string representation.
`nodeRepl.emitImage()` accepts a base64 data URL or an object with `data` or `bytes` and `mimeType`.
Images use PNG, JPEG or WebP. Result collection stops at 8 MiB or 1,024 items and preserves earlier items on an error.
The last expression is displayed unless it is undefined, a handle, or a value already emitted by that cell.
Thrown errors become error results. A normal error leaves the session and its earlier bindings intact.
Cell timers are cleared after completion. Timeout ids are numbers, without a host timer's `refresh()` method.
Intervals, immediates and microtask scheduling have no context globals. Async hooks collect Timeout and Immediate
resources created during a cell, including timers obtained through a constructor escape, and cancel them when it ends.
AsyncLocalStorage binds driver requests and output to their originating cell. A delayed promise continuation from an
old cell cannot use a later cell's admission or write to its result. Reset closes the worker and clears all its state.
`console.info`, `warn`, `debug` and `error` use the log writer. `dir` and `table` inspect their argument.

The first JavaScript result includes sleight's Windows API text beginning with `## Computer Use`.
The existing relay path delivers it, including on a failed acquisition. Reset and timeout cause the next worker to
deliver it again. `cua.rewriteDocumentation()` returns it explicitly. Windows result budgeting retains Windows paragraphs.
The prompt budget inventories Windows docs, descriptions and the safety refusal separately, with 0 added Mac characters.

## App handles

`cua.getApp()` accepts a name, executable path, AUMID, exact title or `{ windowId: "101" }`.
It emits the acquired tree and returns a handle. The handle binds the decimal HWND and process creation string.
Later reads include both. Action requests also include the latest read id and their arguments.
`cua.getState()` returns apps and windows. `cua.listApps()` returns the app array.
Reads accept `{ emit: false }` so the relay's injected guard can inspect without duplicating output.
`getAXStateAndScreenshot()` returns `{ state, screenshot }` when the driver supports it.
App reads preserve the driver's Mac-compatible `Window:` header and numbered tree text.

The Windows `replay` command accepts the existing replay file and options. It starts an absolute Node executable
and the Windows launcher module, then uses the ordinary relay. Its child lifecycle uses Windows process ownership,
without POSIX process groups. A four-step Notepad and Calculator fixture tests this dispatch with a fake driver.

## Windows validation still required

Compile the driver with in-box C# 5 and run its headless selftests. The synthetic provider suite expects 777 checks,
including unsupported enabled flags and 20 refused-selector cases. Check that a guessed refused window title returns
the same `WINDOW_NOT_FOUND` code as a missing title.

Run the REPL tests under the installed Windows Node version with network permissions, Node 25 or later.
Confirm Node 24 refuses native JavaScript, and check the permission flag's Windows path spelling, including spaces and
non-ASCII characters. Mac tests on Node 26.12.1 prove IPC, constructor-escape refusals and timer cleanup with a fake driver.
Acquire Notepad through the real MCP relay and verify session approval, its tree, identity and executable-wide lease.
Check that declined approval, forbidden targets and missing action policy refuse before content or input dispatch.
Check worker and driver exit after reset, timeout, EOF and parent interruption. Check non-ASCII paths and text.
Measure cold startup and warm requests. App approvals, real UIA behavior, captures, actions and focus preservation
remain unverified until a Windows session runs them.
