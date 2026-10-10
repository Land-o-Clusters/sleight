# Scoped approvals

Status: design only, not built. Building it waits on the owner's call (asked 2026-10-10).

Design proposal, 2026-10-09. Adoption requires the owner's decision. Track 6 asks for
read, control and sensitive approvals, expiry, and confirmation before anything irreversible.
The current behavior below is from `11a289328b794a800433e5ef8d1ed5130338e472`; the proposed behavior
is unimplemented. This work used existing traces and documents, without live runs.[^roadmap]

## Recommendation

Start with an opt-in pilot: separate read and control grants for one app and session, then ask
once for each detected sensitive action. Keep session expiry first; define timed and turn expiry
before adding either. Do not remember a sensitive-action answer. An app grant, including an existing
preapproval, must never answer the new confirmation.[^laws][^preapproved]

A guard running in the engine's JavaScript is not a security boundary. Claude writes that code
and can bypass its checks. The pilot can catch mistakes in cooperative calls; it cannot promise
confirmation before every irreversible effect. If that promise is a release requirement, hold the
feature until a trusted operation interface can restrict every action outside model-written
JavaScript. Keep unsupported commits with the user. Do not modify or wrap OpenAI's helper to obtain
that interface.[^laws][^document]

| Approach | Benefit | Cost and limit |
| --- | --- | --- |
| Explain today's session grant more clearly | Smallest change, no additional app prompts | Does not separate reads from actions or add commit confirmation |
| Cooperative scope pilot, recommended | Reuses observed methods and window data; exposes scope and expiry | Adds scope upgrades and confirmations; arbitrary JavaScript and hidden app effects remain outside its guarantees |
| Trusted structured operations | Could restrict direct operations without trusting Claude's code | Needs a new interface, restricted execution and app-specific effect rules; the current engine approval metadata is insufficient |

These trade-offs follow from today's app/risk approval key, the recorded metadata in T1, and the
document guard's published bypasses.[^relay][^t1][^document]

## Scope meanings

The following permissions are proposed. Engine refusals and existing document, flow, lease and
local-tool checks still apply. Every applicable grant must cover the operation. An app-wide read
permission exposes the app's accessible contents. It does not isolate one document.[^settings][^document]

| Scope | What the user would allow | What needs another decision |
| --- | --- | --- |
| Read | Acquire an app with `getApp`, read its accessibility state and take its screenshots | Any input, including clicks between views, scrolling, keys, text, paste, value changes or secondary actions |
| Control | Read plus ordinary clicks, keys, text, paste, scrolling and drags within the approved app | Detected sensitive actions and operations whose commit effect cannot be determined |
| Sensitive | Prepare a sending, deletion, purchase, form submission or discard operation, then request a decision on its exact final action | Every final action requires Confirm once, even if the app already has control permission |

Sensitive should be a request category, with no standing grant. A control grant includes reads.
a read grant never upgrades itself. Version one would offer Read or Read and control at the app
prompt, and use a separate sensitive confirmation. Unknown methods would stop before forwarding.
Do not equate the engine's `low`, `medium` and `high` risk levels with these scopes: T1 labels both
reads and controls `low`.[^t1]

Treat saving over existing content as sensitive unless a recoverable copy is verified. Permission
changes and terminal command submission are sensitive too. An ordinary save means a new local file
or a save with verified recovery. Unknown recovery requires confirmation. Existing change review
can retain a copy of a backed file, but it is off by default and cannot recover every kind of
app state.[^settings]

Read covers the operations sleight sends. The app can still change its own state. Selecting
an app can change the observed window, and the real-use mail tasks explicitly avoid marking mail
read. Navigating to another message requires control under this definition, even when the task's
purpose is reading. A later navigation-only permission would need separate design.[^document][^mail]

## What sleight can observe

Today the relay remembers an exact app/risk pair when the engine offers session persistence. The
key omits the action's method. The engine can approve an Always allow app without sending an
elicitation to sleight. A scope check must run before each operation, independently
of whether an engine prompt arrives.[^relay][^settings]

For cooperative calls, sleight has the requested method and arguments, previously returned element
lines, window titles, roles and URLs. Its existing guard resolves numbered or labeled targets
against a fresh window read and detects changed element numbers. The app's eventual effect can
still differ from the observed UI.[^guard][^t3]

