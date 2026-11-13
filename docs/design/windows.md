# Windows research

2026-10-09. Code inspected at `6e21846` on `origin/pane/auto-mode`.
This research used public documentation and source inspection. Windows behavior remains untested.

## Windows plugin registration and settings

2026-10-26, built from `136b55d5`. Offline tests inject Windows paths and services. No Windows VM has run this code.

### Registration evidence

Claude Code documents inline plugin MCP maps, substitution of `CLAUDE_PLUGIN_ROOT` in command and argument fields,
and separate argument arrays. It does not document a per-platform command map or promise that extensionless commands
resolve through PATHEXT or cross-spawn. The Windows entry uses an absolute executable path.
See the [plugin manifest reference](https://code.claude.com/docs/en/plugins-reference#mcpservers) and
[stdio MCP reference](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server), read 2026-10-26.

`sleight-mcp.cmd register` is a gated diagnostic. Before any manifest read or write, it checks the terminal and a session
age of 10 seconds, then presence and Windows Hello or the account password with the generic `settings` confirmation key.
It separately validates the running Node location using the launcher's discovery script with a fixed system PATH.
Registration accepts Node in Program Files only, including the x86 known folder. A refusal leaves the manifest alone.
A pass replaces only this copy's `computer` MCP entry with absolute Node and `lib\launch.mjs` paths. The repository manifest
keeps its macOS command. An installed update replaces the edit; a checkout loads in place, so registration there edits source.
The [loading reference](https://code.claude.com/docs/en/plugins/loading), read 2026-10-26, documents these install locations.

Node discovery tries Windows' Program Files known folders before absolute PATH entries. It accepts only a regular `node.exe`
whose entire ancestor chain has no reparse points. nvm-windows links, fnm junctions and Scoop links refuse with a reason.
Every ancestor directory containing `.git` rejects the candidate. An ancestor containing `package.json` also rejects it,
except the token account's profile directory itself, where a stray package file does not mark every per-user Node as project-local.
Markers outside the candidate's ancestor chain have no effect. Neither the current directory nor `CLAUDE_PROJECT_DIR`
selects a project boundary. Versions below 24 are skipped, allowing a newer PATH candidate after an older Program Files install.
Loader variables NODE_OPTIONS and NODE_PATH are cleared. The caller's remaining Node environment is inherited.
Quoting, Unicode, stdin forwarding, exit codes and actual installer layouts need Windows checks. The fixed bootstrap supports `C:\Windows`.

### Separate Windows manifest fallback

If the VM shows that the extensionless command fails, package the same payload with a separate Windows manifest and marketplace
entry. The macOS distribution keeps its existing manifest. The second package remains a design. Prefer
`"command":"${CLAUDE_PLUGIN_ROOT}/bin/sleight-mcp.cmd"` if Claude Code launches that directly. If it requires CMD, use the fixed
absolute `C:\Windows\System32\cmd.exe`, arguments `/d`, `/c`, and one quoted command string around the plugin's `.cmd` path.
The package contains its own launcher and hooks with relative paths inside its root. It never rewrites an installed manifest,
and each update includes the Windows command. The VM result selects the command form before packaging.

`bench/windows/run-checks.mjs --probe-launchers --output <new-report.json>` records three stdio-spawn forms:
CMD `/d /s /c` resolving the documented extensionless path through PATHEXT, CMD `/d /s /c` with explicit `.cmd`,
and absolute `cmd.exe /d /c` with the quoted `.cmd`. All use `--doctor` and draw nothing. Quoted command lines use
`windowsVerbatimArguments` so Node preserves CMD quoting. These probes model shell-mediated loading; repeat the forms
in Claude Code's plugin loader and record its version,
startup result, `/plugin` errors and MCP listing. The CMD probes cannot establish how Claude Code handles PATHEXT.
The manifest reference puts plugin `bin/` on Bash's PATH. Check Git Bash's bare `sleight-mcp` resolution in the VM;
the shell script now refuses MINGW, MSYS and CYGWIN with a pointer to the `.cmd` launcher.

Command hooks use Git Bash on Windows, or PowerShell when Git Bash is absent. Hooks with `args` use direct execution;
Windows requires a real executable there. Sleight's `hooks/hooks.json` contains a module entry and no shell command,
so that shell choice does not parse `register.tsx`. See the
[hooks execution contract](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form), read 2026-10-26.

The documentation for mods describes modules in `hooks/hooks.json`, with mods enabled in terminal Claude Code from 2.1.288.
It does not guarantee Windows support separately. The module path and `register` export match that contract.
Loading this TSX module on Windows, its pane and its turn hooks remain unverified. Check the active-mod listing
in `/plugin` in the VM. See [mods overview](https://code.claude.com/docs/en/plugins/mods/overview), read 2026-10-26.

### Settings and remaining limits

`windows-settings.mjs` handles hand, cursor style, turbo preferences and permissions. There are no `stream` or
`cursor stream` commands on either platform. The user edits `hand.json` as described in the cursor protocol.
Only reads bypass the terminal gate. Exact removal forms retain TTY and agent-marker checks and run the ancestor walk
with `freshMs:0`, preparing the helper when needed. If the in-box compiler is missing, these five exact forms fall back to
TTY and agent-marker checks alone and print one stderr notice. ACL, package-integrity and unknown preparation failures
still refuse. A completed refusing walk still refuses. They skip presence queries and confirmation.
Other appearance changes use the person walk with no session-age delay.
High-stakes forms keep the shared classification and authentication.

`platform/win32-files.mjs` supplies settings transactions and native file operations. A SHA-256 pin binds the exact
PowerShell helper bytes before both one-shot and persistent execution. Requests use UTF-8 on stdin. The helper checks owner
SID, protected DACL, reparse points and hardlinks. Settings files grant access only to the token user and SYSTEM,
matching the native strict-file rule. The shared `%LOCALAPPDATA%\sleight` directory also accepts Administrators,
matching host-cache creation. Both creators use those three principals on that folder. Settings reads and writes accept
a host-created folder, so `hand on` can recover its unsafe user-owned hand file.
Transactions hold ancestor handles, create private temporary files and
replace atomically, with native readback. A store read needs one native operation, and a write includes its own native readback.
The MCP hand reader keeps one asynchronous PowerShell worker, compiling Add-Type once per session. It refreshes at most every
250 ms on an unreferenced timer after startup, rechecking native handles on every read. Events do not drive refreshes.
It accepts a completed snapshot for at most 1,000 ms after the last good reply, then treats it as unsafe. The worker has a 20-second startup budget and a 4-second request deadline; a worker failure
leaves it off until the session restarts. No Windows ACL verdict is cached using Node stat evidence. The pinned source is gzip-compressed inside the encoded
bootstrap, with a 22,000-character guard to leave room under the Windows command-line limit.
`platform/win32-files.ps1` and `windows-node.ps1` read and write UTF-8 byte streams without setting console encodings.
The registry and process scripts in `direct-browser/windows-platform.mjs` and the cursor worker
`hand/windows-security.ps1` also write UTF-8 through `OpenStandardOutput`, without changing the console code page.
These paths still need Windows checks with and without a console.
An injected runner test observes 1 spawn for 11 reads. Measure cold startup in the VM, then record 100 warm reads and
their spawn count. Check event-loop delay and propagation
when the hand turns off, with additional cases for a stalled worker and a DACL-only change. Create the shared folder with
the host builder first, then run `hand on`, read status and turn it off. Repeat with settings creating the folder first,
then the host builder. Record owner and ACEs in both orders. Verify a settings leaf with an Administrators ACE still
refuses until `hand on` replaces it. Check closing idle after a 2-second event gap.

`hand on` and `hand off` replace unsafe user-owned regular files after the gate, resetting untrusted contents. Status names the
unsafe state and file path. Partial edits refuse. `permissions repair` repairs its file's DACL before preserving valid JSON.
`--discard` replaces invalid contents after the same confirmation. Both paths require the current user as owner and refuse reparse points and hardlinks. Unsafe parent directories still refuse. ACL enforcement and filesystem races need Windows qualification.

The stream is off by default. The launcher reads `hand.json.stream` independently of drawing, while `SLEIGHT_HAND=0` suppresses
both outputs. The `ring` and `seam` styles are wired; character commands, glove drawing, Electron opt-ins and recipe storage refuse.
The MCP endpoint advertises 5 browser tools but refuses actions until peer verification and trusted consent exist. Turbo on
records a preference only. Native app driving is unavailable. This code uses Node and in-box Windows components.

VM checks also cover non-ASCII profile names such as `Menéndez 日本`, malformed JSON, unsafe default ACL recovery,
foreign-owner and hardlink refusal, worker EOF cleanup, the real person gate, both hook-shell configurations, Node versions
and spaces, then ring geometry and capture exclusion in a later interactive session.

## Person gate (WIN5, 2026-10-26)

The Windows gate uses a csc-built helper for process and console observations, presence and settings confirmation.
With 0 Windows runs, its behavior remains unverified. The ancestor walk accepts a System32 `svchost.exe` boundary only directly above a
path-verified Windows Terminal, in session 0 with births ordered. If that row's token cannot be queried, those
observations replace its SID check. Outside that exception, a failed token query refuses the snapshot.
The VM must check this with a standard user and an unelevated administrator.

An agent can open a fresh `wt` or use `wt -w 0 nt`; both pass the walk after 10 seconds when the expected process and
console observations are available. Windows Hello or the account password is the only control for high-stakes forms
against that route. Forms that only take access away or change looks have no age wait and generally use the walk alone.
On Windows, `hand off`, `turbo off`, `turbo app off`, `permissions block` and `permissions revoke` run the walk with
`freshMs:0`, matching macOS. They require a TTY without agent markers and prepare the helper when needed.
If the in-box compiler is missing, these exact removal forms use TTY and agent-marker checks alone and print one stderr notice.
ACL, package-integrity and unknown preparation failures still refuse.
An available helper whose walk refuses or fails does not use that fallback.

Presence means an active, unlocked session with `GetLastInputInfo` idle time below 120 seconds. Synthetic input counts
toward that time. The password fallback unpacks protected credentials into unmanaged buffers and makes one
`LOGON32_LOGON_INTERACTIVE` attempt. It compares the resulting SID with the launcher and helper. The buffers are wiped
before freeing them. Cached account verification can accept a stale cached password while offline. Windows qualification must check
local, Microsoft and domain accounts, secure-desktop behavior, presence while typing there, prompt cancellation and
whether killing the helper at 60 seconds removes the dialog.

The account-based helper cache is `%LOCALAPPDATA%/sleight/turbo-host`, resolved by the native known-folder API.
Claude's file and shell guard refuses common forms that name the folder. Windows shell text with sleight or local app-data
name hints, environment parent traversal, hinted wildcard words or cmd variable substitutions passes only as one literal reader.
A wildcard needs a path hint in the same word. Hints include `~`, `$HOME`, `$PROFILE`,
and Git Bash drive paths under `/c/Users`, `/mnt/c/Users` and `/cygdrive/c/Users`. A `./` or `../` word counts only when
it has a wildcard before the final segment, or its final segment is a 1 to 4 character prefix followed by `*` or `?`.
`./src/*.ts` and `./build/*` pass. `./src/**/*.ts` and `../sl*` refuse. `local` matches a path segment,
so `localization`, `locales` and `localhost` globs pass. Environment-variable profile lookups count too.
Hint-free relative globs such as `./turbo-h*`, `./slei*ht`, `./???` and `../../sleigh*` pass, including after a directory
change in an earlier call.
Encoded-command flags refuse beside a PowerShell or pwsh invocation, including script blocks, Start-Process argument
lists, cmd, wsl, runas, wmic, schtasks and iex wrappers, including parenthesized strings.
Unquoted shell names count at any position, except in echo, Write-Host, Write-Output, printf, git, winget, choco,
scoop, brew, which and Get-Command data. Quoted command strings are inspected in known execution arguments.
Inside parentheses or backtick substitutions, those data commands no longer hide shell names from the encoded-flag check.
The iex form combining GetString and FromBase64String also refuses. Script arguments that match encoded-command flags,
such as `pwsh -File build.ps1 -e value`, refuse. Ordinary script arguments such as `-Environment staging` pass.
The PowerShell tool applies the protected-state name rule on macOS, Linux and WSL too. Non-readers naming sleight,
Application Support or the Mac guard's protected settings filenames refuse, even outside sleight's folders.
Wildcard commands naming Library/Caches or Library/Application words also refuse, including a Set-Location before a write.
This includes other apps' Application Support files, Turborepo's `turbo.json`, Homebrew and pip cache globs,
and `Get-ChildItem ~/Library/Caches/*`.
On the recovered Mac PowerShell corpus, refusals rose from 7 of 27 to 8 of 27 (29.63 percent);
the held-out set stayed at 1 of 366 (0.27 percent), and the hint-adjacent set at 0 of 52.
The Mac Bash guard is unchanged on 39 original and 182 additional commands on both darwin and Linux, 442 decisions total.
An en-dash or em-dash host flag still needs a Windows VM parsing check.
Bare `turbo`, roaming `$env:APPDATA`, `node -e`, git formats and ordinary globs pass without another hint.
The tuning corpus stays at 0 refusals of 214. Relative-glob narrowing reduces held-out refusals from 3 of 366
(0.82 percent) to 2 (0.55 percent). The reviewer's original 364-command subset also has 2 refusals.
Hint-adjacent refusals fall from 15 of 52 to 13 (25 percent). The recovered 46-command mixed developer set falls from
10 refusals to 3 on Windows, through both Bash and PowerShell. Its 19 Windows-specific commands fall from 9 refusals to 2.
These corpora probe the rule and do not measure real-session refusal rates.
Remaining false positives include wildcards under `$env:` or `%VAR%`, `ls ~\*.txt`, cmd `%X:a=b%` and `%DATE:~-4%`,
`appdata` in a commit message, sleight checkout paths, local-app-data configuration, environment traversal and legitimate encoded calls.
Of 100 attack and control probes, 92 still refuse, including all 23 home and drive wildcard attacks.
Encoded-wrapper refusals stay at 31 of 35. The 4 passing controls use Unicode dashes (3) or `pwsh-preview` (1).
Of 111 additional wrapper probes, refusals rise from 92 to 98, with 6 newly refused and 0 newly passing.
Of 60 additional wildcard spellings, 39 still refuse.
The hook cannot see script-file contents, commands supplied through a pipe, or a script written by a file tool and then run.
Building folder names from pieces or finding them by listing passes without encoding. The guard also misses aliases
created in an earlier call (`subst`, `New-PSDrive`, `mklink /J` or a junction) and relative paths after a call that changed
into a parent without a hint, because it doesn't track aliases or shell cwd.
All 55 full-intent name-building probes still pass, compared with 44 before narrowing. All 53 retained hint-word probes
still refuse, along with 2 decoded-expression probes. Unrecognized shell executable names, Unicode host flags and opaque
payloads outside the decoded-expression check remain gaps. These are text-only measurements with an identity stat mock;
Windows parsing, canonical filesystem aliases and mod loading still need the VM.
Windows Hello or the account password, plus the helper hash, remain the real controls.
Same-user programs outside the hook can replace the helper. The private copy is hashed again before snapshot, presence and confirmation
runs, but a same-user replacement race remains. No password is passed through Node, command arguments or a managed C# string.

The default build uses declared WinRT interfaces. The metadata variant references the two System32 WinMetadata files,
`System.Runtime.WindowsRuntime.dll` and `Facades\System.Runtime.dll` when that facade exists. Only the metadata
variant adds `winrt` to the build key. A Windows VM must compile and run both variants, including a framework without
the optional facade. The Mac tests check argument vectors only. This work uses the in-box framework and adds 0 dependencies.

## Turbo groundwork (WIN4, 2026-10-26)

The owner unparked Windows on 2026-10-26. WIN4 adds read-only adapters for phase 2. It does not enable a
Windows connection. Chrome, Edge and Brave remain unqualified. No Windows commands or browser sessions ran
on this Mac; the adapter tests inject the platform, filesystem and command runner.

`lib/direct-browser/windows-platform.mjs` exports `createWindowsTurboDiscovery`. It returns nothing unless
the platform is `win32`. The future Windows launcher can call `browsers()`, `processes(browser)` and
`activePort(browser, processObservation)`. None writes settings, starts a browser or accepts consent.

| macOS assumption | Windows source or remaining gate |
| --- | --- |
| `/Applications/<browser>.app/Contents/MacOS/...` in `browsers.mjs` and `turbo-setup.mjs` | Try standard installs under LOCALAPPDATA, ProgramW6432, ProgramFiles, ProgramFiles(x86) and ProgramFiles(Arm) first. Then use App Paths values for `chrome.exe`, `msedge.exe` and `brave.exe` in HKCU and HKLM, in both registry views. Each candidate has `path` and `source: standard` or `registry`. Registry hints outside those roots have `location: unverified-location` and rank last. Publisher proof remains required before any launch. |
| `~/Library/Application Support/<browser>` | Under LOCALAPPDATA: `Google\Chrome\User Data`, `Microsoft\Edge\User Data`, `BraveSoftware\Brave-Browser\User Data`. USERPROFILE plus `AppData\Local` is the fallback. Each root contains `Default` and `Profile N` subfolders. A process's `--user-data-dir` switch supplies its custom root. UserDataDir policy roots still need separate selection and proof. |
| `SingletonLock` hostname/PID symlink in `selected-connection.mjs` | Windows has no equivalent symlink to trust. CIM returns main-process candidates by exact executable path, owner SID, session and creation time. Multiple candidates remain ambiguous. Each candidate still needs proof of its profile root. |
| POSIX owner, mode, inode and `O_NOFOLLOW` checks for `DevToolsActivePort` | Read at most 512 bytes through one descriptor, compare bigint file IDs and nanosecond timestamps before and after, require a timestamp after process creation, and use the existing CRLF-capable parser. The result is explicitly unauthenticated. Native owner/DACL, reparse-point and handle checks remain required. |
| `lsof`, libproc, `csops`, Apple team IDs and `codesign` | Before any socket opens, prove loopback listener ownership with GetExtendedTcpTable, process birth with GetProcessTimes, and the expected publisher with WinVerifyTrust. Recheck the same incarnation after connecting and before commands. This lane supplies no substitute for that gate. |
| Swift consent, connected indicator, Pause, Disconnect and payment cards in `host.mjs` | A Windows host needs trusted controls and hardware-input consent. Opening an inspect page or finding an endpoint grants nothing. Never relaunch the user's browser with debugging flags or change enterprise policies automatically. |
| `hand/browser-hand.mjs`, `app-health.js` and `hand/locate.js` use Mac window metadata | Read owned-target bounds over CDP as described below. Native exposure and monitor evidence still gate drawing. Hand settings, helper compilation and Library log/cache paths also need the Windows launcher/host work. |
| Unix ownership and sockets in `installed-config.mjs`, `session-host.mjs` and the cursor client | Windows DACLs and named pipes need their own checks. Do not route Windows through the current POSIX receipt, helper-cache or config writer. |

Windows includes PowerShell 5.1 and Get-CimInstance. The fixed query reads Win32_Process for the three browser
image names. It skips other sessions and `--type=` children before calling GetOwnerSid. A same-session main
process with an unreadable owner fails the query. Other owners are excluded, and creation times use UTC epoch
milliseconds. Command lines are parsed inside the adapter for `--user-data-dir` and never returned to its caller.
Duplicate, relative or malformed profile switches refuse the observation. `tasklist /FO CSV` lacks full executable
paths and creation times, so it cannot distinguish an image-name collision or PID reuse. An incomplete observation
for this user also fails the query. There is no elevation attempt. See Microsoft's [App Paths](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration)
and [Win32_Process](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process) contracts.

Both fixed scripts use UTF-16LE `-EncodedCommand`. The child environment contains only matching SystemRoot and
windir, plus valid TEMP and TMP paths when present, and still needs publisher proof for the executable.
Failed, timed-out or malformed registry queries return standard candidates with `registry: unavailable`.
This keeps discovery hints available under Constrained Language Mode without starting separate reg.exe queries
for each browser, hive and view. Process query failure still refuses observations.

Pass the full process observation to `activePort`, which reads that observation's profile root and tags the hint
with its PID, start time, application and root. A default-root file can belong to another browser incarnation.
The caller must prove the same PID and creation time that supplied the hint, plus the selected profile.
`mapWindowsDiscovery({selected, processes, hint})` maps matching observations to `discoverSelected` inputs:
`selected.root`, `canonicalRoot`, process `alive`/`root`, and file `path`/`canonicalPath`/`text`/`mtime`.
It supplies `platform: win32` for Windows path handling, but no setting, capability or peer evidence. Here `alive`
means observed in the query. Refresh the query before use. A hint alone yields `disconnected` even with the
setting and capability enabled. Native process, profile and peer checks still gate a connection.

### Cursor geometry

On Windows, the CDP filter has a private `windowBounds(targetId)` capability for an owned top-level page.
It checks ownership before and after `Browser.getWindowForTarget`. The public CDP socket continues to refuse
that method, `Browser.getWindowBounds` and `Browser.setWindowBounds`. The adapter validates the numeric
rectangle and window state, preserves negative screen origins, and labels its units `cdp-bounds`.
Missing window state is `unknown`. Renderers must skip unknown and minimized states.

CDP [Browser.Bounds](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#type-Bounds) describes screen
pixels. Whether Windows returns DIPs or physical pixels remains open for the DPI matrix below. A minimized
window returns restored bounds. CDP supplies no HWND, owning PID, z-order, virtual desktop
membership or monitor DPI. Its outer rectangle also does not identify the viewport origin below tabs, side
panels and borders. Bounds don't prove which tab is in front: an owned background tab can share its window with unowned
tabs. Bounds alone cannot satisfy the hand's exposure checks or the cursor protocol's units.

Before drawing, bind the CDP target to one HWND/PID, check DWM frame bounds, cover and current desktop, and
derive a per-monitor DPI transform for both the window origin and viewport offsets. Validate that transform
at 100%, 125%, 150% and 200%, browser zoom, mixed-DPI monitors and negative origins. Never multiply a global
origin by devicePixelRatio or treat a CDP window ID as an HWND. Pending that evidence, Windows cursor events
must omit points or report `skipped:no-geometry`, while the Mac hand planner continues using native geometry.

### Security and consent

CIM filtering excludes other users and sessions from returned candidates, but it is no socket authentication.
A local debugging port can be reached by another local process even when it binds only to loopback. The native
peer gate must reject foreign, wildcard and ambiguous listeners. It must also prove the selected profile;
registry paths, file timestamps and Browser.getVersion cannot do that.

Keep `cdp-filter.mjs`'s protected-port interception at browser, page and child routes, including a popup's
first request. Guard the port across host spellings, redirects and WebSocket URLs. The private bridge stays
on 127.0.0.1 with a random path, one client and Origin rejection. It does not isolate hostile local processes
that obtain that path, or protect the browser port from unrelated local clients.

Chrome's inspect consent must be checked on Windows. Edge and Brave need separate consent and live
qualification. Edge's [RemoteDebuggingAllowed](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/remotedebuggingallowed)
policy can prohibit debugging. An absent DevToolsActivePort is not proof that the browser is absent. Report
policy or capability failures and leave them unchanged. Edge's inspect UI and consent parity remain unverified.

Enablement requires Windows evidence for the native peer/DACL checks and consent/revocation controls.
Qualification also covers the protected-port fence, covered/minimized behavior, cursor DPI placement and
owned-tab cleanup. These adapters use only Node and Windows components.

Recommend one bounded compatibility spike, subject to the owner's decision. A full port should wait
until the installed Windows engine answers through the interface sleight needs. Windows computer
use exists, and the desktop app has an ARM64 package, but public documentation does not establish
that the engine runs on ARM64 or exports the same JavaScript contract.

## What OpenAI documents

| Question | Finding | Public source and date read |
|---|---|---|
| Does Windows computer use exist? | The 2026-05-29 release, 26.527, added desktop app control through screenshots, clicks and typing in the foreground. | [ChatGPT and Codex changelog](https://learn.chatgpt.com/docs/changelog#may-2026), read 2026-10-09 |
| Which product contains it? | Computer Use is a plugin in the ChatGPT desktop app, available with Work and Codex in supported regions. Setup enables its server and skill. The docs illustrate an MCP server toggle. | [Computer Use](https://learn.chatgpt.com/docs/computer-use), read 2026-10-09 |
| Is there an ARM64 app? | Yes. OpenAI provides separate x64 and Arm64 MSIX packages. That confirms app packaging. Each computer-use component's architecture and operation still need checking. | [Deploy the Windows app](https://learn.chatgpt.com/docs/enterprise/windows-deployment), read 2026-10-09 |
| Is this the older Windows chat app? | Codex joined the ChatGPT desktop app on 2026-07-09. Current Windows docs identify Store product `9PLM9XGG6VKS`. The older Help Center article lists x64 and arm64 support but points to `9NT1R1C2HH7J`. Its release notes end at January 2025. Use the current desktop documentation for the spike. | [Changelog](https://learn.chatgpt.com/docs/changelog#july-2026), [Windows desktop app](https://learn.chatgpt.com/docs/windows/windows-app), [older app article](https://help.openai.com/en/articles/9982051-using-the-chatgpt-windows-app), [older release notes](https://help.openai.com/en/articles/10003026-windows-app-release-notes), all read 2026-10-09 |
| Is `cua_repl` the same on Windows? | Unconfirmed. Searches for `cua_repl` and `cua.getApp` did not find a public API contract in the OpenAI documentation checked. The plugin's MCP toggle does not establish a launchable stdio server, its config key, method names, elicitation fields, or compatibility outside the desktop host. | [Computer Use setup](https://learn.chatgpt.com/docs/computer-use#set-up-computer-use), [Windows desktop app](https://learn.chatgpt.com/docs/windows/windows-app), both read 2026-10-09 |
| Can the public computer-use API answer that? | It documents an application supplying an environment and executing model requests, through code or structured actions. It does not document the desktop plugin's `cua_repl` interface. | [Computer use API guide](https://developers.openai.com/api/docs/guides/tools-computer-use), read 2026-10-09 |

The public pages checked leave the Windows native helper's name and architecture, ARM64 support,
accessibility backend and JavaScript methods unresolved. Guest inspection must answer those questions
before a port, including support for `getAXState`, app-scoped screenshots, `turn_ended` and reuse of
the server outside the desktop host. Calling it the Mac's Sky helper on Windows would be a guess.

Windows Computer Use uses the active desktop, moves its pointer and types into its foreground app.
The target must be visible, with the session unlocked for unattended work. OpenAI suggests a
Windows VM when the user needs their main desktop. Locked use is documented for macOS only.
[Windows foreground use](https://learn.chatgpt.com/docs/computer-use#windows-foreground-use), read
2026-10-09.

For sleight, that changes the product promise. A VM could keep Windows input inside the guest while
the owner uses macOS, but guest apps would still compete for one foreground desktop. The Mac promise
that several agents can drive different background windows would need to be withdrawn on Windows.
Keeping a VM running while its window is covered or minimized is a separate measurement; these docs
do not establish it. A Windows port would need one input lease for the whole guest desktop, plus
takeover and stop checks. The present window leases cannot prevent different apps stealing focus.

## What carries over from this checkout

The estimates below come from this checkout. Paths are relative to the repo.

| Part | Reusable work | Windows work still needed |
|---|---|---|
| Relay | JSON-RPC forwarding, request tracking, session and turn metadata, approval memory, result compaction in [relay.mjs](../../plugins/sleight/lib/relay.mjs) (`createRelay`, `turnMeta`) and [compact-reads.mjs](../../plugins/sleight/lib/compact-reads.mjs). | Verify metadata and elicitation schemas, tool names, errors, and cleanup against the actual Windows server. The relay consumes `codex/toolSurface.app.appId` and currently describes identities as bundle IDs. |
| Guards | Window and element comparisons in [document-scope.mjs](../../plugins/sleight/lib/document-scope.mjs) (`windowFromText`, `guardedCode`), flow inspection in [flow-rules.mjs](../../plugins/sleight/lib/flow-rules.mjs), and lease coordination in [input-lease.mjs](../../plugins/sleight/lib/input-lease.mjs). | Check Windows tree/header formats, app IDs, shortcuts, and Node's `node:sqlite` availability. Replace Mac storage paths and validate Windows file identity and locking. Use desktop leases for foreground input. Missing identity or an unreadable tree must stop actions. JavaScript guards remain mistake checks, not a security boundary. |
| Mod | Pane, status, stop, and turn hooks in [register.tsx](../../plugins/sleight/hooks/register.tsx), with image decoding and rendering in [snapshot.ts](../../plugins/sleight/hooks/snapshot.ts). | Verify the Windows Claude host's mod support and engine turn cleanup. Snapshot code assumes `cua.getApp` and `getScreenshot({emit:false})`. A pane refresh must preserve foreground focus. The mod approves only its own exact snapshot and turn-end calls. |
| Benchmark | Driver result parsing, timing, repetition and published failure records in [driver.mjs](../../bench/driver.mjs) and [run.mjs](../../bench/run.mjs). | Replace fixtures and verification in [tasks.mjs](../../bench/tasks.mjs): TextEdit, Mac Calculator, Chess and Xcode Simulator are Mac tasks. [preapproved-process.mjs](../../bench/preapproved-process.mjs) uses POSIX process-group signals, and [codex-arm.mjs](../../bench/codex-arm.mjs) edits a Mac approval-file location. Windows needs its own cleanup and consent code. Start with guest Calculator and a disposable Notepad document. |

The current launcher also needs a port. [bin/sleight-mcp](../../plugins/sleight/bin/sleight-mcp) is a
shell script that looks inside `/Applications/ChatGPT.app` for Node. [launch.mjs](../../plugins/sleight/lib/launch.mjs)
(`resolveServer`, `doctor`, `run`) assumes a versioned `unified-computer-use/.mcp.json` entry named
`cua_repl`, `CUA_REPL_NODE_REPL_PATH` and `SKY_CUA_SERVICE_PATH`. It invokes macOS helpers and registers
local tools by default. Finding the Windows app is insufficient to run this launcher unchanged.

The roadmap's native exclusions all need replacement or omission in an initial port:

- [drag.js](../../plugins/sleight/lib/drag.js) uses AppKit, CoreGraphics, PID events and Mac window
  geometry. Windows needs its own drag code and a way to restore the pointer.
- `menu_bar` and `notifications` share [menubar.js](../../plugins/sleight/lib/menubar.js), which reads
  System Events menu bars and macOS notification banners. Windows tray and notification controls
  would be separate work.
- [keyboard-taps.js](../../plugins/sleight/lib/keyboard-taps.js) and
  [bench/keyboard-taps.swift](../../bench/keyboard-taps.swift) query `CGGetEventTapList`.
- [watch.sh](../../scripts/watch.sh) and [watch-install.sh](../../scripts/watch-install.sh) use
  `osascript`, Library log paths and launchd. A Windows update watch needs its own scheduler.

Other Mac dependencies matter too: [hover.js](../../plugins/sleight/lib/hover.js),
[select-window.js](../../plugins/sleight/lib/select-window.js), [ask.js](../../plugins/sleight/lib/ask.js),
the health and target helpers in [read-failure.mjs](../../plugins/sleight/lib/read-failure.mjs) and
[app-health.js](../../plugins/sleight/lib/app-health.js), and AppKit clipboard IO in
[clipboard.js](../../plugins/sleight/lib/clipboard.js). [clipboard.mjs](../../plugins/sleight/lib/clipboard.mjs)
also recognizes Command-based copy shortcuts. [preapproved.mjs](../../plugins/sleight/lib/preapproved.mjs)
uses a fixed `~/Library/Application Support/sleight/preapproved.json` plus Unix ownership, mode and
no-symlink checks. A Windows design needs user-owned authority and ACL checks; silently relaxing those
checks or moving approval authority into the project would change the safety contract.

## Free UTM test path, for the owner to decide

UTM's free website build has the same features as the paid App Store version and virtualizes ARM64
guests on Apple Silicon. Use its QEMU Windows workflow. Windows GPU acceleration is absent,
so graphics and screenshot failures could be VM-specific.
[UTM](https://mac.getutm.app/), read 2026-10-09.

Microsoft supplies a Windows 11 ARM64 ISO for VM creation on supported hardware. Downloading the
installer does not grant a Windows license. UTM requires a valid Microsoft license, and Microsoft's
Mac guidance requires a separate license for each Windows 11 Pro instance. That guidance names
Parallels as an authorized solution. It does not establish Microsoft support for UTM.
[ARM64 ISO](https://www.microsoft.com/en-us/software-download/windows11arm64),
[UTM Windows guide](https://docs.getutm.app/guides/windows/),
[Microsoft Mac guidance](https://support.microsoft.com/en-us/windows/experience/platform-variants/options-for-using-windows-11-with-mac-computers-with-apple-m1-m2-and-m3-chips),
all read 2026-10-09.

The test would avoid new spending if the owner already has a license that covers this VM and suitable
ChatGPT access. Otherwise, stop for their license decision. Neither an unactivated installation nor
a preview build is assumed to be a free entitlement. No paid VM or new subscription is proposed.

Windows minimums include two CPU cores, 4 GB RAM, 64 GB storage, UEFI with Secure Boot capability and
TPM 2.0. Personal Home/Pro setup needs internet and a Microsoft account.
[Windows requirements](https://www.microsoft.com/en-us/windows/windows-11-specifications), read
2026-10-09. UTM's current guide says newer versions enable Secure Boot and TPM automatically.
[UTM Windows guide](https://docs.getutm.app/guides/windows/), read 2026-10-09.

For planning, allocate 4 guest cores and 8 GB guest RAM. A 96 GB virtual disk and about 120 GB free
host disk would leave space for the VM, installer and updates. Prefer at least 16 GB host RAM, with
more headroom while other projects run. Check the actual Mac before allocation. This proposed budget
needs measurement against the owner's workload.

Each stage below is optional and needs the owner's approval before execution:

1. Approve the license, resource budget and software list: free UTM, Microsoft's ARM64 ISO, UTM's
   Windows guest drivers/SPICE tools, and the current ARM64 ChatGPT desktop app. Confirm existing
   account access. The Computer Use docs condition availability on region and workspace policy.
   [Computer Use](https://learn.chatgpt.com/docs/computer-use), read 2026-10-09.
2. Create an ARM64 Windows VM through UTM's Virtualize > Windows flow, enable guest tools, and use
   no shared home directory or clipboard for the first check. Verify TPM and Secure Boot. Complete
   Windows setup and confirm networking. UTM documents guest drivers and display troubleshooting.
   [UTM Windows guide](https://docs.getutm.app/guides/windows/), read 2026-10-09.
3. Install the current ChatGPT ARM64 app inside the guest and enable Computer Use there. First check:
   in Codex, approve guest Calculator, ask it to click `12 × 12`, and verify `144`. Record app/OS
   versions, guest architecture, plugin startup, approvals, errors and whether input stays in the VM.
   An app that opens but cannot drive Calculator is a failed engine check.
4. If that passes, inspect the installed plugin's manifest and runtime documentation without changing
   vendor files. Is there a `cua_repl` server and a usable executable? Does its own first-call help
   expose app acquisition, tree reads, screenshots and actions? Do `tools/list`, approval elicitations,
   session/turn metadata and `turn_ended` match sleight? Inspect executable architecture separately;
   successful emulation would prove operation on ARM Windows, not a native ARM64 engine build.
5. Only if the contract matches, approve a separate relay spike under `bench/`, using the guest's
   installed server. A read precedes any action. Use ordinary client approval prompts and omit Mac
   local tools. Test a declined approval, wrong-window refusal, stop, and owned-child cleanup before
   trying a disposable Notepad edit. Publish every attempt with personal data removed and home paths
   as `~`. Any incompatible contract, missing consent path or uncertain cleanup stops this stage.

Allow 60 to 90 minutes for checks after the guest is ready, as a proposed limit. If native Codex
works but no reusable server contract exists, bank that result and stop. A different Windows
automation backend would be a new project decision. A passing spike would justify a port proposal
with measured limits. Background Windows operation and readiness to release would require further work.


## Private Windows state

Authority stays on one machine: settings, preapprovals and grants live under the account home's
`AppData\Local\sleight`, never Roaming. Inherited APPDATA, LOCALAPPDATA and SystemRoot do not select production roots.
UNC roots refuse. Tests can inject an environment through the platform adapter. A Windows run must still verify native known-folder
discovery and handle-based owner, DACL and reparse checks.

The acceptance rule requires the token user's SID as owner. An elevated run can create an Administrators-owned file;
sleight refuses that file rather than broadening the owner rule. Run settings commands unelevated. Recovery for an existing
Administrators-owned store needs an operator-reviewed repair. sleight must not change ownership automatically.

A private discovery directory does not prevent another process from creating a named pipe first. A pipe server must use
`FILE_FLAG_FIRST_PIPE_INSTANCE` and `PIPE_REJECT_REMOTE_CLIENTS`. The client must bind the server PID, token user SID,
process incarnation and expected helper image through `GetNamedPipeServerProcessId` and held process handles. Discovery
files still need the ordinary file checks. A matching pipe name or directory ACL alone proves no server identity.

Mandatory integrity labels are a separate boundary from the DACL. Low-integrity and AppContainer processes must not gain
settings-write or consent-channel access merely because their user SID matches. Preserve the OS integrity and capability
checks and refuse unavailable evidence. Test those denials, elevated ownership, pipe squatting, account-home lookup and
DACL-change cache invalidation in a Windows guest before enabling these paths. No Windows security claim is measured yet.

### Browser safety gates (WIN7R, 2026-10-26)

WIN7 adds peer verification, file validation and trusted cards to WIN3's single native helper. WIN7R separates two file
rules. `StrictPrivateAcl` applies to sleight-created state. It requires token-user ownership and a protected DACL whose
explicit ACEs reference only that user and SYSTEM. `BrowserFileAcl` applies only to the DevToolsActivePort leaf.
The token user owns it and inherited ACEs are allowed. Writing, deleting or changing permissions is limited to that user,
SYSTEM and Administrators. Other principals may read. Null and empty DACLs refuse. Both rules check every parent for trusted
ownership and replacement rights, reparse points, volume and identity on every call. Successful verdicts are not cached.
The validator requires a fixed local NTFS volume. ReFS, mapped drives, SUBST, alternate streams and paths containing
a tilde refuse without repair. Run unelevated. The validator refuses elevated ownership too.

The leaf and parent handles request FILE_READ_DATA or FILE_LIST_DIRECTORY. Browser endpoint reads share READ and WRITE while
keeping write-time, full-size, identity and DACL rechecks. Parents and strict files share READ only. None shares DELETE. Real
Chrome concurrency and parent rename behavior remain unverified. Handles remain open through the check and recheck. The bounded endpoint read uses that same inspected handle, with a 512-byte maximum. It remains an
unauthenticated hint. Non-read checks release their handles before a caller's later open, so they do not protect that later open.

The peer gate retains the listener check in both address families, requiring exact loopback addresses and the selected
browser PID. After opening, the private transport must return its connected socket. Its actual local port and endpoint
address select the server-side ESTABLISHED row in TCP_TABLE_OWNER_PID_CONNECTIONS. That row must belong to the verified
browser PID. Missing, foreign or ambiguous rows fence the connection before commands. The gate repeats listener and
connection checks before every command, with no reconnect. A TCP table that grows during reading gets one bounded retry.
The process handle pins creation FILETIME, user SID and session while checking liveness and the executable path.
WinVerifyTrust checks the disk executable's expected publisher with cache-only trust retrieval and revocation checking
off. The publisher comparison uses the file's first signature. This does not prove the running image or loaded modules.
Same-user code execution, including injection and socket
duplication into a signed browser, remains outside this boundary.

Cards use separate `--consent` mode. The hand-only spawn still refuses consent. Mouse approval requires matching physical
down and up messages on one drawn decision, low-level hook evidence and a hardware message source. Keyboard approval
requires focusing the drawn word field, typing the card's random word and pressing Return. Each key must have physical
provenance; paste, repeat and modified input cannot supply the word. Tab then Space and Return on opening cannot approve.
Esc cancels. All decisions wait 500 ms after the first paint and after each activation. Input queued inside that delay
cannot count later. This value follows the review's recommendation; no arming constant was found in this branch's Mac
ASK CARD code. Touch, pen and device-16 touchpad input remain refused. WM_GETOBJECT can expose the form and
read-only request to Narrator. The drawn decisions don't expose an Invoke action. Clicking the scrollable request returns
focus to the form on mouse-up. Click evidence and the typed word clear after a decision or loss of activation.

The card installs desktop-wide low-level mouse and keyboard hooks for its lifetime. It retains keyboard evidence only
while its own window is foreground. Endpoint security products may flag these hooks. The mouse hook calls WindowFromPoint
only on button-down, then message-time checks use the card's rectangle. A missing hook fails closed and the request expires.
WM_DPICHANGED returns before pointer access or Framework handling if lParam is null or the DPI is outside 48 to 768.
Card layout reserves the caption and borders, caps width to the monitor work area and reduces the scrollable detail height
when needed. It requires at least 3 body lines and button labels plus padding. A smaller work area cancels the request.
On a DPI change, the suggested rectangle's largest monitor intersection selects the work area, and a layout fault cancels.
The 1280 by 720 at 150 percent case and cards straddling two monitors at different DPI still need the
[Windows VM checks](../../bench/windows/vm-runbook.md#windows-polish-checks).
WIN0 discovers the gate tests in its existing WIN3 and WIN4 suites. Native self-tests and card validation draw nothing.
No C# compilation or Windows security behavior has been measured on this Mac. Browser startup still refuses pending
Windows qualification and broker integration, including connected controls and revocation.

### Open VM checks for browser safety

- Compile the cursor and separate person source lists on x64 and ARM64. Check interop offsets and OpenProcessToken with
  PROCESS_QUERY_LIMITED_INFORMATION. Run `--gate-selftest`, `--consent-selftest` and `--consent-validate` without drawing.
- Read a real Chrome-created DevToolsActivePort with inherited ACEs. Widen its DACL and a parent's DACL separately and
  confirm refusal. Pause the helper with parent handles open and try renaming a parent. Test normal browser writes while
  those handles are held, reparse races, labels below medium and elevated ownership.
- Try SO_REUSEADDR on the browser port. Verify the accepted-connection row, including a foreign server that closes its
  listener before the second check. Exercise IPv4, IPv6, socket churn, PID reuse and disappearance between checks.
- Check WinVerifyTrust on real chrome.exe, msedge.exe and brave.exe, including a cached-only trust failure. Measure time
  per `current()` call before deciding whether publisher verification needs a per-incarnation cache.
- Measure GetCurrentInputMessageSource for mouse, Precision Touchpad, touch, pen, RDP and Hyper-V console input. Does a
  laptop touchpad report device 2 or 16? Keep touch, pen and device 16 refused until provenance is separately qualified.
- From another medium-integrity process, try SendMessage and PostMessage for WM_LBUTTONDOWN, WM_KEYDOWN (Space, Tab,
  letters and Return) and BM_CLICK, with and without a recent real click. Try UIA InvokePattern and
  LegacyIAccessible.DoDefaultAction on every exposed element, and SendInput from a low-integrity process.
- Verify Tab then Space, Return on opening, wrong words, paste, repeated keys and all input during the 500 ms delay.
  Check reactivation, a double click arriving as the card opens, Narrator reading, detail scrolling, keyboard focus and
  long cards at different DPIs. Hover over a hung window and test hook removal. Confirm hook cleanup on every close path.

### Open VM checks for private paths

- Set `USERPROFILE=C:\evil` and verify that `os.userInfo().homedir` still returns the token account's profile directory.
  Account-based production paths rely on this behavior. It has not been checked on Windows.
- Change a file's owner and DACL without changing its content. Check whether each edit changes the NTFS ChangeTime
  exposed as Node's `ctimeMs`. The current cache key includes file identity and ctime, but those invalidation assumptions
  remain unproved on NTFS.
- Widen a parent directory's DACL while leaving the file unchanged. The file-only key cannot detect that change.
  Before enabling cached Windows permission verdicts, include the relevant parent identities and volume serial in the key,
  or leave directory-dependent Windows verdicts uncached. WIN7's native validator doesn't cache successful verdicts.
- Verify that account and helper roots refer to local volumes. A drive-letter path can reference a mapped network drive or
  SUBST mapping. Rejecting UNC and device paths alone does not prove locality. The checked system root currently accepts
  only `C:\Windows`, without verifying the `C:` mapping. Non-C installations refuse until native known-folder lookup is available.
- Check alternate data streams and 8.3 aliases in the recording guard. Its Windows comparison handles case and
  separators only. The authoritative Windows write path currently refuses every write.

## Built-in Windows cursor host (WIN3R, 2026-10-26)

The phase 1 hand mode is separate from macOS and cannot display consent or payment cards. WIN7 adds a separate consent
mode to the same binary, pending Windows qualification. The host compiles C# 5 source with the
in-box .NET Framework compiler. The compiler and PowerShell paths are fixed under `C:\Windows`; environment variables
cannot redirect them. Other Windows installations refuse until an account or OS API supplies a verified root. The ACL
check requires a SYSTEM, Administrators or TrustedInstaller owner and rejects user write or replacement rights on those
executables, and write-file or replacement rights on their ancestors. A create-subdirectory-only ACE at the drive
root cannot replace an existing protected component and is allowed. The build record includes the compiler SHA-256. Compilation uses its private build
folder as cwd and absolute Framework assembly references. Compiler output is capped at 64 KiB and paths are redacted.
A cached preparation runs one batched PowerShell check. Reusing that receipt rechecks source, record and executable hashes
in Node. Locks record PID, process birth and creation time. Missing owners, reused PIDs and locks older than 600 seconds
can be reclaimed. An unreadable process birth stays busy until that age. A lock with no owner record uses its folder age.

The cache still uses LOCALAPPDATA in this branch. Its owner and DACL checks remain required. The executable is hashed
before a path-based launch. A same-user replacement between that hash and launch remains possible. A future launch-copy
step can close that race. The host uses Windows components and sleight source only.

### Coordinates, surfaces and privacy

Frame coordinates use physical desktop pixels. The built-in renderer gets the target HWND's DPI and monitor origin, converts
positions and rectangles to DIPs around that origin for planning, then maps them back for drawing. The point stays at
the same physical location while ring strokes, chips and sprite cells scale with DPI. A target spanning monitors uses
that HWND's DPI for its art. Moving to a different monitor or DPI clears the current plan. The next frame binds again.
Each top-level overlay forwards display and DPI changes to the dispatcher. Surface bounds come from currently visible
paths, cursor art and the current sprite cell. Each overlay reuses one DIB section, bitmap wrapper and memory DC until
capacity grows or the overlay closes. A size or position change replaces the layered window's previous contents.
There is no frame timer when idle. The reader buffers stdin and applies backpressure at 64 queued frames.
Output is UTF-8 without a BOM, with LF endings. Optional menu permissions and usage objects are discarded; there is no
Windows menu or consent UI in phase 1.

Labels, caret motion and key-tap pulses remain suppressed unconditionally. The frame reader does not call UI Automation
while its result remains unused. The separate SecureInput helper keeps its headless selftests for future use.

`StringInfo` remains the label segmenter. .NET Framework's older Unicode rules can split Thai SARA AM, regional-indicator
pairs, emoji sequences and newer Indic conjuncts differently from Swift. Format characters, including ZWJ, are removed
before segmentation. The 40-element and 80-scalar limits still apply. Unicode, 41-element and over-80-scalar reference
cases cover common parity. Separate Windows fixtures expose the Thai and regional-indicator differences.

### Character decode and remaining Windows checks

The inspected hatch-pet assembly and despill scripts write WebP with `lossless=True`, including v2 atlases. The host uses
bounded managed PNG and VP8L readers and passes no compressed art to a native image codec. VP8L supports prefix groups,
LZ77, color caches and all four transforms. It caps files at 8 MiB, images at 1536 by 2288, prefix groups at 256 and
aggregate integer cells at 16 million. Work is capped at 64 million steps; cancellation and a 2-second elapsed budget
are checked between bounded steps. These limits can refuse a valid complex image. They are cooperative limits without
process isolation or an OS memory cap. Lossy WebP and animated containers fall back to the ring.
The reader follows the [WebP lossless bitstream specification](https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification).
The tests include synthetic fixture art only. sleight includes compatibility code without pets or vendor artwork.

A Windows VM must compile the source, run the native tests and confirm `--interop-selftest` reports an OSVERSIONINFOW
size of 276 bytes. `--capabilities`, `--validate`, `--plan-dump`, `--check-character`, `--decode-webp`, `--label-dump` and
the selftests don't create windows. Compile and decoder results, native ACL enforcement, UI Automation provider behavior,
GDI lifetime, focus preservation, capture exclusion, 60 seconds of idle CPU, and rendering at 100%, 125%, 150% and 200%
with negative monitor origins remain unverified on Windows. Test Win32 EDIT ES_PASSWORD, WPF and WinUI PasswordBox,
Edge and Chrome password inputs before and after another UIA client, and an Electron password prompt. Check a drag
across mixed-DPI monitors and read back window styles and display affinity separately from visual acceptance.
