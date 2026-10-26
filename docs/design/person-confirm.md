# Person confirmation for high-stakes settings changes

Built for 1.5.1 (owner, 2026-10-26, VC10). Code: `plugins/sleight/lib/person-confirm.mjs`, the PERSON CONFIRM section and the
`--confirm-person` mode of `direct-browser/native/consent-host.swift`, and the auth-dialog identity in `own-host.mjs`.

## Why

The guard hook reads the command text, and the launcher's terminal check (`person-gate.mjs`) reads each ancestor process up
to a terminal app. Neither can tell a person from an agent that opens a fresh Terminal window through computer use and
types the command, because both have the same ancestry. The third check needs a finger on the Touch ID sensor or the
account password, which an agent doesn't have.

## The flow

1. The launcher's main block runs `settingsChangeRefusal`: the terminal check, then `confirmationRefusal` for high-stakes forms.
   It dispatches only when both return nothing, so nothing is written after a refused, failed, cancelled or timed-out confirmation.
2. Presence first. When the Mac is locked or has had no input for 120 s (`remote-approvals.js` presence, the same test remote
   approvals use), the change is refused outright. An unknown presence leaves the decision to the sheet.
3. The consent host is built from sleight's own sources into the helper cache, as for the ghost hand. The launcher starts
   it as `consent-host --confirm-person <key> [subject]`. The host runs `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`.
   macOS shows Touch ID, with the password as its own fallback. The exit code is the answer: 0 confirmed, 1 failed, 2
   cancelled, 3 timed out, 64 refused arguments, 69 the Mac can't ask.
4. The sheet's reason comes only from the host's table, keyed by the change. Of the command's arguments, it takes only a
   bundle id (`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`, 100 characters at most) or a browser name from a fixed list. Node checks
   the same and the host checks again. macOS words it as "consent-host is trying to turn on sleight turbo for Google Chrome."
5. The host withdraws the sheet after 60 s (`LAContext.invalidate`), and SIGINT, SIGTERM or SIGHUP do the same, so Ctrl-C in
   the terminal cancels. The launcher kills a helper that hasn't exited 2 s after that.

## What counts as high-stakes

| Path | High-stakes forms | Low-stakes forms (terminal check only) |
|---|---|---|
| `turbo` | `on`, `app on` | `off`, `app off` |
| `permissions` | `unblock`, `sites`, `repair` | `block`, `revoke`, `memory clear` |
| `allow` | | `remove` |
| `routine` | `add`, `unlock` | `remove`, `--remove` |
| `watch` | `<url> --find`, `record`, `unlock` | `remove` |
| `hand`, `cursor` | | every form |
| Menu bar | | Ghost Hand, Revoke, Revoke All, Never Act in or on, Turn Turbo Off… (its own card), turbo's session rows |

Anything that only takes access away is low-stakes (sleight-arch, 2026-10-26). Any other form of a high-stakes family,
usage errors included, asks under the generic `settings` key, so a writer added later
is covered before anyone lists it.

## The sheet's process, and sleight's refusal

On this Mac (macOS 27, read-only checks on 2026-10-26) the LocalAuthentication sheet belongs to
`/System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle` (bundle id
`com.apple.LocalAuthentication.UIAgent`, running as `coreautha`), with `coreauthd` as its daemon. Authorization prompts belong
to `SecurityAgent.bundle` (`com.apple.SecurityAgent`). The engine reads such a dialog with the header `App: SecurityAgent`.
`own-host.mjs` treats these names, bundle ids, paths and pids like sleight's own consent host: the relay refuses getApp calls,
local tools, handles and approval cards that name them, and withholds a read whose window is one of them, with the line
`That is macOS's own Touch ID or password dialog; only you can answer it.` The engine's own treatment of these windows wasn't
probed, because that would put a sheet on the owner's screen.

## Remote approvals

Remote approvals (LAWS, 2026-10-25) let the user's typed `allow <app>` approve apps while nobody is at the Mac. A settings
change isn't an app approval, so it has no path there: the confirmation is always the local sheet, and with nobody present
the change is refused before any sheet shows.

## Threat model

These checks keep Claude's shell, file tools and computer use from changing sleight's settings. They don't stop code that rewrites sleight itself. The plugin's JavaScript, the launcher and the helper cache are
all files the same user can write, so a program running as that user can replace the check along with what it checks.
Within that model, two cheap paths are closed:

- The guard hook refuses Claude's Write, Edit and shell writes to `~/Library/Caches/sleight/` and to installed copies of the
  plugin (`<host>/plugins/cache/<marketplace>/sleight/`, for Claude Code, Codex and Cursor). A plugin loaded from a
  working checkout isn't covered, and its source can be edited as before.
- The helper that answers is never the cached file itself. The launcher picks the build keyed by the source as hashed at
  that moment. It reads the binary through one open file and checks its owner, mode and hash against the build record.
  Then it runs a private copy of those bytes from a fresh 0700 folder. The build record is in the same cache, so this
  closes a swap between the check and the run. Rewriting the whole cache, record included, still gets through. A fresh compile per confirmation
  would drop the cache from the chain, at the cost of a compile each time (over 120 s cold at load 31 to 38, host.mjs).

## Outside sleight's control

- Another computer-use tool can act on the password sheet. It still needs the password, and Touch ID still needs a finger.
- A person can approve a sheet they didn't expect. The terminal line printed before the sheet gives the full command.
- Code that runs as the user outside Claude's tools, such as a script an agent wrote earlier and the user ran, can rewrite
  sleight and its checks (see the threat model).

## Not verified

No sheet was shown while building this, since the owner was using the Mac. Whether `evaluatePolicy` from the cached,
ad-hoc-signed host binary shows the sheet, and how macOS words the fallback when the account has no password, are
unchecked. Tests inject the confirmation (`confirmationRefusal`) and a stand-in evaluator (the Swift fixture), and the compile
test runs only `--confirm-person-check`, which prints the reason and exits.