| Signal | Proposed treatment | Reliability and gap |
| --- | --- | --- |
| Current target labeled Send, Delete permanently, Buy, Submit, Discard or Don't Save | Ask before activating it; show its role and surrounding dialog text | A matching label identifies a visible warning signal. Labels can be absent, localized, misleading or supplied by a page |
| Save, Replace or confirmation dialog/sheet | Inspect the target and destination; confirm replacement, discard and external submission | Window kind helps identify context. T2's Save sheet and T1's Save dialog cannot by themselves establish an irreversible effect |
| Return, Space or an app shortcut | Resolve focused control and current dialog first; ask when it commits or is uncertain | The same key can insert text, activate a default button or send. T1's approval metadata omits the actual key |
| Backspace/Delete in a known text selection | Ordinary editing only when the observed context supports it | Deleting a file or message is sensitive even if Trash or Undo exists; a key name alone cannot distinguish these cases |
| Coordinates, unlabeled controls, custom canvas or unknown focus | Treat the effect as unknown and ask before input, or stop if there is no reviewable target | Coordinates and pixels do not specify an action's semantics; a screenshot judgment is not proof |
| Typing, paste, `setValue`, secondary actions or navigation | Check the receiving context, including autosubmit and drag/drop destinations | An app can transmit immediately after input. Change events, drops and links can also trigger a save or send. Waiting for a Send button can miss the commit |

These proposed rules have unmeasured detection rates. They use the methods and observations in
T1 to T3 and the real-use tasks. A matching label would trigger a warning. An unmatched action
could still be harmful.[^t1][^t2][^t3][^web]

### Recorded examples

T1 has 28 computer-use approval requests: 18 `get_app_state`, five `press_key`, two `click`, and
one each of `drag`, `type_text` and `set_value`. All 28 carry `riskLevel: "low"`, and their
`tool_params` contain only `app`. Line 12 reaches the client. The later requests use
`answered-for-session`. Selected fields, without session identifiers:[^t1]

```json
{"line":12,"tool_name":"get_app_state","riskLevel":"low","tool_params":{"app":"com.apple.Chess"}}
{"line":22,"tool_name":"press_key","riskLevel":"low","tool_params":{"app":"com.apple.Chess"}}
{"line":39,"tool_name":"click","riskLevel":"low","tool_params":{"app":"com.apple.Chess"}}
{"line":53,"tool_name":"drag","riskLevel":"low","tool_params":{"app":"com.apple.Chess"}}
```

The method distinguishes reading from input, but the approval fields omit the button or key
involved. Sensitive-action detection remains untested. At line 74,
Chess returns `Window: "Save"` and `0 dialog Save, ID: save-panel`; TextEdit T2 line 29 returns
`Window: "Save"` and `0 sheet Description: save, ID: save-panel`. Matching only `sheet` would miss
the Chess case. These excerpts cover file dialogs, without a purchase, send or deletion.[^t1][^t2]

T3 line 23 refuses a click because element 44 changed from `button One` to a button
identified as `Three` earlier in the same call. A future confirmation must bind the current target, not just its
number. T2 line 31's forwarded JavaScript is shortened to 300 characters in the trace, as are long
UI strings. These logs cannot reconstruct every key, omitted label or later statement, so this
note does not infer such actions from them.[^t3][^t2][^trace]

### Real-use task coverage

The task definitions describe intended behavior, not evidence that every run performed it:

| Tasks | Proposed scope and confirms | What the task cannot establish |
| --- | --- | --- |
| Safari/Helium form and SPA request | Control for fields, one confirmation at Submit | Both use local fixtures; successful submission would not prove detection of a real purchase |
| Infinite records | Control for navigation and text, one confirmation at Confirm review | This tests another commit label, not sending or deletion |
| Grid, editor, dense and nested pages | Control for edits/navigation; confirm uncertain autosave or input effects | Their prompts alone do not prove that edits remain local or reversible |
| Preview PDF, Finder files and the TextEdit/Calculator transfer | Control for rotation, rename/move and copy/paste; confirm saves without verified recovery | An ambiguous save destination or moving to a destructive target would also require confirmation |
| Word, Excel and PowerPoint | Control for fixture edits; confirm overwrite or uncertain commit | Sign-in, activation, licensing and permission dialogs are explicit stops, not dialogs to approve automatically |
| Mail and Mimestream | Control for navigation/search; no send or delete authorized | Their tasks prohibit sending and deletion, so they cannot measure either detector's recall |

