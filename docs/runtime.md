# Mac runtime preview

sleight 1.6.0 will include an opt-in preview of its own Mac computer-use runtime. The ChatGPT engine stays the default.
The preview uses a persistent Swift helper and a JavaScript worker, with sleight's app approvals and input leases.
It currently exposes reads. Input stays unregistered until the live checks pass.

## Turn it on or off

Set `SLEIGHT_RUNTIME=own` in the environment of the sleight MCP server, then restart that server or start a new host
session. For a Claude Code session started from a terminal:

```sh
SLEIGHT_RUNTIME=own claude
```

For an MCP registration with an `env` object, add `"SLEIGHT_RUNTIME": "own"` there and restart the desktop host.
To turn the preview off, remove that variable or set it to `engine`, then
restart the server. These are the only 2 accepted values. The selection lasts for the server's lifetime.

This setting applies to the MCP route only. The shell route (`sleight-mcp session` / `sleight-mcp js`, including
Grok Bot) strips `SLEIGHT_RUNTIME` from its environment, so setting it there has no effect. Whether any Claude host
uses that shell route remains unverified.

The preview does not silently fall back to the engine when a runtime read fails. Stop on a refusal. To return to the
engine, change the setting and restart. Browser and Electron turbo keep their existing paths and per-app opt-ins.

## What works today

The runtime exposes 3 tools: `js`, `js_reset` and `turn_ended`, plus turbo's browser tools when turbo is on.
JavaScript bindings persist between calls.
`cua.getState()` and `cua.listApps()` provide filtered app inventory. `cua.getApp()` acquires an approved running app
with an existing window. The parent forces `launch: false`, including when a caller asks to launch. Window selection by id,
accessibility reads, window screenshots and combined tree/image reads are implemented.

Repeat reads currently return full trees. Engine diff-format parity and its token savings remain unverified.
Element numbers require a tree delivered to the model. Hidden reads and slices establish no new numeric baseline.
The runtime preserves app, process-start and window identity checks, approval refusals and turn boundaries.

Pointer and keyboard implementations are built, but their production handlers remain unregistered. Clicks, typing,
shortcuts, scrolling and drags are unavailable. Semantic actions (`setValue`, text selection, secondary actions and
paste), renderer accessibility activation and driver-backed local tools are built but not connected to this preview.
Thin Chromium and Electron trees may remain thin. The local drag, hover, menu and notification tools are
not exposed by the preview's 3-tool surface. Engine browser-extension APIs are unavailable on this path.

The runtime keeps refusing OpenAI apps and terminals under the existing forbidden-target policy. The user's existing
`ComputerUseAllowForbiddenTargets` setting can lift that restriction. The runtime reads this setting once at startup;
changing it requires a server restart. Authentication agents, the current host and
protected settings windows remain refused. Selecting the runtime does not approve app access.

Any configured site limit blocks native content reads and captures because the preview has no trusted native site
identity reader. Missing app policy or permission checks refuse access. A malformed or duplicate `Screenshot frame:`
line suppresses screenshot coordinate association, including when document text repeats that marker.

The qualification plan has 29 mechanism cells with 470 trials, followed by 5 tasks with 5 attempts per runtime
(50 model attempts). Offline fixtures and synthetic image encodes do not qualify those checks. This preview has no
measured claim of engine parity, faster tasks or lower memory use. Real input, clipboard restoration, renderer
recovery, other Spaces, multiple displays and locked-session behavior still need live qualification. A sitting
report cannot qualify the runtime. PNG at pixel scale remains the capture default.

## Install without ChatGPT

