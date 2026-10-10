# Windows research

2026-10-09. Code inspected at `6e21846` on `origin/pane/auto-mode`.
This research used public documentation and source inspection. Windows behavior remains untested.

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
- `blocked_app` uses [blocked-app.js](../../plugins/sleight/lib/blocked-app.js) and
  [blocked-apps.mjs](../../plugins/sleight/lib/blocked-apps.mjs), with macOS Accessibility and bundle
  identities. Omit it in a spike and retain engine refusals.
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
