# sleight on Windows

The Windows branch is a preview with 0 live Windows driver runs. Its JavaScript worker and fake-driver tests run on
macOS. Native compilation, app behavior and speed still need a Windows sitting. There is no Windows speed claim. The
parent guard adds one driver read before each action, and its cost gets measured in the Windows VM before any claim.
The [driver contract](design/windows-driver.md) describes the implemented paths and remaining checks.

On Windows, sleight uses its own UI Automation driver. It does not need the ChatGPT Mac engine.
The relay checks session approval, forbidden targets, window identity and input leases before native access.
Browser turbo also refuses because Windows peer verification and trusted consent are not connected.
Native admission is wired but unverified on Windows. Browser control remains unavailable.

## Install the preview

Use a reviewed `claude/win` checkout on Windows 11 as a standard user. The first planned qualification is ARM64.
x64 compilation and app driving remain unverified. Keep the checkout on a local drive.

Install Node 25 or later for Windows in Program Files, outside a project folder. The JavaScript worker requires
Node's permission model with network access denied. The launcher's older Node 24 discovery check and doctor can
accept a runtime that the worker refuses with `REPL_NODE_UNSUPPORTED`. Use Node 25 or later even if doctor passes.
The in-box .NET Framework C# compiler builds native helpers on first use. No .NET SDK install is required by this path.
Helpers and settings use the account's local AppData `sleight` folder with ACL checks.

From the checkout in PowerShell, run these commands separately:

```powershell
node --version
.\plugins\sleight\bin\sleight-mcp.cmd --doctor
.\plugins\sleight\bin\sleight-mcp.cmd register
claude --plugin-dir .\plugins\sleight
```

`register` checks the selected Node executable and rewrites this copy's MCP entry to its absolute Windows paths.
It needs the user's presence and confirmation. Stop if either check refuses. Start a new Claude Code session after
registration. Plugin updates replace that manifest edit, so registration is specific to this copy.
The Windows launcher uses `C:\Windows`. Installations with a different system root currently refuse.
The macOS `setup` flow does not install the Windows driver.

An MCP connection and a successful doctor result do not prove native admission or browser control works.
The Claude Code mod, remote approvals, Defender behavior and SmartScreen behavior still need Windows checks.
The [VM runbook](../bench/windows/vm-runbook.md) covers evidence collection. Its earlier Node 24 instruction
predates the worker's Node 25 requirement.

## Read and act

The first `js` result includes the Windows API and its own `drive-windows-apps` skill. The Windows launcher reads
that skill from `lib/windows-repl/skills/`, outside the plugin's host-discovered Mac `skills/` folder.
The API keeps the `cua` names:

```javascript
let app = await cua.getApp("Notepad");
```

Acquisition reads a running window. `cua.getState()` lists apps and windows. Names, executable paths, AUMIDs and exact
window titles can select an app. Matches across different processes refuse with `AMBIGUOUS_APP`.
Several matching windows of one process select the first non-popup window, or the first match if all are popups.
Use `cua.getApp({ windowId: "101" })` to select an exact HWND from inventory.
No acquisition launches an app or raises its window.

UI Automation supplies numbered elements, AutomationIds and labels. Input first tries the control's patterns,
such as Invoke, Value, Toggle and SelectionItem. Posted window messages cover some remaining input.
`setValue` replaces a field without a shortcut. A modifier chord without a matching accelerator can refuse as
`CHORD_NEEDS_FOREGROUND`. Limited nonprinting chords can act as a bare key. Check the returned limits.
An action returns a tree with `confirmation: "unconfirmed"`. Inspect the intended result before repeating input.
If an error reports possible input delivery, read again first. A quiet UI is not a success receipt.

Screenshots try `PrintWindow`, then `Windows.Graphics.Capture`, then `BitBlt` from the target window's client DC.
The `BitBlt` route is allowed only when no window covers the target. WGC may show a capture border; its behavior
still needs Windows measurements. The result's `capture.method` names the route used.
Coordinates are physical client pixels, multiplier 1, including at mixed DPI. If every route fails or renders black,
the result is a note without an image. Minimized classic windows, cloaked windows and windows on another virtual
desktop also return a note without an image.
Minimized packaged windows refuse.
An all-black note can also describe black app content. The combined tree and screenshot are sequential
observations. Covered captures, mixed DPI and negative monitor origins still need Windows measurements.

Paste sends the supplied text to a focused, writable native Edit or RichEdit control without accessing the system
clipboard. Other controls, C0 characters (including tabs and newlines) and DEL refuse before input. Paste and typeText
accept at most 4,000 UTF-16 units per call. If delivery is uncertain, inspect the target before retrying.

## Background rule and refusals

