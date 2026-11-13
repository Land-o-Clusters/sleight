# Windows platform seams

WIN1 adds adapter selection and paths while Windows native operations remain refused until tested in a Windows guest.
Windows paths were tested with JavaScript fixtures on the Mac, with 0 runtime dependencies added.

## Interface

`getPlatform(platform = process.platform)` returns a frozen adapter. Tests inject the platform explicitly. Selection
doesn't perform I/O. Linux retains the existing POSIX paths and mocked macOS helpers for Ubuntu CI; Linux drawing
remains off. `handSetting` checks the adapter's `hand.supported` capability. Windows, Linux and unknown injected platforms
return platform-off, even with `SLEIGHT_HAND=1`.

| Member | Contract | Windows item |
| --- | --- | --- |
| `paths({home, env})` | Settings, cache, character, renderer-discovery and helper-cache folders without creating them | Implemented with Node's Windows path rules |
| `join(...parts)` | Selected platform's path join | Implemented |
| `nativeHost.built(options)` | Read cached build availability | WIN3 |
| `nativeHost.prepare(options)` | Build and return `{status, spawn, checkCharacter}`; `spawn(options)` returns an owned child | WIN3 |
| `nativeHost.createFrameChannel(options)` | Existing nonce-bound trusted channel over supplied streams | WIN3 |
| `nativeHost.environment({env})` | Native helper's restricted environment | Implemented as data only |
| `cursorSink.create(options)` | `{write, refresh, stats, close}`; `write` never waits | WIN2 named-pipe sink implemented, Windows qualification pending |
| `person.walkAncestors(options)` | `{ok: true}` or `{ok: false, reason}`; absence of proof refuses | WIN5 |
| `person.prepareConfirm(options)` | Build the trusted confirmation helper, returning a spawn handle | WIN5 |
| `filePermissions.privateFile(path, {kind, uid})` | `{ok, reason}`; exact private-file or private-directory check on macOS | WIN2, then WIN3's character loader |
| `filePermissions.privateFileAsync(path, {kind, uid})` | Async check with the same result and shared identity cache | WIN2, then WIN3's character loader |
| `filePermissions.privateDirectory(path, opts)` | Convenience wrapper with `kind: 'directory'`; also has an async twin | WIN2, then WIN3's character loader |
| `hand.supported` | Whether the hand can be enabled; independent of environment overrides | False until the Windows host is ready |

Windows native stubs throw errors with `code: 'NOT_IMPLEMENTED'`, an `item` field naming the WIN item, and a capability name.
Permission stubs return `{ok: false, reason}` naming WIN2. They never accept POSIX mode bits as Windows proof.
A failed host turns the hand off. Settings changes are refused when ancestry is unproved. Confirmation returns
`no helper`, and hand-file reads return `unsafe`. These consumers keep their existing failure handling.

The Darwin adapter loads the compiler and spawner only when preparation is requested. Read-only build lookup and the
nonce-bound frame channel remain synchronous in small shared modules. The existing ancestry walk and Unix sink moved into separate modules
without changing their algorithms. The relay calls the sink through `hand/events.mjs` with its existing action logic.

## Folders

macOS keeps `~/Library/Application Support/sleight` for settings, characters and cursor discovery, and
`~/Library/Caches/sleight` for cache. The helper bank remains `turbo-host` under cache.

