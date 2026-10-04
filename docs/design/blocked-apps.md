# Blocked apps

The engine's helper refuses terminals (Terminal, iTerm2) and OpenAI's own apps
(ChatGPT, Codex, Atlas, with their beta builds) before any approval prompt. The
refusal is OpenAI's code and is never modified, patched or wrapped. This feature
adds sleight's own way to drive those apps, through the same macOS Accessibility
and posted-event path as `menu_bar` and `drag`, once the user opts in (owner
decision, 2026-10-04, docs/status/LAWS.md).

## Opt-in

Both keys together turn the feature on. Either alone does nothing:

- `SLEIGHT_BLOCKED_APPS=1` in Claude Code's environment.
- `~/Library/Application Support/sleight/blocked-apps.json`, containing exactly
  `{"version": 1}`, next to the preapproved list. It must be a regular file,
  owned by the OS account, not group- or world-writable, and not a symlink.
  A missing file leaves the feature off, and an invalid one stops startup.

A repository or plugin setting cannot turn the feature on, and the flag file is
read once at startup, like the flow rules. Either key without the other writes a
stderr note that says which one is missing. When the feature is on, the trace
writer turns on if it wasn't already. The relay writes each action to the trace.

## Relay behavior

The refusal text is `Computer Use is not allowed to use the app '…' for safety
reasons.` (engine 26.930.31730, captured with `bench/blocked-refusal.mjs`). When
the user opted in, the relay appends a note to such results that specifies the
refused app and offers `blocked_app`. Without the opt-in, results pass unchanged,
as before.

`blocked_app` is a local tool, answered in the relay like `drag` and `menu_bar`.
It takes only the refused apps, matched by bundle ID first (name only when no
bundle is known). OpenAI's apps match the `com.openai.` bundle prefix, which
covers the ChatGPT app (now `com.openai.codex`) and beta builds.

## Consent

The first call for an app asks through sleight's own prompt (`ask.js`), with the
same session memory and never-remembered declines as other app approvals. The
prompt says what it allows. For OpenAI's apps it reads
`Claude will be able to click in ChatGPT, including approval buttons, for the
rest of this session.` For terminals it adds that every command send is shown
first. The consent follows `SLEIGHT_APPROVAL_SCOPE`: `once` asks before every
call.

When the #9 preapproved list is merged, the consent is pre-approvable through it
with the same rules as other local tools. A pre-approval never covers the
per-send prompts below.

## Terminal sends

In a terminal, a send that can run a command asks first, every time. `type`
shows its exact text, with newlines escaped. The keys that execute or paste
(Return, Enter, super+v) ask too. The prompt has Allow Once and Don't Allow,
like Claude Code's Bash prompt. The relay forgets these asks immediately, and
the preapproved list cannot cover them. `SLEIGHT_APPROVAL_SCOPE=once` changes
nothing about them. Reads, scrolling, and inert keys (Tab, super+c) don't ask.

## Driving

Operations: `read` (the front window as numbered elements in the engine's style,
long values kept at head and tail, plus a window screenshot through
`screencapture -l`, saved next to the session's temp files), `click` (AXPress by
element number, or a real click at a
window-relative point), `type`, `key` (one key or chord), `scroll` (posted to the
app's process, so it stays in the background). Reads, element presses and
scrolls stay in the background. Typing, keys and point clicks need the app in
front: the driver brings it forward, acts, then puts the previous front app and
the pointer back, as `drag` does, and the result says so. A point click refuses
when another window covers the point, also as `drag` does.

Actions reserve the whole app through the input leases (scope: app), like
`drag`. Reads take no lease, and another session can read while an action runs.
Flow rules check `blocked_app` arguments (typed text, key names) like other local
tools, before any consent or effect, and `flow_exception` works on stopped calls.

The relay logs each executed action to stderr and the trace with app, element
and text. A click on a button named like Approve, Allow, Run or Accept is also
named in the result. The transcript then shows the click.

Settings and preferences windows of these apps are refused for every operation,
including reads. Claude cannot change the apps' own approval or safety settings.
The check is the window title (`blocked-apps.mjs`), and the driver repeats it
with the same pattern.

## Limits

The gate is consent. It does not isolate the approved app from Claude, and a yes
covers clicks on the app's approval buttons. The consent prompt says as much.
Settings refusal depends on window titles, and localized or unusual titles can
pass it. The screenshot needs Screen Recording for the app that runs Claude
Code. The AX path needs Accessibility for it, as `menu_bar` and `drag` already
do. Background scroll reaches the app's focused view and may not affect every
view. Keystrokes go through System Events and need the app in front, which
interrupts a person using that app, and counts as takeover by the engine for
apps it can see. `screencapture` files stay in the session's temp folder until
macOS cleans it.