Sources: [desktop tasks](../../bench/tasks-real.mjs), [web tasks](../../bench/tasks-web.mjs),
[Office tasks](../../bench/tasks-office.mjs), [Mail tasks](../../bench/tasks-mail.mjs),
[Mimestream instructions](../../bench/real-mimestream.mjs#L86-L96). Mimestream's private message
contents are unnecessary for this design and are omitted.[^laws]

## Expiry and prompt text

Use explicit scope and duration in both the client elicitation and sleight's own panel. Today's
panel says an accepted session approval lasts until the Claude session ends; the client prompt
does not explain that duration.[^settings][^prompt]

Proposed wording, with the actual app and duration substituted:

| Lifetime | Read prompt | Control prompt |
| --- | --- | --- |
| Session, current lifetime | Allow Claude to read TextEdit's contents and screenshots until this Claude session ends? | Allow Claude to read and control TextEdit until this Claude session ends? Detected sensitive actions still ask separately. |
| N minutes, example N = 15 | Allow Claude to read TextEdit's contents and screenshots for 15 minutes from approval? | Allow Claude to read and control TextEdit for 15 minutes from approval? Detected sensitive actions still ask separately. |
| Turn | Allow Claude to read TextEdit's contents and screenshots until this response finishes? | Allow Claude to read and control TextEdit until this response finishes? Detected sensitive actions still ask separately. |

Each prompt should also say that these checks guard cooperative calls and can miss effects.
Buttons would be Allow and Don't allow. Read and control are separate decisions; do not default a
read request to control. Sensitive prompts always say Confirm once and omit duration choices.

Proposed expiry rules:

- Store grants in relay memory with app identity, scope, exact engine risk level, approval time
  and expiry. Clear them at session shutdown. Preserve today's separate risk checks.[^relay]
- Timed grants use a monotonic deadline starting when the user accepts. Each operation checks it
  immediately before dispatch, including later operations in a batch. Activity does not extend it.
  Expiry cannot retract an operation already dispatched.
- Turn means one response to a user message, including its tool calls, not one `js` call or a quiet
  period. End it on the host's turn-complete or Stop event. The existing idle cleanup is insufficient
  by itself. A host without a reliable turn event must refuse turn-scoped grants.[^turn]
- Scope upgrades keep the earlier deadline unless the user explicitly approves a new duration.
  Decline, cancel, missing UI and timeout grant nothing. An expired queued action asks again;
  expiry never silently falls back to session consent.

Today's `SLEIGHT_APPROVAL_SCOPE=once` disables relay approval memory. It does not provide timed
or turn expiry and does not cancel the engine's Always allow decisions.[^settings]

## Confirmation before irreversible actions

The proposed rule requires a fresh user decision immediately before sending, deleting, purchasing,
submitting a form, discarding unsaved work or another irreversible commit. Treat an uncertain
commit effect as sensitive. Do not wait for the app's own last confirmation: some actions commit
on the first click or keystroke. These categories follow track 6's requested policy. The traces
do not prove they can all be recognized.[^roadmap][^t1]

Show the actual app and window, exact action and target, visible destination/recipient/amount when
available, and the evidence that caused the warning. Missing details should say unknown. Let the
user inspect the full outgoing payload or document change locally; do not put those contents in
the grant audit. A proposed fixture prompt:

> Confirm submitting the filled form in Safari? Action: click Submit. Destination: the observed
> local fixture URL. This sends the fields shown in the preview. Confirm once / Don't allow.

The preview must come from the current observed fields, not Claude's summary. If it cannot be
collected safely, stop for the user to perform the final action. Existing change review covers
backed files after edits. It cannot supply a universal preview or undo a sent message.[^settings][^web]

Acceptance must be a user event from the host. Keep model output and page contents outside the
approval channel. A trusted version must prevent agent tools from operating its confirmation UI.
Today's `blocked_app` opt-in can permit clicks on ChatGPT approval buttons, so app consent alone
does not establish who pressed a confirmation. The pilot cannot guarantee this isolation across
other tools.[^settings][^document]

Bind acceptance to one operation, its arguments, app, observed window/URL and target identity,
plus the preview's contents. Serialize the pending action. After acceptance, read again and compare;
any changed context or payload requires another decision. Consume acceptance before dispatch.
Never replay it after an error, timeout or unknown outcome. A batch must stop before its sensitive
operation and revalidate the remaining actions afterward. T3's changed numbers and the document
guard's race limits motivate these checks. Revalidation still leaves a gap before native input.[^t3][^document]

Use the existing human prompt routes, with cancel/timeout refusing execution. Keep sensitive
confirmations distinct from ordinary app approval forms so the benchmark's app-message matcher
cannot answer them. The current five-minute panel timeout limits the wait for an answer. It does
not expire an accepted session grant.[^prompt][^settings][^benchmark]

### Interaction with existing approvals

| Existing authority | Proposed interaction |
| --- | --- |
| Engine app approval/refusal | Preserve its request and risk warning. A sleight grant cannot lift a refusal. Confirmation does not replace required engine consent. Never send `persist: "always"` |
| ChatGPT/Codex Always allow list | Keep it user-owned and read-only to sleight. Since it can suppress engine prompts, check scopes and sensitive operations independently. Ask for a sleight scope even when no engine prompt arrives |
| Benchmark allowlist | Preserve only the owner-authorized app coverage in benchmark runs. It cannot answer a sensitive confirmation. Headless runs without a person stop at that point; do not extend the hook or add apps |
| User's preapproved list | Version 1 contains app/risk ceilings, with no read/control, expiry or irreversible-action fields. Request an explicit pilot scope instead of reinterpreting old consent. It never approves the final action |
| Existing session grant | A legacy app/risk answer is not a scoped answer. Enter the pilot in a fresh session and obtain its scope explicitly |

The current sources establish these independent authorities: [LAWS](../status/LAWS.md#approvals-and-safety),
[settings](../settings.md#approval-scope), [preapproved design](preapproved-apps.md),
[benchmark hook](../../bench/approve.mjs) and [relay approval handling](../../plugins/sleight/lib/relay.mjs#L1600-L1647).
The user list remains at `~/Library/Application Support/sleight/preapproved.json`, loaded from its
fixed path. No project, plugin or environment value may add entries to either sleight list.
Only an explicit owner order can authorize an edit to the user list, with the preservation and
end-date requirements in LAWS. This proposal changes neither list nor ChatGPT settings.[^laws][^preapproved]

## Public comparisons

Public documentation read 2026-10-09; these are documented behaviors, not new local tests.

| Product | Documented approval behavior | Implication for sleight |
| --- | --- | --- |
| Codex/ChatGPT Computer Use | Per-app consent, persistent Always allow with removal in settings, and possible extra requests for sensitive or disruptive actions | Keep app consent separate from commit review. The docs do not specify a universal irreversible-action guarantee or user-selectable read/control timers[^openai] |
| LCU on macOS | Native pane offers conversation, Always allow when the runtime offers it, and deny. Tool auto-approval leaves app consent in force. App-list allow/revoke uses Touch ID or password; its docs call that a convenience guard over an ordinary account file | Reuse the clear distinction between tool and app approval. sleight's laws prohibit adopting LCU's writes to the shared ChatGPT list. The cited docs do not advertise read/control/sensitive grants with N-minute expiry[^lcu][^lcuapps][^laws] |
| Claude Code's own computer use | App approvals last for the session. Broad-access apps show warnings. Fixed tiers are view-only for browsers/trading, click-only for terminals/IDEs, and full control otherwise | The app category fixes its tier. Desktop docs specify 30 minutes for Dispatch-spawned sessions. The cited Code pages leave universal confirmation before irreversible actions unspecified[^claude][^claudedesktop] |

Anthropic's separate Cowork safety guide describes imperfect training safeguards and notes that an
action in an allowed app can affect another app. That supports keeping indirect effects explicit;
it does not establish an enforcement guarantee for Claude Code's action classifier.[^cowork]

## Prompt cost and remaining limits

For the pilot, request the needed scope at first use. If the task needs input, ask for Read and
control directly. Let A be apps without an explicit pilot grant, U later read-to-control
upgrades, and C sensitive or uncertain operations. The proposed sleight prompt count is A + U + C,
plus any independent engine, flow or local-tool asks. Version one keeps scope upgrades and final
action confirmations separate.

Illustrative costs, not replay measurements:

| Task in a fresh session | Proposed sleight prompts, assuming known ordinary targets |
| --- | --- |
| Calculator button calculation | 1 control grant |
| TextEdit/Calculator transfer and save over the original | 2 control grants + 1 save confirmation without verified recovery = 3 |
| Safari fixture form or SPA request | 1 control grant + 1 submit confirmation = 2 |
| Mail navigation | 1 control grant, no send/delete approval |
| Read first, then edit in the same app | 1 read grant + 1 control upgrade = 2 |

These examples use the task definitions above. T1 shows why scopes should not prompt on every
low-risk event: one Chess task generated 28 engine approval requests. Existing benchmark grants
can remove ordinary app asks today, but cannot remove the proposed confirmation.[^t1][^benchmark]

N-minute expiry would add one renewal for each app/scope used after its deadline; turn expiry
would ask again in each response that uses the app. Human response time, unknown-target prompts,
classification accuracy and extra reads are unmeasured. Do not claim a measured speed or safety
improvement from this design.

Version one should defer timer configuration, navigation-only grants and persistent scope schemas.
It should keep unsupported or unreviewable final actions with the user. It cannot catch every
localized or deceptive label, automatic save/send, indirect app effect, event race, or operation
through another tool. Raw JavaScript can bypass the guard or forge the observations a relay gate
uses. A guarantee of confirmation before every irreversible effect needs trusted enforcement and a
restricted supported surface; the current engine cannot supply that through the approval fields
seen here.[^t1][^document][^laws]

Before code work, obtain the owner's ruling on the cooperative pilot, the refusal of unknown
effects, and the exclusion of arbitrary JavaScript from scoped mode. A later approved
validation plan should include deceptive/localized labels, input-triggered commits, batches,
expiry during a prompt, stale targets, saved approvals, headless refusal and attempted bypasses.
Keep the read-only mail tasks restricted to reading. Never use them for send/delete tests.[^mail][^laws]

## Sources

Trace line numbers are one-based JSONL records. Paths use `$TMPDIR`; the three hashes identify the
original private files. Only the small field excerpts above are published. Long strings are already
shortened by the trace writer. This note uses the recorded excerpts without reconstructing omitted
text or screenshots.[^trace]

[^t1]: `$TMPDIR/sleight-bench/2026-10-09T22-25-01-496Z/sleight-chess-drag-1/trace-35769.jsonl`, lines 12 to 13, 19 to 130 (approval records), 74 (Save dialog). SHA-256: `f29bbfa62c1e693c8aaa8071abc98ae5048f60338dba99d5365a51e827d9aea3`.
[^t2]: `$TMPDIR/sleight-bench/2026-10-09T22-25-01-496Z/sleight-textedit-save-1/trace-34270.jsonl`, lines 29 (Save sheet), 31 (shortened forwarded code), 38 (document window). SHA-256: `a67740535cb3a6815679bcd0ec38d8fe235d5cde23a6c8cb95e0afca8537800b`.
[^t3]: `$TMPDIR/sleight-bench/2026-10-09T20-12-27-195Z/sleight-calculator-click-1/trace-52207.jsonl`, line 23 (stale element refusal). SHA-256: `bdeb6dcc15e7ea14ab25f2426d7fc9436cf521b52d058e44c3d20ffe866b83b0`.
[^roadmap]: [ROADMAP, track 6](../status/ROADMAP.md#6-features-after-replay).
[^laws]: [LAWS, approvals and safety, engine and method](../status/LAWS.md).
[^settings]: [Settings, approval scope, preapproved apps and change review](../settings.md).
[^preapproved]: [Preapproved apps design](preapproved-apps.md).
[^document]: [Document scope, advisory guard and failure limits](document-scope.md).
[^relay]: [Relay app/risk key](../../plugins/sleight/lib/relay.mjs#L171-L184) and [session answer handling](../../plugins/sleight/lib/relay.mjs#L845-L867).
[^guard]: [Action target and stale-element checks](../../plugins/sleight/lib/document-scope.mjs#L300-L335).
[^trace]: [Trace writer, long strings shortened after 300 characters](../../plugins/sleight/lib/launch.mjs#L140-L153).
[^prompt]: [Native approval panel routing](../../plugins/sleight/lib/launch.mjs#L195-L216).
[^turn]: [Relay lifecycle and idle cleanup](../../plugins/sleight/lib/relay.mjs#L54-L57), [turn cleanup](../../plugins/sleight/lib/relay.mjs#L1681-L1698).
[^benchmark]: [Benchmark approval hook](../../bench/approve.mjs), [authorized benchmark apps](../../bench/tasks.mjs#L122-L132).
[^mail]: [Mail restrictions](../../bench/tasks-mail.mjs), [Mimestream restrictions](../../bench/real-mimestream.mjs#L86-L96).
[^web]: [Web task instructions](../../bench/tasks-web.mjs), [fixture form and other desktop tasks](../../bench/tasks-real.mjs).
[^openai]: [Official OpenAI Computer Use documentation, permissions and approvals](https://learn.chatgpt.com/docs/computer-use#permissions-and-approvals).
[^lcu]: [LCU README, native approval pane](https://github.com/amontlabs/lcu#approve-apps-from-claude-natively), [adapter approval boundary](https://github.com/amontlabs/lcu/blob/main/docs/ADAPTERS.md#approval-boundary).
[^lcuapps]: [LCU installation, manage approved apps](https://github.com/amontlabs/lcu/blob/main/docs/INSTALLATION.md#manage-approved-apps).
[^claude]: [Claude Code computer use, approve apps per session](https://code.claude.com/docs/en/computer-use#approve-apps-per-session).
[^claudedesktop]: [Claude Code Desktop, app permissions](https://code.claude.com/docs/en/desktop#app-permissions).
[^cowork]: [Anthropic Cowork computer-use safety guide, permissions and safety](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork).