Windows uses the account home's `AppData\Local\sleight` for settings, approval records, grants, characters, renderer
discovery and helper cache. Nothing that records authority uses Roaming. Production roots come from `os.userInfo().homedir`,
with fixed relative components. `HOME`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` never redirect production stores.
Tests can supply `paths({home, env})` explicitly. Environment keys are case-insensitive. Conflicting case variants refuse.
Relative paths, drive-relative paths, root-relative paths, device namespaces, UNC roots and control characters refuse.
The native helper will later supply known folders through `SHGetKnownFolderPath`. Redirected profiles remain unqualified.

`nativeHost.environment({env})` has the same signature on both platforms. On Windows, production uses `C:\Windows` only
after checking that it and `System32` are real directories without reparse redirection. PATH contains only those two
folders. Inherited SystemRoot, PATH, COMSPEC, temporary paths and loader controls are discarded. An explicit environment is
for tests only. A non-C Windows installation refuses until native OS-folder discovery is implemented. WIN3 must still prove
OS and helper identities before launching a child. Darwin keeps `{PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8'}`.

Hand settings, character roots, preapprovals, permissions, Electron grants and opt-ins, turbo config, startup and surface
caches, and the shell socket directory now use platform paths. Existing POSIX store validators still need Windows implementations.
Cursor events use WIN2's named-pipe transport on Windows. Its security worker uses the checked system root in production,
with an explicit `testEnv` option for fixtures. The recording guard recognizes the local settings root on
Windows. Its writer refuses there until held-handle and reparse checks replace its POSIX working-directory proof. Mac-only
routine scheduling, downloads, exports and launch helpers still need separate ports.

Private-file checks take a path and `{kind: 'file' | 'directory', uid?}` and return `{ok, reason}`. POSIX callers may pass an
already-read `stat`. A native validator must open its own handles. The sync and async methods share up to 256 successful
results, keyed by path, requested kind and owner, and file identity (`dev`, `ino`, owner, mode, link count, size, mtime and
ctime). A synchronous cache miss must not block the relay with a child process. Windows can warm that cache through the async
method; without proof, the sync method refuses. Async validation checks identity again before caching. Failures are not
cached. `readHandConfig` uses this cache beside its existing 250 ms setting snapshot. NTFS file ID and security-descriptor
change invalidation still need guest verification before any Windows result can be accepted.

## Person ancestry

Use a small helper with `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)` and `Process32FirstW`/`Process32NextW`. Compile
sleight's own C# P/Invoke source through the host build seam. The snapshot supplies PID and parent PID without
starting PowerShell or depending on CIM service availability or command-output localization.
[Microsoft documents process snapshots and enumeration](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-createtoolhelp32snapshot).

The helper opens each process with query-only rights and holds the handle through its final liveness check. Its report
includes the full executable path, token user SID, logon/session identity and creation time. A parent newer than its child, a
reused PID, a cycle, an inaccessible process or an unknown ancestor refuses. The walk has a 32-level, 1,000 ms budget
and a 10 s session-age bar for changes that grant access. `GetProcessTimes` supplies creation time;
[Microsoft's PID-reuse example](https://devblogs.microsoft.com/oldnewthing/20150403-00/?p=44313) explains why parent PID alone
does not prove ancestry. These additional checks are sleight's proposed policy.

Allow only verified shell and terminal executable identities in the same user session. An executable's basename or
command line is insufficient. Deny agent hosts, editors with agents, multiplexers and unreadable ancestors. ConPTY,
OpenConsole and Windows Terminal topology need guest fixtures: a console host or an `isTTY` result alone never proves
a person started the command. If that topology cannot be bound, refuse. Windows permits parent-process spoofing, so
ancestry remains a mistake check. High-stakes changes also require the separate OS confirmation.

This is design only. WIN5 adds ancestry and confirmation. WIN4's browser-process work doesn't include this gate.
PowerShell `Get-CimInstance Win32_Process` can help an operator diagnose
topology, but it is not the authority source in this design.

## Person confirmation

Use `Windows.Security.Credentials.UI.UserConsentVerifier`, with the desktop
`IUserConsentVerifierInterop.RequestVerificationForWindowAsync` path bound to a trusted helper HWND. Microsoft requires
the desktop window interop route instead of the UWP `RequestVerificationAsync` call.
[UserConsentVerifier desktop guidance](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier)
describes Hello, PIN and fingerprint verification. This design accepts only `Verified`; unavailable, not configured,
canceled, locked out, timeout, a lost pipe or an unexpected response refuses. It never asks for a password or PIN in
sleight's own UI.

Keep the host's fixed reason table, private build copy, binary hash report, one-use request nonce and 60 s deadline.
The request is sent only over the launcher's inherited channel. Confirmation authorizes the one requested settings
change and never writes Always allow by itself. The helper must withdraw on cancellation or channel loss. Windows
Hello UI and HWND ownership require a later interactive Windows test. C# interop with the in-box Framework compiler
is unverified. A package or SDK requirement is an owner question before adding a dependency.

## Owned by the user and private

Windows mode bits, `chmod`, a successful file open and a numeric `stat.uid` cannot establish this property. The Windows
permission methods refuse until a native validator supplies handle-based identity and security-descriptor evidence.
The proposed acceptance rule is:

- The owner SID equals the current process token's user SID. Names and environment variables are not identities.
- A non-null, protected DACL allows only that SID and LocalSystem to read, modify or delete file data.
  Reject other allow ACEs, including Everyone, Users, Authenticated Users and inherited broad grants. Directory create,
  delete-child, write-DACL and write-owner rights follow the same rule. Unknown ACE types refuse.
- The object has the expected regular-file or directory type. Refuse reparse points, including junctions, across the
  checked path to the trusted root. Files have one link. Verify volume and file identity through held handles and
  recheck before publication. A rename must not replace the checked object with an unchecked one.
- Creation supplies that descriptor explicitly. Parent directories must prevent another ordinary user from replacing
  or deleting protected children. Atomic writers validate the temporary file and destination directory through handles.
- An unreadable descriptor, unsupported filesystem, unproved network identity or ambiguous path refuses. The policy
  grants nothing based on a path being under AppData. It does not protect against other code running as the same user
  or an administrator exercising privileges.

This is sleight's proposed policy, stricter than inheriting a profile directory's ACL. Microsoft documents descriptor
inheritance at creation and the `GetSecurityInfo` and `GetNamedSecurityInfo` APIs in
[file security and access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights).
WIN2 must bind this evidence to renderer discovery and named-pipe peers. WIN3 must apply the same rule to installed
characters and compiled helpers. The shared validator's exact handle API remains integration work; POSIX `Stats` will
not become Windows proof.
