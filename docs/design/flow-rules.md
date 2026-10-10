# Flow rules

## Configuration

Set `SLEIGHT_FLOW_RULES=1` to read the user's
`~/Library/Application Support/sleight/flow-rules.json`, or set an absolute path.
The file must resolve outside the working project and plugin. It is read once
before the engine starts. Invalid or missing enabled configuration stops startup.
There is no tool to write or reload rules. Editing the file cannot alter the
active session's compiled rules. Protect the file's permissions yourself.

The JSON has `version: 1` and a `rules` array. Each rule has a unique `id`,
`kind`, `destinations` (app names, bundle IDs or `"*"`) and optional `except`.
A `pattern` rule adds a JavaScript regex `pattern` and optional `flags` (i/m/s/u).
A `source` rule adds `sources`, an array of app names or bundle IDs.
Matching app names ignores case. Engine headers supply observed bundle aliases.

Each selector array also accepts `site:example.com` for one host, or `site:*.example.com`
for its subdomains. The wildcard matches `a.example.com` and `a.b.example.com`, excluding
`example.com` itself. Host matching ignores case, scheme and port. Selectors use ASCII DNS labels
(punycode for international names) or a canonical IPv4 address. A wildcard needs at least two DNS
labels after `*.`. Paths, schemes, ports, whitespace, trailing dots, partial wildcards and shortened
IP addresses in selectors stop startup. Existing app selectors, `browser` and `*` keep their meaning.

## Relay checks

Before forwarding `js`, the relay scans literal arguments to `typeText`, `paste`,
`setValue` and `pressKey`, including literal bracket method names and escapes.
Constant templates and adjacent literal pieces are checked. Simple key sequences
are assembled across accepted calls per app, retaining the last 16 KiB.
Command and navigation keys reset that approximation. It can differ from the app buffer.
Literal `getApp` assignments identify destinations; cached handles and the last
observed window supply other targets. An unknown target cannot use an exception
listed in a rule's `except` array. `drag` and `menu_bar` string arguments are
checked before local effects, using their `app` argument as destination.

Site attribution uses HTTP or HTTPS URLs from native Window/URL headers and browser tab headers.
Saved tab handles and their locators share the last observed host for that tab. A later read of a
different tab leaves those handles alone. Native handles use the last observed window for their app.
Missing, malformed or conflicting headers clear the current site's attribution. A browser destination
whose site is unknown is checked against site destination rules, but cannot establish a site
exception. Recognized native browsers follow the same rule. A literal navigation URL is checked
against its requested host, without granting an exception, and clears the handle's earlier site
until the engine returns a header. Back, forward and reload also clear the earlier site before later
input in the same call. Once a native app has returned a web URL, missing or conflicting headers
preserve its browser classification while clearing its host. Site rules keep separate typing tails per app and host, while
app rules keep their existing per-app tails.

Protected source values come from returned text, even on errors: UI Value fields, text
elements, their continuation lines, and emitted plain text or JSON strings.
Window headers attribute UI sections; otherwise the call's app supplies the
source. UI menu chrome and API documentation are excluded. Values stay in memory
until session shutdown. A source rule checks exact, case-sensitive substrings.
Observed source values retain their original host after a tab changes site. A result with
several window or tab headers attributes each text section separately and leaves the call's
destination site unknown. Site source rules need a usable header; plain output without one still
supports app source rules.
Calls run one at a time so a completed read is recorded before the next action.

A match refuses the entire call before forwarding and identifies the rule.
Checks ignore old complete input matches when appending harmless text.
`flow_exception` doesn't accept decision arguments. It shows the stopped call and
rules through `ask.js` on the desktop or an elicitation elsewhere. Only a user's
accept allows one identical retry. Another call cancels it. Decline, cancel and
prompt failure grant nothing. Other calls wait while the prompt is open.
An exception is consumed before dispatch, including a failed engine action.

## Limits

This guards mistakes. It cannot establish a security boundary. Reads and sends
in one call have no intervening source check. JavaScript can build
strings at runtime, encode or transform values, use computed method names or
clipboard shortcuts, and bypass literal inspection. Coordinate drags disclose
no dragged text in their arguments. Screenshots and data not exposed as text are
not recorded. Partial, reformatted or case-changed copies can evade source checks.
UI parsing can miss fields or retain harmless text; exact substring matching can
also block unrelated copies. App attribution depends on cooperative code and
headers. Reassigned handles or missing headers can misattribute data, as can
forged headers or multiple apps in one call. Clipboard contents and other tools are outside
these checks. Rules cannot stop writes through Bash or another MCP server, nor
prevent edits to their file on disk. They retain the startup copy in memory.
Site attribution can become stale between calls when a person changes the tab's URL. Native windows in
the same app share one observed destination, and unfamiliar native browser names may escape the
unknown-site check until a URL is observed. These limits also apply to site exceptions.