Use the normal [plugin install](../README.md#install), with these additional requirements for the preview:

- Install Node 25 or later on PATH. The launcher prefers the Node bundled in ChatGPT.app when executable. If it lacks
  `--permission` or `--allow-net`, the Mac JavaScript worker checks PATH, then the usual Homebrew, `/usr/local` and
  `~/.local` install paths for a Node with both flags. Selection has a 6,000 ms total budget, at most 2,000 ms per probe.
  The relay keeps its original Node. Claude Code's own runtime does not supply this executable to sleight.
- Install Apple's Xcode command-line tools, including Swift, Clang and the macOS SDK. A full Xcode installation
  with those tools also works. Complete the installation yourself before first use. sleight checks for the tools
  without opening the installer.
- Give the app hosting Claude Code the grants described below. The runtime preview does not require ChatGPT,
  a Codex sign-in or the OpenAI helper. The default engine path still requires the engine installation.

Candidates must be Mach-O executables owned by the user or root, without group/world writes or setuid/setgid bits.
Relative PATH entries and entries inside the relay's working directory are skipped. Every ancestor must be owned by
the user or root, and world-writable directories need the sticky bit. Version-manager scripts are refused; probes
run with an empty environment. The selected real path and file identity are checked before every worker fork.
A changed or removed file triggers one new selection. Failure is cached until the relay restarts.
With no qualifying Node, `js` returns `REPL_NODE_UNSUPPORTED` with refusal reasons. Install Node from nodejs.org or
Homebrew, restart the relay, then run doctor to check the worker line. This fallback has offline test coverage;
its first live acquisition remains unverified.

On the first runtime operation that needs the helper, sleight compiles its bundled Swift sources and the C peer
helper locally through `xcrun`. It caches them under `~/Library/Caches/sleight/turbo-host/mac-driver/`, keyed by source
hash and architecture. Changed sources need another build. Each compiler invocation has a 300-second timeout.
First-use compile time and cold-start memory have not been measured for this runtime.

Until Apple Developer signing is available, the preview uses this source build. A future signed, notarized prebuilt
helper could remove the local compiler requirement. Giving it its own Accessibility and Screen Recording identity
also needs a stable app bundle and launch arrangement.

## Grants and exposure

The source-built helper should use the responsible host app's Accessibility and Screen Recording grants, such as
those of Terminal or the desktop app running Claude Code. This TCC attribution is the design, unmeasured for this
binary. Accessibility permits reading app trees and, when input is
enabled later, controlling apps. Screen Recording permits window captures. sleight's app approval is a separate
check. It does not replace either macOS grant.

A grant to Terminal covers other scripts launched by Terminal. These grants are not limited to sleight or to the
app approved on its card. Review the host app's access in System Settings > Privacy & Security. The preview has no
separate signed helper identity that narrows that exposure. Revoking a grant can make later reads fail.

## Diagnose and report a problem

Run the offline runtime section from the `plugins/sleight` folder with the same environment as the server:

```sh
SLEIGHT_RUNTIME=own ./bin/sleight-mcp --doctor
```

It reports selection, the Node executable and version the worker would use, support for its required flags,
the helper source SHA-256, matching cached binary hashes, and whether Swift and Clang files were found.
SDK availability and compilation remain unchecked. Doctor never compiles, starts a helper, runs
a probe or requests a grant. Accessibility and Screen Recording show `unknown`: checking another process's current
grants requires launching it, so doctor leaves those grants unchecked. An exit of 0 means
the Node flags are supported and source and a build or compiler files were found. It does not certify app access or
live qualification. In own mode, `--doctor <app>` checks that the argument is nonempty and does not start with `-`,
then ignores it. Engine-mode doctor retains its existing live read.

Doctor also reads the newest `runtime-probe*.json` in `~/Library/Logs/sleight/`, if one exists. The probe harness
requires an explicit `--out`, and reports saved elsewhere are not discovered. Keep an existing probe's JSON in that
folder under a name such as `runtime-probe-2026-10-31.json` if you want doctor to show it. Doctor prints its date,
verdict, cell count, cleanup status and source comparison. Grants may have changed since the saved run.
Doctor reports an invalid newest report without substituting an older passing result.

When reporting a failure, include the sleight version, macOS version, host app, Node version, runtime selection and
doctor output. Add the app name, error code, delivery/retry fields and a small reproduction using dummy content.
State whether it also fails after switching back to the engine. Remove personal paths, titles, content and nonce
values before sharing logs. Describe what you observed and what you did not check; never repeat input with an
unknown outcome just to gather evidence.
