# Blocked apps

The engine's helper refuses terminals (Terminal, iTerm2) and OpenAI's own apps
(ChatGPT, Codex, Atlas, with their beta builds) before any approval prompt. The
refusal is OpenAI's code and is never modified, patched or wrapped. This feature
adds sleight's own way to drive those apps, through the same macOS Accessibility
and posted-event path as `menu_bar` and `drag` (owner decision, 2026-10-04,
docs/status/LAWS.md).

## The gate is the prompt

There is no other opt-in: no environment variable, flag file or setting. The
`blocked_app` tool is always listed. When the engine refuses an app, the relay
says so in the result and offers the tool. The user approves that app in
sleight's prompt first, and Allow puts it on the session allowlist like any
other app approval. When the #9 preapproved list is merged,
the consent is pre-approvable through it with the same rules as other local
tools. A pre-approval never covers the per-send prompts below.

## Relay behavior

The refusal text is `Computer Use is not allowed to use the app '…' for safety
reasons.` (engine 26.930.31730, captured with `bench/blocked-refusal.mjs`). The
relay appends a note to such results that specifies the refused app and offers
`blocked_app`, whenever the tool is registered.

`blocked_app` is a local tool, answered in the relay like `drag` and `menu_bar`.
It takes only the refused apps, matched by bundle ID first (name only when no
bundle is known). OpenAI's apps match the `com.openai.` bundle prefix, which
covers the ChatGPT app (now `com.openai.codex`) and beta builds. The relay
resolves the app first, then pins the driver to the resolved bundle ID and pid.
A name alias then drives only the app the consent named.

## Consent

The first call for an app asks through sleight's own prompt (`ask.js`), with the
same session memory and never-remembered declines as other app approvals. The
prompt says what it allows. For OpenAI's apps it reads
`Claude will be able to click in ChatGPT, including approval buttons, for the
rest of this session.` For terminals it adds that every command send is shown
first. The consent follows `SLEIGHT_APPROVAL_SCOPE`: `once` asks before every
call.

## Terminal sends

In a terminal, every key or text that can run a command asks first, every time.
The rule is an allowlist of inert keys (arrows, Tab, Escape, ctrl+c), because
ctrl+m, ctrl+j and ctrl+o reach a shell as Return, C-j and C-o, and shifted or
optioned Returns execute too. `type` shows its exact text, with newlines
escaped. Any other key or chord asks. The prompt has Allow Once and Don't
Allow, like Claude Code's Bash prompt. The relay forgets these asks
immediately, and the preapproved list cannot cover them.
`SLEIGHT_APPROVAL_SCOPE=once` changes nothing about them. Reads and scrolling
don't ask.

## Driving

Operations: `read` (the app's largest standard window as numbered elements in
the engine's style, long values kept at head and tail, plus a window screenshot
through `screencapture -l`, saved next to the session's temp files), `click`
(AXPress by element number, or a real click at a window-relative point),
`type`, `key` (one key or chord), `scroll` (posted to the app's process, so it
stays in the background). Reads, element presses and scrolls stay in the
background. Typing, keys and point clicks need the app in front. The driver
brings it forward and checks that the switch worked, refusing to send otherwise
(keystrokes would go to whatever is frontmost). It then puts the previous front
app and the pointer back, as `drag` does, and the result says so. A point click
refuses when another window covers the point, also as `drag` does.

Actions reserve the whole app through the input leases (scope: app), like
`drag`. Reads take no lease, and another session can read while an action runs.
Flow rules check `blocked_app` arguments (typed text, key names) like other local
tools, before any consent or effect, and `flow_exception` works on stopped calls.

The relay logs each executed action to stderr and the trace with app, element
and text. A click on a button named like Approve, Allow, Run or Accept is also
named in the result. The transcript then shows the click.

Settings and preferences windows of these apps are refused for every operation,
including reads. Claude cannot change the apps' own approval or safety settings.
The title decides, with the relay's pattern and its flags (blocked-apps.mjs);
Terminal titles its settings window after the open pane ("General",
"Profiles"). The driver refuses a window with a toolbar as well. The check errs
toward refusal.

## Limits

The gate is consent. It does not isolate the approved app from Claude, and a yes
covers clicks on the app's approval buttons. The consent prompt says as much.
Settings refusal depends on titles plus the toolbar rule, and a localized title
without a toolbar can pass it. The screenshot needs Screen Recording for the app
that runs Claude Code, and it captures only a window that is on screen. The AX
path needs Accessibility for it, as `menu_bar` and `drag` already do. Background
scroll reaches the app's focused view and may not affect every view. Keystrokes
go through System Events and need the app in front, which interrupts a person
using that app, and counts as takeover by the engine for apps it can see.
System Events' keystroke doesn't act on an embedded newline in Terminal, so each
newline becomes one Return key press. In the 2026-10-04 live check the ChatGPT
app's window exposed only its window-control buttons to the walk (its UI is web
content), so a harmless click there had no target. `screencapture` files stay in
the session's temp folder until macOS cleans it.