The driver has no foreground fallback. It does not raise or restore windows, switch virtual desktops, move the real
pointer or use system input. A step that needs those mechanisms stops. A dialog opened by an app may flash its
taskbar button or change foreground focus. Successful actions report `foregroundChanged` from before/after HWND
samples and `foregroundExecutable`, a validated basename. The name is `null` when fresh inventory cannot identify
a permitted foreground app, including refused and forbidden apps.
These samples cannot detect a focus change that reverses before the final sample.

The relay requires session approval before the first tree or capture. There is no Windows Always allow choice.
Approval memory lasts for the Claude Code session, including turn ends and REPL resets. Its key includes the app id,
executable path, file creation time and file size, so a replacement with different metadata needs a new card.
Preserving both creation time and size is outside this metadata check. The prompt displays a cleaned executable name and folder. Input leases
reserve the executable across sessions, including its popups. Reads and actions recheck process and window identity.
Actions take a fresh parent-side tree and apply payment, flow and document-scope checks before native input.
A missing action policy refuses with `WINDOWS_SAFETY_UNAVAILABLE`.

Terminals, ChatGPT, Codex and Atlas refuse unless the user set `SLEIGHT_ALLOW_FORBIDDEN_TARGETS=1`, which takes effect at
the next launch.
Their settings windows remain refused. Claude, Cursor, Copilot and VS Code receive a warning because they can show
approval cards. sleight's own host windows, other-session windows and unresolved packaged-app frame hosts refuse.
Password values are redacted. Stop on declined approval, lease refusal or a safety check.
Never edit approval files or refusal switches to get past a stop.

The driver's HWND selector refuses apps above its own integrity level or at High or above with `ELEVATED_TARGET`.
High targets stay refused when the driver runs elevated. The same ceiling applies to selection by name.
Access denial while reading a target token after opening its process also returns `ELEVATED_TARGET`.
That denial can also mean a protected process whose integrity could not be read.
Forbidden app and private-title guesses stay `WINDOW_NOT_FOUND`.
Ask the user to reopen the app without administrator rights. UAC and sign-in secure desktops are outside this driver.
sleight has no `uiAccess` privilege, even when run as administrator. App approval does not lift these limits.

## Known gaps

| Target or operation | Limit |
| --- | --- |
| GTK apps, including some GIMP and Inkscape versions | A useful Windows accessibility tree is not established. Missing controls are unsupported, even when the window renders a screenshot. |
| LibreOffice | The planned path is best effort through the Windows MSAA proxy. Tree completeness, provider timeouts and Value support are unmeasured. Accelerators can need foreground input. |
| Games and canvas UIs | Raw input, DirectX and missing controls are outside the background input path. A screenshot may be black. Game control is unqualified. |
| WPF and OLE drags | Posted drags do not support OLE drag and drop. Detected WPF, Explorer and Office drags refuse. Other posted drags report the OLE limit, even if a message was delivered. |
| Minimized UWP apps | Minimized packaged windows refuse. Only the user can restore them. Covered and minimized are different states. |
| IME composition | Text insertion sends characters and bypasses composition. Apps that require an IME composition session are unsupported. Non-US layouts still need measurements. |
| Chromium and Electron | Detected Chromium windows refuse posted input. Available UIA patterns remain the native route. Browser turbo is unavailable in this build. sleight refuses foreground input. |
| `uiAccess` | sleight lacks this privilege. Targets above the driver's integrity level or at High or above stay refused. Other software with this privilege can weaken injected-input provenance checks on consent controls. Windows validation is pending. |
| Windows Graphics Capture (WGC) | Capture tries `PrintWindow`, `Windows.Graphics.Capture`, then `BitBlt` from the client DC only when no window covers the target. The WGC route may show a capture border. Border behavior is unmeasured. |
| Taskbar flash | A background dialog can flash the app's taskbar button or change foreground focus. Before/after HWND samples report the final change, without attributing its cause. |
| Renamed unpackaged terminals | A renamed terminal without an AUMID, recognized window class or PE version names can pass the forbidden-name check. The terminal refusal does not cover that case. |
| UIA providers in another process | The driver omits foreign-process subtrees before reading labels or values. Legitimate WebView2 or IDE terminal content may be missing. Real providers still need VM checks. |
| Safety-check cost | Each action adds an identity verification and a full UIA read. Inventory reads PE version information per window. The added latency is unmeasured. |
| AUMID-only flow rules | Windows source matching uses the executable name in the read header, and destination `appId` uses the image path. Rules that name only an AUMID remain unconfirmed. |

Hover is unavailable. Locked-session behavior, toolkit text delivery and screenshot exclusion of the cursor overlay
remain unverified. Use only the installed Windows API and stop when a method refuses.
