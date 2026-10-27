import { parseTypedApps, isPresent, predictApps, upfrontAsk, remoteApprovalNotice, physicalApprovalNotice, resolveApp } from './remote-approvals.mjs';
// A stdio relay between Claude Code and the computer-use server.
//
// The server scopes app approvals and cleanup to a Codex session and turn,
// read from `_meta["x-codex-turn-metadata"]` on each tool call. Claude Code
// sends no such field, so the relay supplies it:
//
// - session_id: one per relay process. Claude Code starts one server process
//   per session, so approvals last for the session, as in Codex.
// - turn_id: rotates each time the turn ends. A `turn_ended` call (sent by the
//   sleight mod at the end of each Claude turn) gets the current ids filled
//   in, then the next call starts a new turn.
//
// Claude Code 2.1.288 opens with a `server/discover` probe from a newer MCP
// protocol; the server exits on any request before `initialize`, and Claude
// Code then restarts it on the older protocol. The relay answers the probe
// with "method not found" itself, so the server isn't killed.
//
// It also keeps the server's js_add_node_module_dir tool out of the model's
// tool list, marks turn_ended as internal (it stays listed because Claude Code
// only lets the mod call listed tools; the mod refuses model calls to it), and
// ends the open turn when Claude Code closes the connection.
//
// App approvals: the server asks before each action on an app and never
// remembers an answer for a session itself. In Codex, the host remembers "Allow
// for this session" and answers the repeats. Claude Code's prompt can only
// accept or decline, so the relay plays that part: once the user accepts an app,
// later approval requests for the same app and risk level are answered with the
// same accept, for the life of this process (one Claude Code session). A
// different app, a riskier request or a new session reaches the user. Declines
// and cancels are never remembered, and nothing is stored on disk.
// `approvalScope: 'once'` turns this off.
//
// `ask`, when given, asks the user about app approvals instead of forwarding
// them to Claude Code: `ask(message, sessionScoped)` resolves to 'accept',
// 'decline' or 'cancel'. launch.mjs uses it under the desktop app, which
// declines MCP prompts without showing them. Session memory works the same way.
// Review calls supply a third argument `{ kind: 'review', detail }` and expect
// the user's 'keep', 'undo' or 'cancel'. These answers are never session grants.
//
// `localTools`, when given, are sleight's own tools, answered here and never
// sent to the server: `{ tools, call(name, args, approve) }`. `approve(key,
// message, options)` asks the user once per key and session, through `ask`
// when given, else through an elicitation sent to Claude Code. launch.mjs uses
// this for the menu bar and notifications, which the engine can't reach.
// `options.once` asks and is never remembered (a terminal command send);
// `options.kind` and `options.detail` shape the prompt.
//
// The relay annotates the engine's refusals of Terminal, iTerm2 and OpenAI's
// own apps with the one setting that lifts them, which only the user runs (see
// blocked-apps.mjs). The refusal itself is OpenAI's and is never changed.
//
// `idleTurnEndMs`, when given, ends a used turn once no engine call has been
// running for that long. Hosts without the mod (the desktop app's Claude Code)
// never end the engine's turn, and the engine keeps holding the app (its badge
// on the window) until the session closes.
//
// `trace`, when given, receives every message as it passes, for debugging.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isV3Frontend, isV3Bridge, failure as turboFailure } from './direct-browser/worker.mjs';
import { browserBundleId } from './direct-browser/browsers.mjs';
import { engineBrowserOpen as engineBrowserOpenSetting, engineOpenTool, widenTurboOpen, turboRoute, parseEngineOpen, siteOf, acquisitionCode, openCode,
  openedNote, invalidAppReply, invalidAppNote, notBrowserNote, unknownBrowserNote, browserWindowProblem, withBrowserOpenFirst, CLEANUP_NOTE, DOCUMENT_SCOPE_NOTE, STOPPED_NOTE } from './engine-browser-open.mjs';
import { pageSite } from './permissions.mjs';
import { DOCUMENT_TOOL, WINDOW_HEADER, documentKey, documentLabel, windowFromText, lastWindowFromText, isDocumentRead, withoutEcho, readCode, guardedCode, WINDOWS_MARK, GUARD_READY, GUARD_MARK, GUARD_END, GUARD_OMIT_MARK, menuRoot, selectedMenuEntry } from './document-scope.mjs';
import { ChangeReview, REVIEW_TOOL, isChangeCancel } from './change-review.mjs';
import { FLOW_TOOL } from './flow-rules.mjs';
import { NATIVE_HANDOFF_TOOL, openNativeHandoffUi } from './native-handoff.mjs';
import { createHandoffWaiter, HANDOFF_WAIT_MS, handoffMessages } from './direct-browser/handoff.mjs';
import { browserCall, browserReply, nativeBindings, browserLeaseNote } from './browser-call.mjs';
import { nativeArgumentsProblem } from './native-arguments.mjs';
import { BrowserRecovery } from './browser-recovery.mjs';
import { selectedBrowserCode } from './browser-discovery.mjs';
import { rewritePaymentPolicy } from './payment-policy.mjs';
import { requestedSubmitRules } from './requested-submit.mjs';
import { rewriteWorkflow } from './workflow-docs.mjs';
import { createPaymentMessages, PAYMENT_ALLOWED, PAYMENT_WAITING } from './payment-gate.mjs';
import { rewriteBrowserInstructions, isNativeGetState, WINDOWS_LINE, withFirstCallWindows, withInventoryNote } from './engine-app-docs.mjs';
import { rewriteTabError, isTabBinding } from './tab-errors.mjs';
import { isLeaseRead, isFilteredRead } from './input-lease.mjs';
import { evaluateWrite } from './evaluate-write.mjs';
import { verifyWindowIdentity } from './window-identity.mjs';
import { guardStopMark, splitMenuActions, takeGuardStop, withoutStopTree, hasWholeTree, menuRemainder, dialogRemainder, dialogRefusal, returnRefusal, windowGone, stopNote, continuedNote, menuIdentity,
  unchangedMenuWindow, menuWindowRefusal, idleSample, tabRefusal, tabRemainder, tabFocusRefusal, shownStandardWindows, parentLeaseRefusal, parentLeaseGate,
  failedActionText, paletteRefusal, oneTabAdded, landingRefusal, replaceLastTree, lastHeader } from './menu-continuation.mjs';
import { checkedStop, stopText } from './checked-stop.mjs';
import { TurnOutcomes, unconfirmedInput } from './turn-outcomes.mjs';
import { resultCompleteness, filteredRead } from './read-completeness.mjs';
import { stripHandBindings } from './hand/bindings.mjs';
import { narrationLine } from '../hooks/narration.mjs';
import { cursorRecord } from './hand/events.mjs';
import { createSessionPause, PAUSED_NOTE, PAUSE_DRAIN_NOTE, PAUSE_CONTROL_LOST_NOTE, NATIVE_PAUSE_CUT_NOTE } from './session-pause.mjs';
import { stripGuardTiming } from './guard-timing.mjs';
import { stripDP1Trace } from './dp1-trace.mjs';
import { createStuckEscapes } from './stuck-escape.mjs';
import { isInventoryRead } from './inventory-read.mjs';
import { createReadCompactor, dropAcquisitionTree, hasFullTree, filteredReadCode, filteredReadMark, failureReason, TEXTLESS_NOTE } from './compact-reads.mjs';
import { promptNotice } from './prompt-notice.mjs';
export { promptNotice };
import { dropRepeatedText } from './repeated-text.mjs';
import { ruleDelivery, guidanceForHost } from './rule-delivery.mjs';
import { typedTextReceipt, typingReceiptCall, typingReceiptCode, withoutTypingReceipt, typingReceiptTarget } from './typed-text-receipt.mjs';
import { createBrowserStaleGuard } from './browser-stale.mjs';
import { literalElements } from './literal-elements.mjs';
import { createResultBudget, requestsFullDocumentation, grokResult } from './result-budget.mjs';
import { forbiddenTargetWarning, isForbiddenSettingsWindow, refusalNotice, refusedApp } from './blocked-apps.mjs';
import { OWN_HOST_LINE, AUTH_DIALOG_LINE, isOwnHost, ownLine, mentionsOwnHost, namesOwnHost as appNamesOwnHost, getAppTargets, ownHostPid as isOwnHostPid } from './own-host.mjs';
import { clipboardCode, clipboardPlan, clipboardActions, createClipboardSession, createNativeClipboardIO } from './clipboard.mjs';
import { fillFormCode } from './fill-form.mjs';
import { dragToCode } from './drag-to.mjs';
import { pickFromListCode } from './pick-from-list.mjs';
import { backgroundLinksCode } from './browser-background-links.mjs';
import { browserAliasesCode, createBrowserAliasNotices } from './browser-aliases.mjs';
import { reorderCode, rewriteDragAttempt } from './reorder.mjs';
import { offscreenNotes, withOffscreenNotes } from './offscreen-click.mjs';
import { isBrowserRead } from './browser-read.mjs';
import { tabCleanupCode, cleanupTabsBefore, cleanupTimeoutNote } from './browser-tab-cleanup.mjs';
import { ReplWarmup, replSetupCode, browserWarmupUseCode } from './repl-warmup.mjs';
import { documentationOrigin } from './documentation-origin.mjs';
import { TabClickResults } from './tab-click-result.mjs';
import { openedTabNote, tabReuseCode, readOpened, createdTabCall, parseOpenedPayload } from './tab-reuse.mjs';
import { menuBarOnlyNote, offSpace, offSpaceNote, readFailureAdvice, savePanelNote } from './read-failure.mjs';
import { TurnJournal, writeReceipt } from './turn-receipts.mjs';
import { TurnStats, unavailableStatsFrame } from './turn-stats.mjs';
import { simulatorScreenshotNote } from './simulator-focus.mjs';
import { splitTextSave } from './text-save.mjs';
import { autoPrintCode, noOutputNotice } from './no-output.mjs';
import { withoutPageCallbacks } from './page-callbacks.mjs';
import { leanCallDescription } from './lean-calls.mjs';
import { initializationAdvice } from './initialization-guidance.mjs';
import { syntaxErrorHint, syntaxOrigin } from './syntax-errors.mjs';
import { compactJsDescription, engineJsVariant } from './tool-description.mjs';
import { createLightReturn, createCloseRead, lightReturnCode } from './light-return.mjs';
import { createTabProbe, nativeTabPlan } from './tab-probe.mjs';
import { hostLabel, isGrokClient } from './host-label.mjs';
import { TURN_START, TURN_START_TOOL, codexCallTurn, codexTurnClient, codexTurnFrame } from './codex-turn.mjs';
import { rootWindowId, popupWindows } from './popup-window.mjs';

// App handles have getAXState but no getState; only cua has getState. 13 of 27 sleight runs wrote app.getState
// in their first call and 8 errored, losing a turn each (Fable study, 2026-10-17 11:53Z pass).
export function nativeGetStateCode(code, isNative = () => false, isBrowser = () => false) {
  if (typeof code !== 'string' || !code.includes('getState')) return code;
  // Same-length mask, so text typed into a document ("see app.getState()") is never rewritten.
  const masked = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, v => ' '.repeat(v.length));
  const bound = new Set(), other = new Set();
  for (const m of masked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(await\s+cua\s*\.\s*getApp\s*\()?/g)) (m[2] ? bound : other).add(m[1]);
  let out = '', last = 0;
  for (const m of masked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(\s*(?:\?\.|\.)\s*)getState(?=\s*\()/g)) {
    const id = m[1];
    if (id === 'cua' || !(bound.has(id) || (!isBrowser(id) && (isNative(id) || (id === 'app' && !other.has(id)))))) continue;
    const at = m.index + id.length + m[2].length;
    out += code.slice(last, at) + 'getAXState'; last = at + 'getState'.length;
  }
  return last ? out + code.slice(last) : code;
}

// Compile without executing. A complete prefix excludes function bodies and blocks; an invalid
// token in place of return distinguishes executable code from comments, strings and regexes.
export function finalReturnCode(code) {
  if (typeof code !== 'string' || code.length > 32768 || !/(?<![\w$])return(?![\w$])/.test(code)) return code;
  const valid = body => {
    try { new Script(`async function __sleightReturn() {\n${body}\n}`); return true; }
    catch { return false; }
  };
  if (!valid(code)) return code;
  const trivia = '(?:\\s|//[^\\n]*(?:\\n|$)|/\\*[\\s\\S]*?\\*/)*';
  const returns = [...code.matchAll(/(?<![\w$])return(?![\w$])/g)];
  if (returns.length > 128) return code;
  for (const match of returns) {
    const prefix = code.slice(0, match.index), tail = code.slice(match.index + 6);
    if (!valid(prefix) || valid(prefix + '@' + tail)) continue;
    const leading = new RegExp('^' + trivia).exec(tail)[0];
    if (/[\r\n\u2028\u2029]/.test(leading)) continue; // return's ASI must stay intact.
    const value = tail.slice(leading.length);
    const end = new RegExp(';' + trivia + '$').exec(value)?.index ?? value.length;
    const expression = value.slice(0, end);
    if (!expression.trim() || !valid(`return (\n${expression}\n);`)) continue;
    const wrapped = /^(?:\{|(?:async\s+)?function\b|class\b)/.test(expression) ? `(${expression})` : expression;
    // A `;` keeps a value that starts with ( [ ` / + - from joining an unterminated previous line:
    // `x\nreturn (y)` must not become `x(y)`.
    const joins = /^[([`/+-]/.test(wrapped) && prefix.trim() && !prefix.trimEnd().endsWith(';');
    const rewritten = prefix + (joins ? ';' : '') + wrapped + value.slice(end);
    if (valid(rewritten)) return rewritten;
  }
  return code;
}

// `app.click(3); …` with no await and more code after it: the call goes on without the action,
// and a failure then ends the session. A last statement is fine, since the call returns its promise.
// Strings are blanked first, so typed text that mentions an action doesn't count.
export function unawaitedAction(code) { return unawaitedCall(code)?.method; }

// The methods an engine handle takes. Input methods act on the app; read methods only look. One list for the unawaited-action
// check and for the handles a call uses (recovery must see every handle an action goes through, GA1).
const INPUT_METHODS = 'click|drag|dragTo|scroll|selectText|setValue|performSecondaryAction|paste|press|pressKey|typeText|pickFromList';
const HANDLE_METHODS = `${INPUT_METHODS}|doubleClick|rightClick|getAXState|getAXStateAndScreenshot|getScreenshot|waitFor|getJsDialog`;
const UNAWAITED_CALL = new RegExp(String.raw`(?:^|[;{}\n])\s*((?:(?:const|let|var)\s+)?[A-Za-z_$][\w$]*\s*=\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:${INPUT_METHODS})\()`, 'g');

function unawaitedCall(code) {
  code = withoutPageCallbacks(code);
  const bare = code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, literal => literal.replace(/[^\r\n]/g, ' '));
  for (const m of bare.matchAll(UNAWAITED_CALL)) {
    let end = m.index + m[0].length - 1, chained = false;
    for (;;) {
      let depth = 0;
      for (; end < bare.length; end++) {
        if (bare[end] === '(') depth++;
        else if (bare[end] === ')' && --depth === 0) break;
      }
      const chain = /^\s*\.\s*(?:then|catch|finally)\s*\(/.exec(bare.slice(end + 1));
      if (!chain) break;
      chained = true;
      end += chain[0].length;
    }
    if (m[1] ? chained : bare.slice(end + 1).replace(/^\s*;?/, '').trim()) {
      const start = m.index + m[0].lastIndexOf(m[2]);
      return { method: m[2], line: bare.slice(0, start).split('\n').length };
    }
  }
}

// `require(` outside strings and comments. The engine's REPL has none: 3 of 20 textedit-save runs spent a
// turn on `require('fs')` checking a save the result had confirmed (Fable study, 2026-10-17).
const codeOnly = code => String(code).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ')
  .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
export function usesRequire(code) {
  return /(?<![\w$.])require\s*\(/.test(codeOnly(code));
}
// A call that uses require and nothing of the engine's (cua, sleight or a handle method) can only fail.
export function requireOnly(code) {
  return usesRequire(code) && !/\b(?:cua|sleight)\s*\.|\.\s*(?:getAXState|getScreenshot|getAXStateAndScreenshot|click|drag|dragTo|scroll|selectText|setValue|performSecondaryAction|paste|press|pressKey|typeText|waitFor|getJsDialog|emitImage)\s*\(/.test(codeOnly(code));
}
function requireNote(refused, saved, prompt) {
  return promptNotice((refused ? 'sleight stopped this call before it ran: ' : 'sleight: ') + '`js` has no `require` and no file system access.' +
    (saved ? " The save result's `on disk:` field already gives the saved file's size and kind." : ''), prompt);
}

// The skill's rules for an open_file result under SLEIGHT_OPEN_RULES=short: without what open_file already
// did (acquiring, choosing a window, opening a document), tap coordinates, the drag, hover and banner tools,
// and the doctor line. Every safety passage stays word for word, and a heading left empty goes too.
const OPEN_DROPS = /^(?:- When the task specifies an app|- After renumbering|- If acquisition returns an empty tree|- Among windows|- A window other than the one getApp shows|- Multiply tap coordinates|- Acquire a document that's already open|- Reorder rows or move selected text|- Engine events don't trigger hover|(?:- )?In a browser, |- `notifications` presses|Rows, text selected in |If `js` fails to start|Startup failure: )/;
export function openFileRules(rules) {
  if (typeof rules !== 'string') return rules;
  const blocks = [];
  for (const line of rules.split('\n')) {
    const starts = !blocks.length || !line.trim() || /^(?:- |#)/.test(line) || !blocks.at(-1).at(-1).trim() || /^#/.test(blocks.at(-1)[0]);
    if (starts) blocks.push([line]); else blocks.at(-1).push(line);
  }
  const kept = blocks.filter(block => !OPEN_DROPS.test(block[0]));
  const out = kept.filter((block, i) => {
    if (!/^#/.test(block[0])) return true;
    const next = kept.slice(i + 1).find(b => b[0].trim());
    return next && !/^#/.test(next[0]);
  });
  return out.map(block => block.join('\n')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const META_KEY = 'x-codex-turn-metadata';
const HIDDEN_TOOLS = new Set(['js_add_node_module_dir']);
const TURN_END_TOOL = 'turn_ended';
// The engine tells the model to send only an acquisition first. In 798 of 799 benchmark sessions the
// first call held no action, though sleight acquires and checks the window before any that follow
// (batching study, 2026-10-09). Rewritten only while the engine's sentence is exactly this.
const FIRST_CALL_RULE = 'execute exactly one of the API calls shown below, optionally assigning its result to a variable. Do not add other API calls, waits, or snapshots to that invocation.';
// Chaining past Cmd+N or Cmd+O got the lease to stop 10 of 12 TextEdit batches (2026-10-09), hence its last clause.
// Naming getApp here: before its first call Claude sees only the engine's list, whose one native-looking
// entry is cua.getState(), and 50 of 80 runs spent their first turn on it. With this wording 0 of 12
// did, with turns 7.91 to 7.17 and total time 30.6 s to 27.0 s a run, every run passing (A/B, 2026-10-11).
const FIRST_CALL_BATCH = 'start with one of the API calls shown below, assigning the app to a variable. For a Mac app you can name, start with `let app = await cua.getApp("Calculator")` (its name or bundle ID): it returns that app\'s UI state. Use cua.getState() only to find an app or browser you can\'t name. When you already know the first actions on that app, put them after it in the same call: sleight acquires the app and checks its window before they run. Chain every later action whose target you already know (keys, text, `{ id }` or `{ label }` clicks) in one call too, but end the call after a shortcut that opens or names a window (Cmd+N, Cmd+O, or Cmd+S on an untitled document): sleight stops the rest of a call when its window changes.';
const selectedMenuItem = text => selectedMenuEntry(text)?.number;
const OPEN_MENU = /^\t*(\d+) menu (?:[^\n]*, )?Secondary Actions: [^\n]*\bCancel\b/m;

// An open menu in front of a window reads as "0 menu Secondary Actions: Cancel". Escape left it open in
// 3 of 3 tries in the head-to-head (TextEdit and Finder, 2026-10-09), and its Cancel action closed it.
// `shown` counts earlier stuck-menu notes for this window. In word-edit-1 (2026-10-17) the short note
// repeated through 15 calls of Escape and clicks while typing never reached the document.
export function openMenuNote(text, prompt, shown = 0) {
  const menu = typeof text === 'string' && OPEN_MENU.exec(text);
  if (menu) return promptNotice(`sleight: a menu is open (element ${menu[1]}). Escape doesn't always close a menu in a background app; \`await app.performSecondaryAction(${menu[1]}, "Cancel")\` does.`, prompt);
  const entry = selectedMenuEntry(text), number = entry?.number;
  if (!number) return;
  // Escape and clicking the menu-bar item left Word's Table menu open or reopened it, and its Cancel action closed it
  // (word-edit-2, 2026-10-18). The element with Cancel is the item's own line, or its menu read as a root.
  // With no Cancel on that line, Cancel on the item did nothing; clicking it opened its menu, whose Cancel closed it
  // (word-edit-1, 2026-10-18, lines 120 to 136).
  const cancel = cancelTarget(text, entry.title);
  if (shown >= 2) return promptNotice(`sleight: a menu may still be stuck open (menu-bar item ${number}), and keys may be swallowed while it is. Check that typing landed (a value or count in the tree changed), and switch route (a toolbar or ribbon control, or a keyboard shortcut) instead of repeating Escape or clicks.${cancel === undefined ? ` Or click ${number} to open its menu, then close that menu with \`await app.performSecondaryAction(<its menu>, "Cancel")\`; Cancel on the menu-bar item alone does nothing.` : ''}`, prompt);
  return shown ? `sleight: a menu may still be stuck open (menu-bar item ${number}).` : cancel === undefined
    ? promptNotice(`sleight: a menu may be stuck open: menu-bar item ${number} is selected with no menu showing, and keys may not reach the document. Click ${number} to open its menu, then close that menu with \`await app.performSecondaryAction(<its menu>, "Cancel")\`; Cancel on the menu-bar item alone does nothing.`, prompt)
    : promptNotice(`sleight: a menu may be stuck open; keys and clicks may not reach the document. Close it with \`await app.performSecondaryAction(${cancel}, "Cancel")\`, not Escape or a click; if it stays open, tell the user.`, prompt);
}
// What the result says after sleight's one Escape to a stuck menu (stuck-escape.mjs), or today's note when none went out.
export function stuckEscapeNote(result, app, number, fallback, prompt) {
  if (result?.posted !== true) return fallback;
  if (result.selected === false) return /* notice */ promptNotice(`sleight sent one Escape to ${app} to close a stuck menu (menu-bar item ${number}); no menu-bar item is selected now. The tree above is from before it.`, prompt);
  if (result.selected === true) return /* notice */ promptNotice(`sleight sent one Escape to ${app} to close a stuck menu (menu-bar item ${number}); the item is still selected.`, prompt) + (fallback ? '\n' + fallback : '');
  return /* notice */ promptNotice(`sleight sent one Escape to ${app} to close a stuck menu (menu-bar item ${number}). Read the window to check that it closed.`, prompt);
}
function cancelTarget(text, title) {
  for (const line of text.split('\n')) {
    const m = /^\t*(\d+) (?:\([^)]*\) )*(.*?), (?:[^\n]*, )?Secondary Actions: (?:[^,\n]*, )*Cancel(?:,|$)/.exec(line);
    if (m && m[2].replace(/^menu bar item (?:\([^)]*\) )*/, '') === title) return m[1];
  }
}

// A menu note from earlier in a call (its acquisition, or the part before a menu continuation) is stale when
// the call's last tree shows the same window whole with no menu: the call's own click consumed it. excel-edit
// runs 1 and 5 repeated it 4 to 5 times (2026-10-17). A compacted view or a diff can't show the menu gone, and
// another window's tree says nothing about the window the note came from.
const MENU_NOTE_LINE = /^sleight: a menu (?:is open|may (?:still )?be stuck open)\b[^\n]*(?:\n|$)/gm;
const headerLine = text => /^Window: [^\n]*/.exec(text)?.[0];
export function dropStaleMenuNotes(head, rest) {
  const text = (rest ?? []).filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
  const at = text.lastIndexOf('Window: ');
  if (at < 0) return head;
  const tree = text.slice(at), header = headerLine(tree);
  // A compacted view keeps only the root line, so a root with a Cancel action counts as a menu here.
  if (!/^0 /m.test(tree) || /^0 [^\n]*\bSecondary Actions: [^\n]*\bCancel\b/m.test(tree) || menuRoot(tree) || OPEN_MENU.test(tree)) return head;
  // A last tree, whole or a diff, that adds a selected menu-bar item and no menu: the menu closed and the
  // stuck-menu note covers what is left, so only an earlier "is open" note goes. word-edit-1 kept both (2026-10-17).
  const stuck = !!selectedMenuItem(tree) || /^\+ \t*\d+ (?:menu bar item )?\([^)]*\bselected\b[^)]*\)/m.test(tree);
  if (!stuck && /…\(\d+\)|^[+~\-] |sleight: (?:lines changed|no change since)/m.test(tree)) return head;
  let changed = false, before = '';
  const out = head.flatMap(item => {
    if (item?.type !== 'text' || typeof item.text !== 'string') return [item];
    // Each note belongs to the last Window header before it, in this item or an earlier one.
    const kept = item.text.replace(MENU_NOTE_LINE, (note, offset) => {
      if (stuck && !note.startsWith('sleight: a menu is open')) return note;
      const preceding = before + item.text.slice(0, offset);
      const from = preceding.lastIndexOf('Window: ');
      return from >= 0 && headerLine(preceding.slice(from)) === header ? '' : note;
    });
    before += item.text + '\n';
    if (kept === item.text) return [item];
    changed = true;
    return kept.trim() ? [{ ...item, text: kept.replace(/\n+$/, '') }] : [];
  });
  return changed ? out : head;
}

// Each tree in a result: its item, its span (with the guard mark that wraps it, if any) and its text.
function resultTrees(content) {
  const trees = [];
  (content ?? []).forEach((item, index) => {
    if (item?.type !== 'text' || typeof item.text !== 'string') return;
    for (const match of item.text.matchAll(/^Window: /gm)) {
      const next = /^(?:Window: |\[\/?sleight:|sleight: )/gm;
      next.lastIndex = match.index + 1;
      const end = next.exec(item.text)?.index ?? item.text.length;
      const guarded = item.text.slice(0, match.index).endsWith(GUARD_MARK);
      trees.push({ index, start: guarded ? match.index - GUARD_MARK.length : match.index, end, guarded, text: item.text.slice(match.index, end) });
    }
  });
  return trees;
}
const isMenuTree = tree => menuRoot(tree) || OPEN_MENU.test(tree);
const WINDOW_ROOT = /^0 (?:(?:standard|floating|system|dialog) window|window|sheet|dialog)\b/m;
export const menuWindowKey = window => window && JSON.stringify([window.title, window.app]);
const commentless = code => String(code ?? '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');

// textedit-save (2026-10-17, transcript lines 22-36): the Cancel the menu note advised closed the menu, but the
// result printed the acquisition's menu tree above the window's, and Claude doubted it and sent Escape and a
// re-read. A call that cancels a menu (its Cancel action or Escape) and ends on that window with no menu says
// so, and its earlier menu trees of that window go. `wasOpen` answers for a window whose last result was a menu.
// `head` is a split call's acquisition result, which the relay puts before the rest's `content`.
const MENU_CLOSED_NOTE = /* lean notice */ 'sleight: the menu closed.';
const CLOSES_MENU = /\.\s*performSecondaryAction\s*\([^)]*,\s*(['"`])Cancel\1\s*\)|\.\s*pressKey\s*\(\s*(['"`])esc(?:ape)?\2/i;
export function closedMenuContent(content, code, wasOpen = () => false, prompt, head = []) {
  if (!Array.isArray(content) || !CLOSES_MENU.test(commentless(code))) return;
  const trees = resultTrees([...head, ...content]), last = trees.at(-1);
  if (!last || last.index < head.length || isMenuTree(last.text) || !WINDOW_ROOT.test(last.text) || selectedMenuItem(last.text) || /…\(\d+\)/.test(last.text)) return;
  const window = windowFromText(last.text), key = menuWindowKey(window);
  if (!key) return;
  const menus = trees.slice(0, -1).filter(tree => isMenuTree(tree.text) && menuWindowKey(windowFromText(tree.text)) === key);
  if (!menus.length && !wasOpen(window)) return;
  // Menu notes before the last tree that follow this window's header go too.
  let before = '';
  const strip = (item, index) => {
    if (item?.type !== 'text' || typeof item.text !== 'string') return [item];
    // A guarded read becomes an omitted one, which the read compactor leaves out.
    const edits = menus.filter(tree => tree.index === index).map(tree => tree.guarded
      ? { start: tree.start, end: tree.start + GUARD_MARK.length, text: GUARD_OMIT_MARK } : { start: tree.start, end: tree.end, text: '' });
    if (index < last.index) for (const note of item.text.matchAll(MENU_NOTE_LINE)) {
      const preceding = before + item.text.slice(0, note.index), from = preceding.lastIndexOf('Window: ');
      if (from >= 0 && menuWindowKey(windowFromText(preceding.slice(from))) === key) edits.push({ start: note.index, end: note.index + note[0].length, text: '' });
    }
    before += item.text + '\n';
    if (!edits.length) return [item];
    let text = item.text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    return text.trim() ? [{ ...item, text: text.replace(/\n{3,}/g, '\n\n') }] : [];
  };
  return { head: head.flatMap((item, i) => strip(item, i)),
    content: [...content.flatMap((item, i) => strip(item, head.length + i)), { type: 'text', text: promptNotice(MENU_CLOSED_NOTE, prompt) }] };
}

// finder-move (2026-10-17): Claude copied a file, selected the destination folder's row and chose Move Item Here
// (and Paste) four times. Nothing moved, since those commands act on the folder the window shows. The note
// needs a call that clicks a menu item titled Paste, Paste Item or one with "Here" (or presses Cmd+V or
// Cmd+Option+V), and a last tree of a file browser (a list of rows with file URLs) with a folder row selected,
// no text field focused, and the same window listing the same files as before the call.
const PASTE_HERE_NOTE = /* lean notice */ 'sleight: Paste and Move act on the folder the window shows, not a selected row. Open the destination first.';
const pasteTitle = title => /\bHere\b/.test(title) || /^Paste(?: Item)?$/i.test(title);
const MODIFIERS = new Set(['super', 'cmd', 'command', 'meta', 'alt', 'option', 'opt']);
const pasteKey = key => {
  const parts = key.toLowerCase().split('+').map(part => part.trim()), mods = parts.slice(0, -1);
  return parts.at(-1) === 'v' && mods.some(mod => ['super', 'cmd', 'command', 'meta'].includes(mod)) && mods.every(mod => MODIFIERS.has(mod));
};
const menuTitle = (tree, number) => {
  const line = new RegExp(`^\\t*${number} (.*)$`, 'm').exec(tree)?.[1];
  return line?.replace(/^(?:\([^)]*\)\s*)+/, '').replace(/^menu item /, '').replace(/, (?:ID|Help|Description|Secondary Actions|Value):.*$/, '').trim();
};
const fileUrls = tree => [...tree.matchAll(/^\t+\d+ [^\n]*\bURL: (file:\/\/[^\s,]+)/gm)].map(match => match[1]).sort().join('\n');
const fileBrowser = tree => /^\t+\d+ (?:outline|list|table|browser)\b/m.test(tree) && /^\t+\d+ row\b/m.test(tree) && !!fileUrls(tree);
export const fileListing = tree => (typeof tree === 'string' && WINDOW_ROOT.test(tree) && !isMenuTree(tree) && fileBrowser(tree) ? fileUrls(tree) : undefined);
export function pasteHereNote(content, code, { menu, files = () => undefined } = {}, prompt) {
  if (!Array.isArray(content) || typeof code !== 'string') return;
  const source = commentless(code), trees = resultTrees(content), last = trees.at(-1);
  if (!last) return;
  const menus = [...trees.slice(0, -1).map(tree => tree.text).filter(isMenuTree), ...(typeof menu === 'string' && isMenuTree(menu) ? [menu] : [])];
  const clicked = [...source.matchAll(/\.\s*click\s*\(([^)]*)\)/g)].some(([, args]) => {
    const label = /^\s*(?:\{[^}]*?\blabel\s*:\s*)?(['"`])((?:(?!\1).)*)\1/.exec(args)?.[2];
    if (label !== undefined) return pasteTitle(label.trim());
    const number = /^\s*(\d+)\s*(?:,|$)/.exec(args)?.[1];
    return number !== undefined && menus.some(tree => { const title = menuTitle(tree, number); return !!title && pasteTitle(title); });
  });
  const pressed = [...source.matchAll(/\.\s*pressKey\s*\(\s*(['"`])((?:(?!\1).)*)\1/g)].some(([, , key]) => pasteKey(key));
  if (!clicked && !pressed) return;
  const listed = fileListing(last.text), window = windowFromText(last.text);
  if (!listed || !window || /^The focused UI element is \d+ (?:text entry area|text field|text area|text view|search field|combo box|web area)\b/m.test(last.text)) return;
  if (!/^\t+\d+ row \([^)]*\bselected\b/m.test(last.text) ||
      !/^\t+\d+ [^\n]*\([^)]*\bselected\b[^)]*\)[^\n]*\bURL: file:\/\/[^\s,]*\/(?:,|\s|$)/m.test(last.text)) return;
  const key = documentKey(window);
  const earlier = trees.slice(0, -1).filter(tree => documentKey(windowFromText(tree.text) ?? {}) === key).map(tree => fileListing(tree.text)).filter(Boolean);
  // The last read before the call; else this call's first read of the window (its acquisition).
  const before = files(key) ?? earlier[0];
  return before === listed ? promptNotice(PASTE_HERE_NOTE, prompt) : undefined;
}

// SLEIGHT_FIRST_CALL_BATCH=merge, under A/B. Since 668b462 a call continues into a window its own
// shortcut opens, but the clause above still ends the call there: save and close were split in 14 of
// 15 TextEdit runs, and no first call in 617 runs held an action (study, 2026-10-10).
const FIRST_CALL_MERGE = 'start with one of the API calls shown below, assigning the app to a variable. When you already know the first actions on that app, put them after it in the same call (`let app = await cua.getApp("TextEdit"); await app.pressKey("super+n")`): sleight acquires the app and checks its window before they run. Chain every later action whose target you already know (keys, text, `{ id }` or `{ label }` clicks) in one call too, such as typing after the click that focuses a field, or Cmd+W after Cmd+S when the task closes the document. Do not end a call only to read the window before an action you already know: sleight waits for the app after each click, shortcut or Return, follows a Save or Open panel, a new window or a document saved under a name the call typed, and stops the rest of the call if any other window appears.';
// Whether a call's first action needs no element from the tree: keys, typing, paste, or a click,
// scroll or drag at coordinates.
const ACTION = /\.(pressKey|typeText|paste|click|doubleClick|rightClick|scroll|drag|setValue|selectText|performSecondaryAction|performAction)\(\s*(\[)?/;
export function treeFreeFirstAction(code) {
  const first = ACTION.exec(typeof code === 'string' ? code : '');
  return !!first && (['pressKey', 'typeText', 'paste'].includes(first[1]) || (!!first[2] && ['click', 'doubleClick', 'rightClick', 'scroll', 'drag'].includes(first[1])));
}
export function firstCallBatchSetting(value) {
  return ['merge', 'nosavestop'].includes(value) ? value : value !== '0';
}
// Element numbers written as literals in a call's code. Others were computed in the call. A list number passed to
// pickFromList counts, so the helper checks it against the line Claude saw (CC2).
export function literalNumbers(code) {
  return [...new Set([...String(code ?? '').matchAll(/\.(?:click|setValue|selectText|performSecondaryAction|scroll|pickFromList)\(\s*(\d+)\s*[,)]/g)].map(m => Number(m[1])))];
}
// The action names in a call's code, in order, when the code runs each once: no loops or sleight helpers.
export function guardActions(code) {
  if (typeof code !== 'string' || /\b(?:for|while|do)\b|\.(?:forEach|map|reduce|some|every|pickFromList)\(|\bsleight\s*\./.test(code)) return;
  return [...code.matchAll(/\.(click|drag|scroll|selectText|setValue|performSecondaryAction|paste|pressKey|typeText)\s*\(/g)].map(m => m[1]);
}
// A call's leading `let h = await cua.getApp("X")`, and the same without the declaration.
const DECLARED_ACQUISITION = /^\s*((?:let|const|var)\s+[A-Za-z_$][\w$]*\s*=\s*await\s+cua\.getApp\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)\s*;?)/;
const ASSIGNED_ACQUISITION = /^\s*((?:(?:let|const|var)\s+)?[A-Za-z_$][\w$]*\s*=\s*await\s+cua\.getApp\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)\s*;?)/;
// A name an engine method is called on: the handles a call uses. METHOD_CALL counts every such call whatever its receiver, so a
// call on a receiver HANDLE_CALL can't name (`apps[0].click(`, `h?.click(`) shows as more method calls than handles.
const HANDLE_CALL = new RegExp(String.raw`\b([A-Za-z_$][\w$]*)\s*\.\s*(?:${HANDLE_METHODS})\s*\(`, 'g');
const METHOD_CALL = new RegExp(String.raw`\.\s*(?:${HANDLE_METHODS})\s*\(`, 'g');
// Any way the code can reach the engine's getApp: `cua.getApp (`, `cua["getApp"]`, a destructured or aliased getApp, or
// a computed `cua[name]`. Recovery never speaks for such a call.
function reachesGetApp(code) {
  const text = String(code ?? ''), bare = codeOnly(text);
  return /\bgetApp\b/.test(bare) || /\[\s*(["'`])getApp\1\s*\]/.test(text) || /\bcua\s*(?:\?\.)?\s*\[/.test(bare);
}
function numberedHandles(code) {
  return [...new Set([...String(code ?? '').matchAll(/([A-Za-z_$][\w$]*)?\.(?:click|setValue|selectText|performSecondaryAction|scroll|pickFromList)\(\s*\d+\s*[,)]/g)].map(m => m[1]))];
}
export function batchingDescription(description, variant = true, prompt, windows = false) {
  const text = prompt === 'lean' ? (variant === 'merge' ?
    'start with `let app = await cua.getApp("<app>")`; batch known actions: sleight acquires the app and checks its window before they run. Do not end a call only to read the window before an action you already know: sleight waits for the app after each click, shortcut or Return, follows a Save or Open panel, a new window or a document saved under a name the call typed, and stops the rest of the call if any other window appears.' :
    'start with `let app = await cua.getApp("<app>")`; batch known actions: sleight acquires the app and checks its window before they run. Chain known actions, but end the call after a shortcut that opens or names a window (Cmd+N, Cmd+O, or Cmd+S on an untitled document): sleight stops the rest of a call when its window changes.') :
    variant === 'merge' ? FIRST_CALL_MERGE : FIRST_CALL_BATCH;
  const stops = variant === 'nosavestop' ? text.replace(
    ', but end the call after a shortcut that opens or names a window (Cmd+N, Cmd+O, or Cmd+S on an untitled document): sleight stops the rest of a call when its window changes.',
    '. sleight waits for the sheet a shortcut opens.') : text;
  const replacement = windows ? withFirstCallWindows(stops) : stops;
  return typeof description === 'string' && description.includes(FIRST_CALL_RULE) ? description.replace(FIRST_CALL_RULE, replacement) : description;
}
// Both browser-guard sites refuse native access with this text.
const NATIVE_DENIED = /* lean notice */ 'Native access stopped: use the handle returned by cua.getApp directly, after a standalone native app read. No native lease for this browser call.';
// SLEIGHT_PROMPT=lean descriptions of the tools sleight adds. Each tool keeps its default text.
const LEAN_TOOL_DESCRIPTIONS = {
  app_handoff: "Here await user's Continue; reread app. Away: end turn, ask user to sign in and reply. Never request passwords/codes. Cancel keeps app open.",
  document_scope: 'Ask the user to approve the last observed document or window for this session, after a js call with only let app = await cua.getApp("App") (or { windowId: 123 }). Actions need an approved matching Window and URL; window changes stop them. A mistake guard, not isolation from arbitrary JavaScript.',
  review_changes: 'Shows this session\'s saved-file changes. Before editing, read the window with a standalone cua.getApp call. op "list": each touched document\'s diff or size/date summary; op "review": the user picks Keep, Undo or Later per document. Only the user can decide. Undo restores the session backup, refusing if the file changed after the last agent action; unsaved buffers aren\'t restored. Backups end with the session.',
  flow_exception: 'Ask the user to allow, once, the exact call a flow rule last stopped. No decision arguments. Retry the identical call after approval; never work around a refusal.',
  turn_ended: 'Internal: sleight hooks call this. Never call it yourself.',
};
export const promptTool = (tool, prompt) => prompt === 'lean' && LEAN_TOOL_DESCRIPTIONS[tool?.name] ? { ...tool, description: LEAN_TOOL_DESCRIPTIONS[tool.name] } : tool;
const TURN_END_DESCRIPTION = 'Internal to sleight: its hooks call this when a Claude turn ends. Never call it yourself.';

// The guard's window-change stop as the engine reports it, the first line of the exception.
const STOP_LINE = /^(?:Error: )?(?:Input lease stopped this action: window or URL changed\.|Selected window changed\.)/;

const SHUTDOWN_GRACE_MS = 3000;

// Splits a stream into newline-delimited JSON-RPC messages.
// getScreenshot() already shows its image, so passing it to nodeRepl.emitImage
// shows it twice: 2 images per step, 64 in one iPhone Mirroring session
// (2026-10-07). Drop exact repeats within a result and say so once.
export function dropRepeatedImages(content, prompt) {
  const seen = new Set();
  let dropped = 0;
  const kept = content.filter(block => {
    if (block?.type !== 'image' || typeof block.data !== 'string') return true;
    if (seen.has(block.data)) { dropped++; return false; }
    seen.add(block.data);
    return true;
  });
  if (!dropped) return content;
  const copies = dropped === 1 ? 'a repeated copy' : `${dropped} repeated copies`;
  kept.push({ type: 'text', text: promptNotice(`sleight: dropped ${copies} of the same image. getScreenshot() already shows its picture, so don't pass it to nodeRepl.emitImage too.`, prompt) });
  return kept;
}

// A PNG's or JPEG's pixel size from its base64 data, or undefined.
export function imageSize(data) {
  let b;
  try { b = Buffer.from(data.slice(0, 200000), 'base64'); } catch { return undefined; }
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  for (let i = 2; b[0] === 0xff && b[1] === 0xd8 && i + 9 < b.length && b[i] === 0xff;) {
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return undefined;
}

// The engine's screenshots are in pixels, 2× a window's points on a Retina display, and Claude
// reads drag points off them. Returns [app name, size, window title] for the last image in an
// engine result that names one app ("Window: "Game 1", App: Chess."), so drag can convert. The
// title is undefined when the result names more than one window. A headerless
// image can instead use the one acquired handle identified by the caller.
export function screenshotOf(content, target) {
  const image = content.filter(c => c?.type === 'image' && typeof c.data === 'string').at(-1);
  if (!image) return undefined;
  const headers = content.filter(c => c?.type === 'text').flatMap(c => [...(c.text ?? '').matchAll(/^Window: ("(?:[^"\\]|\\.)*"), App: ([^\n]+?)\.?$/gm)]);
  const apps = new Set(headers.map(m => m[2].trim()));
  const titles = new Set(headers.map(m => { try { return JSON.parse(m[1]); } catch { return undefined; } }));
  const size = imageSize(image.data);
  // Standalone getScreenshot() replies have no Window header. Bind their one
  // distinct image only to the acquired handle identified by this call.
  if (!content.some(c => c?.type === 'text' && /^Window:/m.test(c.text ?? '')) && target?.app && target?.title && size &&
      new Set(content.filter(c => c?.type === 'image').map(c => c.data)).size === 1) {
    return [target.app, size, target.title];
  }
  return apps.size === 1 && size ? [[...apps][0], size, titles.size === 1 ? [...titles][0] : undefined] : undefined;
}

const CHROME_LINE = /^(?:standard window\b|button (?:Close|Minimize|Zoom|Full Screen)\b)/;
export const CHROME_SETTLE_MS = 1500;

// True when the accessibility text is only the Mac window and its chrome (menu bar,
// Close/Minimize/Zoom). iPhone Mirroring's tree is this: the iPhone screen is pixels only.
export function chromeOnlyTree(text) {
  if (typeof text !== 'string' || !/^Window: /m.test(text) || !/\bstandard window\b/.test(text)) return false;
  let menuIndent = -1;
  for (const line of text.split('\n')) {
    const m = /^(\t*)(\d+) (.+)/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    if (menuIndent >= 0) {
      if (indent > menuIndent) continue;
      menuIndent = -1;
    }
    if (/\bmenu bar\b/.test(m[3])) { menuIndent = indent; continue; }
    if (!CHROME_LINE.test(m[3])) return false;
  }
  return true;
}

function chromeSwipe(app, size, target, direction, distance = 1) {
  const axis = { up: 1, u: 1, down: 1, d: 1, left: 0, l: 0, right: 0, r: 0 }[direction];
  const amount = typeof distance === 'number' ? distance : distance?.pixels;
  if (![0, 1].includes(axis) || !Number.isFinite(amount) || amount <= 0) return app.scroll(target, direction, distance);
  const span = Math.min(size[axis] * 0.65, typeof distance === 'number' ? amount * size[axis] * 0.65 : amount);
  const sign = ['up', 'u', 'left', 'l'].includes(direction) ? 1 : -1;
  const from = [size[0] * 0.5, size[1] * 0.525], to = [...from];
  from[axis] -= sign * span / 2; to[axis] += sign * span / 2;
  return app.drag(from, to);
}

function chromeScrollCode(code, tree, size, handles) {
  if (typeof code !== 'string' || !chromeOnlyTree(tree) || !size?.every(n => Number.isFinite(n) && n > 0)) return code;
  // Skip quoted text and comments; only known native handles on this observed window can swipe.
  return code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b([A-Za-z_$][\w$]*)\.scroll\s*\(/g,
    (match, handle) => handles.has(handle) ? `(${chromeSwipe.toString()}).bind(null, ${handle}, ${JSON.stringify(size)})(` : match);
}

export function lastImageData(content) {
  return (content ?? []).filter(c => c?.type === 'image' && typeof c.data === 'string').at(-1)?.data;
}

export function chromeSettleHandle(code) {
  const matches = [...String(code ?? '').matchAll(
    /\b([A-Za-z_$][\w$]*)\.(?:getScreenshot|getAXStateAndScreenshot|click|doubleClick|rightClick|scroll|drag|pressKey|typeText|paste)\s*\(/g)];
  return matches.at(-1)?.[1];
}

export function shouldSettleChromeScreenshot(code, content) {
  if (typeof code !== 'string' || !ACTION.test(code)) return false;
  const text = (content ?? []).filter(c => c?.type === 'text').map(c => c.text).join('\n');
  return chromeOnlyTree(text) && lastImageData(content) !== undefined;
}

export async function waitForMatchingScreenshots({
  first, take, now = Date.now, sleep, limitMs = CHROME_SETTLE_MS, intervalMs = 100,
}) {
  const start = now();
  let prev = first, shots = 1;
  while (now() - start < limitMs) {
    await sleep(intervalMs);
    if (now() - start >= limitMs) break;
    const data = await take();
    shots++;
    if (typeof data !== 'string') break;
    if (data === prev) return { data, waitedMs: now() - start, matched: true, shots };
    prev = data;
  }
  return { data: prev, waitedMs: now() - start, matched: false, shots };
}

function replaceLastImage(content, data) {
  const next = content.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]?.type === 'image') { next[i] = { ...next[i], data }; break; }
  }
  return next;
}

// Inserts item before the first window tree, splitting engine docs off a text item that carries both.
// Content without a tree gets it last.
export function beforeFirstTree(content, item) {
  const index = content.findIndex(c => c.type === 'text' && WINDOW_HEADER.test(c.text ?? ''));
  if (index < 0) return [...content, item];
  const tree = content[index], at = tree.text.search(WINDOW_HEADER);
  const split = at > 0 ? [{ ...tree, text: tree.text.slice(0, at) }, item, { ...tree, text: tree.text.slice(at) }] : [item, tree];
  return [...content.slice(0, index), ...split, ...content.slice(index + 1)];
}

function lines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  const receive = chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  };
  stream.on('data', receive);
  return () => stream.off('data', receive);
}

// The key an app approval is remembered under, or undefined for a request
// that isn't a session-scopable computer-use app approval.
function approvalKey(msg) {
  const meta = msg.params?._meta;
  const app = meta?.tool_params?.app;
  if (msg.method !== 'elicitation/create' || meta?.connector_id !== 'computer-use') return undefined;
  if (!Array.isArray(meta.persist) || !meta.persist.includes('session')) return undefined;
  if (typeof app !== 'string' || !app) return undefined;
  return JSON.stringify([app, meta.riskLevel ?? null]);
}

function isAppApproval(msg) {
  return msg.method === 'elicitation/create' && msg.params?._meta?.connector_id === 'computer-use';
}

// Persist metadata alone does not establish that a card grants app access.
function plainAppCard(msg, apps = []) {
  const match = /^Allow Computer Use to use "([^"\r\n]+)"\?$/.exec(msg.params?.message ?? '');
  const app = msg.params?._meta?.tool_params?.app;
  // Real engine cards quote the display name and carry the bundle ID in tool_params.app.
  // Only an unambiguous catalog match may bridge those two identities.
  return isAppApproval(msg) && !!match && (match[1] === app ||
    typeof app === 'string' && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(app) && resolveApp(match[1], apps)?.id === app);
}

// A window whose title follows its active tab (a browser) is retitled by a new tab. When the tree Claude last saw for the
// intended window is still there with exactly one selected tab added, it is the same window and gets no window note:
// "outcome unconfirmed" there read as "my keys went to another window", and Haiku stopped (Firefox mdn b7 r2, 2026-10-19;
// 12 of 60 Firefox task-runs got that note, every one this case). The tree already shows both tabs. A line saying so would
// put the lean prompt over 0.71 of the default's size.
const newTabOf = (intended, earlier, observed, tree) => !!intended && !!observed && observed.app === intended.app &&
  !!earlier && sameHeader(earlier.window, intended) && oneTabAdded(earlier.text, tree, intended.title);
const sameHeader = (a, b) => ['title', 'app', 'url'].every(key => a?.[key] === b?.[key]);

function windowsInText(text) {
  const starts = [...text.matchAll(/^Window: /gm)].map(m => m.index);
  return starts.map((start, i) => windowFromText(text.slice(start, starts[i + 1]))).filter(Boolean);
}

// The server marks turn_ended with `_meta.ui.visibility: []`, which Claude Code
// reads as "callable by no one", the mod included. Drop that, and describe it
// as internal; the mod refuses model calls to it. Other hosts keep the mark:
// Codex hides the tool from the model and its plugin hooks still call it.
function internalTurnEnd(tool, keepHidden = false) {
  const { _meta, ...rest } = tool;
  const { ui, ...otherMeta } = _meta ?? {};
  const meta = keepHidden && ui !== undefined ? { ...otherMeta, ui } : otherMeta;
  return {
    ...rest,
    description: TURN_END_DESCRIPTION,
    ...(Object.keys(meta).length ? { _meta: meta } : {}),
  };
}

const STATS_TOOLS = new Set(['js', 'replay', 'browser_open', 'browser_read', 'browser_act', 'browser_fill']);

export function createRelay({
  directBrowser,
  turboUnavailable,
  directHost,
  remoteApprovals,
  // Whether sleight's mod runs in this host (Claude Code). Only the mod can call turn_ended for the model, end a turn
  // after a used one only, and bind a turbo turn to the user's message. Elsewhere (Codex, Cursor) turn_ended stays hidden
  // from the model as the engine marks it, turbo's tools are left out, and a turn sleight sat out ends here.
  modHost = () => true,
  // Lists apps holding keyboard filter taps ([{ app, bundleId }]), checked when a turn ends.
  keyboardTaps,
  windowIdentity,
  // Whether a list row a click left unchanged lies outside the list's visible frame (offscreen-click.mjs).
  elementVisibility,
  menuContinuationTimeoutMs = 600,
  // A tab the call's own Cmd+T or Ctrl+T opened in the leased window carries the call on (menu-continuation.mjs
  // tabRefusal). SLEIGHT_TAB_CONTINUATION=0 stops there as before, for the A/B.
  tabContinuation = process.env.SLEIGHT_TAB_CONTINUATION !== '0',
  // SLEIGHT_TABC=0 is the behavior before CC7, LB4 and LB6, for the A/B. On: a stop that passes the tab checks takes the tab
  // continuation before menuRemainder's navigation branch (which claimed Safari's Start Page and then failed its whole-call
  // idle check), Safari's hidden one-tab strip counts (tabRefusal's hiddenStrip), and after the rest's Return the result
  // waits up to `tabLandingMs` for a tree that names the header's page (landingRefusal), reading every `tabLandingIntervalMs`.
  tabFirst = process.env.SLEIGHT_TABC !== '0', tabLandingMs = 1500, tabLandingIntervalMs = 150,
  ck3 = process.env.SLEIGHT_CK3 !== '0',
  // A palette, gallery, floating window or popover covers the standard window under it the way a dialog does
  // (menu-continuation.mjs PALETTE_ROLES). SLEIGHT_POPOVER_CONTINUATION=0 is the behavior before it, for the A/B: plain
  // and floating windows still cover, popovers don't, and an untitled palette closed by a button isn't refused.
  popoverContinuation = process.env.SLEIGHT_POPOVER_CONTINUATION !== '0',
  // The next call takes the covered window as its lease after the dialog closed between calls (parentLeaseRefusal).
  // SLEIGHT_PARENT_LEASE=0 keeps the stale-lease refusal, for the A/B.
  parentLease = process.env.SLEIGHT_PARENT_LEASE !== '0',
  // SLEIGHT_WB1=1 (off until its held-out A/B): one route per document sub-step. A gallery or palette window the call's own
  // label or ID click opened takes the rest of the call (menuRemainder's palette, paletteRefusal), and typing that missed a
  // clicked field says so and names setValue (compact-reads.mjs missedFieldNote).
  routeSteering = process.env.SLEIGHT_WB1 === '1',
  // SLEIGHT_WB2=1 (off until its held-out A/B): a call whose last read shows a new Undo item title says the app recorded the
  // edit (compact-reads.mjs undoTitle).
  undoReceipts = process.env.SLEIGHT_WB2 === '1',
  // Milliseconds for the dialog continuation's HID-idle windows; tests inject one.
  clock = () => performance.now(),
  beginStop = () => {}, stopEngine, restartEngine, prepareEngine, backendChanged, engineChanged, browserChoice, inspectInput, onStopReported = () => {}, stopGraceMs = 3000, restartTimeoutMs = 30000,
  clientIn, clientOut, serverIn, serverOut,
  sessionId = randomUUID(),
  approvalScope = 'session',
  ask,
  // The launcher supplies its native dialog for clients without form elicitation.
  fallbackAsk,
  handoffUi = openNativeHandoffUi,
  handoffTimeoutMs = HANDOFF_WAIT_MS,
  onInitialize = () => {},
  startupCache,
  preapproved,
  // Adds an app to the user's pre-approved list when they click "Always allow" (owner, 2026-10-10).
  alwaysAllow,
  grantAudit = () => {},
  stderr = process.stderr,
  localTools,
  clipboardHelper,
  clipboardIO,
  clipboardMode,
  flowRules,
  changeReview = true,
  receipts = false,
  stateReview = false,
  redactReceiptTitles = true,
  receiptWriter = writeReceipt,
  // One evidence line per native action; SLEIGHT_OUTCOMES=1 opts in pending native A/B.
  outcomes = false,
  // SLEIGHT_COMPLETENESS=1 opts in independently of outcomes pending A/B.
  completeness = false,
  // SLEIGHT_ACTION_LOG=<path> (opt-in): an ActionLog (action-outcomes.mjs) gets one JSON line per action.
  actionLog,
  idleTurnEndMs,
  simFocusNote = true,
  inputLease,
  onLeaseFault = () => {},
  engineForbiddenTargets = false,
  // Whether a pid is sleight's own consent host (own-host.mjs); tests pass a fake.
  ownHostPid = isOwnHostPid,
  // The user's blocks (permissions.mjs): app({ bundleId, name }) gives the line to relay for a blocked app, and noteApp records
  // the app sleight acts in for the menu's Never Act in row. The launcher supplies them; without them nothing is blocked.
  // page(site) and sitesLimited() hold site blocks on the engine path; webBrowser(appId) says whether an app is a web browser
  // (true, false, or undefined while unknown, when a read with web content counts as one).
  permissions,
  webBrowser = () => undefined,
  guardTiming = false,
  // 'careful' reads the window before every action, including keys, text and coordinates later in
  // a call, which skip it by default (owner, 2026-10-09). Document scope is always careful.
  guardMode,
  // Native observations in place of the settled read before typing after Return (light-return.mjs).
  // The launcher turns it on only with SLEIGHT_GUARD_LIGHT_RETURN=1; it needs windowIdentity and a lease.
  guardLightReturn = false,
  // Rewrites the engine's first-call rule in the js tool description. The launcher turns it on unless
  // SLEIGHT_FIRST_CALL_BATCH=0: in 24 runs a side it cut turns 208 to 168 (2026-10-09). 'merge' picks
  // the wording under A/B.
  firstCallBatch = false,
  // Under A/B (SLEIGHT_FS=1, loss study 2026-10-19 fix 3): the js description notes at the engine's inventory sentence that
  // getState lists no windows (INVENTORY_NOTE) and FIRST_CALL_WINDOWS goes on. An engine description that matches a pin gets
  // the compact text, which has no inventory sentence, so only TS3's goes there. The flag also turns on the pins of the
  // engine's current descriptions (tool-description.mjs COMPUTER_JS_HASH). Every engine session reads this description, and
  // on 10 native held-out tasks x3 (2026-10-19) it lost passes (word-memo 2/3, textedit-notes-table 1/3 against 2/3) and
  // word-brief went 67.2 to 100.2 s, so it stays behind the flag. Fix 4, the browser's keyboard new-tab sentence, is default
  // (engine-app-docs.mjs KEYBOARD_TAB_SENTENCE).
  firstCallSteering = process.env.SLEIGHT_FS === '1',
  // Under A/B (SLEIGHT_TS3=1): the js description says getState lists no windows (FIRST_CALL_WINDOWS).
  firstCallWindows = process.env.SLEIGHT_TS3 === '1' || firstCallSteering,
  // Under A/B (SLEIGHT_RESULT_TRIM=1): leaves out a split acquisition's tree when its call returns a
  // newer full one. Trimming Save-panel file lists with it lost (11/12, 2026-10-11) and is gone.
  resultTrim = false,
  leanCalls = process.env.SLEIGHT_LEAN_CALLS === '1',
  // Opt-in: a first getApp result keeps the skill and tree, with engine docs on the next js result,
  // as open_file already does. The live A/B and any default change belong to sleight-arch.
  leanFirst = process.env.SLEIGHT_LEAN_FIRST === '1',
  compactAcquisition = process.env.SLEIGHT_COMPACT_ACQUISITION === '1',
  // Opt-in (SLEIGHT_COMPACT_REACQUIRE=1): a re-acquisition of a window Claude saw whole gets "no change" or the
  // changed lines, as a read does. It cut prompt tokens 9% but lost the 2026-10-17 A/B (excel-edit and word-edit, 5 rounds:
  // 156.3 s and 9/10 against 149.4 s and 10/10), with more Excel turns.
  compactReacquire = process.env.SLEIGHT_COMPACT_REACQUIRE === '1',
  firstCallRules,
  dedupeRules = process.env.SLEIGHT_DEDUPE_RULES === '1',
  // The first-call rules go before the result's first window tree, so the last thing Claude reads is the
  // answer-bearing tree. With 5 KB of rules after preview-read's 2.3 KB tree, Haiku thought on turn 2 in 5/5
  // sleight runs against 2/5 for Peekaboo (2026-10-17). SLEIGHT_RULES_FIRST=0 keeps them last, for the A/B.
  rulesFirst = process.env.SLEIGHT_RULES_FIRST !== '0',
  // CC6 (codex-vs-cc-1019): the engine's Workflow lines that ask for a getAXState() after actions say instead that the
  // result already holds the state (workflow-docs.mjs), on the computer surface under the guard. SLEIGHT_WORKFLOW_DOCS=0
  // keeps the engine's lines, for the A/B.
  workflowDocs = process.env.SLEIGHT_WORKFLOW_DOCS !== '0',
  // SLEIGHT_OPEN_RULES=short (A/B, off by default): an open_file result carries only the rules that matter after
  // an open, and the whole skill comes with Claude's first js result. Haiku thought before answering in 18/18
  // sleight preview-read runs, all given the whole skill in their first result, against 2/5 for Peekaboo (correlational, 2026-10-17).
  openRules = process.env.SLEIGHT_OPEN_RULES === 'short' ? 'short' : 'full',
  // A read whose document area exposes no text values gets one note to screenshot it. Claude's first Excel
  // read returned no cell values and a screenshot followed in 5/5 excel-edit runs, about 3 s a run (2026-10-17).
  // The note costs about 30 tokens and no engine call; attaching a screenshot would cost an image and a
  // serial capture on every such read.
  // Preserve the 60fe1319 relay baseline: the hint is independent of the screenshot sentence A/B.
  // SLEIGHT_TEXTLESS_HINT=0 leaves it out, including the open_file textless fallback.
  textlessHint = process.env.SLEIGHT_TEXTLESS_HINT !== '0',
  confirmPayments = 'requested',
  // Shell hosts have no form surface. Every engine card goes to sleight's panel.
  panelOnly = false,
  // LaunchServices identity only, without opening or reading the app. Shell display names may differ from bundle IDs.
  resolveApprovalApp,
  rs,
  // sleight's own payment card for the engine-path payment gate (payment-card.mjs); the launcher supplies it. Without it a
  // payment stop reaches Claude as it is.
  paymentCard,
  // How long Claude's result waits for the card. Codex ends an MCP call after its tool_timeout_sec (60 s by default), so
  // the hold stays under it; after it Claude gets the stop and a note, and a later Allow once still counts.
  paymentCardHoldMs = 45000,
  prompt = process.env.SLEIGHT_PROMPT,
  diagnoseRead,
  staleHelperCheck,
  settleTextWrite,
  prepareTextWrite,
  // { send, check }: posts one Escape to the leased app's pid after a menu stayed stuck on two results in a row, and
  // reads that app's menu bar (stuck-escape.mjs). The launcher supplies it unless SLEIGHT_STUCK_ESCAPE=0.
  stuckEscape,
  // Notices from work that finished between calls (rich-text clipboard recovery), added to the next
  // tool result Claude gets, so they don't stay on stderr where Claude never looks.
  takeNotices,
  // Probes an app's windows outside the engine ({ status, windows, minimized, hidden, onScreen }).
  spaceProbe,
  // Whether an app is running, asked before a recovery acquisition (which launches a quit app). It defaults to spaceProbe; with
  // neither, recovery is refused.
  runningProbe = spaceProbe,
  // Long-lived helper transaction: record, recheck before launch, restore the user's app once.
  frontRestore: restoreFront,
  trace: writeTrace = () => {},
  traceCode = false,
  now = Date.now,
  helperCrashJitterMs = () => Math.floor(Math.random() * 1500),
  chromeSettleMs = CHROME_SETTLE_MS,
  chromeSettleIntervalMs = 100,
  chromeSettleSleep = ms => new Promise(r => setTimeout(r, ms)),
  launchSettleSleep = ms => new Promise(r => setTimeout(r, ms)),
  launchReread = process.env.SLEIGHT_LAUNCH_REREAD === '1',
  warmRepl = false,
  warmEngine = false,
  openFast = false,
  openShot = process.env.SLEIGHT_OPEN_SHOT !== '0',
  closeReadSkip = process.env.SLEIGHT_DP1 !== '0',
  handleApi = process.env.SLEIGHT_DP3 !== '0',
  // SLEIGHT_BROWSER_CORE=1: browser_open for a browser turbo doesn't drive, as two js calls (engine-browser-open.mjs).
  engineBrowserOpen = engineBrowserOpenSetting(),
  // open_file adds a screenshot only when the opened document's tree holds none of its text or cells.
  openAutoShot = process.env.SLEIGHT_OPEN_AUTO_SHOT !== '0',
  openShotTimeoutMs = 5000,
  onClientReply = () => {},
  // The ghost hand (hand/relay-hand.mjs), told about admitted calls, approvals and results. Fire-and-forget:
  // the relay never awaits it or reads its state, and without it nothing changes.
  hand,
  cursor,
  pause = createSessionPause(),
  pauseHost,
}) {
  const pauseChecks = new Map(), pausedCalls = new Set(), nativePauseCuts = new Set();
  const applyPause = value => {
    if (value) for (const id of engineCalls) if (running.has(id) && !localRunning.has(id)) pausedCalls.add(id);
    cursor?.setPaused?.(value);
    directBrowser?.setPaused?.(value);
    if (value) hand?.pause?.();
  };
  const releasePause = pause.subscribe(applyPause);
  function pauseBlocked(msg) {
    if (msg.method !== 'tools/call' || [TURN_END_TOOL, TURN_START_TOOL].includes(msg.params?.name)) return false;
    try {
      if (!pauseChecks.has(msg.id)) pauseChecks.set(msg.id, pause.checkpoint());
      pauseChecks.get(msg.id)();
      return false;
    } catch { return true; }
  }
  function pauseReply(msg, text = PAUSED_NOTE) {
    if (pauseHost?.controlLost) text += ' ' + PAUSE_CONTROL_LOST_NOTE;
    const response = { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text }] } };
    // Internal split calls still need their normal callback and bookkeeping.
    observeServerMessage(response);
  }
  const localCursor = new Map();
  const callNarration = new Map();
  const cursorStatus = (state, detail) => { try { cursor?.status(state, detail); } catch {} };
  const runScreenshotDetails = new WeakMap();
  // Tags carry geometry through split replies without saving pixels before final delivery.
  const tagRunScreenshots = (content, detail) => { for (const item of content ?? []) if (item?.type === 'image') runScreenshotDetails.set(item, detail); };
  const localCursorResult = (id, failed, phase) => {
    const record = localCursor.get(id); if (!record) return;
    localCursor.delete(id);
    try { cursor.action({ ...record, phase: phase ?? (failed ? 'failed' : 'done') }); } catch {}
    cursorStatus(failed ? 'error' : 'done', record);
    if (!failed) cursorStatus('thinking', record);
  };
  if (rs !== undefined && rs !== '0' && rs !== '1') {
    stderr.write('sleight: unknown SLEIGHT_RS value; using previous account policy and submit instruction. Use 1 or unset to enable, 0 to disable.\n');
  }
  if (directBrowser !== undefined && !isV3Frontend(directBrowser)) throw Error('TRUSTED_ROUTE_REQUIRED');
  if (directHost !== undefined && !(isV3Bridge(directHost) && isV3Frontend(directBrowser))) throw Error('TRUSTED_ROUTE_REQUIRED');
  let installedBootstrapped = false;
  const remoteEnvelope = directHost?.bootstrapEnvelope() ?? { version: 1, session: randomUUID(), nonce: randomBytes(32).toString('hex') };
  const remoteTurns = new Set(), typedApps = new Set(), remoteRefusedCalls = new Set(), remoteUnboundNotices = new Map(), awayCards = new Map();
  function bindTurboPrompt(frame) {
    // Both envelope forms are authenticated before this helper. A late bind must not replace a newer prompt's authority.
    paymentMessages.set(frame.text);
    const binding = directHost.bind(frame, turboApps(), clientHost).then(available => {
      if (available) { resumeRequested = true; resumeAfterStop(); }
      return { available, deferred: false };
    });
    // prompt.submit awaits turn_ended. During pause even a slow worker must not hold the person's message.
    // Binding continues in the background; both the relay and worker still refuse calls until Resume.
    if (pause.paused) { binding.catch(() => {}); return Promise.resolve({ available: false, deferred: true }); }
    return binding;
  }
  let promptOrigin;
  let catalogSettled = false;
  let remoteCatalog = { apps: [], defaults: {} };
  const remoteRead = async operation => {
    let timer;
    try { return await Promise.race([Promise.resolve().then(() => remoteApprovals?.[operation]?.()),
      new Promise(resolve => { timer = setTimeout(resolve, 1500); timer.unref?.(); })]); }
    catch { return undefined; } finally { clearTimeout(timer); }
  };
  // One background scan per relay session. A caller's timeout never cancels the shared scan.
  const catalogReady = Promise.resolve().then(() => remoteApprovals?.catalog?.()).then(catalog => {
    if (Array.isArray(catalog?.apps)) remoteCatalog = catalog;
  }).catch(() => {});
  async function waitCatalog() {
    let timer;
    try { await Promise.race([catalogReady, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); }
    finally { clearTimeout(timer); }
  }
  const pendingTyped = new Set();
  const typedKey = id => JSON.stringify([id, 'low']);
  function applyTyped() {
    for (const text of pendingTyped) {
      for (const app of parseTypedApps(text, remoteCatalog.apps)) {
        if (forbiddenTargetWarning(app) || typedApps.has(typedKey(app))) continue;
        typedApps.add(typedKey(app));
        stderr.write(`sleight: typed session approval for ${app}.\n`);
      }
      if (catalogSettled) pendingTyped.delete(text);
    }
  }
  catalogReady.then(() => { catalogSettled = true; applyTyped(); });
  const remotePresent = async () => promptOrigin !== 'bridge' && isPresent(await remoteRead('presence'));
  const appIdentity = app => remoteCatalog.apps?.find(a => a.id === app) ?? resolveApp(app, remoteCatalog.apps);

  let clientHost; // the menu bar's host line, from initialize's clientInfo (host-label.mjs)
  let grokClient = false;
  const originalModHost = modHost;
  modHost = () => !grokClient && originalModHost();
  // Codex sends its sandbox state on each tool call (codex/sandbox-state, because the engine advertises it), and the engine
  // runs a call in a kernel for that state. The relay's own calls carry the client's latest state so they reach the same
  // kernel, and a change in it means a fresh kernel: no guard setup and no handles (the first getApp in Codex failed on
  // the warm kernel's setup, 2 of 2 live tasks, 2026-10-19).
  const ENGINE_CONTEXT_KEYS = ['codex/sandbox-state', 'codex/sandbox-state-meta', 'codex/sandbox-launcher'];
  let engineContext = {}, engineContextKey = '';
  const engineMeta = () => ({ ...engineContext, [META_KEY]: turnMeta() });
  // Codex marks who answered a form (approvals_reviewer in _meta; its auto-review writes "auto_review"). Only an answer with
  // no marker or the marker "user" writes Always. Any other marker, unknown ones included, is a session allow.
  const reviewerAnswer = result => {
    const meta = result?._meta;
    return !!meta && typeof meta === 'object' && Object.hasOwn(meta, 'approvals_reviewer') && meta.approvals_reviewer !== 'user';
  };
  // The kernel identity is the sandbox policy itself (codex/sandbox-state, or its alias), hashed over sorted keys. The launcher
  // and key order don't change it. Each change gets a new epoch, which the guard setup checks in the kernel, so a return
  // to an earlier kernel starts from clean guard state.
  const stableJson = value => Array.isArray(value) ? '[' + value.map(stableJson).join(',') + ']'
    : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
    : JSON.stringify(value);
  let kernelEpoch = 0;
  const HOOK_ARGS = ['hook_event_name', 'session_id', 'turn_id'];
  // The user's own message for the engine-path payment gate (payment-gate.mjs): only an authenticated turbo begin sets it.
  const paymentMessages = createPaymentMessages();
  // The client's name, for the card's "sleight request for ..." line, and the cards that already granted their allowance.
  let clientName;
  const grantedCards = new WeakSet();
  // Turbo in Codex (codex-turn.mjs): Codex's prompt hook binds a turn through turn_started, its Stop and Interrupt hooks
  // release it. Set from initialize's clientInfo, and never under the mod, whose own handshake stays as it was.
  // codexBinding: the Codex thread and turn the last accepted prompt hook named. codexEpoch: bumped by every Stop or
  // Interrupt, so a bind still queued when one arrives never runs.
  let codexClient = false, codexBinding, codexEpoch = 0, codexSequence = 0, codexPending = Promise.resolve();
  const codexTurns = new Set();
  const codexTurbo = () => codexClient && !modHost();
  let turboNoticeShown = false;
  let handoffPresencePending;
  const directNames = new Set(directBrowser?.tools().map(tool => tool.name) ??
    (turboUnavailable ? ['browser_open','browser_read','browser_act','browser_fill','browser_tabs'] : []));
  const directTurnEnds = new Map();
  function collectDirectEnd(id) {
    if (!directBrowser) return;
    const pending = directBrowser.end(); // Revoke before forwarding the engine turn end.
    if (id === undefined) return;
    const state = { pending: true, replies: [] };
    directTurnEnds.set(id, state);
    let timer;
    const unproved = () => ({ revoked: false, cleanup: [{ status: 'retained', resource: 'semantic-journals', code: 'CLEANUP_UNPROVED' }] });
    Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(unproved()), stopGraceMs); })])
      .catch(unproved).then(receipt => {
        clearTimeout(timer); state.pending = false; state.receipt = receipt;
        for (const reply of state.replies) toClient(reply);
      });
  }
  const frontRestore = process.env.SLEIGHT_FRONT_RESTORE === '0' ? undefined : restoreFront;
  const readHints = {};
  // Each guard install carries only the outcome and completeness experiments selected for this session.
  const outcomeSetup = { ...(outcomes || actionLog ? { outcomes: true } : {}), ...(completeness ? { completeness: true } : {}) };
  let turnOutcomes = new TurnOutcomes();
  const outcomeCalls = new Map(), outcomeEnds = new Map();
  const completenessCalls = new Map();
  let compactor = createReadCompactor({ leanCalls, prompt, compactAcquisition, compactReacquire, screenshotReads: textlessHint, readHints, routeSteering, undoReceipts, outcomes, actionNumbers: workflowDocs });
  const browserStale = createBrowserStaleGuard();
  let resultBudget = createResultBudget();
  const docOrigin = documentationOrigin();
  let documentationClientMeta = {};
  const documentationContext = () => stableJson([engineEpoch, kernelEpoch, engineContext, documentationClientMeta,
    computerSurface, browserChoice, confirmPayments, rs]);
  const fullDocumentationCalls = new Set();
  const aliasNotices = createBrowserAliasNotices();
  // Whether the engine's js description is its computer-only one, from the last tool list.
  let computerSurface = false;
  // The tool list as this session shows it: the engine's tools rewritten by this session's settings, then sleight's own.
  // The handshake cache stores the engine's list and answers through this too (startup-cache.mjs).
  const clientTools = ({ tools, ...result }) => ({ ...result, tools: tools
    .filter(t => !HIDDEN_TOOLS.has(t.name))
    .filter(t => !documentMode || t.name === 'js' || t.name === TURN_END_TOOL)
    .map(t => (t.name === TURN_END_TOOL ? internalTurnEnd(t, !modHost()) : t))
    .map(t => {
      if (t.name !== 'js') return t;
      // The engine's computer-only description says its browser APIs are disabled (cua-repl's browser-disabled part).
      computerSurface = typeof t.description === 'string' &&
        (engineJsVariant(t.description)?.variant === 'computer' || /(?:^|\n)Browser APIs are disabled\.(?:\n|$)/.test(t.description));
      const compact = compactJsDescription(t.description, firstCallBatch, leanCalls, firstCallWindows, { current: firstCallSteering });
      if (compact !== undefined) return { ...t, description: engineBrowserOpen && !documentMode ? withBrowserOpenFirst(compact) : compact };
      const batched = firstCallBatch ? batchingDescription(t.description, firstCallBatch, prompt, firstCallWindows) : t.description;
      const description = firstCallSteering ? withInventoryNote(batched) : batched;
      const final = leanCalls ? leanCallDescription(description) : description;
      return { ...t, description: engineBrowserOpen && !documentMode ? withBrowserOpenFirst(final) : final };
    })
    .concat(documentMode ? [DOCUMENT_TOOL, ...(localTools?.tools ?? []).filter(t => t.name === 'select_window')] : (localTools?.tools ?? []), changeReview ? [REVIEW_TOOL] : [], flowRules ? [FLOW_TOOL] : [],
      (modHost() || codexTurbo()) && directBrowser ? directBrowser.tools().map(t => engineBrowserOpen ? widenTurboOpen(t, directBrowser.browser) : t)
        : engineBrowserOpen && !documentMode ? [engineOpenTool(prompt)] : [],
      codexTurbo() ? [structuredClone(TURN_START)] : [],
      // app_handoff refuses document-scoped surfaces, so document mode doesn't advertise it.
      documentMode ? [] : [structuredClone(NATIVE_HANDOFF_TOOL)])
    // Claude Code defers MCP tools behind a search, which cost a turn before the first call, and
    // again before the first drag (3/3 textedit-drag runs, 2026-10-08). sleight's descriptions
    // are short, so all but the internal turn_ended load up front, local tools included.
    .map(t => promptTool(t, prompt))
    // The host validates rewritten calls too. Admit only this private optional object,
    // which the mod overwrites and the relay removes before any tool executes.
    .map(t => modHost() && STATS_TOOLS.has(t.name) && t.inputSchema?.type === 'object' && t.inputSchema.additionalProperties === false ? { ...t,
      inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, sleight_stats: { type: 'object' } } } } : t)
    .map(t => (t.name !== TURN_END_TOOL && t.name !== TURN_START_TOOL ? { ...t, _meta: { ...t._meta, 'anthropic/alwaysLoad': true } } : t)) });
  let startup = startupCache?.bind({
    send: msg => toClient(msg), forward: msg => clientLine(JSON.stringify(msg), true),
    present: { tools: clientTools }, log: line => stderr.write(line + '\n'),
  });
  const clickResults = new TabClickResults();
  const journal = receipts || stateReview ? new TurnJournal({ redactTitles: redactReceiptTitles }) : undefined;
  const turnStats = new Map(), statsCalls = new Map(), closedStats = new Set();
  const statsEnds = new Map();
  const statsId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
  const finishStats = id => {
    const log = turnStats.get(id);
    turnStats.delete(id);
    for (const [call, owner] of statsCalls) if (owner === log) statsCalls.delete(call);
    closedStats.add(id);
    if (closedStats.size > 64) closedStats.delete(closedStats.values().next().value);
    return log ? log.frame() : unavailableStatsFrame();
  };
  const recordAction = (method, ...args) => {
    try { actionLog?.[method](...args); } catch {}
    try {
      if (method === 'request') {
        const msg = args[0], tag = msg.params?.arguments?.sleight_stats;
        // This transport never reaches the engine, nor does its title select the exclusion.
        if (msg.params?.name !== TURN_END_TOOL && msg.params?.arguments) delete msg.params.arguments.sleight_stats;
        const id = statsId(tag?.turn);
        if (!modHost() || !id || tag.internal === true || closedStats.has(id) ||
            !STATS_TOOLS.has(msg.params?.name)) return;
        if (!turnStats.has(id)) {
          if (turnStats.size >= 8) {
            // Quarantine dropped turns as closed so later spare capacity cannot produce partial totals.
            closedStats.add(id);
            if (closedStats.size > 64) closedStats.delete(closedStats.values().next().value);
            return;
          }
          turnStats.set(id, new TurnStats({ clock }));
        }
        const log = turnStats.get(id);
        log.request(msg);
        if (log.calls.has(msg.id)) statsCalls.set(msg.id, log);
      } else if (method === 'waitStart' || method === 'waitEnd') {
        for (const log of turnStats.values()) log[method](...args);
      } else {
        const id = method === 'reply' ? args[0]?.id : args[0];
        statsCalls.get(id)?.[method](...args);
        if (method === 'reply') statsCalls.delete(id);
      }
    } catch {}
  };
  const receiptEnds = new Map();
  let latestReceipt;
  function finishReceipt() {
    if (!journal) return;
    let receipt;
    try { receipt = journal.finish({ session: sessionId, turn: turnId, review: stateReview }); }
    catch { journal.last = undefined; return latestReceipt = { unavailable: true }; }
    if (!receipt.calls.length && !receipt.omitted) return latestReceipt;
    let path, unavailable = false;
    if (receipts) {
      try { path = receiptWriter(receipt); }
      catch { unavailable = true; }
    }
    stderr.write(`sleight: receipt ${receipt.calls.length} calls, ${receipt.windows.length} windows, ${receipt.omitted} omitted, ${unavailable ? 1 : 0} write failures\n`);
    return latestReceipt = { ...(path ? { path } : {}), ...(unavailable ? { unavailable } : {}), ...(receipt.review ? { review: receipt.review } : {}) };
  }
  const resultCalls = new Map(); // forwarded native actions, with the read available before input
  const splitInputs = new Set(); // input in an earlier part of this same client call
  const remapNotes = new Map(); // call id -> what remapStale changed, told to Claude with the result
  const requireNotes = new Map(); // call id -> the no-require note for a call that also used the engine
  let saveReceipted = false; // a result has carried a confirmed save's `on disk:` receipt
  // Apps this session drove (names and bundle IDs), and turn_ended calls whose reply should say
  // when one of them holds a keyboard filter tap: the mod shows that to the user.
  const drivenApps = new Set(), turnEnds = new Set(), tapWarned = new Set();
  let traceFailed = false;
  function trace(direction, msg) {
    if (traceFailed) {
      if (direction === 'preapproved-app') throw new Error('preapproval trace unavailable');
      return;
    }
    try { writeTrace(direction, msg); }
    catch (error) {
      traceFailed = true;
      if (direction === 'preapproved-app') throw error;
    }
  }
  let turnId = randomUUID();
  let turnUsed = false;
  let nextInternalId = 0;
  const newClipboard = () => clipboardMode === 'preserve' && (clipboardIO || clipboardHelper)
    ? createClipboardSession(clipboardIO ?? createNativeClipboardIO(clipboardHelper)) : undefined;
  let clipboard = newClipboard();
  const clipboardReplies = new Map();
  const clipboardResets = new Set();
  // Call ID -> whether its native copy included Cut.
  const nativeCopies = new Map();
  const listRequests = new Set();
  const internalRequests = new Map();
  let tabsMayNeedCleanup = false;
  const openedReads = new Set();
  // Results that already got their error notices. The opened-tab probe sends the same result through again.
  const errorNoted = new WeakSet();
  let tabCleanupPending;
  const tabCleanupNotes = new Map();
  const turnEndCalls = new Map(); // request id -> original turn arguments, until acknowledgement
  const failedTurnEnds = new Map(); // turn id -> cleanup the engine rejected
  const turnEndAttempts = new Map(); // includes the initial explicit or idle cleanup
  function trackTurnEnd(id, args) {
    turnEndCalls.set(id, args);
    turnEndAttempts.set(args.turn_id, (turnEndAttempts.get(args.turn_id) ?? 0) + 1);
  }
  const approvalRequests = new Map(); // server request id -> approval key and stop generation
  const grokElicitations = new Set(); // all forms forwarded to Grok, including unkeyed and non-session forms
  const alwaysOffered = new Map(); // server request id -> { app, riskLevel } offered "Always allow"
  // "Always allow" is offered only for a session-scoped engine app approval, terminals and OpenAI's
  // apps included (owner, 2026-10-11), and only the user's answer to sleight's prompt or Claude Code's
  // form can pick it.
  function alwaysChoice(msg) {
    const meta = msg.params?._meta;
    const app = meta?.tool_params?.app, riskLevel = meta?.riskLevel ?? 'high';
    // The engine names an app by bundle ID or by name, so check both ways.
    if (!alwaysAllow || approvalScope !== 'session' || approvalKey(msg) === undefined) return undefined;
    if (!['low', 'medium', 'high'].includes(riskLevel)) return undefined;
    return { app, riskLevel };
  }
  function rememberAlways(choice) {
    try { alwaysAllow(choice.app, choice.riskLevel); trace('always-allow', choice); }
    catch (error) { process.stderr.write(`sleight: couldn't add ${choice.app} to the pre-approved list: ${error.message}\n`); }
  }
  const approved = new Set(); // approval keys the user accepted this session
  const listApproved = new Set(); // apps the user's pre-approved list answered for the engine this session
  // A revoke from sleight's menu or `sleight-mcp permissions` also ends this session's own approvals of that app.
  preapproved?.onRemoved?.(apps => {
    for (const key of [...approved]) {
      try { const parts = JSON.parse(key); if (apps.includes(parts[0]) || parts[0] === 'sleight' && apps.includes(parts[2])) approved.delete(key); } catch {}
    }
    for (const key of [...typedApps]) {
      const id = JSON.parse(key)[0];
      if (apps.some(app => app === id || appIdentity(app)?.id === id)) typedApps.delete(key);
    }
    pendingTyped.clear();
    for (const app of apps) listApproved.delete(app);
  });
  // Bundle ids of apps the engine approved this session (session cards and the pre-approved list), for turbo's begin
  // frame. Turbo still needs the operator's per-app opt-in and its own debugger card before it touches an app.
  // The pre-approved list counts from the session's start, before the engine asks about the app. It comes last, so a
  // long list never pushes this session's cards past the 64-id cap.
  function turboApps() {
    const ids = new Set([...listApproved, ...[...typedApps].map(key => JSON.parse(key)[0])]);
    for (const key of approved) {
      try { const parts = JSON.parse(key); if (parts.length === 2 && parts[0] !== 'sleight') ids.add(parts[0]); } catch {}
    }
    try { for (const app of typeof preapproved?.list === 'function' ? preapproved.list() : []) ids.add(app); } catch {}
    // An app the user blocked never reaches turbo either.
    return [...ids].filter(app => typeof app === 'string' && app.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/.test(app) &&
      !permissions?.app({ bundleId: app })).slice(0, 64);
  }
  let asking = Promise.resolve(); // `ask` prompts, one at a time
  const shellAppCards = new WeakMap(), pendingShellAsks = new Map();
  const plainCard = msg => shellAppCards.get(msg) ?? plainAppCard(msg);
  let clientCanElicit; // undefined until initialize (legacy in-process callers)
  const localNames = new Set(localTools?.tools.map(t => t.name) ?? []);
  const elicitations = new Map(); // our elicitation id -> resolve
  const lightReturn = guardLightReturn && windowIdentity && inputLease?.directory
    ? createLightReturn({ directory: inputLease.directory, observe: windowIdentity }) : undefined;
  const tabProbe = ck3 && windowIdentity && inputLease?.directory
    ? createTabProbe({ directory: inputLease.directory, observe: windowIdentity, trace }) : undefined;
  const closeRead = closeReadSkip && windowIdentity && inputLease?.directory
    ? createCloseRead({ directory: inputLease.directory, observe: windowIdentity }) : undefined;
  const promptFailures = new Map(); // call id -> native panel failure, distinct from a user decline
  const running = new Set(); // ids of engine calls waiting for a result
  const engineCalls = new Set(); // calls actually sent to the current engine, including private reads
  const nativeChecked = new Map(); // call id -> its verified native admission, when available
  const focusedChecked = new Set();
  const callDetails = new Map();
  const pendingClients = new Map();
  const stoppedClients = new Set();
  let stopCollected = false;
  let backendRestartUnconfirmed = false;
  let stopUnconfirmed = false, resumeRequested = false;
  let stopFinished = false, restarting, initialization;
  let engineEpoch = 0, nextEngineRequest = 0, updatePending = false;
  const engineRequests = new Map();
  let stopGeneration = 0;
  const callGenerations = new Map();
  function cancelInternalRequests(message) {
    docOrigin.invalidate();
    const requests = [...internalRequests.values()];
    for (const id of internalRequests.keys()) { pauseChecks.delete(id); pausedCalls.delete(id); nativePauseCuts.delete(id); }
    internalRequests.clear();
    for (const resolve of requests) resolve({ error: { message } });
  }
  let identityWarned = false, identityWarning = false;
  function nativeIdentity(target, observed) {
    try { return verifyWindowIdentity(target, observed); }
    catch (error) {
      if (observed?.status === 'mismatch' || !/identity is unavailable|identity is ambiguous/.test(error.message)) throw error;
      if (!identityWarned) { identityWarned = true; identityWarning = true; }
      return undefined;
    }
  }
  function resumeAfterStop() {
    if (!stopFinished || !resumeRequested || (!stopUnconfirmed && !(stopCollected && restartEngine))) return;
    closing = false; stopUnconfirmed = false; resumeRequested = false;
    // Existing in-flight calls and their leases remain reserved until they actually finish.
    forgetHandles();
    if (stopCollected) {
      for (const state of helperStates.values()) clearTimeout(state.timer);
      helperStates.clear();
    }
    if (!stopCollected && !serverIn.writableEnded && !serverIn.destroyed) {
      for (const state of helperStates.values()) if (state.stuck && state.pending === undefined) scheduleHelperRead(state);
    }
  }
  async function restartCollectedEngine(backend = false, update = false, preparedServer) {
    const generation = stopGeneration;
    const isCurrent = () => generation === stopGeneration && !closing && !disposed;
    try {
      const engine = await restartEngine(isCurrent, preparedServer);
      if (!isCurrent()) throw new Error(/* notice */ 'Engine restart was stopped.');
      detachServer();
      serverIn = engine.serverIn; serverOut = engine.serverOut;
      engineEpoch++;
      docOrigin.invalidate();
      engineCalls.clear();
      bindServer();
      stopCollected = false;
      if (initialization) {
        const id = `sleight-initialize-${nextInternalId++}`;
        const reply = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { internalRequests.delete(id); pauseChecks.delete(id); reject(new Error(/* notice */ 'Engine initialization timed out.')); }, restartTimeoutMs);
          internalRequests.set(id, msg => { clearTimeout(timer); resolve(msg); });
          toServer({ ...initialization, id });
        });
        if (reply.error || reply.result?.isError) throw new Error(reply.error?.message ?? 'Engine initialization failed.');
        toServer({ jsonrpc: '2.0', method: 'notifications/initialized' });
      }
      if (!isCurrent()) throw new Error(/* notice */ 'Engine restart was stopped.');
      clipboard = newClipboard();
      if (!update) { compactor = createReadCompactor({ leanCalls, prompt, compactAcquisition, compactReacquire, screenshotReads: textlessHint, readHints, routeSteering, undoReceipts, outcomes, actionNumbers: workflowDocs }); selectorWindows.clear(); helperHandles.clear(); helperAliases.clear(); }
      resultCalls.clear(); docsShown = backend; priorRead = undefined; lastTree = undefined;
      if (!backend) { deferredEngineDocs = []; clientJsDelivered = false; }
      // Rules held for Claude's first js result go with the next engine docs instead.
      if (deferredRules) { deferredRules = undefined; rulesShown = browserRulesShown = false; }
      for (const state of helperStates.values()) clearTimeout(state.timer);
      helperStates.clear();
      screenshots.clear();
      if (!backend && !update) turnId = randomUUID();
      updatePending = false;
      trace('engine-restarted-after-stop', {});
    } catch (error) {
      if (isCurrent()) {
        if (!update) closing = true;
        beginStop();
        try { stopCollected = (await stopEngine())?.collected === true; }
        catch { stopCollected = false; }
        stopUnconfirmed = !stopCollected; stopFinished = true;
      }
      throw error;
    }
  }
  const reconnectNotes = new Set(), updateRetries = new Set(), engineBindings = new Map();
  // Session approvals are keyed by the app argument the engine was given, so a handle is reacquired with
  // its original string argument (a name stays a name); the bundle ID is the fallback.
  const ORIGIN_LITERAL = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/;
  function rememberEngineBindings() {
    for (const [handle, target] of handleBundles) {
      if (!target?.appId || !/^[A-Za-z_$][\w$]*$/.test(handle)) continue;
      const origin = handleOrigins.get(handle);
      engineBindings.set(handle, origin && ORIGIN_LITERAL.test(origin) ? origin : JSON.stringify(target.appId));
    }
  }
  function restoreEngineBindings(code) {
    let prefix = '';
    for (const [handle, argument] of engineBindings) {
      if (!new RegExp(`(?:^|[^\\w$])${handle.replace(/[$]/g, '\\$&')}\\s*(?:\\.|\\[|\\?)`).test(code)) continue;
      prefix += `globalThis[${JSON.stringify(handle)}] = await cua.getApp(${argument});\n`;
      engineBindings.delete(handle);
    }
    return prefix;
  }
  function reconnectEngine(id) {
    const generation = stopGeneration, attempt = { generation };
    let collecting = false;
    restarting = attempt;
    clearTimeout(idleTimer);
    attempt.promise = (async () => {
      const preparedServer = await prepareEngine?.();
      if (generation !== stopGeneration || closing || disposed) throw new Error(/* notice */ 'Engine restart was stopped.');
      // End the open turn on the engine being replaced, as a normal turn end does, so it releases what it
      // holds. A hung or dead engine costs one grace period, never the reconnect.
      let graceTimer;
      await Promise.race([Promise.resolve().then(() => endOpenTurn(false, id)).catch(() => {}),
        new Promise(resolve => { graceTimer = setTimeout(resolve, stopGraceMs); })]);
      clearTimeout(graceTimer);
      if (generation !== stopGeneration || closing || disposed) throw new Error(/* notice */ 'Engine restart was stopped.');
      collecting = true; updatePending = true; beginStop();
      const receipt = await stopEngine();
      if (generation !== stopGeneration || closing || disposed) throw new Error(/* notice */ 'Engine restart was stopped.');
      stopCollected = receipt?.collected === true;
      if (!stopCollected) throw new Error('Engine collection is unconfirmed. Run /sleight stop before retrying.');
      // This cache is bound to the launch identity of the collected engine.
      // The existing client is already initialized; its replacement uses live replies.
      startup?.close(); startup = undefined;
      // The collected engine can't take an old turn's cleanup.
      turnEndCalls.clear(); failedTurnEnds.clear(); turnEndAttempts.clear();
      cancelInternalRequests('Engine collected.');
      rememberEngineBindings();
      invalidateDiagnostics(); forgetGuard(); browserStale.reset(); browserRecovery.reset();
      browserWarmConfirmed = false;
      privateWarmRequests.clear();
      dropHeldWarmPrompts();
      engineRequests.clear();
      await clipboard?.close();
      await restartCollectedEngine(false, true, preparedServer);
      reconnectNotes.add(id);
      trace('engine-update-reconnected', { id });
    })().catch(error => { backendRestartUnconfirmed = collecting && !stopCollected; throw error; })
      .finally(() => { if (restarting === attempt) restarting = undefined; });
    return attempt.promise;
  }
  const localRunning = new Set();
  const preapprovalNotes = new Map(); // call id -> grants made during that call
  let idleTimer;
  const documentMode = approvalScope === 'document';
  const documentGrants = new Set();
  const documentRisks = new Set();
  const documentCalls = new Map();
  let observedDocument;
  let observedEngines = new Set();
  let observedRisks = new Set();
  let documentAsking = false;
  const changes = new ChangeReview();
  const changeCalls = new Map();
  let lastWindow;
  let lastWindowText = '';
  let reviewing = false;
  let disposed = false;
  const browserHandles = new Set();
  const nativeHandles = new Set();
  const browserPlan = code => browserCall(code, browserHandles, nativeHandles);
  const browserCalls = new Map();
  const browserRecovery = new BrowserRecovery();
  const helperStates = new Map();
  const helperHandles = new Map();
  // js calls awaiting a reply, and whether this engine session has shown its first-call docs:
  // docs again without a js_reset mean the session restarted and every handle is gone.
  const jsCalls = new Map();
  const syntaxOrigins = new Map();
  const chromeSettled = new Set();
  let guardReady = false, guardGeneration = 0;
  const guardCalls = new Map();
  let abortWarm = () => {};
  const browserWarmToken = randomUUID();
  let browserWarmConfirmed = false;
  const privateWarmRequests = new Set();
  const nativeWarmRequests = new Set();
  const heldWarmPrompts = new Map(); // engine prompt -> decline timer, held while native inventory is pending
  const flushHeldWarmPrompts = () => {
    if (privateWarmRequests.size) return;
    for (const [held, timer] of [...heldWarmPrompts]) {
      clearTimeout(timer); heldWarmPrompts.delete(held);
      if (pendingClients.size) observeServerMessage(held);
      else if (!stopCollected && !closing && !disposed) toServer({ jsonrpc: '2.0', id: held.id, result: { action: 'decline' } });
    }
  };
  const dropHeldWarmPrompts = () => { for (const timer of heldWarmPrompts.values()) clearTimeout(timer); heldWarmPrompts.clear(); };
  const replWarmup = new ReplWarmup({ enabled: warmRepl,
    setup: () => replSetupCode({ browserChoice, scope: `${sessionId}:${turnId}`, token: browserWarmToken, ...outcomeSetup }),
    abort: () => { browserWarmConfirmed = false; abortWarm(); },
    request: code => new Promise(resolve => {
      let id;
      do { id = `sleight-warm-${nextInternalId++}`; }
      while (pendingClients.has(id) || internalRequests.has(id) || callGenerations.has(id));
      privateWarmRequests.add(id);
      let pending = true;
      const finish = (reply, expired = false) => {
        if (!pending) return;
        pending = false;
        browserWarmConfirmed = !expired && !!reply.result && !reply.error && !reply.result.isError;
        clearTimeout(timer);
        abortWarm = () => {};
        if (expired) {
          docOrigin.invalidate();
          internalRequests.set(id, reply => replWarmup.retainDocs(reply));
          forgetGuard();
        }
        resolve(reply);
        // The engine can drain native work before replying to a cell, even without await.
        // Keep inventory out of the guard cell and out of the held client's wait.
        // A client call already in flight pays the native start itself. An engine that runs cells
        // in order would also hold its approval prompt behind this private cell, where it is declined.
        queueMicrotask(() => { if (warmEngine && browserWarmConfirmed && !closing && !disposed && !pendingClients.size) {
          const nativeId = `sleight-native-warm-${nextInternalId++}`;
          privateWarmRequests.add(nativeId);
          nativeWarmRequests.add(nativeId);
          toServer({ jsonrpc: '2.0', id: nativeId, method: 'tools/call', params: { name: 'js',
            arguments: { code: 'try { void Promise.resolve(cua.listApps({ emit: false })).catch(() => {}); } catch {}',
              title: 'Prepare native inventory', timeout_ms: 1000 }, _meta: engineMeta() } });
        } });
      };
      const timer = setTimeout(() => finish({}, true), 6000);
      timer.unref?.();
      abortWarm = () => { docOrigin.invalidate(); finish({}); };
      internalRequests.set(id, finish);
      guardCalls.set(id, guardGeneration);
      const request = { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js',
        arguments: { code, title: 'Prepare sleight REPL', timeout_ms: 5000 }, _meta: engineMeta() } };
      docOrigin.begin(request, documentationContext(), { appFree: !browserChoice &&
        code === replSetupCode({ scope: `${sessionId}:${turnId}`, token: browserWarmToken, ...outcomeSetup }) });
      toServer(request);
    }),
    resume: msg => closing || disposed ? leaseStop(msg, promptNotice('REPL preparation was stopped before this call ran.', prompt)) : handleClient(msg),
    refuse: msg => leaseStop(msg, promptNotice('REPL preparation was stopped before this call ran.', prompt)),
  });
  const forgetGuard = () => { guardReady = false; guardGeneration++; };
  const screenshots = new Map(); // lowercased app name -> { latest, byTitle } pixel sizes of its engine screenshots
  const framesNoted = new Set(); // [app, title, size] keys whose coordinate frame note Claude has seen
  const stuckMenus = new Map(); // window key -> { title, shown } of its selected menu-bar item
  const stuckEscapes = createStuckEscapes();
  const openMenus = new Set(); // menuWindowKey of windows whose last result was an open menu
  const fileLists = new Map(); // window key -> file URLs its last file-browser tree listed
  let lastMenuTree; // the last result's tree, when it was a menu
  // Every tools/call gets the next number. An acquisition's read can stand in for the guard's
  // first read only in the call right after it (priorRead.seq + 1).
  let callSeq = 0, priorRead;
  // The previous call's final tree and its window, for the guard's menu-trap check when the next call's first key reads nothing.
  let lastTree;
  const callStarts = new Map(); // call id -> when it arrived, so a read's duration is known
  const callSeqs = new Map();
  let docsShown = false;
  let deferredEngineDocs = [], clientJsDelivered = false, deferredRules;
  let undeliveredGuidance = [];
  const engineDocs = (content = [], embedded = false) => content.flatMap(item => {
    if (item.type !== 'text') return [];
    const start = item.text.search(/^(?:## Computer Use|# Other Browser APIs|# Computer Use Confirmations Policy|# Browser Safety|# API Reference)\n/m);
    if (start < 0 || start > 0 && !embedded) return [];
    const text = item.text.slice(start), at = text.search(/^Window: /m);
    return [{ ...item, text: at < 0 ? text : text.slice(0, at) }];
  });
  const retainEngineDocs = content => {
    for (const docs of engineDocs(content)) if (!deferredEngineDocs.some(c => c.text === docs.text)) deferredEngineDocs.push(docs);
  };
  let clientJsSeen = false;
  const nativeAcquisitions = new Set();
  // Once per session: Claude keeps them in context across engine restarts.
  const ruleBlocks = ruleDelivery();
  const ruleItem = text => ruleBlocks.item(text);
  let rulesShown = false;
  let browserRulesShown = false;
  const browserRules = firstCallRules?.match(/## Browsers\n[\s\S]*?(?=\n## |$)/)?.[0];
  const nativeRules = browserRules ? firstCallRules.replace(browserRules, '').trim() : firstCallRules;
  function rulesFor(browser, policyRewritten = false) {
    if (!firstCallRules) return;
    if (!rulesShown) {
      rulesShown = true;
      if (browser) browserRulesShown = true;
      return guidanceForHost(requestedSubmitRules(browser ? firstCallRules : nativeRules, {
        SLEIGHT_RS: policyRewritten ? rs : '0', SLEIGHT_CONFIRM_PAYMENTS: confirmPayments, SLEIGHT_PROMPT: prompt,
      }), grokClient);
    }
    if (browser && !browserRulesShown && browserRules) {
      browserRulesShown = true;
      return guidanceForHost(browserRules, grokClient);
    }
  }
  const helperAliases = new Map();
  const helperReads = new Map();
  const helperProbes = new Map();
  const helperFullReads = new Set();
  const lateHelperReplies = new Set();
  let helperActive;
  const helperControls = new Map();
  const helperDiagnosticReplies = new Map();
  const lateDiagnosticControls = new Map();
  let diagnosisGeneration = 0;
  const diagnosisAdvice = (key, diagnosis) => promptNotice(diagnosis?.kind === 'app-save-panel'
    ? panelAdvice(diagnosis.target, key) ?? 'Read or input refused while the same Save panel remains. Follow the earlier recovery advice, then read the app again.'
    : readFailureAdvice(key, diagnosis), prompt);
  const helperAdvice = key => diagnosisAdvice(key, helperStates.get(key)?.diagnosis);
  // Apps Claude was told this turn are off the current Space, and the reads that wait on that
  // check: call id -> { key, health }.
  const spaceNoted = new Set(), spaceChecks = new Map();
  // What the probe found before each read went to the engine. An app that was already running with
  // a window wasn't launched by that read, which lets a split acquisition's read stand in below.
  const preHealth = new Map();
  const frontCalls = new Map();
  function cancelFrontCalls() {
    for (const token of frontCalls.values()) Promise.resolve().then(() =>
      frontRestore({ action: 'finish', token, success: false })).catch(() => {});
    frontCalls.clear();
  }
  async function forwardAcquisition(msg, selector) {
    const generation = stopGeneration;
    let token;
    try {
      ({ token } = await frontRestore({ action: 'begin', selector }) ?? {});
      if (token) {
        if (generation !== stopGeneration || closing || disposed) {
          await frontRestore({ action: 'finish', token, success: false }); return;
        }
        const ready = await frontRestore({ action: 'arm', token });
        if (generation !== stopGeneration || closing || disposed) {
          await frontRestore({ action: 'finish', token, success: false }); return;
        }
        if (ready?.armed === true) frontCalls.set(msg.id, token);
      }
    } catch { /* Missing helper evidence leaves focus alone. */ }
    if (generation === stopGeneration && !closing && !disposed) toServer(msg);
  }
  const savePanelsNoted = new Set();
  function panelAdvice(health) {
    if (health?.savePanelOnly !== true) return;
    const panels = (health.savePanelWindowIds?.length ? health.savePanelWindowIds : ['unknown'])
      .map(id => JSON.stringify([health.app ?? null, health.pid ?? null, id]));
    if (panels.every(id => savePanelsNoted.has(id))) return;
    panels.forEach(id => savePanelsNoted.add(id));
    return promptNotice(savePanelNote(health), prompt);
  }

  function invalidateDiagnostics() {
    diagnosisGeneration++;
    for (const [id, probe] of helperProbes) {
      if (!probe.control) continue;
      clearTimeout(probe.timer); helperProbes.delete(id); helperReads.delete(id); jsCalls.delete(id);
      documentCalls.delete(id); changeCalls.delete(id); lateHelperReplies.add(id); finishedCall(id);
      lateDiagnosticControls.set(id, { key: probe.control.key, generation: probe.generation });
      probe.receive({ error: { message: 'engine session changed' } });
    }
  }

  function controlRead(control) {
    if (disposed || closing || running.size || localRunning.size || documentAsking || reviewing || flowAsking || approvalScope !== 'session') return Promise.resolve({ status: 'unknown' });
    return new Promise(resolve => {
      const id = `sleight-diagnosis-${nextInternalId++}`;
      const generation = diagnosisGeneration;
      const finish = msg => {
        if (generation !== diagnosisGeneration) { resolve({ status: 'unknown' }); return; }
        helperFullReads.add(control.key);
        const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        resolve({ status: !msg.error && !msg.result?.isError && windowFromText(text) ? 'responding'
          : (msg.error || msg.result?.isError) && /\btimeoutReached\b/.test(msg.error?.message ?? text) ? 'timeout' : 'unknown' });
      };
      const probe = { receive: finish, control, generation };
      helperProbes.set(id, probe);
      helperFullReads.add(control.key);
      handleClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: control.probe, timeout_ms: 1500 } } });
      if (!helperProbes.has(id)) return;
      probe.timer = setTimeout(() => {
        helperProbes.delete(id); helperReads.delete(id); jsCalls.delete(id);
        documentCalls.delete(id); changeCalls.delete(id); lateHelperReplies.add(id); finishedCall(id);
        lateDiagnosticControls.set(id, { key: control.key, generation }); helperFullReads.add(control.key);
        // A relay response deadline is weaker evidence than a native timeoutReached.
        resolve({ status: 'unknown' });
      }, 5500);
    });
  }

  function helperSelector(selector) {
    let key;
    try {
      key = JSON.parse(selector.startsWith("'")
        ? '"' + selector.slice(1, -1).replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"') + '"' : selector);
    } catch { key = selector.replace(/\s+/g, ''); }
    key = typeof key === 'string' ? key.toLowerCase() : `window:${key.windowId}`;
    return helperAliases.get(key) ?? key;
  }
  function helperPlan(code) {
    if (typeof code !== 'string' || /cua\.rewriteDocumentation\(/.test(code)) return undefined;
    code = code.trim();
    const read = isLeaseRead(code);
    if (read && isInventoryRead(code)) return { read, key: 'helper inventory', probe: code };
    const literal = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{\s*(?:windowId|"windowId")\s*:\s*\d+\s*\})`;
    const acquisition = code.match(new RegExp(String.raw`^(?:(?:(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*)?await\s+cua\.getApp\(\s*${literal}\s*\)\s*;?$`));
    if (read && acquisition) {
      const selector = acquisition[2], key = helperSelector(selector);
      return { read, acquisition: true, key, selector, handle: acquisition[1] ?? 'app', probe: `var __sleightHelperRecovery = await cua.getApp(${selector})` };
    }
    const handles = [...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\./g)].map(m => m[1]);
    if (read) {
      const handle = handles.find(h => !['nodeRepl', 'cua'].includes(h));
      const known = helperHandles.get(handle);
      return { read, handle, selector: known?.selector, key: known?.key ?? `handle:${handle}`, probe: known?.probe ?? code };
    }
    const explicit = [...code.matchAll(new RegExp(String.raw`cua\.getApp\(\s*${literal}\s*\)`, 'g'))].map(m => helperSelector(m[1]));
    const keys = [...explicit, ...handles.map(h => helperHandles.get(h)?.key).filter(Boolean)];
    return { read, keys: keys.length ? keys : helperActive ? [helperActive] : [] };
  }
  function scheduleHelperRead(state) {
    clearTimeout(state.timer);
    const retry = () => {
      if (disposed || closing || !state.stuck || state.pending !== undefined) return;
      if (running.size || localRunning.size || documentAsking || reviewing || flowAsking) {
        state.timer = setTimeout(retry, 1000); state.timer.unref?.(); return;
      }
      const id = `sleight-helper-${nextInternalId++}`;
      helperProbes.set(id, {});
      handleClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: state.probe, timeout_ms: 5000 } } });
      if (!helperReads.has(id)) { scheduleHelperRead(state); return; }
      const probe = helperProbes.get(id);
      if (probe) {
        probe.timer = setTimeout(() => {
          const plan = helperReads.get(id); helperReads.delete(id);
          updateHelperRead(plan, { error: { message: 'timeoutReached: automatic helper read timed out' } });
          documentCalls.delete(id); changeCalls.delete(id); helperProbes.delete(id);
          lateHelperReplies.add(id); finishedCall(id);
          trace('helper-recovery-timeout', { id, app: state.key });
        }, 5500);
        probe.timer.unref?.();
      }
    };
    state.timer = setTimeout(retry, Math.max(1000, state.retryAt - Date.now()));
    state.timer.unref?.();
  }
  function updateHelperRead(plan, msg) {
    if (!plan) return;
    let state = helperStates.get(plan.key);
    if (!state) { state = { key: plan.key, timeouts: 0, probe: plan.probe }; helperStates.set(plan.key, state); }
    const error = msg.error?.message ?? (msg.result?.isError
      ? (msg.result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n') : '');
    const success = !msg.error && !msg.result?.isError;
    state.pending = undefined;
    if (success) {
      clearTimeout(state.timer); helperStates.delete(plan.key);
      if (state.stuck) trace('helper-recovered', { app: plan.key });
      if (helperProbes.has(msg.id) && plan.key !== 'helper inventory') helperFullReads.add(plan.key);
      if (plan.fullVisible) helperFullReads.delete(plan.key);
      const appId = msg.result?._meta?.['codex/toolSurface']?.app?.appId;
      const window = windowFromText((msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'));
      if (plan.selector) for (const alias of [appId, window?.app]) {
        if (typeof alias === 'string') helperAliases.set(alias.toLowerCase(), plan.key);
      }
      if (window && plan.selector && plan.key !== 'helper inventory') helperControls.set(plan.key, plan);
      return;
    }
    helperControls.delete(plan.key);
    state.timeouts = /\btimeoutReached\b/.test(error) ? state.timeouts + 1 : 0;
    if (state.timeouts >= 2 && !state.stuck) {
      state.stuck = true; state.retryAt = Date.now() + 20000;
      trace('helper-stuck', { id: msg.id, app: plan.key, consecutiveReadTimeouts: state.timeouts });
      if (diagnoseRead && !helperProbes.has(msg.id)) {
        const generation = diagnosisGeneration;
        const control = [...helperControls.values()].find(other => other.key !== plan.key && !helperStates.get(other.key)?.stuck);
        state.diagnosing = Promise.resolve().then(() => diagnoseRead(plan.key, control?.key, () => control && generation === diagnosisGeneration ? controlRead(control) : Promise.resolve({ status: 'unknown' })))
          .then(diagnosis => { state.diagnosis = generation === diagnosisGeneration ? diagnosis : { kind: 'unknown' }; trace('helper-diagnosis', { app: plan.key, ...state.diagnosis }); })
          .catch(() => { state.diagnosis = { kind: 'unknown' }; });
        helperDiagnosticReplies.set(msg.id, state);
      }
    }
    if (state.stuck) {
      scheduleHelperRead(state);
      if (!helperDiagnosticReplies.has(msg.id)) {
        if (msg.error) msg.error.message += `\n\n${helperAdvice(plan.key)}`;
        else msg.result = { ...msg.result, isError: true, content: [...(msg.result?.content ?? []), { type: 'text', text: helperAdvice(plan.key) }] };
      }
    }
  }
  const flowCalls = new Map();
  let flowPending;
  let flowPermit;
  let flowAsking = false;
  // An engine-path browser_open's keys carry the tool's own arguments, so a flow exception allows its identical retry.
  const fingerprint = msg => engineOpenPrints.get(msg.id) ?? JSON.stringify([msg.params.name, msg.params.arguments ?? {}]);
  // engineOpenAllowed: a browser_open whose keys a flow exception allowed, so a tab continuation's rest is covered too.
  const engineOpenPrints = new Map(), engineOpenAcquisitions = new Set(), engineOpenAllowed = new Map();
  function flowStop(msg, reason) {
    toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `Flow rules: ${reason}. Stop. Ask the user with flow_exception for one identical retry; never work around the rule.` }] } });
  }
  async function flowException(msg) {
    if (Object.keys(msg.params.arguments ?? {}).length) { flowStop(msg, 'only the user can decide; no arguments are accepted'); return; }
    if (!flowPending || running.size || localRunning.size || reviewing || documentAsking || flowAsking) { flowStop(msg, 'a stopped call and no pending call or prompt are required'); return; }
    const pending = flowPending;
    flowAsking = true;
    const detail = `${pending.reason}\n\nTool: ${pending.name}\nArguments:\n${JSON.stringify(pending.args, null, 2)}\n\nAllow this exact call once? The rule stays active afterward.`;
    try {
      const answer = queueDecision(() => ask ? askPrompt([msg.id], 'Allow one flow-rule exception?', false, { kind: 'flow', detail }) : elicit(detail), [msg.id]);
      const action = await answer.catch(() => 'cancel');
      if (disposed) return;
      flowPermit = action === 'accept' ? { fingerprint: pending.fingerprint, revision: flowRules.revision } : undefined;
      trace('flow-exception-decision', { rules: pending.rules, action });
      toClient({ jsonrpc: '2.0', id: msg.id, result: { ...(action !== 'accept' ? { isError: true } : {}), content: [{ type: 'text', text: action === 'accept' ? 'The user allowed one identical retry. Any other call cancels this exception.' : 'The user did not allow this transfer. Stop and tell them.' }] } });
    } finally { flowAsking = false; }
  }

  function changeStop(msg, reason) {
    toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `Change review: ${reason}. Stop and tell the user.` }] } });
  }

  function clipboardStop(msg, reason) {
    toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: reason }] } });
  }
  function clipboardNotices(msg, notices) {
    if (!notices?.length) return;
    msg.result = { ...(msg.result ?? {}), content: [...(msg.result?.content ?? []), ...notices.map(text => ({ type: 'text', text: promptNotice(text, prompt) }))] };
  }

  async function reviewChanges(msg) {
    const generation = stopGeneration;
    const args = msg.params.arguments ?? {};
    if (Object.keys(args).some(k => k !== 'op') || !['list', 'review'].includes(args.op ?? 'list')) {
      changeStop(msg, 'only op list or review is accepted. Keep and Undo decisions must come from the user'); return;
    }
    if (running.size || localRunning.size || reviewing || documentAsking || flowAsking) { changeStop(msg, 'wait for the pending call or prompt'); return; }
    const entries = [...changes.entries.values()];
    if ((args.op ?? 'list') === 'list') {
      toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: entries.map(e => changes.describe(e)).join('\n\n') || 'No saved-file changes captured this session.' }] } }); return;
    }
    if (inputLease && entries.length) {
      try {
        const key = inputLease.acquire({ appId: 'desktop', app: 'macOS', title: 'change review', url: null }, 'desktop');
        leaseCalls.set(msg.id, { key }); refreshHeartbeat();
      } catch (err) { leaseStop(msg, err.message); return; }
    }
    clearTimeout(idleTimer);
    reviewing = true;
    const results = [];
    let failed = false;
    try {
      for (const entry of entries) {
        if (generation !== stopGeneration || closing || disposed) { failed = true; results.push('Review stopped; changes remain pending.'); break; }
        const detail = changes.describe(entry);
        const answer = queueDecision(() => ask
          ? askPrompt([msg.id], `Review ${entry.title}`, false, { kind: 'review', detail })
          : elicitReview(`Review ${entry.title}\n${detail}\nChoose Keep, Undo or Later. Undo restores the saved copy shown above. Reopen it in the app afterward.`), [msg.id]);
        const decision = await answer.catch(() => 'cancel');
        if (disposed) return;
        if (generation !== stopGeneration || closing) { failed = true; results.push('Review stopped; changes remain pending.'); break; }
        trace('review-decision', { path: entry.path, decision });
        try {
          if (['keep', 'undo'].includes(decision)) {
            if (closing || leaseFault) throw new Error(/* notice */ 'Input lease: this session is closing.');
            const key = leaseCalls.get(msg.id)?.key;
            if (key) inputLease.renew([key]);
            results.push(changes.decide(entry, decision));
          } else results.push(`${entry.path}: pending, no user decision.`);
        }
        catch (err) { failed = true; results.push(`Refused: ${err.message}`); }
      }
      toClient({ jsonrpc: '2.0', id: msg.id, result: { ...(failed ? { isError: true } : {}), content: [{ type: 'text', text: results.join('\n') || 'No saved-file changes captured this session.' }] } });
    } finally {
      reviewing = false;
      const key = leaseCalls.get(msg.id)?.key;
      finishedCall(msg.id);
      if (key) {
        try { inputLease.release([key]); }
        catch (err) { trace('input-lease-release-error', { error: err.message }); }
      }
      scheduleIdleEnd();
    }
  }
  let leaseWindow;
  let nativeHandoff;
  const nativeHandoffUnavailable = /* notice */ 'Handoff not resumed; app kept for the user. Nothing is waiting. End your turn: ask the user to finish sign-in on the Mac and reply "signed in" or "continue". On their next message, acquire the app fresh.';
  async function handoffNativeApp(msg) {
    const args = msg.params.arguments ?? {};
    if (msg.id === undefined || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
      leaseStop(msg, promptNotice('app_handoff takes no arguments.', prompt)); return;
    }
    const target = leaseWindow, generation = stopGeneration, kernel = kernelEpoch, engine = engineEpoch;
    if (!inputLease || !target?.appId || !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/.test(target.appId) ||
        webBrowser(target.appId) === true || ownWindow(target) || documentMode) {
      leaseStop(msg, promptNotice('app_handoff needs a confirmed native app read with an input lease. Browser and document-scoped surfaces must stop for the user.', prompt)); return;
    }
    if (closing || disposed || stopCollected || leaseFault || running.size || localRunning.size || internalRequests.size || approvalRequests.size) {
      leaseStop(msg, promptNotice('another call is pending or this session is stopped.', prompt)); return;
    }
    const blocked = appLine(target.appId, target.app);
    if (blocked) { blockStop(msg, blocked); return; }
    let key;
    try { key = inputLease.acquire(target, 'app'); }
    catch (error) { leaseStop(msg, error.message); return; }
    const state = { id: msg.id }, current = () => nativeHandoff === state && generation === stopGeneration &&
      kernel === kernelEpoch && engine === engineEpoch && !state.cancelled && !closing && !disposed && !stopCollected && !leaseFault &&
      !appLine(target.appId, target.app);
    state.cancel = () => { state.cancelled = true; };
    nativeHandoff = state;
    cursorStatus('handback', { app: target.app });
    running.add(msg.id); localRunning.add(msg.id); leaseCalls.set(msg.id, { key });
    callDetails.set(msg.id, 'native sign-in handoff'); clearTimeout(idleTimer); refreshHeartbeat();
    let ui, waiter, returned = false, present = true;
    try {
      present = await remotePresent();
      if (!current()) throw Error('Handoff not resumed; app kept for the user.');
      ui = await handoffUi();
      if (!current()) throw Error('Handoff not resumed; app kept for the user.');
      waiter = createHandoffWaiter({ ui, current, session: sessionId, turn: turnId, timeoutMs: handoffTimeoutMs });
      state.cancel = () => waiter.dispose();
      const pending = waiter.wait({ app: target.appId });
      if (!present && pending.shown !== true) throw Error(nativeHandoffUnavailable);
      if (!present) {
        returned = true;
        toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: false, content: [{ type: 'text',
          text: 'App kept for the user. The card closes when this turn ends. End your turn: ask the user to finish sign-in on the Mac and reply "signed in" or "continue". On their next message, acquire the app fresh.' }] } });
      }
      const resumed = await pending;
      if (!resumed || !current()) throw Error('Handoff not resumed; app kept for the user.');
      // The person's Continue permits replacing the previous window identity,
      // not the app identity. Forget stale refs/selection before the usual
      // acquisition path, which still asks engine approvals and binds a lease.
      forgetHandles(); compactor.reset();
      if (returned) return;
      inputLease.renew([key]);
      const id = `sleight-signin-${nextInternalId++}`, handle = `__sleightSigninApp${nextInternalId++}`;
      state.readId = id;
      const reply = await new Promise(resolve => {
        state.cancel = () => { lateHelperReplies.add(id); splitCalls.delete(id); resolve(undefined); };
        callGenerations.set(id, generation);
        splitCalls.set(id, resolve);
        handleClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js',
          arguments: { code: `var ${handle} = await cua.getApp(${JSON.stringify(target.appId)})` } } });
      });
      if (!current() || !reply) throw Error('Handoff not resumed; app kept for the user.');
      const bundle = reply.result?._meta?.['codex/toolSurface']?.app?.appId;
      if (reply.error || reply.result?.isError) {
        toClient({ ...reply, id: msg.id }); return;
      }
      if (bundle !== target.appId || leaseWindow?.appId !== target.appId) {
        forgetHandles();
        throw Error('Handoff acquisition has no matching app identity. Read the intended app again.');
      }
      toClient({ ...reply, id: msg.id, result: { ...reply.result, isError: false, content: [
        { type: 'text', text: promptNotice(`Continue received; fresh engine read. Sign-in is unverified. Use ${handle} for this app. Payments and submits keep their usual checks.`, prompt) },
        ...(reply.result.content ?? []),
      ] } });
    } catch (error) {
      if (!returned && !disposed && generation === stopGeneration) leaseStop(msg, promptNotice(!present ? nativeHandoffUnavailable : /^Handoff /.test(error.message) ? error.message : 'Handoff not resumed; app kept for the user.', prompt));
    } finally {
      waiter?.dispose(); try { ui?.close?.(); } catch {}
      if (nativeHandoff === state) nativeHandoff = undefined;
      localRunning.delete(msg.id); finishedCall(msg.id);
      try { inputLease.release([key]); } catch (error) { trace('input-lease-release-error', { error: error.message }); }
    }
  }
  // The window IDs results showed, and which window each pop-up came up from. Each decision is traced (popup-window).
  const popups = popupWindows(event => trace('popup-window', event));
  let recoveryTarget, recoveryKnown = false; // recoveryKnown: the target is a bundle ID the engine confirmed
  let stateRead = false; // a getState read went to the engine this session, so its app ids are Claude's to use
  let lastConfirmedWindow; // the lease's last window with a confirmed bundle ID, kept when the lease drops
  let lastShown = new Set(); // the standard windows the last observed result showed (shownStandardWindows), for the parent lease
  // Call id -> the window the parent lease pinned for that call. The pin lasts until the call's reply goes out.
  const parentPins = new Map();
  function releasePin(id) {
    const target = parentPins.get(id);
    if (!target) return;
    parentPins.delete(id);
    if (target.parentPin?.id !== id) return;
    const { nativeIdentity, identityRequired } = target.parentPin;
    delete target.parentPin;
    if (nativeIdentity === undefined) delete target.nativeIdentity; else target.nativeIdentity = nativeIdentity;
    if (identityRequired === undefined) delete target.identityRequired; else target.identityRequired = identityRequired;
  }
  let selectedWindow; // Explicit select_window only, including its opened-handle recovery.
  let openedWindow; // Advisory document hint, used only for drag defaults.
  let selectionVerified = false;
  function clearSelection() {
    selectedWindow = undefined; selectionVerified = false;
    if (leaseWindow) delete leaseWindow.selectedParent;
  }
  const sameHeader = (a, b) => a && b && ['title', 'app', 'url'].every(key => a[key] === b[key]);
  // Retain a verified child's parent for recovery, never for ordinary input confirmation.
  const sameWindow = (a, b) => sameHeader(a, b) || a && b && a.title === b.title && a.app === b.app &&
    (!a.url && sameHeader(a.selectedParent, b) || !b.url && sameHeader(b.selectedParent, a));
  function selectionRecovery() {
    const args = { app: selectedWindow.appId, ...(selectedWindow.url ? { url: selectedWindow.url } : { title: selectedWindow.title }) };
    if (selectedWindow.windowNumber !== undefined) args.windowNumber = selectedWindow.windowNumber;
    return `Call select_window with ${JSON.stringify(args)}.`;
  }
  function confirmRecovery() {
    return promptNotice(`Begin js with \u0060${constApp ? '' : 'let app = '}await cua.getApp(${JSON.stringify(selectedWindow.appId)})\u0060 (name or bundle ID); actions may follow on its returned handle.`, prompt);
  }
  function selectedCancel(code) {
    return typeof code === 'string' && selectedWindow && selectedWindow.windowNumber !== undefined && leaseWindow?.appId === selectedWindow.appId &&
      sameWindow(leaseWindow, selectedWindow) && code.trim().replace(/;$/, '').split(';').every(statement => {
        const action = /^\s*await\s+([A-Za-z_$][\w$]*)\.(pressKey|click|performSecondaryAction)\((.*)\)\s*$/.exec(statement);
        if (!action) return isLeaseRead(statement.trim());
        const handleWindow = openedWindows.get(action[1]) ?? handleBundles.get(action[1]);
        if (handleWindow?.appId !== selectedWindow.appId ||
            openedWindows.has(action[1]) && !sameHeader(handleWindow, selectedWindow)) return false;
        const acquiredNumber = handleSelectors.get(action[1])?.match(/^\{\s*(?:windowId|"windowId")\s*:\s*(\d+)\s*\}$/)?.[1];
        const number = acquiredNumber ? Number(acquiredNumber) : handleWindow.windowNumber ?? handleWindow.nativeIdentity?.windowNumber;
        if (number !== undefined && number !== selectedWindow.windowNumber ||
            leaseWindow.selectedParent && !openedWindows.has(action[1]) && number === undefined) return false;
        if (isChangeCancel(`await app.${action[2]}(${action[3]})`, lastWindowText)) return true;
        const cancel = action[2] === 'performSecondaryAction' && /^\s*(\d+)\s*,\s*(["'])Cancel\2\s*$/.exec(action[3]);
        if (!cancel) return false;
        const lines = lastWindowText.split('\n'), root = lines.findIndex(line => /^0 /.test(line));
        if (root < 0 || !(menuRoot(lastWindowText) || /^0 (?:sheet|dialog)\b/.test(lines[root]))) return false;
        for (let i = root; i < lines.length; i++) {
          if (i > root && /^\S/.test(lines[i])) break;
          const element = /^\s*(\d+) (.*)$/.exec(lines[i]);
          if (element?.[1] === cancel[1]) return /Secondary Actions: (?:[^,]*, )*Cancel(?:,|$)/.test(element[2]);
        }
        return false;
      });
  }
  let constApp = false;
  // After js_reset, or when the engine's session restarts on its own, no handle survives.
  function forgetHandles() {
    engineBindings.clear();
    browserStale.reset();
    forgetGuard();
    tabsMayNeedCleanup = false;
    openedReads.clear();
    // Keep native routing names, not their handles or grants. A stale native name must still take
    // the native read and clipboard path until a confirmed browser binding replaces it.
    clearSelection(); openedWindow = undefined; browserHandles.clear(); leaseWindow = undefined; lastShown = new Set(); for (const id of [...parentPins.keys()]) releasePin(id); dragWindows.clear(); handleBundles.clear(); openedWindows.clear(); openedWindowCalls.clear(); openedAliases.clear(); unconfirmedHandles.clear(); handleSelectors.clear(); handleOrigins.clear(); constApp = false;
    standardWindows.clear(); appProcesses.clear(); processProbes.clear();
  }
  const dragWindows = new Map(); // successful numbered window reads, for cross-window endpoints
  const handleBundles = new Map();
  // Engine app handles share the app's main window. Keep open_file's document binding separately from reads.
  const openedWindows = new Map(), openedWindowCalls = new Set(), openedAliases = new Map();
  const openedWindowLeases = new Map(), openedFlowPlans = new Map(), openedWindowReads = new Set();
  function openedWindowCall(msg, flowPlan) {
    if (msg.method !== 'tools/call' || msg.params?.name !== 'js' || openedWindowCalls.has(msg.id)) return false;
    const code = msg.params.arguments?.code;
    if (typeof code !== 'string' || !openedWindows.size) return false;
    const bare = codeOnly(code), bindings = new Map(openedWindows);
    // Retain only simple aliases, member receivers and standalone echoes. Any other use of a
    // bound name can assign or shadow it (including patterns, loop heads and parameters), so forget it.
    let rest = bare.replace(/(^|;)\s*(?:(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*(?=;|$)/g,
      (match, boundary, name, source) => {
        const target = bindings.get(source);
        if (target) bindings.set(name, target); else bindings.delete(name);
        return boundary + ' '.repeat(match.length - boundary.length);
      });
    rest = rest.replace(/\b[A-Za-z_$][\w$]*(?=\s*\.)/g, '')
      .replace(/(^|;)\s*[A-Za-z_$][\w$]*\s*(?=;|$)/g, '$1');
    const uncertain = new Set([...rest.matchAll(/[A-Za-z_$][\w$]*/g)].map(match => match[0]));
    for (const name of bindings.keys()) if (uncertain.has(name) || /`[\s\S]*?\$\{/.test(code)) bindings.delete(name);
    // Prune on mixed action paths too, before any async selection or successful reply can retain aliases.
    for (const name of openedWindows.keys()) if (!bindings.has(name)) openedWindows.delete(name);
    const handles = [...new Set([...bare.matchAll(HANDLE_CALL)].map(match => match[1]).filter(handle => bindings.has(handle)))];
    if (!handles.length) {
      // A standalone alias is a local REPL assignment; it needs no window selection.
      if (/^\s*(?:(?:let|const|var)\s+)?[A-Za-z_$][\w$]*\s*=\s*[A-Za-z_$][\w$]*\s*;?\s*$/.test(bare)) {
        openedAliases.set(msg.id, bindings);
      }
      return false;
    }
    const target = bindings.get(handles[0]);
    openedWindow = handles.every(handle => bindings.get(handle) === target) ? target : undefined;
    if (!selectedWindow) {
      // Opened handles share the engine's app window. Keep their file URL as a hint,
      // without selecting, re-reading or requiring document identity on a URL-less child.
      openedAliases.set(msg.id, bindings);
      return false;
    }
    const request = { app: target.appId, url: target.url };
    const refuse = () => leaseStop(msg, promptNotice(`handle ${handles[0]} belongs to ${JSON.stringify(target.url)}; window unconfirmed. Call select_window with ${JSON.stringify(request)}.`, prompt));
    if (selectedWindow.appId !== target.appId || !sameHeader(selectedWindow, target)) {
      refuse(); return true;
    }
    if (!inputLease || !windowIdentity || !localTools?.call || !localNames.has('select_window') || running.size || handles.some(handle => bindings.get(handle) !== target)) {
      refuse(); return true;
    }
    const blocked = callBlock('js', msg.params.arguments) ?? appLine(target.appId, target.app);
    if (blocked) { blockStop(msg, blocked); return true; }
    // A sheet belongs to its document. The existing parent lease checks keep that dialog attached to this window.
    if (leaseWindow?.appId === target.appId && sameWindow(leaseWindow.parent, target)) {
      openedAliases.set(msg.id, bindings); return false;
    }
    if (documentMode && (!documentAllowed() || !sameWindow(observedDocument, target))) { refuse(); return true; }
    const generation = stopGeneration;
    const current = () => {
      if (generation !== stopGeneration || closing || disposed) throw Error('opened window call stopped');
    };
    running.add(msg.id); localRunning.add(msg.id);
    if (flowPlan) openedFlowPlans.set(msg.id, flowPlan);
    callDetails.set(msg.id, 'opened handle window');
    Promise.resolve().then(async () => {
      current();
      let key;
      try { key = inputLease.acquire(target, 'app'); }
      catch (error) { stop(error.message); return; }
      openedWindowLeases.set(msg.id, key); refreshHeartbeat();
      const expected = leaseWindow?.selectedParent && sameWindow(leaseWindow, target)
        ? { ...target, windowNumber: leaseWindow.selectedParent.windowNumber, nativeIdentity: leaseWindow.nativeIdentity } : target;
      const identity = verifyWindowIdentity(expected, await windowIdentity({ ...expected, allowUnfocused: true }));
      current();
      const matched = leaseWindow?.appId === target.appId && sameWindow(leaseWindow, target);
      if (!matched) {
        const result = await localTools.call('select_window', { ...request, expectedAppId: target.appId,
          ...(Number.isSafeInteger(identity.windowNumber) && identity.windowNumber > 0 ? { windowNumber: identity.windowNumber } : {}) }, async (parts, message, options) => {
          const allowed = await approve(parts, message, msg.id, options); current();
          if (allowed) inputLease.renew([key]);
          return allowed;
        }, undefined, target);
        current();
        const value = !result.isError && JSON.parse(result.content?.find(c => c.type === 'text')?.text ?? '{}');
        if (!value?.ok || value.target?.appId !== target.appId || !sameWindow(value.target, target) ||
            value.identity?.pid !== identity.pid || value.identity?.windowNumber !== identity.windowNumber) throw Error('selection unconfirmed');
        selectedWindow = { ...value.target, windowNumber: identity.windowNumber };
        selectionVerified = false;
        const id = `sleight-opened-window-${nextInternalId++}`;
        callGenerations.set(id, generation);
        openedWindowReads.add(id);
        splitCalls.set(id, async reply => {
          try {
            current();
            if (reply.error || reply.result?.isError || leaseWindow?.appId !== target.appId || !sameWindow(leaseWindow, target)) throw Error('read unconfirmed');
            const checked = verifyWindowIdentity({ ...target, nativeIdentity: identity, windowNumber: value.identity.windowNumber },
              await windowIdentity({ ...target, windowNumber: value.identity.windowNumber }));
            current();
            resume(checked);
          } catch { stop(); }
        });
        handleClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: `var __sleightWindowCheck${nextInternalId++} = await cua.getApp(${JSON.stringify(target.appId)})` } } });
      } else {
        const checked = verifyWindowIdentity({ ...target, nativeIdentity: identity }, await windowIdentity(target));
        current(); resume(checked);
      }
    }).catch(() => stop());
    const stop = reason => {
      localRunning.delete(msg.id); finishedCall(msg.id);
      if (generation === stopGeneration && !closing && !disposed) {
        if (reason) leaseStop(msg, reason); else refuse();
      }
    };
    const resume = identity => {
      leaseWindow.nativeIdentity = identity; leaseWindow.identityRequired = true;
      openedAliases.set(msg.id, bindings);
      selectedWindow = { ...target, windowNumber: identity.windowNumber, nativeIdentity: identity }; selectionVerified = true;
      localRunning.delete(msg.id); running.delete(msg.id);
      openedWindowCalls.add(msg.id); handleClient(msg);
    };
    return true;
  }
  const unconfirmedHandles = new Set(); // handles an acquisition bound without a confirmed bundle ID
  // Windows seen with a standard-window root, by documentKey, with when, for which bundle and in which process: only
  // these can be covered by a dialog the lease moves to. A process note forgets the bundle's windows from any other
  // process, and those seen before any process was known, since a relaunch may have come between.
  const standardWindows = new Map(), appProcesses = new Map(), processProbes = new Map();
  const processKey = observed => `${observed.pid}:${observed.processStart}`;
  const noteProcess = observed => {
    if (typeof observed?.appId !== 'string' || !Number.isSafeInteger(observed.pid)) return;
    const instance = processKey(observed);
    appProcesses.set(observed.appId, instance);
    for (const [key, seen] of standardWindows) if (seen.appId === observed.appId && seen.process !== instance) standardWindows.delete(key);
    if (leaseWindow?.appId === observed.appId && leaseWindow.parent && leaseWindow.parent.seen?.process !== instance) delete leaseWindow.parent;
  };
  function numberWindow(code, fallback) {
    const handles = numberedHandles(code);
    const window = handles.length === 1 && handleBundles.get(handles[0]);
    const numbers = literalNumbers(code), lines = compactor.seenLines(window, numbers);
    // An unknown handle or a window whose numbers Claude never saw retains the old check. Only another app's handle
    // changes the window: handleBundles moves on reads, so after an action retitled or opened a sheet in the same
    // app, its entry is the old window and the lease target is the current one.
    return window && fallback && window.app !== fallback.app && numbers.every(n => lines?.[n] !== undefined) ? window : fallback;
  }
  const handleOrigins = new Map(); // handle -> the getApp argument that acquired it
  const handleSelectors = new Map();
  const selectorWindows = new Map();
  function observedAppId(call, window, result) {
    const appId = result?._meta?.['codex/toolSurface']?.app?.appId;
    const cached = call.acquisition ? selectorWindows.get(call.selector)
      : call.handle ? handleBundles.get(call.handle) : leaseWindow;
    const matches = window && cached && (call.acquisition
      ? documentKey(cached.window) === documentKey(window) : cached.app === window.app);
    return window && (typeof appId === 'string' && appId ? appId : matches ? cached.appId : undefined);
  }
  let leaseFault;
  let leaseTimer;
  let closing;
  let renewalFailures = 0;
  const leaseCalls = new Map();
  const drained = new Set();
  function stopHeartbeat() { clearInterval(leaseTimer); leaseTimer = undefined; }

  // sleight's own consent host (its glove, approval and payment cards) answers only the person's click. No call reaches
  // it, and a reply whose window is it reaches Claude only as the line (ported from claude/p130-pm1 ba365bcf, ccf2ed6f).
  // reply id -> the line Claude gets instead of the reply: OWN_HOST_LINE, or the user's line for an app or site they blocked.
  const withheld = new Map();
  const ownWindow = window => !!window && isOwnHost(window.appId, window.app);
  // macOS's Touch ID and password sheets (coreautha, SecurityAgent) are refused the same way, with their own line.
  function ownStop(msg, line = OWN_HOST_LINE) {
    toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: line }] } });
  }
  // A local tool's app, a js call's getApp literals (a name, a path or a pid, however spelled), and the windows its
  // handles hold from reads. A computed getApp reaches the engine, whose approval card for the host is declined.
  // Returns the line for the first one named, or undefined.
  function namesOwnHost(name, args) {
    if (name !== 'js') return isOwnHost(args.app) ? ownLine(args.app) : undefined;
    const code = String(args.code ?? '');
    const target = getAppTargets(code).find(target => appNamesOwnHost(target, ownHostPid));
    if (target !== undefined) return ownLine(target);
    const held = [...codeOnly(code).matchAll(HANDLE_CALL)].map(match => handleBundles.get(match[1])).find(ownWindow);
    return held ? ownLine(held.appId, held.app) : undefined;
  }
  // The engine's approval card names the host by its app (a name, alias, path or pid) or in its message.
  const ownApproval = msg => isAppApproval(msg) &&
    (appNamesOwnHost(msg.params?._meta?.tool_params?.app, ownHostPid) || mentionsOwnHost(msg.params?.message));
  const approvalLine = msg => ownLine(msg.params?._meta?.tool_params?.app) === AUTH_DIALOG_LINE ||
    /\b(?:coreautha|coreauthd|securityagent|com\.apple\.localauthentication)\b/i.test(String(msg.params?.message ?? '')) ? AUTH_DIALOG_LINE : OWN_HOST_LINE;

  function failLease(error) {
    nativeHandoff?.cancel?.();
    directBrowser?.end();
    leaseFault = error.message;
    trace('input-lease-error', { error: leaseFault });
    closing = true;
    replWarmup.cancel();
    stopHeartbeat();
    onLeaseFault(error);
  }

  // An app the user blocked is declined without asking them; the read or action then reaches Claude as the user's line.
  function declineBlockedApproval(msg) {
    const asked = msg.params?._meta?.tool_params?.app, refusal = appLine(asked, asked);
    if (!refusal) return false;
    trace('blocked-app-approval', { id: msg.id });
    for (const id of running) if (!localRunning.has(id)) withheld.set(id, refusal);
    toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'decline' } });
    return true;
  }
  // A blocked app answers with the user's one line and nothing reaches the engine.
  function blockStop(msg, line) {
    toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: line }] } });
  }
  // Every app a call names: a local tool's app, a js call's getApp strings, and the apps its handles hold from earlier reads.
  // sleight's own consent host (its glove, approval and payment cards) is refused with or without the user's blocks.
  const appLine = (bundleId, name) => appNamesOwnHost(bundleId, ownHostPid) || isOwnHost(bundleId, name) ? ownLine(bundleId, name) : permissions?.app({ bundleId, name });
  function callBlock(name, args) {
    if (name !== 'js') return typeof args.app === 'string' ? appLine(args.app, args.app) : undefined;
    const code = String(args.code ?? '');
    // Every getApp argument made of string literals, however spelled (own-host.mjs). A computed name is left to the
    // engine's approval card, which the relay declines for a blocked app, and to the read, which is withheld.
    for (const literal of getAppTargets(code)) {
      const line = appLine(literal, literal);
      if (line) return line;
    }
    for (const match of codeOnly(code).matchAll(HANDLE_CALL)) {
      const held = handleBundles.get(match[1]), line = held && appLine(held.appId, held.app);
      if (line) return line;
    }
    return undefined;
  }
  // Site blocks on the engine path: a browser window's action needs a read that proves an allowed site. webBrowser is asked
  // only once the user has site limits. While its answer is pending (undefined), every app counts as a browser: a proven
  // site is judged, and an action without one is refused. When the lookup failed or the window has no bundle id (null), a
  // window counts as a browser's when its read shows web content. A confirmed browser's read of a page whose site can't be
  // proven is withheld; a read with no web content still reaches Claude, so a start page can be read.
  const UNKNOWN_BROWSERS = "You limited the sites sleight acts on, and it doesn't know yet whether this app is a web browser, so it doesn't act here. Try again in a moment (sleight-mcp permissions lists your limits).";
  const pageLine = (window, read = false) => {
    if (!permissions?.sitesLimited?.()) return undefined;
    const browser = webBrowser(window?.appId), page = window?.page;
    if (browser === false || browser === null && !page) return undefined;
    if (read) return !page || page.unproven && browser !== true ? undefined : permissions.page(page);
    if (browser === undefined && (!page || page.unproven)) return UNKNOWN_BROWSERS;
    return permissions.page(page);
  };
  function leaseStop(msg, reason, browserAdvice = false) {
    const note = browserAdvice && msg.params?.name === 'js' && browserLeaseNote(msg.params.arguments?.code, browserHandles);
    const content = [{ type: 'text', text: reason.startsWith('Input lease:') ? reason : `Input lease: ${reason}` }];
    if (note) content[0].text += '\n' + promptNotice(note, prompt);
    toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true,
      content } });
  }
  function refreshHeartbeat() {
    if (disposed) { stopHeartbeat(); return; }
    const keys = [...leaseCalls.values()].map(c => c.key).filter(Boolean).concat([...openedWindowLeases.values()]);
    if (!keys.length) { stopHeartbeat(); return; }
    if (leaseTimer) return;
    leaseTimer = setInterval(() => {
      const active = new Set([...leaseCalls.values()].map(c => c.key).filter(Boolean).concat([...openedWindowLeases.values()]));
      try { inputLease.renew(active); renewalFailures = 0; }
      catch (err) {
        trace('input-lease-renewal-error', { error: err.message });
        // Three busy ticks give up after 15 s, leaving time to stop the engine
        // before a lease renewed on the preceding tick can expire at 30 s.
        if (!err.leaseBusy || ++renewalFailures >= 3) failLease(err);
      }
    }, 5000);
    leaseTimer.unref?.();
  }
  function finishedCall(id) {
    callNarration.delete(id);
    openedWindowCalls.delete(id);
    openedFlowPlans.delete(id);
    openedWindowReads.delete(id);
    openedAliases.delete(id);
    const openedKey = openedWindowLeases.get(id);
    if (openedKey) {
      openedWindowLeases.delete(id);
      try { inputLease.release([openedKey]); }
      catch (error) { trace('input-lease-release-error', { error: error.message }); }
      refreshHeartbeat();
    }
    // A call that ends without an engine result (a refusal, a retry, a stop) shows no more hand.
    hand?.result(id, true);
    handBindingMarks.delete(id);
    callDetails.delete(id);
    lightReturn?.end(id);
    tabProbe?.end(id);
    tabLandings.delete(id);
    closeRead?.end(id);
    const call = leaseCalls.get(id);
    if (call) {
      if (call.key && !leaseFault && !disposed) {
        try { inputLease.renew([call.key]); }
        catch (err) { if (!err.leaseBusy) failLease(err); else trace('input-lease-renewal-error', { error: err.message }); }
      }
      leaseCalls.delete(id);
      refreshHeartbeat();
    }
    if (running.delete(id)) scheduleIdleEnd();
    if (!running.size) { for (const resolve of drained) resolve(); drained.clear(); }
  }
  function releaseLeases() {
    stopHeartbeat();
    try { inputLease?.close(); }
    catch (err) { trace('input-lease-release-error', { error: err.message }); }
    leaseFault = undefined;
    renewalFailures = 0;
  }

  function prepareLease(msg, browser) {
    if (msg.method !== 'tools/call') return true;
    const name = msg.params?.name;
    const own = (name === 'js' || localNames.has(name)) && namesOwnHost(name, msg.params.arguments ?? {});
    if (own) { ownStop(msg, own); return false; }
    const blocked = (name === 'js' || localNames.has(name)) && callBlock(name, msg.params.arguments ?? {});
    if (blocked) { blockStop(msg, blocked); return false; }
    if (!inputLease) return true;
    if (name === TURN_END_TOOL) {
      if (running.size) { leaseStop(msg, 'an action or read is still running; end the turn after it finishes.'); return false; }
      return true;
    }
    if (name === DOCUMENT_TOOL.name) return true;
    if (name === 'js_reset') { forgetHandles(); return true; }
    if (name !== 'js' && !localNames.has(name)) return true;
    const args = msg.params.arguments ?? {};
    const code = args.code;
    if (name === 'js' && typeof code !== 'string') { leaseStop(msg, 'js needs code.'); return false; }
    if (name === 'js' && browser) {
      // The engine's browser surface names no page sleight can check, so site limits refuse it.
      if (permissions?.sitesLimited?.()) { blockStop(msg, "You limited the sites sleight acts on, and it can't check the site of an engine browser call, so it doesn't make one (turbo checks each page; sleight-mcp permissions lists your limits)."); return false; }
      if (running.size) { leaseStop(msg, 'another call in this session is pending.'); return false; }
      // Tabs are isolated by the extension. Never reserve the previous native app for a tab call.
      const nativeDenied = promptNotice(NATIVE_DENIED, prompt);
      leaseCalls.set(msg.id, { nativeDenied, observe: false });
      return true;
    }
    const read = name === 'js' ? typeof code === 'string' && isLeaseRead(code)
      : (name === 'menu_bar' && args.op === 'apps') || (name === 'notifications' && args.op === 'list');
    if (read && name === 'js' && /\bcua\.getState\(/.test(code)) stateRead = true;
    const acquisition = read && withoutEcho(code ?? '').match(/^(?:(?:(let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*)?await\s+cua\.getApp\(\s*(.*?)\s*\)\s*;?$/s);
    const handle = acquisition ? acquisition[2] ?? (constApp ? undefined : 'app')
      : read && code?.match(/([A-Za-z_$][\w$]*)\.(?:getAXState|getAXStateAndScreenshot|getScreenshot)\(/)?.[1];
    const selector = acquisition?.[3];
    if (selector && handle) handleSelectors.set(handle, selector);
    if (acquisition?.[1] === 'const' && handle === 'app') constApp = true;
    if (msg.id === undefined) { leaseStop(msg, 'actions and reads need a request id.'); return false; }
    let key;
    if (!read) {
      if (running.size) { leaseStop(msg, 'another call in this session is pending.'); return false; }
      if (leaseFault) { leaseStop(msg, leaseFault); return false; }
      if (ownWindow(leaseWindow)) { ownStop(msg, ownLine(leaseWindow.appId, leaseWindow.app)); return false; }
      if (name !== 'js') {
        leaseCalls.set(msg.id, { localAction: true }); return true;
      }
      if (selectedWindow && !selectedCancel(code) && (isChangeCancel(code, lastWindowText) || !selectionVerified || leaseWindow?.appId !== selectedWindow.appId || !sameHeader(leaseWindow, selectedWindow))) {
        leaseStop(msg, `selected window is not confirmed. ${confirmRecovery()}`); return false;
      }
      if (!leaseWindow?.appId) {
        // `let`: a failed `let app = …` leaves no binding, so a bare `app = …` would fail, and the
        // engine accepts `let` again for a name it already has (both checked 2026-10-07).
        // With no app read yet, an app named in this call beats getState, which acquires nothing.
        // An app id the code compares against (`a.id === "org.example.app"`) names the app as well as getApp does.
        // Without either, a session that already read getState is sent to getApp: sending getState again
        // acquired nothing in the Firefox race round (form-travel, 2026-10-17).
        const named = code.match(/cua\.getApp\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/)?.[1] ??
          code.match(/\.id\s*===?\s*("[A-Za-z][\w-]*(?:\.[\w-]+)+"|'[A-Za-z][\w-]*(?:\.[\w-]+)+')/)?.[1];
        // The app the call names, or the one its handle holds, comes before the last app any call read (GA1).
        const handleApp = [...new Set([...codeOnly(code).matchAll(HANDLE_CALL)].map(m => handleBundles.get(m[1])?.appId))];
        const target = (named && `cua.getApp(${named})`) || (handleApp.length === 1 && handleApp[0] && `cua.getApp(${JSON.stringify(handleApp[0])})`) || recoveryTarget;
        const recovery = /* notice */ target ? `Send exactly \u0060${constApp ? '' : 'let app = '}await ${target}\u0060 in js.`
          : stateRead ? `Send \u0060${constApp ? '' : 'let app = '}await cua.getApp("<id>")\u0060 in js, with the app's id from getState.`
          : 'Send exactly \u0060await cua.getState()\u0060 in js.';
        // Template literals, statements and other calls make a lookup an action (form-settings-helium, 2026-10-17:
        // one listWindows expression with a template literal was refused with this same advice).
        const inventory = /\bcua\.(?:listApps|listWindows|getState)\(/.test(code)
          ? ' To look up apps or windows, send one expression with plain quotes, such as \u0060(await cua.listApps()).map(a => a.id).join("\\n")\u0060.' : '';
        const missing = ['bundle ID', ...(typeof leaseWindow?.app !== 'string' || typeof leaseWindow?.title !== 'string' ? ['full window header'] : [])];
        leaseStop(msg, promptNotice(`a bundle ID and full window header are required. Missing target identity: ${missing.join(', ')}. ${recovery}${inventory} Use the handle returned by cua.getApp directly.`, prompt), true);
        return false;
      }
      if (leaseWindow.identityError) { leaseStop(msg, leaseWindow.identityError); return false; }
      const stale = name === 'js' ? compactor.staleIndex(numberWindow(code, leaseWindow), code) : undefined;
      if (stale) {
        leaseStop(msg, promptNotice(stale.number !== undefined
          ? `element ${stale.number} may be stale. Numbers in this window changed since your last full read, and ${stale.number} isn't one you've seen since. Use a number from a + line in the latest result, or read the whole window with getAXState({ disableDiffing: true }) first.`
          : `this call computes an element number (${stale.computed}), and numbers in this window changed since your last full read. Use a literal number from a + line in the latest result, or read the whole window with getAXState({ disableDiffing: true }) first.`, prompt));
        return false;
      }
      if (engineForbiddenTargets && isForbiddenSettingsWindow(leaseWindow)) {
        leaseStop(msg, `${leaseWindow.app}'s settings window is refused, so Claude can't change its approval or safety settings. Close it or read another window.`);
        return false;
      }
      const held = appLine(leaseWindow.appId, leaseWindow.app) ?? pageLine(leaseWindow);
      if (held) { blockStop(msg, held); return false; }
      try { key = inputLease.acquire(leaseWindow); }
      catch (err) { leaseStop(msg, err.message); return false; }
    }
    const observe = name === 'js' && (!read || (!isInventoryRead(code) && /cua\.getApp\(|\.(?:getAXState|getAXStateAndScreenshot)\(/.test(code)));
    leaseCalls.set(msg.id, { key, observe, read, selector, handle, acquisition: !!acquisition });
    return true;
  }

  const documentAllowed = () => documentGrants.has(documentKey(observedDocument));
  function documentStop(msg, reason) {
    toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text:
      `Document scope: ${reason}. ${observedDocument ? `Observed ${documentLabel(observedDocument)}. ` : ''}` +
      promptNotice('Stop actions. Read the intended window with one standalone cua.getApp call, then ask the user with document_scope.', prompt) }] } });
  }

  function askDocument(message, scoped, callIds) {
    return queueDecision(() => ask ? askPrompt(callIds, message, scoped) : elicit(message), callIds).catch(() => 'cancel');
  }

  async function approveDocument(msg) {
    if (!observedDocument || running.size || documentAsking) {
      documentStop(msg, 'a completed, unambiguous window read is required');
      return;
    }
    const target = observedDocument;
    const key = documentKey(target);
    if (!documentGrants.has(key)) {
      documentAsking = true;
      const action = await askDocument(`Allow Claude to use ${documentLabel(target)} for this session? ` +
        'Scope checks read window contents. This guards mistakes, not malicious JavaScript.', true, [msg.id]);
      documentAsking = false;
      if (action !== 'accept') { documentStop(msg, 'the user did not approve this document'); return; }
      documentGrants.add(key);
      for (const risk of observedRisks) documentRisks.add(JSON.stringify([key, risk]));
    }
    toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Approved ${documentLabel(target)} for this session.` }] } });
  }

  async function documentEngineApproval(msg) {
    const [callId, call] = [...documentCalls.entries()][0] ?? [];
    if (callGenerations.has(callId) && callGenerations.get(callId) !== stopGeneration) {
      toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } }); return;
    }
    const engine = msg.params?._meta?.tool_params?.app;
    const risk = approvalKey(msg);
    let action = 'decline';
    if (call?.read && typeof engine === 'string') {
      call.engines.add(engine);
      if (risk) call.risks.add(risk);
      action = await askDocument(`Read one window in ${engine} to identify its document? This read does not approve actions.`, false, [callId]);
    } else if (call && documentAllowed() && observedEngines.has(engine) && risk) {
      const key = JSON.stringify([documentKey(observedDocument), risk]);
      if (documentRisks.has(key)) action = 'accept';
      else {
        action = await askDocument(`Allow Claude to use ${documentLabel(observedDocument)} at risk level ` +
          `${msg.params?._meta?.riskLevel ?? 'unspecified'} for this session?`, true, [callId]);
        if (action === 'accept') documentRisks.add(key);
      }
    }
    // Keep document grants here. Never persist a whole-app grant in the engine.
    toServer({ jsonrpc: '2.0', id: msg.id, result: { action, ...(action === 'accept' ? { content: {} } : {}) } });
  }

  function scheduleIdleEnd() {
    clearTimeout(idleTimer);
    if (!idleTurnEndMs || disposed || closing || running.size || reviewing || (!turnUsed && !failedTurnEnds.size)) return;
    idleTimer = setTimeout(() => {
      trace('idle-turn-end', { turnId });
      endOpenTurn(false);
    }, idleTurnEndMs);
    idleTimer.unref?.();
  }
  let nextElicitId = 0;

  const toServer = (msg, continuationChecked = false) => {
    if (pauseBlocked(msg)) { pauseReply(msg); return; }
    // Native approval tokens carry no parent call ID. Keep fresh calls out of that ambiguity until the old call drains.
    if (pausedCalls.size && msg.method === 'tools/call' && msg.params?.name !== TURN_END_TOOL && !pausedCalls.has(msg.id)) {
      pauseReply(msg, PAUSE_DRAIN_NOTE); return;
    }
    if (msg.result?.action === 'accept' && (pause.paused || pausedCalls.size)) {
      for (const id of pausedCalls) nativePauseCuts.add(id);
      msg = { ...msg, result: { action: 'decline' } };
    }
    let closeKeyApp;
    // An accepted app approval is the exact beat of its action.
    if (hand && msg.method === undefined && msg.id !== undefined) hand.answered(msg.id, msg.result?.action);
    if (msg.method === undefined && msg.id !== undefined) {
      const request = engineRequests.get(msg.id);
      if (request) {
        engineRequests.delete(msg.id);
        if (request.epoch !== engineEpoch) return;
        closeKeyApp = request.closeKeyApp;
        msg = { ...msg, id: request.id };
      } else if (engineEpoch > 0) return;
      recordAction('waitEnd', 's:' + msg.id);
    }
    if (stopCollected || (closing && msg.method === 'tools/call' && msg.params?.name !== TURN_END_TOOL &&
        !(internalRequests.has(msg.id) && String(msg.id).startsWith('sleight-tab-cleanup-')))) return;
    const continuation = msg.method === 'tools/call' && menuForwards.get(msg.id);
    if (continuation && !continuationChecked) {
      // Admission may wait on another guard. Sample again at the final engine boundary,
      // including startup retries, against the original call's forwarding time.
      if (continuation.checking) return;
      continuation.checking = true;
      const { call, expected, baseline, lease, original, head, current, tab, stopAt } = continuation;
      const since = Math.min(call.forwardedAt, call.sampledAt ?? call.forwardedAt), probeAt = clock();
      menuIdentity(windowIdentity, expected, menuContinuationTimeoutMs).then(observed => {
        if (!current() || leaseWindow !== lease ||
            !unchangedMenuWindow(expected, baseline, observed, tab ? stopAt : since, clock()) ||
            tab && tabFocusRefusal(observed)) {
          if (tab) trace('tab-continuation-refused', { id: msg.id, reason: 'final-check', ...idleSample(observed, stopAt, clock(), since) });
          menuForwards.delete(msg.id); continuedLeads.delete(msg.id);
          menuCalls.delete(msg.id);
          if (head) splitHeads.set(msg.id, head); else splitHeads.delete(msg.id);
          const clipboardReply = clipboardReplies.get(msg.id);
          if (clipboardReply) { clipboardReplies.delete(msg.id); clipboardReply.receive(original); }
          else observeServerMessage(original);
          return;
        }
        continuation.checking = false;
        if (tab) trace('tab-continuation-forwarded', { id: msg.id, probeMs: Math.round(clock() - probeAt) });
        toServer(msg, true);
      });
      return;
    }
    if (msg.method === 'tools/call' && callGenerations.has(msg.id) && callGenerations.get(msg.id) !== stopGeneration) {
      observeServerMessage({ jsonrpc: '2.0', id: msg.id, result: { content: [] } }); return;
    }
    if (closing && msg.result?.action === 'accept') msg = { ...msg, result: { action: 'cancel' } };
    if (serverIn.writableEnded || serverIn.destroyed) { trace('server-input-closed', { id: msg.id }); return; }
    if (msg.result?.action === 'accept' && closeKeyApp) closeRead?.keyPressed(closeKeyApp);
    trace('to-server', msg);
    docOrigin.sent(msg, documentationContext());
    if (msg.method === 'tools/call' && msg.id !== undefined) engineCalls.add(msg.id);
    if (msg.method === 'tools/call' && msg.id !== undefined && msg.params.name !== TURN_END_TOOL) {
      callDetails.set(msg.id, msg.params.name + (msg.params.arguments?.title ? ': ' + msg.params.arguments.title : ''));
    }
    if (msg.method === 'tools/call' && menuCalls.has(msg.id)) menuCalls.get(msg.id).forwardedAt ??= clock();
    // The action log times a call from here, after sleight's own checks and waits.
    if (msg.method === 'tools/call' && msg.id !== undefined) recordAction('sent', msg.id);
    if (msg.method === 'tools/call' && msg.params?.name !== TURN_END_TOOL) pauseHost?.activity();
    serverIn.write(JSON.stringify(msg) + '\n');
    replWarmup.sent(msg);
  };
  function cleanupBrowserTabs() {
    if (tabCleanupPending) return tabCleanupPending;
    tabCleanupPending = (async () => {
      if (!tabsMayNeedCleanup || stopCollected || disposed) return;
      if (running.size) {
        const ready = await new Promise(resolve => {
          const done = () => { clearTimeout(timer); resolve(true); };
          const timer = setTimeout(() => { drained.delete(done); resolve(false); }, stopGraceMs);
          drained.add(done);
        });
        if (!ready) return /* notice */ promptNotice('sleight: kept tabs because a call did not finish before the cleanup deadline.', prompt);
      }
      if (stopCollected || disposed) return;
      return await new Promise(resolve => {
        const id = `sleight-tab-cleanup-${nextInternalId++}`;
        const timer = setTimeout(() => {
          internalRequests.delete(id); pauseChecks.delete(id); lateHelperReplies.add(id);
          resolve(cleanupTimeoutNote);
        }, SHUTDOWN_GRACE_MS);
        internalRequests.set(id, reply => {
          clearTimeout(timer);
          resolve((reply.result?.content ?? []).filter(c => c.type === 'text')
            .flatMap(c => (c.text ?? '').split('\n')).filter(line => /^sleight: kept tab .* because /.test(line)).join('\n'));
        });
        toServer({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js',
          arguments: { code: cleanupTabsBefore(Date.now() + 2000) }, _meta: engineMeta() } });
      });
    })().finally(() => { tabCleanupPending = undefined; });
    return tabCleanupPending;
  }
  function extraChromeScreenshot(handle) {
    return new Promise(resolve => {
      const id = `sleight-chrome-settle-${nextInternalId++}`;
      internalRequests.set(id, msg => {
        resolve(msg.error || msg.result?.isError ? undefined : lastImageData(msg.result?.content));
      });
      toServer({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: `await ${handle}.getScreenshot()` } } });
    });
  }
  // The last screenshot's size per app and window title, for drag to convert Claude's pixels.
  function recordScreenshot(content, certifiedRead, target) {
    const shot = screenshotOf(content, target);
    if (!shot) return;
    const entry = screenshots.get(shot[0].toLowerCase()) ?? { byTitle: {}, byWindow: {} };
    entry.latest = shot[1];
    if (shot[2] !== undefined) entry.byTitle[shot[2]] = [shot[1].width, shot[1].height];
    // Equal titles share a byTitle key; a cross-window drag converts B's points only with B's own (XD1R).
    if (shot[2] !== undefined && certifiedRead?.title === shot[2] && certifiedRead.app?.toLowerCase() === shot[0].toLowerCase()) {
      entry.byWindow[certifiedRead.number] = [shot[1].width, shot[1].height];
    }
    screenshots.set(shot[0].toLowerCase(), entry);
  }
  // The open_file window's picture, or undefined when the engine refuses, fails or takes over 5 s.
  function openScreenshot(handle) {
    return new Promise(resolve => {
      const id = `sleight-open-shot-${nextInternalId++}`;
      const timer = setTimeout(() => { internalRequests.delete(id); pauseChecks.delete(id); lateHelperReplies.add(id); resolve(undefined); }, openShotTimeoutMs);
      internalRequests.set(id, reply => {
        clearTimeout(timer);
        resolve(reply.error || reply.result?.isError ? undefined
          : (reply.result?.content ?? []).filter(c => c?.type === 'image' && typeof c.data === 'string').at(-1));
      });
      toServer({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js',
        arguments: { code: `await ${handle}.getScreenshot()` }, _meta: engineMeta() } });
    });
  }
  async function fullerLaunchRead(msg, plan) {
    const text = content => (content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const size = value => [...value.matchAll(/^\t*\d+ /gm)].length;
    const before = text(msg.result?.content), window = windowFromText(before), count = size(before);
    if (!plan?.acquisition || msg.error || msg.result?.isError || !window || count === 0 || count >= 20) return;
    const generation = stopGeneration;
    await launchSettleSleep(2500);
    if (generation !== stopGeneration || closing || disposed) return;
    const reply = await new Promise(resolve => {
      const id = `sleight-launch-read-${nextInternalId++}`;
      const timer = setTimeout(() => {
        internalRequests.delete(id); pauseChecks.delete(id); lateHelperReplies.add(id); resolve(undefined);
      }, 5500);
      internalRequests.set(id, reply => { clearTimeout(timer); resolve(reply); });
      toServer({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js',
        arguments: { code: `await ${plan.handle}.getAXState({ disableDiffing: true })` }, _meta: engineMeta() } });
    });
    if (generation !== stopGeneration || closing || disposed || !reply?.result || reply.result.isError) return;
    const after = text(reply.result.content);
    const later = windowFromText(after);
    if (!hasFullTree(after) || later?.app !== window.app || later.title !== window.title || size(after) <= count) return;
    msg.result.content = [...dropAcquisitionTree(msg.result.content, reply.result.content, undefined, compactReacquire), ...reply.result.content];
  }
  const toClient = (msg, afterWrite, remoteNotice = false) => {
    if (msg.method === undefined) { pauseChecks.delete(msg.id); pausedCalls.delete(msg.id); nativePauseCuts.delete(msg.id); }
    // An approval prompt's time comes off the action log's call times (the engine's prompts and sleight's own).
    if (msg.method === 'elicitation/create' && msg.id !== undefined) recordAction('waitStart', 'c:' + msg.id);
    // Every call's reply ends it, by whatever path: its parent lease pin ends too.
    if (msg.method === undefined && msg.id !== undefined) releasePin(msg.id);
    if (msg.method === undefined && !remoteNotice && remoteRefusedCalls.delete(msg.id)) return;
    if (msg.method === undefined && stoppedClients.has(msg.id)) return;
    const directEnding = msg.method === undefined && directTurnEnds.get(msg.id);
    if (directEnding?.pending) { directEnding.replies.push(msg); return; }
    if (directEnding) {
      directTurnEnds.delete(msg.id);
      if (msg.result) {
        const receipt = directEnding.receipt;
        const retained = receipt.revoked !== true || receipt.cleanup.some(row => !['closed', 'released', 'already-gone'].includes(row.status));
        msg = { ...msg, result: { ...msg.result, isError: !!msg.result.isError || retained,
          _meta: { ...msg.result._meta, 'sleight/directBrowser': receipt },
          content: [...(msg.result.content ?? []), { type: 'text', text: JSON.stringify({ directBrowser: receipt }) }] } };
      }
    }
    if (msg.method === undefined && msg.id !== undefined && Array.isArray(msg.result?.content) && takeNotices) {
      const notices = takeNotices();
      if (notices?.length) msg = { ...msg, result: { ...msg.result, content: [...msg.result.content, ...notices.map(text => ({ type: 'text', text }))] } };
    }
    const ending = receiptEnds.get(msg.id);
    if (msg.method === undefined && ending?.pending) { ending.replies.push(msg); return; }
    if (msg.method === undefined && promptFailures.has(msg.id)) {
      const message = promptFailures.get(msg.id); promptFailures.delete(msg.id);
      if (msg.error) msg = { ...msg, error: { ...msg.error, message } };
      else msg = { ...msg, result: { ...msg.result, isError: true, content: [{ type: 'text', text: message }] } };
    }
    if (msg.method === undefined && helperDiagnosticReplies.has(msg.id)) {
      const state = helperDiagnosticReplies.get(msg.id); helperDiagnosticReplies.delete(msg.id);
      state.diagnosing.finally(() => {
        if (disposed || closing) return;
        const advice = helperStates.get(state.key) === state ? diagnosisAdvice(state.key, state.diagnosis)
          : promptNotice(`A read of ${state.key} succeeded while sleight checked the fault. Read that app again before continuing.`, prompt);
        if (msg.error) msg.error.message += `\n\n${advice}`;
        else msg.result = { ...msg.result, isError: true, content: [...(msg.result?.content ?? []), { type: 'text', text: advice }] };
        toClient(msg);
      });
      return;
    }
    if (msg.method === undefined && splitCalls.has(msg.id)) {
      const next = splitCalls.get(msg.id); splitCalls.delete(msg.id); callGenerations.delete(msg.id); next(msg); return;
    }
    if (msg.method === undefined) { engineOpenPrints.delete(msg.id); engineOpenAllowed.delete(msg.id); continuedOutcomes.delete(msg.id); menuAdmissions.delete(msg.id); menuBaselines.delete(msg.id); menuContinued.delete(msg.id); menuForwards.delete(msg.id); splitInputs.delete(msg.id); }
    if (msg.method === undefined && splitHeads.has(msg.id)) {
      let head = splitHeads.get(msg.id); splitHeads.delete(msg.id);
      // The call re-acquired and then showed the same window whole: its acquisition tree is a duplicate. Word runs sent
      // both in every call (about 110k of 211k characters a run, 2026-10-17).
      if (msg.result && !msg.result.isError) head = dropAcquisitionTree(head, msg.result.content, splitCodes.get(msg.id), compactReacquire);
      if (msg.result) head = dropStaleMenuNotes(head, msg.result.content);
      splitCodes.delete(msg.id);
      msg = msg.result ? { ...msg, result: { ...msg.result, content: [...head, ...(msg.result.content ?? [])] } }
        : { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [...head, { type: 'text', text: msg.error?.message ?? 'error' }] } };
      // A continued call opens with what ran, and a stop's ran/not-sent line rises above an acquisition's tree.
      const lead = continuedLeads.get(msg.id); continuedLeads.delete(msg.id);
      // Without a tree of its own the reply is a diff or an error against the stop's page, which Claude never saw.
      if (lead?.stopTree?.length && msg.result && !hasWholeTree(msg.result.content)) msg = { ...msg, result: { ...msg.result, content: [...lead.stopTree, ...msg.result.content] } };
      const leadText = lead && continuedNote(lead.plan, lead.ran, lead.kind, { over: lead.over, title: lead.title, failed: !!msg.result.isError });
      const content = msg.result.content;
      const stop = msg.result.isError ? content.findIndex(item => item?.type === 'text' && /^sleight: this call ran /.test(item.text ?? '')) : -1;
      if (leadText || stop > 0) msg = { ...msg, result: { ...msg.result, content: [...(leadText ? [{ type: 'text', text: promptNotice(leadText, prompt) }] : []),
        ...(stop > 0 ? [content[stop]] : []), ...content.filter((_, i) => stop <= 0 || i !== stop)] } };
    }
    if (helperProbes.has(msg.id) && msg.method === undefined) {
      retainEngineDocs(msg.result?.content);
      const probe = helperProbes.get(msg.id);
      clearTimeout(probe.timer); helperProbes.delete(msg.id); probe.receive?.(msg);
      trace('helper-recovery-result', msg); return;
    }
    // Admission refusals can finish an opened-window call before it reaches the engine reply path.
    if (msg.method === undefined && (openedWindowLeases.has(msg.id) || openedFlowPlans.has(msg.id))) finishedCall(msg.id);
    const clientTool = msg.method === undefined ? pendingClients.get(msg.id)?.split(': ')[0] : undefined;
    const nativeAcquisition = msg.method === undefined && nativeAcquisitions.delete(msg.id);
    if (msg.method === undefined) {
      pendingClients.delete(msg.id); callGenerations.delete(msg.id);
      if (reconnectNotes.delete(msg.id) && msg.result) msg.result.content = [...(msg.result.content ?? []),
        { type: 'text', text: promptNotice('sleight reconnected after a ChatGPT engine update.', prompt) }];
      updateRetries.delete(msg.id); reconnectNotes.delete(msg.id);
    }
    if (clientOut.writableEnded || clientOut.destroyed) {
      const guidance = (msg.result?.content ?? []).filter(item => ruleBlocks.trusted(item) || engineDocs([item], true).length).map(docOrigin.full);
      ruleBlocks.retry(guidance);
      for (const item of guidance) if (!undeliveredGuidance.some(c => c.text === item.text)) undeliveredGuidance.push(item);
      if (msg.method === undefined) { resultBudget.finish(msg.id); fullDocumentationCalls.delete(msg.id); }
      trace('client-output-closed', { id: msg.id }); return;
    }
    if (receiptEnds.has(msg.id) && msg.method === undefined) {
      const receipt = receiptEnds.get(msg.id); receiptEnds.delete(msg.id);
      if (receipt && msg.result) msg.result = { ...msg.result,
        _meta: { ...msg.result._meta, 'sleight/receipt': receipt },
        // Claude Code's $.mcp.call currently drops result _meta. Keep a bounded structured copy
        // in content for the mod, including write failures, without putting review prose on stderr.
        content: [...(msg.result.content ?? []), { type: 'text', text: 'sleight-receipt: ' + JSON.stringify({ ...receipt,
          ...(receipt.review?.length > 32000 ? { review: receipt.review.slice(0, 32000) + '\nReview truncated; open the receipt for the full review.' } : {}) }) }] };
    }
    if (statsEnds.has(msg.id) && msg.method === undefined) {
      const pending = statsEnds.get(msg.id); statsEnds.delete(msg.id);
      let frame;
      try { frame = typeof pending === 'string' ? finishStats(pending) : pending; } catch {}
      if (msg.result && frame) msg.result = { ...msg.result, _meta: { ...msg.result._meta, 'sleight/stats': frame.stats },
        content: [...(msg.result.content ?? []), frame.content] };
    }
    const saveNote = msg.method === undefined && saveNotes.get(msg.id);
    if (saveNote) {
      saveNotes.delete(msg.id);
      if (msg.error) msg.error.message += '\n' + saveNote;
      else msg.result = { ...msg.result, content: [...(msg.result?.content ?? []), { type: 'text', text: saveNote }] };
    }
    // Internal acquisitions, and an opt-in first getApp, keep the skill and tree in their
    // result, then deliver the reference with Claude's next JS result (including errors).
    const modelVisible = clientTool && clientTool !== TURN_END_TOOL && !HIDDEN_TOOLS.has(clientTool);
    const leanAcquisition = leanFirst && !clientJsSeen && !deferredEngineDocs.length && nativeAcquisition &&
      msg.result?._meta?.['codex/toolSurface']?.kind !== 'browserUse' && !msg.error && !msg.result?.isError;
    if (modelVisible && clientTool === 'js') { clientJsSeen = true; if (!leanAcquisition) clientJsDelivered = true; }
    if (modelVisible && (leanAcquisition || !['js', 'js_reset'].includes(clientTool)) && Array.isArray(msg.result?.content) && !msg.result.isError) {
      msg.result.content = msg.result.content.flatMap(item => {
        if (item.type !== 'text') return [item];
        if (!item.text.trim()) return [];
        if (clientJsDelivered || !/^(?:## Computer Use|# Other Browser APIs|# Computer Use Confirmations Policy|# Browser Safety|# API Reference)\n/.test(item.text)) return [item];
        const at = item.text.search(/^Window: /m);
        const docs = { ...item, text: at < 0 ? item.text : item.text.slice(0, at) };
        if (!deferredEngineDocs.some(c => c.text === docs.text)) deferredEngineDocs.push(docs);
        return at < 0 ? [] : [{ ...item, text: item.text.slice(at) }];
      });
    }
    if (modelVisible && deferredEngineDocs.length &&
        (clientJsDelivered || msg.error || msg.result?.isError)) {
      if (msg.error) msg = { jsonrpc: msg.jsonrpc, id: msg.id, result: { isError: true,
        content: [{ type: 'text', text: msg.error.message }] } };
      if (Array.isArray(msg.result?.content)) {
        const texts = msg.result.content.filter(item => item.type === 'text').map(item => item.text);
        msg.result.content = [...deferredEngineDocs.filter(item => !texts.some(text => text.startsWith(item.text.trimEnd()))), ...msg.result.content];
        deferredEngineDocs = [];
      }
    }
    if (modelVisible && deferredRules && clientTool === 'js') {
      if (msg.error) msg = { jsonrpc: msg.jsonrpc, id: msg.id, result: { isError: true, content: [{ type: 'text', text: msg.error.message }] } };
      if (Array.isArray(msg.result?.content)) { msg.result.content = [deferredRules, ...msg.result.content]; deferredRules = undefined; }
    }
    let documentationDelivery;
    if (modelVisible && Array.isArray(msg.result?.content)) {
      if (undeliveredGuidance.length) {
        msg.result.content = [...undeliveredGuidance, ...msg.result.content];
        undeliveredGuidance = [];
      }
      msg = { ...msg, result: { ...msg.result, content: resultBudget.apply(aliasNotices(dropRepeatedText(msg.result.content)),
        { id: msg.id, native: !!msg.result._meta?.['codex/toolSurface']?.app?.appId }) } };
      if (dedupeRules) msg.result.content = ruleBlocks.apply(msg.result.content);
      browserStale.observe(msg.result.content);
      saveReceipted ||= msg.result.content.some(c => c.type === 'text' && /\bsaved: observed [^\n]*; on disk: /.test(c.text ?? ''));
      documentationDelivery = docOrigin.project(msg.result.content, { context: documentationContext(),
        full: process.env.SLEIGHT_ENGINE_DOCS === 'full' || fullDocumentationCalls.has(msg.id), isError: !!msg.result.isError });
      msg.result.content = documentationDelivery.content;
    }
    if (msg.method === undefined) fullDocumentationCalls.delete(msg.id);
    if (msg.method === undefined) resultBudget.finish(msg.id);
    if (grokClient && Array.isArray(msg.result?.content)) {
      // Replay only guidance, never an image or action output. It already passed the docs and rule
      // transforms, whose once-per-session state advanced before the final serialized cap.
      msg.result = grokResult(msg.result, () => {
        const guidance = msg.result.content.filter(item => ruleBlocks.trusted(item) || engineDocs([item], true).length).map(docOrigin.full);
        ruleBlocks.retry(guidance);
        for (const item of guidance) if (!undeliveredGuidance.some(c => c.text === item.text)) undeliveredGuidance.push(item);
        return guidance;
      });
    }
    if (grokClient && msg.method === 'elicitation/create' && msg.id !== undefined) grokElicitations.add(msg.id);
    if (msg.method === undefined && msg.id !== undefined && outcomes) {
      const call = outcomeCalls.get(msg.id);
      outcomeCalls.delete(msg.id);
      if (call && !call.recorded && (!call.statusOnly || unconfirmedInput(msg.result?.content))) call.turn.unknown(call.name);
      const summary = outcomeEnds.get(msg.id);
      outcomeEnds.delete(msg.id);
      // Every action result carries the current ledger, including earlier uncertain actions. The last one
      // therefore reaches the model before its final answer. turn_ended is a later user/host log only.
      const actionSummary = call?.turn === turnOutcomes ? call.turn.text() : undefined;
      const text = summary ?? (actionSummary && actionSummary + ' Report these unverified effects in your final answer.');
      if (text && msg.result) msg.result = { ...msg.result, content: [...(msg.result.content ?? []), { type: 'text', text }] };
      else if (text && msg.error) msg.error = { ...msg.error, message: msg.error.message + '\n' + text };
    }
    if (msg.method === undefined && msg.id !== undefined) {
      const read = completenessCalls.get(msg.id);
      completenessCalls.delete(msg.id);
      if (read && Array.isArray(msg.result?.content)) {
        const footer = resultCompleteness(msg.result.content, { ...read, failed: !!msg.result.isError });
        if (footer && !msg.result.content.at(-1)?.text?.trimEnd().endsWith(footer)) msg.result.content.push({ type: 'text', text: footer });
      }
    }
    journal?.reply(msg);
    // The log is a side record: its failure never costs Claude a reply.
    recordAction('reply', msg);
    trace('to-client', msg);
    if (msg.method === undefined && msg.id !== undefined) onClientReply(msg);
    const retainedGuidance = modelVisible && Array.isArray(msg.result?.content)
      ? msg.result.content.filter(item => ruleBlocks.trusted(item) || engineDocs([item], true).length) : [];
    const runImages = msg.method === undefined && !msg.error && !msg.result?.isError
      ? msg.result?.content?.filter(item => item?.type === 'image') : undefined;
    const runDetail = runScreenshotDetails.get(runImages?.at(-1)) ?? { source: 'native' };
    // Keep immutable image fields from exactly this serialized reply, even if a caller later mutates its objects.
    const deliveredImages = runImages?.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
    clientOut.write(JSON.stringify(msg) + '\n', error => {
      // Every replacement, cap, split and helper-probe return is above this boundary. Never record a failed write or refusal.
      if (!error && deliveredImages?.length) try { cursor?.screenshot?.(deliveredImages, runDetail); } catch {}
      const missing = docOrigin.settle(documentationDelivery, msg.result, error);
      if (error) ruleBlocks.retry(retainedGuidance);
      for (const item of [...missing, ...(error ? retainedGuidance : [])]) {
        const full = docOrigin.full(item);
        if (!undeliveredGuidance.some(c => c.text === full.text)) undeliveredGuidance.push(full);
      }
      if (!error && !disposed && !closing) afterWrite?.(msg);
    });
  };
  const inputError = err => {
    trace('stream-error', { stream: 'server-input', error: err.message });
    if (restarting || stopCollected) cancelInternalRequests(err.message); else failLease(err);
  };
  clientOut.on('error', err => { trace('stream-error', { stream: 'client-output', error: err.message }); failLease(err); });

  function turnMeta() {
    return JSON.stringify({ session_id: sessionId, turn_id: turnId });
  }

  function userListGrant(app, riskLevel, tool, ids) {
    if (!preapproved?.allows(app, riskLevel)) return false;
    const grant = { app, riskLevel, tool, source: '~/Library/Application Support/sleight/preapproved.json' };
    // Audit before answering. A failed audit must not grant approval.
    grantAudit(grant);
    if (tool === 'engine') listApproved.add(app);
    trace('preapproved-app', grant);
    stderr.write(`sleight: ${app} (${riskLevel}, ${tool}) pre-approved by the user's list at ${grant.source}\n`);
    for (const id of ids) {
      const notes = preapprovalNotes.get(id) ?? [];
      notes.push(grant); preapprovalNotes.set(id, notes);
    }
    return true;
  }

  function reportPreapprovals(msg) {
    const grants = preapprovalNotes.get(msg.id);
    preapprovalNotes.delete(msg.id);
    if (!grants?.length) return;
    // The engine asks once per action, so a batch of clicks repeats the same grant (12 lines in
    // one Calculator result, 2026-10-08). Name each distinct grant once.
    const text = [...new Set(grants.map(g => `${g.app} (${g.riskLevel}, ${g.tool}) was pre-approved by the user's list at ${g.source}.`))].join('\n');
    if (msg.result) msg.result = { ...msg.result, content: [...(msg.result.content ?? []), { type: 'text', text }] };
    else if (msg.error) msg.error = { ...msg.error, data: { detail: msg.error.data, preapprovals: grants } };
  }

  function endTurnArgs(args = {}) {
    return {
      // The mod and Codex's hooks send Stop or Interrupt. Anything else, an unexpanded template included, is a Stop.
      hook_event_name: ['Stop', 'Interrupt'].includes(args.hook_event_name) ? args.hook_event_name : 'Stop',
      session_id: sessionId,
      turn_id: turnId,
    };
  }

  // Answers an app approval through `ask`. Prompts queue, so a second request
  // for an app the user is still being asked about waits for that answer.
  async function askPrompt(callIds, ...args) {
    try { return await ask(...args); }
    catch (error) {
      if (error?.code === 'SLEIGHT_PROMPT_UNAVAILABLE') {
        for (const id of callIds) promptFailures.set(id, "The approval prompt couldn't be shown. The user made no decision. Stop and tell them.");
      }
      throw error;
    }
  }

  async function physicalDecision(request, callIds = [], present) {
    if (remoteApprovals && !(present ?? await remotePresent())) {
      for (const id of callIds) promptFailures.set(id, physicalApprovalNotice);
      // Only the card stays alive. The caller receives cancel, so a late answer cannot resume its action.
      Promise.resolve().then(request).catch(() => {});
      return 'cancel';
    }
    return request();
  }

  function queueDecision(request, callIds = [], away = false) {
    const generation = stopGeneration, prior = asking;
    const answer = (async () => {
      const present = !remoteApprovals || !away && await remotePresent();
      if (present) await prior;
      if (generation !== stopGeneration || closing || disposed) return 'cancel';
      const decision = await physicalDecision(request, callIds, present);
      return generation === stopGeneration && !closing && !disposed ? decision : 'cancel';
    })();
    asking = answer.catch(() => 'cancel');
    return answer;
  }

  async function remoteAppCard(msg) {
    const generation = stopGeneration;
    // Only the session scope remembers answers. 'once' and 'document' ask on every card.
    const app = msg.params?._meta?.tool_params?.app, appKey = approvalKey(msg);
    const key = approvalScope === 'session' ? appKey : undefined;
    const plain = plainCard(msg) && appKey !== undefined;
    const nativeCard = ask && (isAppApproval(msg) || msg.params?._meta?.connector_id === 'browser-use' || panelOnly);
    // Cards without pending typed text never wait on a catalog scan.
    if (plain && pendingTyped.size) { await waitCatalog(); applyTyped(); }
    if (disposed || closing || generation !== stopGeneration) { toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } }); return; }
    let identity = appIdentity(app);
    const typedEligible = plain && key !== undefined && !forbiddenTargetWarning(app) && !forbiddenTargetWarning(identity?.id) &&
      !/could be dangerous/i.test(msg.params?.message ?? '') && msg.params?._meta?.riskLevel === 'low';
    const typed = typedEligible && identity && typedApps.has(JSON.stringify([identity.id, msg.params._meta.riskLevel]));
    let listed = false, auditFailed = false;
    try { listed = plain && userListGrant(app, msg.params._meta.riskLevel, 'engine', [...running].filter(id => !localRunning.has(id))); } catch { auditFailed = true; }
    if (typed || plain && !auditFailed && (key !== undefined && approved.has(key) || listed)) {
      if (typed) { trace('answered-by-typed-session', { app }); stderr.write(`sleight: answered ${app} from its typed session approval.\n`); }
      toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept', content: {}, ...(typed || key !== undefined && approved.has(key) ? { _meta: { persist: 'session' } } : {}) } }); return;
    }
    const present = await remotePresent();
    if (disposed || closing || generation !== stopGeneration) { toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } }); return; }
    if (present) {
      if (nativeCard) askUser(msg, auditFailed || !plain);
      else if (clientCanElicit === false) toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } });
      else {
        if (plain && key !== undefined) {
          approvalRequests.set(msg.id, { key, generation });
          // The present user's card keeps the "Always" choice the ordinary card path offers.
          const always = grokClient ? undefined : alwaysChoice(msg);
          if (always) {
            alwaysOffered.set(msg.id, always);
            const schema = msg.params.requestedSchema ?? { type: 'object', properties: {} };
            msg.params.requestedSchema = { ...schema, properties: { ...schema.properties,
              remember: { type: 'string', title: 'Remember this choice', enum: ['This session', 'Always'], default: 'This session',
                description: 'Always adds the app to your pre-approved list (sleight-mcp allow remove takes it off).' } } };
          }
        }
        toClient(msg);
      }
      return;
    }
    identity = appIdentity(app);
    const label = identity?.name ?? app;
    // The engine's card carries no parent RPC id. Match the relay's own acquisition/handle metadata when calls overlap.
    // A call refused by an earlier card already has its one reply.
    const pending = [...engineCalls].filter(id => running.has(id) && !localRunning.has(id) && !internalRequests.has(id) && !remoteRefusedCalls.has(id));
    const named = pending.filter(id => {
      const plan = helperReads.get(id) ?? helperPlan(jsCalls.get(id));
      return [plan?.key, ...(plan?.keys ?? [])].filter(Boolean).some(k =>
        k === helperSelector(JSON.stringify(app)) || identity && appIdentity(k)?.id === identity.id);
    });
    const targets = named.length ? named : pending.length === 1 ? pending : [];
    const notice = typedEligible ? remoteApprovalNotice(label) : physicalApprovalNotice;
    for (const id of targets) remoteRefusedCalls.add(id);
    // Unknown dynamic selectors with overlapping calls use the engine's declined reply to identify the refused parent.
    if (!targets.length) for (const id of pending) remoteUnboundNotices.set(id, notice);
    toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'decline' } });
    for (const id of targets) toClient({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: notice }] } }, undefined, true);
    trace('remote-approval-required', { app });
    if (nativeCard) {
      // Identical pending app cards share one physical panel. Keep its late answer within this stop generation.
      const cardKey = plain && key !== undefined ? key : JSON.stringify(['physical', msg.id]);
      if (!awayCards.has(cardKey)) {
        awayCards.set(cardKey, true);
        queueDecision(async () => {
          try {
            const always = plain ? alwaysChoice(msg) : undefined;
            const action = await ask(msg.params.message, plain, panelOnly ? { app, appApproval: plain } : always ? { always: true } : undefined);
            if (!plain || key === undefined || generation !== stopGeneration || disposed || closing) return;
            if (action === 'always' && always) { rememberAlways(always); approved.add(key); }
            else if (action === 'accept') approved.add(key);
          } finally { awayCards.delete(cardKey); }
        }, [], true).catch(() => { awayCards.delete(cardKey); });
        // Deduplicate until the physical answer without blocking later calls.
      }
    } else if (clientCanElicit !== false) {
      const id = `sleight-elicit-away-${nextElicitId++}`, always = !plain || grokClient ? undefined : alwaysChoice(msg);
      if (always) {
        const schema = msg.params.requestedSchema ?? { type: 'object', properties: {} };
        msg.params.requestedSchema = { ...schema, properties: { ...schema.properties,
          remember: { type: 'string', title: 'Remember this choice', enum: ['This session', 'Always'], default: 'This session',
            description: 'Always adds the app to your pre-approved list (sleight-mcp allow remove takes it off).' } } };
      }
      elicitations.set(id, answer => {
        elicitations.delete(id);
        if (plain && key !== undefined && generation === stopGeneration && !disposed && !closing && answer.result?.action === 'accept') {
          if (always && !reviewerAnswer(answer.result) && answer.result.content?.remember === 'Always') rememberAlways(always);
          approved.add(key);
        }
      });
      toClient({ ...msg, id });
    }
  }

  function askUser(msg, ignoreMemory = false) {
    const generation = stopGeneration;
    const pauseCheck = pause.checkpoint();
    const appApproval = plainCard(msg);
    const key = approvalScope === 'session' && (!panelOnly || appApproval) ? approvalKey(msg) : undefined;
    // Only a repeated pending RPC ID in this engine epoch proves a retry. Equal text or metadata can describe
    // independent effects. Keep ID types and terms in the key; settled action consent is never remembered.
    const identified = typeof msg.id === 'string' || (typeof msg.id === 'number' && Number.isFinite(msg.id));
    const pendingKey = panelOnly && identified
      ? JSON.stringify([engineEpoch, generation, msg.id, ignoreMemory, appApproval, msg.params]) : undefined;
    let decision = pendingKey && pendingShellAsks.get(pendingKey);
    if (!decision) {
      decision = asking.then(async () => {
        try { pauseCheck(); } catch { return { action: 'decline' }; }
        if (generation !== stopGeneration) return { action: 'cancel' };
        if (!ignoreMemory && key !== undefined && approved.has(key)) {
          trace('answered-for-session', msg);
          return { action: 'accept', content: {}, _meta: { persist: 'session' } };
        }
        let action;
        const always = alwaysChoice(msg);
        try {
          action = await ask(msg.params?.message ?? 'Allow Computer Use?', key !== undefined,
            panelOnly ? { app: msg.params?._meta?.tool_params?.app, appApproval } : always ? { always: true } : undefined);
        } catch (error) {
          // The engine owns the elicitation's parent call. Return its error there rather than
          // attributing one failed panel to every concurrent call waiting on the engine.
          if (error?.code === 'SLEIGHT_PROMPT_UNAVAILABLE') return { error: { code: -32603, message: error.message } };
          action = 'cancel';
        }
        if (generation !== stopGeneration) return { action: 'cancel' };
        try { pauseCheck(); } catch { return { action: 'decline' }; }
        if (action === 'always' && always) { rememberAlways(always); action = 'accept'; }
        if (action !== 'accept') return { action };
        if (key === undefined) return { action, content: {} };
        approved.add(key);
        return { action, content: {}, _meta: { persist: 'session' } };
      });
      asking = decision.catch(() => ({ action: 'cancel' }));
      if (pendingKey) {
        pendingShellAsks.set(pendingKey, decision);
        decision.finally(() => pendingShellAsks.delete(pendingKey));
      }
    }
    decision.then(result => {
      trace('answered-by-ask', { id: msg.id, result });
      toServer({ jsonrpc: '2.0', id: msg.id, ...(result.error ? result : { result }) });
    });
  }

  // A claimed form capability can still fail to answer. Expire without granting anything.
  function requestElicitation(params, onId) {
    const id = `sleight-elicit-${nextElicitId++}`;
    onId?.(id);
    return new Promise(resolve => {
      const finish = msg => { clearTimeout(timer); elicitations.delete(id); resolve(msg); };
      const timer = setTimeout(() => finish({ result: { action: 'decline' } }), 300000);
      timer.unref?.();
      elicitations.set(id, finish);
      toClient({ jsonrpc: '2.0', id, method: 'elicitation/create', params });
    });
  }

  // Withdraws an elicitation of ours that is still open (MCP cancellation) and answers it as a decline.
  function cancelElicitation(id) {
    const finish = elicitations.get(id);
    if (!finish) return;
    toClient({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'The call failed before it needed this answer.' } });
    finish({ result: { action: 'decline' } });
  }

  // Asks the client's user through an elicitation of our own.
  function elicit(message, onId) {
    if (clientCanElicit === false) return Promise.resolve('cancel');
    return requestElicitation({ message, mode: 'form', requestedSchema: { type: 'object', properties: {} } }, onId)
      .then(msg => msg.result?.action ?? 'cancel');
  }

  function elicitReview(message) {
    if (clientCanElicit === false) return Promise.resolve('cancel');
    return requestElicitation({ message, mode: 'form', requestedSchema: {
      type: 'object', properties: { decision: { type: 'string', enum: ['keep', 'undo', 'later'], title: 'Your decision' } }, required: ['decision'],
    } }).then(msg => msg.result?.action === 'accept' ? msg.result.content?.decision : 'cancel');
  }

  // Approval for a local tool: once per key and session, like app approvals.
  // options.once asks and is never remembered, for sends that must reach the
  // user every time. The user's pre-approved list covers drag, menu_bar and
  // open_file per app, but never a once ask.
  function approve(keyParts, message, callId, options = {}) {
    const generation = stopGeneration;
    const key = JSON.stringify(['sleight', ...keyParts]);
    // A once ask must reach the user every time: never answered from the
    // pre-approved list and never from session memory.
    const scoped = !panelOnly && approvalScope === 'session' && !options.once;
    const preapprovable = !panelOnly && !options.once && keyParts.length === 2 &&
      ['drag', 'menu_bar', 'open_file'].includes(keyParts[0]);
    // withdraw() declines a pending ask whose call failed first: later asks stop waiting on it, an
    // elicitation of ours is cancelled, and a later answer grants nothing. A native panel stays up.
    let withdrawn = false, elicitation, settle;
    const gone = new Promise(resolve => { settle = resolve; });
    const prior = asking;
    const decided = (async () => {
      const present = !remoteApprovals || await remotePresent();
      if (present) await prior;
      if (withdrawn || generation !== stopGeneration || closing || disposed) return false;
      let auditFailed = false;
      try {
        if (preapprovable && userListGrant(keyParts[1], 'high', keyParts[0], [callId])) return true;
      } catch { auditFailed = true; }
      if (!auditFailed && scoped && approved.has(key)) return true;
      let action;
      try {
        cursorStatus('waiting', localCursor.get(callId));
        action = await physicalDecision(() => ask
          ? askPrompt([callId], message, scoped, options.kind ? { kind: options.kind, detail: options.detail } : undefined)
          : elicit(options.detail ? `${message} ${options.detail}` : message, id => { elicitation = id; }), [callId], present);
      } catch {
        action = 'cancel';
      }
      trace('local-approval', { key, action, ...(options.once ? { once: true } : {}), ...(withdrawn ? { withdrawn } : {}) });
      if (withdrawn || generation !== stopGeneration || closing || disposed) return false;
      if (action !== 'accept') { localCursorResult(callId, true, 'declined'); return false; }
      if (scoped) approved.add(key);
      return true;
    })();
    const answer = Promise.race([decided, gone]);
    asking = answer.catch(() => {});
    answer.withdraw = () => {
      if (withdrawn) return;
      withdrawn = true; settle(false);
      if (elicitation !== undefined) cancelElicitation(elicitation);
    };
    return answer;
  }

  // DP4: one engine read while the local drag still owns its app lease.
  async function dragChangedLines(msg, outcome, current) {
    if (process.env.SLEIGHT_DP4 === '0' || outcome.textChanged !== true || !inputLease || !leaseCalls.get(msg.id)?.key) return [];
    current();
    const args = msg.params.arguments, number = outcome.toWindowId ?? outcome.windowId;
    if (!Number.isSafeInteger(number)) return [];
    const known = [...dragWindows.values()].filter(window => window.windowNumber === number &&
      [window.app, window.appId].includes(args.app));
    const target = known.length === 1 ? known[0] : !outcome.toWindowId &&
      leaseWindow && [leaseWindow.app, leaseWindow.appId].includes(args.app) ? leaseWindow : undefined;
    if (!target || target.identityError || (target.identityRequired && !target.nativeIdentity) || webBrowser(target.appId) ||
        [...dragWindows.values()].some(other => other.appId === target.appId && other.title === target.title && other.windowNumber !== number)) return [];
    // Implicit app acquisitions have no window number. Prove the helper's returned
    // number against that engine header before reading through its existing handle.
    if (known.length !== 1) {
      if (!windowIdentity) return [];
      verifyWindowIdentity({ ...target, windowNumber: number }, await windowIdentity({ ...target, windowNumber: number }));
      current();
    }
    const handle = [...handleBundles].find(([name, window]) => {
      const selected = handleSelectors.get(name)?.match(/^\{\s*(?:windowId|"windowId")\s*:\s*(\d+)\s*\}$/)?.[1];
      const bound = window.windowNumber ?? window.nativeIdentity?.windowNumber ?? (selected ? Number(selected) : undefined);
      return !unconfirmedHandles.has(name) && window.appId === target.appId && sameWindow(window, target) &&
        (bound === number || bound === undefined && window.nativeCandidates === 1);
    })?.[0];
    if (!handle || compactor.seenLines(target) === undefined) return [];
    const reply = await new Promise(resolve => {
      const id = `sleight-drag-read-${nextInternalId++}`;
      const timer = setTimeout(() => { internalRequests.delete(id); pauseChecks.delete(id); lateHelperReplies.add(id); resolve(undefined); }, 5000);
      internalRequests.set(id, response => { clearTimeout(timer); resolve(response); });
      toServer({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js',
        arguments: { code: `await ${handle}.getAXState({ disableDiffing: true })` }, _meta: engineMeta() } });
    });
    current();
    if (!reply?.result || reply.error || reply.result.isError) return [];
    const content = reply.result.content ?? [], raw = content.filter(item => item?.type === 'text').map(item => item.text).join('\n');
    const shown = windowFromText(raw), surface = reply.result._meta?.['codex/toolSurface'];
    if (!hasFullTree(raw) || !shown || !sameWindow(target, shown) || surface?.kind === 'browserUse' ||
        (surface?.app?.appId && surface.app.appId !== target.appId)) return [];
    return compactor.process(content.filter(item => item?.type === 'text').map(item => ({ ...item, text: GUARD_MARK + item.text })));
  }

  async function callLocal(msg, plan) {
    const generation = stopGeneration;
    const pauseCheck = pauseChecks.get(msg.id) ?? pause.checkpoint();
    const current = () => {
      pauseCheck();
      if (closing || disposed) throw new Error(/* notice */ 'Input lease: this session is closing.');
      if (generation !== stopGeneration) throw new Error(/* notice */ 'Input lease: this call was stopped.');
    };
    localRunning.add(msg.id);
    let result;
    const name = msg.params.name;
    let args = msg.params.arguments ?? {};
    let resolved, prepared, preparedAsk, preparedFailed = false;
    if (name === 'select_window') { clearSelection(); openedWindow = undefined; }
    try {
      current();
      if (pauseHost?.clearForAction && ['drag', 'hover', 'menu_bar'].includes(name)) { await pauseHost.clearForAction(); current(); }
      if (openFast && name === 'open_file' && localTools.prepareOpen) {
        prepared = localTools.prepareOpen(args, async (parts, message, options) => {
          preparedAsk = approve(parts, message, msg.id, options);
          if (preparedFailed) preparedAsk.withdraw();
          const allowed = await preparedAsk;
          current();
          return allowed;
        });
        prepared.current = current;
        // The approval runs alongside the target probe (118 to 138 ms cold, 2026-10-17) instead of after it.
        // That probe only finds the running app for the lease, and open_file proceeds when the app isn't
        // running, so the approval is needed whatever it finds. A Stop still refuses before any open,
        // and remembers no grant.
        Promise.resolve(prepared.approval).catch(() => {});
      }
      // These tools reserve the whole app for their actions.
      const appTool = ['drag', 'hover', 'select_window', 'open_file'].includes(name);
      if (appTool) {
        current();
        try {
          resolved = await (localTools.target?.(args) ?? Promise.resolve(
            [leaseWindow?.app, leaseWindow?.appId].includes(args.app) ? leaseWindow : undefined));
        } catch (err) {
          // open_file launches an app that isn't running, in the background, and sends no input to a
          // window. Refusing it sent Claude to launch the app through the engine first, which once
          // brought TextEdit to the front (2026-10-10 10:58 UTC).
          if (name !== 'open_file' || !/launch it first/.test(String(err?.message))) throw err;
        }
        // The app the name resolved to may be sleight's own consent host (lease-target.js also checks its pid's executable).
        if (ownWindow(resolved)) throw new Error(ownLine(resolved.appId, resolved.app));
        // The app the name resolved to, which a block by bundle id names.
        const blocked = resolved?.appId && appLine(resolved.appId, resolved.app);
        if (blocked) throw new Error(blocked);
      }
      current();
      if (leaseCalls.get(msg.id)?.localAction && !(name === 'open_file' && !resolved)) {
        const target = resolved ?? { appId: 'desktop', app: 'macOS', title: 'local desktop controls', url: null };
        const key = inputLease.acquire(target, appTool ? 'app' : 'desktop');
        leaseCalls.set(msg.id, { key }); refreshHeartbeat();
      }
      let callArgs = name === 'select_window' && resolved
        ? { ...args, expectedAppId: resolved.appId } : args;
      if (name === 'drag') {
        if (args.windowId === undefined && args.toWindowId === undefined && args.from !== 'the current text selection' &&
            !selectedWindow && openedWindow?.appId === resolved?.appId && windowIdentity &&
            (!leaseWindow || sameWindow(leaseWindow, openedWindow)) &&
            ([args.from, args.to].every(Array.isArray) || leaseWindow?.windowNumber !== undefined)) {
          // Only a fresh native match turns the advisory file URL into a drag source number.
          try {
            const hint = openedWindow;
            const identity = verifyWindowIdentity(hint, await windowIdentity({ ...hint, allowUnfocused: true }));
            current();
            if (openedWindow === hint && (!leaseWindow || sameWindow(leaseWindow, hint)) &&
                identity.pid === resolved.pid && Number.isSafeInteger(identity.windowNumber) && identity.windowNumber > 0 &&
                ([args.from, args.to].every(Array.isArray) || leaseWindow?.windowNumber === identity.windowNumber)) {
              callArgs = { ...callArgs, windowId: identity.windowNumber };
              args = callArgs;
            }
          } catch { current(); trace('drag-opened-window-unconfirmed', { id: msg.id }); }
        }
        if (args.windowId === undefined && args.toWindowId === undefined && args.from === 'the current text selection' && resolved?.appId && localTools.selectionWindow && windowIdentity &&
            [...openedWindows.values()].some(window => window?.appId === resolved.appId)) {
          // Read selection ranges, never document text. An incomplete census keeps drag's ordinary ambiguity refusal.
          try {
            const selected = await localTools.selectionWindow(resolved);
            current();
            if (selected?.ok && selected.target?.appId === resolved.appId && selected.pid === resolved.pid &&
                Number.isSafeInteger(selected.target.windowNumber) && selected.target.windowNumber > 0) {
              const identity = verifyWindowIdentity(selected.target, await windowIdentity({ ...selected.target, allowUnfocused: true }));
              current();
              if (identity.pid === resolved.pid && Number.isSafeInteger(identity.windowNumber) && identity.windowNumber > 0) {
                callArgs = { ...callArgs, windowId: identity.windowNumber };
                args = callArgs;
              }
            }
          } catch (error) { current(); trace('drag-selection-window-unconfirmed', { id: msg.id }); }
        }
        // drag converts Claude's screenshot pixels to window points with this size (2026-10-08).
        const shot = [args.app, resolved?.app].map(a => typeof a === 'string' && screenshots.get(a.toLowerCase())).find(Boolean);
        // Per window too: a second, untitled Chess window left 3 of 13 drags unconverted (2026-10-09).
        const observedNumber = leaseWindow?.windowNumber ?? leaseWindow?.nativeIdentity?.windowNumber;
        const observed = leaseWindow && [leaseWindow.app, leaseWindow.appId].includes(args.app) &&
          (args.windowId === undefined || args.windowId === observedNumber) &&
          (!resolved || (resolved.appId === leaseWindow.appId &&
            (resolved.title == null || (resolved.title === leaseWindow.title && (resolved.url ?? null) === (leaseWindow.url ?? null))) &&
            (resolved.windowNumber === undefined || resolved.windowNumber === observedNumber))) ? leaseWindow : undefined;
        const cross = args.toWindowId !== undefined;
        const readWindow = number => {
          const known = [...dragWindows.values()].filter(window => window.windowNumber === number &&
            [window.app, window.appId].includes(args.app) && (!resolved || resolved.appId === window.appId));
          const window = known.length === 1 && !known[0].identityError &&
            (!known[0].identityRequired || known[0].nativeIdentity) && known[0];
          // The compactor keys native trees by header. Equal titles cannot certify two number maps.
          return window && ![...dragWindows.values()].some(other => other.appId === window.appId &&
            other.title === window.title && other.windowNumber !== number) ? window : undefined;
        };
        const source = cross ? readWindow(args.windowId) : observed;
        const destination = cross ? readWindow(args.toWindowId) : observed;
        const endpoints = { from: args.from, to: args.to }, evidence = {};
        for (const [names, window, prefix] of cross ? [[['from'], source, ''], [['to'], destination, 'to']] : [[['from', 'to'], source, '']]) {
          for (const name of names) {
            const endpoint = endpoints[name];
            if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) continue;
            const known = compactor.seenLines(window);
            const matches = Object.keys(endpoint).length === 1 && typeof endpoint.line === 'string'
              ? Object.entries(known ?? {}).filter(([, line]) => line === endpoint.line) : [];
            if (matches.length !== 1) throw new Error(/* notice */ promptNotice('drag line identity needs one observed element in this app window; read it again', prompt));
            endpoints[name] = Number(matches[0][0]);
          }
          const numbers = names.map(name => endpoints[name]).filter(Number.isInteger);
          const lines = compactor.seenLines(window, numbers);
          if (numbers.length && (!window || numbers.some(n => !lines?.[n] || !compactor.uniqueSeen(window, numbers).includes(n)))) {
            throw new Error(/* notice */ promptNotice('drag element numbers need unique identities from a read of this app window; read it again', prompt));
          }
          evidence[prefix ? 'toElementLines' : 'elementLines'] = lines;
          evidence[prefix ? 'toElementWindow' : 'elementWindow'] = window ? { title: window.title,
            windowId: window.windowNumber ?? window.nativeIdentity?.windowNumber } : undefined;
        }
        callArgs = { ...callArgs, ...endpoints, screenshot: shot ? [shot.latest.width, shot.latest.height] : undefined, screenshots: shot?.byTitle,
          screenshotsByWindow: shot?.byWindow, toElementLines: undefined, toElementWindow: undefined, ...evidence };
      }
      current();
      pauseHost?.activity();
      result = await localTools.call(name, callArgs, async (parts, message, options) => {
        const allowed = await (prepared?.approval ?? approve(parts, message, msg.id, options));
        current();
        if (allowed) {
          // Approval can emit waiting after the admission clear. Remove any control again before pointer input.
          if (pauseHost?.clearForAction && ['drag', 'hover', 'menu_bar'].includes(name)) { await pauseHost.clearForAction(); current(); }
          const key = leaseCalls.get(msg.id)?.key;
          if (key) inputLease.renew([key]);
        }
        return allowed;
      // The fourth argument stays runLocal for callLocalTool; the resolved
      // lease target rides fifth.
      }, undefined, resolved, prepared, { afterDrag: outcome => dragChangedLines(msg, outcome, current) });
      current();
      if (msg.params.name === 'select_window' && !result.isError) {
        const value = JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}');
        if (!value.ok || !value.target?.appId || typeof value.target?.title !== 'string' ||
            (resolved && value.target.appId !== resolved.appId)) throw new Error(/* notice */ 'Window selection returned no matching target');
        const selected = { ...value.target, ...(Number.isSafeInteger(value.identity?.windowNumber) && value.identity.windowNumber > 0
          ? { windowNumber: value.identity.windowNumber } : {}) };
        selectedWindow = selected;
        leaseWindow = undefined;
        if (windowIdentity && selected.windowNumber !== undefined) {
          const observed = await windowIdentity(selected);
          current();
          selected.nativeIdentity = nativeIdentity(selected, observed);
          noteProcess(selected.nativeIdentity);
        }
      }
    } catch (err) {
      // A failed lookup or lease leaves the early open_file approval unanswered; decline it here.
      preparedFailed = true; preparedAsk?.withdraw();
      result = { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true };
    }
    localRunning.delete(msg.id);
    tagRunScreenshots(result?.content, { source: 'local' });
    localCursorResult(msg.id, !!result?.isError);
    if (!running.has(msg.id)) return; // Stop already settled this request after collection.
    if (plan) flowRules.observe(result, plan);
    finishedCall(msg.id);
    const openedApp = result._meta?.['sleight/openedApp'];
    if (name === 'open_file' && openedApp) {
      const { 'sleight/openedApp': _, 'sleight/openedFile': openedFile, ...meta } = result._meta;
      result = { ...result, _meta: meta };
      if (!result.isError && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(openedApp)) {
        const handle = `__sleightOpenedApp${nextInternalId++}`;
        if (typeof openedFile?.path === 'string') compactor.noteOpenedFile(openedFile.path, openedFile.real, openedFile.size);
        // A lazy open skipped `open -g` for a running app; the first read decides whether the file needs it.
        let lazy = openedFile?.lazy === true && typeof localTools.reopen === 'function';
        const acquire = () => {
        const id = `sleight-open-file-${nextInternalId++}`;
        callGenerations.set(id, generation);
        splitCalls.set(id, async reply => {
          openShots.delete(id); openReads.delete(id);
          const textless = textlessOpens.delete(id);
          if (generation !== stopGeneration || closing || disposed) return;
          let state = reply.result ?? { isError: true, content: [{ type: 'text', text: reply.error?.message ?? 'Window read failed.' }] };
          // The read is of the app's main window. A window showing another file means this one may not be in front.
          const shown = !state.isError && typeof openedFile?.path === 'string' &&
            windowFromText((state.content ?? []).filter(c => c?.type === 'text').map(c => c.text).join('\n'));
          let shownPath;
          try { shownPath = shown?.url ? fileURLToPath(shown.url) : undefined; } catch { shownPath = null; }
          const confirmed = shownPath === undefined || [openedFile.path, openedFile.real].includes(shownPath);
          if (lazy && ![openedFile.path, openedFile.real].includes(shownPath)) {
            lazy = false;
            const started = Date.now();
            let opened = false;
            try { await localTools.reopen(openedApp, openedFile.path); opened = true; } catch { /* The notice below says the file isn't confirmed. */ }
            trace('open-reopen', { id: msg.id, ms: Date.now() - started, ok: opened });
            if (generation !== stopGeneration || closing || disposed) return;
            if (opened) { retainEngineDocs(state.content); acquire(); return; }
          }
          const opened = confirmed ? result.content ?? []
            : [{ type: 'text', text: promptNotice(`${args.app}'s main window shows ${shown.url}, not ${args.path}, so sleight can't confirm the file opened. ` +
              'Find its window before acting.', prompt) }];
          // Excel's and Word's trees hold no cells or body text. In 10 of 10 edit runs (2026-10-17) Claude then
          // read the window again and took a screenshot, two model turns, before its first edit. Only a window
          // whose URL is the opened file gets one: with no URL, the read may show another window.
          const matched = typeof shownPath === 'string' && [openedFile.path, openedFile.real].includes(shownPath);
          if (typeof openedFile?.path === 'string') {
            const target = { ...(matched ? shown : {}), appId: openedApp,
              app: shown?.app ?? args.app, title: matched ? shown.title : openedFile.path.split('/').at(-1),
              url: matched ? shown.url : pathToFileURL(openedFile.real ?? openedFile.path).href };
            openedWindows.set(handle, target);
            openedWindow = target;
          }
          let pictured = false;
          if (textless && matched && !state.isError) {
            const started = Date.now(), image = await openScreenshot(handle);
            trace('open-screenshot', { id: msg.id, ms: Date.now() - started, ok: !!image });
            if (generation !== stopGeneration || closing || disposed) return;
            if (image) {
              pictured = true;
              state = { ...state, content: [...(state.content ?? []).filter(c => c?.text !== promptNotice(TEXTLESS_NOTE, prompt)), image] };
            }
          }
          // After `const app`, `let app` is a redeclaration error, so the handle is named for use as is. Beside a
          // notice that the window shows another file, the handle is only named.
          const combined = { ...state, content: [...opened, ...(state.content ?? []),
            ...(!state.isError ? [{ type: 'text', text: promptNotice((pictured ? 'sleight: screenshot added, the tree has no document text. ' : '') +
              `Window handle: \`${handle}\`` + (!confirmed ? '.' : constApp ? ', already acquired. Use it in place of `app`.'
                : `, already acquired, but \`app\` isn't set: start the next call with \`let app = ${handle};\`.`) +
              (handleApi && confirmed ? '\n' + "It has the engine's app API: click, doubleClick, rightClick, pressKey, typeText, paste, setValue, selectText, scroll, performSecondaryAction, getAXState, getScreenshot, getAXStateAndScreenshot." : ''), prompt) }] : [])] };
          if (pictured) recordScreenshot(combined.content);
          const response = { jsonrpc: '2.0', id: msg.id, result: combined };
          reportPreapprovals(response); toClient(response);
        });
        if (openShot) openShots.set(id, handle);
        else if (openAutoShot) openReads.add(id);
        // bench/timing.mjs counts this read as the open_file call's engine time.
        trace('acquisition-split', { id: msg.id, acquisition: id });
        callSeqs.set(id, callSeqs.get(msg.id));
        handleClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js',
          arguments: { code: `var ${handle} = await cua.getApp(${JSON.stringify(openedApp)})` } } });
        };
        acquire();
        return;
      }
    }
    const reply = { jsonrpc: '2.0', id: msg.id, result };
    reportPreapprovals(reply);
    toClient(reply);
  }

  function rotateTurn(carryId) {
    cursorStatus('done'); cursorStatus('idle');
    const outcome = outcomeCalls.get(carryId), read = completenessCalls.get(carryId);
    releaseLeases();
    turnOutcomes = new TurnOutcomes();
    outcomeCalls.clear();
    completenessCalls.clear();
    if (outcome) outcomeCalls.set(carryId, { ...outcome, turn: turnOutcomes });
    if (read) completenessCalls.set(carryId, read);
    turnId = randomUUID();
    turnUsed = false;
    spaceNoted.clear();
  }

  lines(clientIn, clientLine);
  function clientLine(line, startupReady = false) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (documentMode || flowRules) return;
      serverIn.write(line + '\n');
      return;
    }
    // Remove private narration before startup caching, tracing, journals and all execution paths.
    if (!startupReady && msg.method === 'tools/call' && msg.params?.arguments) {
      const raw = msg.params.arguments.sleight_stats?.say;
      if (msg.params.arguments.sleight_stats && typeof msg.params.arguments.sleight_stats === 'object') delete msg.params.arguments.sleight_stats.say;
      callNarration.delete(msg.id);
      const say = modHost() && cursor?.narration && cursor.narration !== 'off' ? narrationLine(raw, msg.params.arguments) : undefined;
      if (say && msg.id !== undefined) {
        if (callNarration.size >= 200) callNarration.delete(callNarration.keys().next().value);
        callNarration.set(msg.id, say);
      }
    }
    if (pauseBlocked(msg)) { callNarration.delete(msg.id); pauseReply(msg); return; }
    if (msg.method === 'initialize') codexClient = codexTurnClient(msg.params?.clientInfo);
    if (msg.method === 'tools/call') {
      if (docOrigin.owns(msg.id)) {
        docOrigin.invalidate();
        toClient({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Request ID is reserved for private REPL preparation.' } });
        return;
      }
      const nextMeta = { ...msg.params?._meta }; delete nextMeta[META_KEY];
      if (stableJson(nextMeta) !== stableJson(documentationClientMeta)) docOrigin.invalidate();
      documentationClientMeta = nextMeta;
      if (msg.params?.name !== 'js') { docOrigin.sent(msg, documentationContext()); docOrigin.invalidate(); }
      if (requestsFullDocumentation(msg.params?.arguments?.code ?? '') || /\bsleight\.nativeDocumentation\s*\(/.test(msg.params?.arguments?.code ?? ''))
        fullDocumentationCalls.add(msg.id);
    }
    if (msg.method === undefined && msg.id !== undefined) recordAction('waitEnd', 'c:' + msg.id);
    if (msg.method === 'tools/call' && msg.params?.name === TURN_START_TOOL && !modHost()) { codexTurnStart(msg); return; }
    // Stop and resume are the user's controls and work on every host. Only binding a turbo turn needs the mod. (A turbo
    // tool called by name in another host reaches a bridge no turn ever bound, which fails it.)
    if (msg.method === 'tools/call' && msg.params?.name === TURN_END_TOOL && Object.hasOwn(msg.params.arguments ?? {}, 'sleight_turbo')) {
      // Host-protected own hook calls only. Bypass journals, tracing, result
      // compaction and the engine so the private bootstrap never reaches them.
      const reply = result => {
        if (!disposed && !clientOut.destroyed && !clientOut.writableEnded)
          clientOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      };
      const refuse = () => reply({ isError: true, content: [{ type: 'text', text: 'Trusted turn binding unavailable.' }] });
      // Without the mod nothing stops the model from calling turn_ended, so no host but the mod's binds a turbo turn.
      if (!modHost() || disposed || msg.id === undefined || Object.keys(msg.params.arguments).length !== 1) { refuse(); return; }
      const frame = msg.params.arguments.sleight_turbo;
      if (frame && Object.keys(frame).length === 1 && frame.event === 'bootstrap' && !installedBootstrapped) {
        installedBootstrapped = true;
        reply({ isError: false, content: [{ type: 'text', text: JSON.stringify({ sleightTurbo: remoteEnvelope }) }] }); return;
      }
      if (!installedBootstrapped || frame?.event !== 'begin') { refuse(); return; }
      if (!Object.hasOwn(frame, 'origin')) {
        // Older mods retain their turbo-only contract, without typed app authority.
        if (!directHost) { refuse(); return; }
        // Validate before a paused turn's immediate reply. The background bridge still validates its own envelope.
        const keys = ['version', 'session', 'nonce', 'event', 'turn', 'text'];
        if (Object.keys(frame).length !== keys.length || !keys.every(k => Object.hasOwn(frame, k)) ||
            frame.version !== remoteEnvelope.version || frame.session !== remoteEnvelope.session || frame.nonce !== remoteEnvelope.nonce ||
            typeof frame.turn !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.turn) || remoteTurns.has(frame.turn) ||
            remoteTurns.size >= 10000 || typeof frame.text !== 'string' || Buffer.byteLength(frame.text) > 65536) { refuse(); return; }
        remoteTurns.add(frame.turn);
        bindTurboPrompt(frame).then(({ available, deferred }) => {
          reply({ isError: !available && !deferred, content: [] });
        }).catch(refuse);
        return;
      }
      const keys = ['version', 'session', 'nonce', 'event', 'turn', 'text', 'origin', 'turbo'];
      if (Object.keys(frame).length !== keys.length || !keys.every(k => Object.hasOwn(frame, k)) ||
          frame.version !== remoteEnvelope.version || frame.session !== remoteEnvelope.session || frame.nonce !== remoteEnvelope.nonce ||
          !['composer', 'bridge'].includes(frame.origin) || typeof frame.turbo !== 'boolean' ||
          typeof frame.turn !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.turn) || remoteTurns.has(frame.turn) ||
          remoteTurns.size >= 10000 || typeof frame.text !== 'string' || Buffer.byteLength(frame.text) > 65536) { refuse(); return; }
      remoteTurns.add(frame.turn);
      trace('mod-turn-begin', { origin: frame.origin });
      const generation = stopGeneration;
      (async () => {
        promptOrigin = frame.origin;
        const present = await remotePresent();
        const typedLine = /^[ \t]*allow\s/i.test(frame.text);
        if (typedLine) pendingTyped.add(frame.text.split(/\r?\n/, 1)[0]);
        if (!present || typedLine) await waitCatalog();
        if (disposed || closing || generation !== stopGeneration) { refuse(); return; }
        applyTyped();
        const alreadyApproved = app => typedApps.has(typedKey(app.id)) || [...approved].some(key => {
          try { return appIdentity(JSON.parse(key)[0])?.id === app.id; } catch { return false; }
        }) || (() => { try { return preapproved?.list?.().some(name => appIdentity(name)?.id === app.id); } catch { return false; } })();
        // Typed grants are session approvals, so other scopes get no up-front ask.
        const context = !present && approvalScope === 'session' ? upfrontAsk(predictApps(frame.text, remoteCatalog).filter(app => !forbiddenTargetWarning(app.id) && !alreadyApproved(app))) : undefined;
        let turboBound = false;
        if (frame.turbo && directHost) {
          const { origin: _origin, turbo: _turbo, ...binding } = frame;
          try { turboBound = (await bindTurboPrompt(binding)).available; } catch {}
        }
        reply({ isError: false, content: [{ type: 'text', text: JSON.stringify({ sleightRemote: { turboBound, ...(context ? { context } : {}) } }) }] });
      })().catch(refuse);
      return;
    }
    if (modHost() && msg.method === 'tools/call' && msg.params?.name === TURN_END_TOOL) promptOrigin = undefined;
    if (msg.method === 'tools/call' && msg.params?.name === TURN_END_TOOL && msg.params.arguments?.sleight_stop === true) startup?.cancel();
    if (modHost() && msg.method === 'tools/call' && msg.params?.name === TURN_END_TOOL && msg.id !== undefined &&
        msg.params.arguments?.sleight_stop === true && statsId(msg.params.arguments?.sleight_stats)) {
      if (statsEnds.size >= 200) statsEnds.delete(statsEnds.keys().next().value);
      statsEnds.set(msg.id, msg.params.arguments.sleight_stats);
    }
    if (!startupReady && startup?.request(msg)) return;
    // When each tool call arrived, so a trace can time the relay's own work on it.
    if (msg.method === 'tools/call' && msg.id !== undefined) {
      callGenerations.set(msg.id, stopGeneration);
      pendingClients.set(msg.id, msg.params?.name + (msg.params?.arguments?.title ? ': ' + msg.params.arguments.title : ''));
    }
    if (tabCleanupPending && msg.method === 'tools/call' && ['js', 'js_reset'].includes(msg.params?.name)) {
      toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text',
        text: promptNotice('Wait for turn_ended, tab cleanup is pending.', prompt) }] } });
      return;
    }
    // SLEIGHT_TRACE_CODE=1 also keeps Claude's code, for benchmark diagnosis on this Mac only.
    if (msg.method === 'tools/call') { trace('call-received', { id: msg.id, method: msg.method, params: { name: msg.params?.name,
      ...(traceCode && typeof msg.params?.arguments?.code === 'string' ? { code: msg.params.arguments.code.slice(0, 4000) } : {}) } }); callSeqs.set(msg.id, ++callSeq); callStarts.set(msg.id, Date.now()); }
    if (msg.method === 'tools/call' && ['js', 'js_reset'].includes(msg.params?.name)) {
      const next = {};
      for (const key of ENGINE_CONTEXT_KEYS) if (msg.params._meta && Object.hasOwn(msg.params._meta, key)) next[key] = msg.params._meta[key];
      const policy = next['codex/sandbox-state'] ?? next['codex/sandbox-state-meta'];
      const key = policy === undefined ? '' : createHash('sha256').update(stableJson(policy)).digest('hex').slice(0, 16);
      engineContext = next;
      if (key !== engineContextKey) { engineContextKey = key; kernelEpoch++; trace('engine-context', { key, epoch: kernelEpoch }); forgetHandles(); }
    }
    // Claude sometimes sends js the Bash tool's parameter name (6 of 437 calls, 2026-10-07).
    const jsArgs = msg.method === 'tools/call' && msg.params?.name === 'js' ? msg.params.arguments : undefined;
    if (jsArgs && jsArgs.code === undefined && typeof jsArgs.command === 'string') {
      const { command, ...rest } = jsArgs;
      msg.params.arguments = { ...rest, code: command };
    }
    if (jsArgs && typeof msg.params.arguments?.code === 'string') {
      // With or without the input lease: after `const app`, a suggested `let app = …` is a redeclaration error.
      if (/(?:^|[;\n])\s*const\s+app\s*=/.test(msg.params.arguments.code)) constApp = true;
      msg.params.arguments.code = finalReturnCode(msg.params.arguments.code);
      const fixed = nativeGetStateCode(msg.params.arguments.code, id => nativeHandles.has(id), id => browserHandles.has(id));
      if (fixed !== msg.params.arguments.code) { msg.params.arguments.code = fixed; trace('getstate-rewritten', { id: msg.id }); }
      if (leanFirst && !requestsFullDocumentation(msg.params.arguments.code) &&
          /\bcua\s*\.\s*getApp\s*\(/.test(codeOnly(msg.params.arguments.code))) nativeAcquisitions.add(msg.id);
    }
    // `let app = await cua.getApp("X"); app` echoes the handle it just bound, which the
    // acquisition adds nothing to. Haiku 5.5 sent it 3 times on 2026-10-08, and the lease
    // refused each one as an action.
    const echo = typeof msg.params?.arguments?.code === 'string' && jsArgs &&
      msg.params.arguments.code.trim().match(/^((?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.getApp\([^;]*\))\s*;\s*([A-Za-z_$][\w$]*)\s*;?$/);
    if (echo && echo[2] === echo[3]) msg.params.arguments.code = echo[1];
    journal?.request(msg);
    recordAction('request', msg);
    if (completeness && msg.method === 'tools/call' && msg.id !== undefined) {
      const name = msg.params?.name, code = codeOnly(msg.params?.arguments?.code ?? '');
      const action = /\.\s*(?:click|pressKey|typeText|paste|setValue|scroll|drag|selectText|performSecondaryAction|pickFromList)\s*\(/.test(code);
      if (name === 'browser_read' || name === 'js' && !action && /\.\s*(?:getAXState(?:AndScreenshot)?|getApp|getTab|getState)\s*\(/.test(code))
        completenessCalls.set(msg.id, { requested: true, filtered: filteredRead(code) });
    }
    if (outcomes && msg.method === 'tools/call' && msg.id !== undefined) {
      const name = msg.params?.name, args = msg.params?.arguments;
      const statusOnly = /^browser_(?:act|fill|open)$/.test(name) || name === 'browser_tabs' && args?.do !== 'list' ||
        /^(?:hover|open_file)$/.test(name) || name === 'menu_bar' && /^(?:open|close)$/.test(args?.op);
      if (statusOnly || /^(?:drag|replay)$/.test(name) || name === 'menu_bar' && /^(?:choose|press)$/.test(args?.op) ||
          name === 'notifications' && args?.op === 'press' ||
          name === 'js' && /\.\s*(?:click|pressKey|typeText|paste|setValue|scroll|drag|selectText|performSecondaryAction|pickFromList)\s*\(/.test(codeOnly(args?.code ?? '')))
        outcomeCalls.set(msg.id, { name, statusOnly, turn: turnOutcomes });
    }
    if (engineBrowserOpen && msg.method === 'tools/call' && msg.params?.name === 'browser_open' && msg.id !== undefined) {
      const routed = turboRoute(msg.params.arguments, directBrowser && { browser: directBrowser.browser, application: directBrowser.application });
      if (!routed) { engineOpen(msg); return; }
      msg.params.arguments = routed;
    }
    const write = jsArgs && evaluateWrite(msg.params.arguments?.code);
    if (write) {
      finishedCall(msg.id);
      toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: write }] } });
      return;
    }
    // sleight's own consent host stops here, before an acquisition is split off and sent ahead of the call.
    const own = msg.method === 'tools/call' && (msg.params?.name === 'js' || localNames.has(msg.params?.name)) &&
      namesOwnHost(msg.params.name, msg.params.arguments ?? {});
    if (own) { finishedCall(msg.id); ownStop(msg, own); return; }
    // A blocked app stops here, before an acquisition is split off and sent ahead of the call.
    const blocked = msg.method === 'tools/call' && (msg.params?.name === 'js' || localNames.has(msg.params?.name)) && callBlock(msg.params.name, msg.params.arguments ?? {});
    if (blocked) { finishedCall(msg.id); blockStop(msg, blocked); return; }
    if (jsArgs && typeof msg.params.arguments?.code === 'string') {
      const problem = nativeArgumentsProblem(msg.params.arguments.code, nativeHandles, browserHandles);
      if (problem) {
        finishedCall(msg.id);
        toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: problem }] } });
        return;
      }
    }
    if (!splitAcquisition(msg) && !splitSave(msg)) handleClient(msg);
  }

  // Codex's prompt hook, and only it (codex-turn.mjs). Like the mod's frames it bypasses journals, tracing and the engine.
  // The reply is always empty: Codex hands a UserPromptSubmit hook's text to the model as context, and an error would
  // show as a failed hook on every prompt. The relay builds the begin frame itself; the envelope never leaves this process.
  function codexTurnStart(msg) {
    const reply = () => {
      if (msg.id !== undefined && !disposed && !clientOut.destroyed && !clientOut.writableEnded)
        clientOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [] } }) + '\n');
    };
    const frame = codexTurbo() ? codexTurnFrame(msg.params) : undefined;
    // One binding per Codex turn. A prompt the user adds mid-turn keeps the first binding (and turbo's tabs); a payment it
    // names asks on sleight's card. An ended turn's id never binds again.
    const fresh = frame && !codexTurns.has(frame.turn);
    trace('codex-turn', { accepted: !!fresh && !!directHost });
    if (!fresh || !directHost || disposed || msg.id === undefined) { reply(); return; }
    if (codexTurns.size >= 4096) codexTurns.delete(codexTurns.values().next().value);
    codexTurns.add(frame.turn);
    codexBinding = { thread: frame.session.toLowerCase(), turn: frame.turn };
    const turn = `codex-${++codexSequence}`, epoch = codexEpoch;
    codexPending = codexPending.catch(() => {}).then(() => epoch === codexEpoch &&
      directHost.bind({ ...directHost.bootstrapEnvelope(), event: 'begin', turn, text: frame.text }, turboApps(), clientHost))
      .then(available => {
        if (available && epoch !== codexEpoch) { void directBrowser?.end(); return; }
        if (available) { resumeRequested = true; resumeAfterStop(); }
      }, () => {}).finally(reply);
  }

  // `let app = await cua.getApp("X"); await app.click(…)` in one call. The lease needs the
  // window before it lets an action through, so the relay sends the acquisition alone, takes
  // the lease from its reply, then sends the rest, and Claude gets both results as one. Before,
  // Claude spent a turn on the acquisition (the engine's first call, or a switch of app).
  const handBindingMarks = new Map();
  const filterMarks = new Map(), splitCalls = new Map(), splitHeads = new Map(), splitCodes = new Map(), rawHeads = new Map(), saveNotes = new Map(), preparedSaves = new Set();
  const openShots = new Map(), openReads = new Set(), textlessOpens = new Set();
  const menuAdmissions = new Map(), menuCalls = new Map(), menuBaselines = new Map(), menuContinued = new Map(), menuForwards = new Map();
  const tabLandings = new Map();
  // Calls whose stop sleight continued: { head } while the head's result is processed, then { start }, the outcomes shown so far.
  const continuedOutcomes = new Map();
  // What a continued call ran before its window changed, for the line its final result opens with.
  const continuedLeads = new Map();
  const skippedSettle = (id, reason) => saveNotes.set(id, promptNotice(`Text-write settle skipped: ${String(reason).replace(/\s+/g, ' ')}.`, prompt));
  function splitSave(msg) {
    if (pauseBlocked(msg)) { pauseReply(msg); return true; }
    if (!inputLease || msg.method !== 'tools/call' || msg.params?.name !== 'js' ||
        msg.id === undefined || typeof msg.params.arguments?.code !== 'string' || browserPlan(msg.params.arguments.code)) return false;
    const plan = splitTextSave(msg.params.arguments.code);
    if (!plan) return false;
    if (!settleTextWrite) { skippedSettle(msg.id, 'helper unavailable'); return false; }
    // Keep refusals that inspect the entire call ahead of any write in its prefix.
    if (unawaitedAction(msg.params.arguments.code) ||
        flowRules?.analyze('js', msg.params.arguments, lastWindow).violations.length) return false;
    if (clipboard) {
      try { clipboardPlan(msg.params.arguments.code); } catch { return false; }
    }
    const expected = handleBundles.get(plan.handle);
    if (!expected?.appId || expected.appId !== leaseWindow?.appId || !sameWindow(expected, leaseWindow)) return false;
    const generation = stopGeneration, prefixId = `sleight-text-write-${nextInternalId++}`, pauseCheck = pauseChecks.get(msg.id);
    const current = () => !pauseBlocked(msg) && generation === stopGeneration && !closing && !disposed && !stopCollected &&
      expected.appId === leaseWindow?.appId && sameWindow(expected, leaseWindow);
    if (prepareTextWrite && !preparedSaves.delete(msg.id)) {
      running.add(msg.id); callDetails.set(msg.id, 'text-write preflight');
      Promise.resolve().then(() => prepareTextWrite(expected, current)).then(() => {
        finishedCall(msg.id);
        if (pauseBlocked(msg)) { pauseReply(msg); return; }
        if (!current()) { if (!disposed && !stopCollected) leaseStop(msg, 'Text save was stopped before the write.'); return; }
        preparedSaves.add(msg.id);
        if (!splitSave(msg)) handleClient(msg);
      }, error => {
        finishedCall(msg.id);
        if (pauseBlocked(msg)) { pauseReply(msg); return; }
        if (!current()) { if (!disposed && !stopCollected) leaseStop(msg, 'Text save was stopped before the write.'); return; }
        if (error.textSaveStop) { leaseStop(msg, error.message); return; }
        skippedSettle(msg.id, error.message);
        handleClient(msg);
      }).catch(error => { finishedCall(msg.id); if (!disposed && !stopCollected) leaseStop(msg, error.message); });
      return true;
    }
    callGenerations.set(prefixId, generation);
    pauseChecks.set(prefixId, pauseCheck);
    splitCalls.set(prefixId, reply => {
      pauseChecks.delete(prefixId);
      if (reply.error || reply.result?.isError) { toClient({ ...reply, id: msg.id }); return; }
      splitInputs.add(msg.id);
      const content = reply.result?.content ?? [];
      const stop = error => toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [...content,
        { type: 'text', text: promptNotice(`Text save stopped after the write: ${error.message}. The save was not sent. Read the intended window before continuing.`, prompt) }] } });
      try { pauseCheck(); } catch (error) { stop(error); return; }
      if (!current()) { stop(new Error(/* notice */ 'window changed or call stopped')); return; }
      let key;
      try { key = inputLease.acquire(expected); }
      catch (error) { stop(error); return; }
      running.add(msg.id); callDetails.set(msg.id, 'text-write settle');
      leaseCalls.set(msg.id, { key }); refreshHeartbeat();
      Promise.resolve().then(() => {
        pauseCheck();
        if (!current()) throw new Error(/* notice */ 'call stopped');
        inputLease.renew([key]);
        return Promise.resolve().then(() => settleTextWrite(leaseWindow, current, inputLease.grant(key)))
          .catch(error => {
            if (!current() || error.textSaveStop) throw error;
            inputLease.renew([key]);
            skippedSettle(msg.id, error.message);
          });
      }).then(() => {
        pauseCheck();
        if (!current()) throw new Error(/* notice */ 'window changed or call stopped');
        inputLease.renew([key]);
        finishedCall(msg.id);
        splitHeads.set(msg.id, [...(splitHeads.get(msg.id) ?? []), ...content]);
        const tail = { ...msg, params: { ...msg.params, arguments: { ...msg.params.arguments, code: plan.tail } } };
        if (!splitSave(tail)) handleClient(tail);
      }).catch(error => { finishedCall(msg.id); if (!disposed && !stopCollected) stop(error); });
    });
    trace('text-save-split', { id: msg.id, prefix: prefixId, handle: plan.handle });
    callSeqs.set(prefixId, callSeqs.get(msg.id)); callSeqs.set(msg.id, ++callSeq);
    handleClient({ ...msg, id: prefixId, params: { ...msg.params, arguments: { ...msg.params.arguments, code: plan.head } } });
    return true;
  }
  // The recovery re-acquisition for a call that uses engine handles: the bundle of the code's own handle, not the last
  // app any call read (GA1: `h.click` recovered to Chrome after a Helium read whose result had no single window). An
  // unknown handle or two apps get no recovery. `app` is the one handle with no entry that recovery itself binds.
  function recoveryPlan(code) {
    const bare = codeOnly(code), handles = [...new Set([...bare.matchAll(HANDLE_CALL)].map(m => m[1]))];
    // A handle-style call on a receiver that isn't a plain name can't be mapped to an app.
    if ([...bare.matchAll(METHOD_CALL)].length !== [...bare.matchAll(HANDLE_CALL)].length) return;
    // Bound by an acquisition whose bundle ID the engine never confirmed: the global target is not its app (GA1).
    if (handles.some(handle => unconfirmedHandles.has(handle))) return;
    const windows = handles.map(handle => handleBundles.get(handle) ?? (handle === 'app' ? lastConfirmedWindow : undefined));
    if (windows.some(window => !window?.appId) || new Set(windows.map(window => window.appId)).size > 1) return;
    const appId = windows[0]?.appId ?? lastConfirmedWindow.appId, target = `cua.getApp(${JSON.stringify(appId)})`;
    const expected = appId === lastConfirmedWindow.appId ? lastConfirmedWindow : windows[0];
    // Another handle's app is acquired under a fresh name, so no binding of Claude's changes.
    const acquire = handles.every(handle => handle === 'app') ? `${constApp ? '' : 'let app = '}await ${target}`
      : `let sleightRecovery${nextInternalId} = await ${target}`;
    return { appId, expected, acquire };
  }
  // Running is something the probe saw: a responding app, or a process id with an error. Absent, denied, ambiguous or no
  // answer all refuse, since a wrong yes launches an app.
  const appRunning = health => health?.status === 'responding' || Number.isSafeInteger(health?.pid);
  // The native running check came back as a promise: hold the call for it (600 ms at most), then go on as if it had just
  // arrived. Not running, or no answer: the call gets the refusal that needs no acquisition, and nothing launches.
  function probeThenResume(msg, appId, answer) {
    const generation = stopGeneration;
    running.add(msg.id); callDetails.set(msg.id, 'recovery running check');
    let timer;
    Promise.race([Promise.resolve(answer).catch(() => undefined),
      new Promise(resolve => { timer = setTimeout(resolve, menuContinuationTimeoutMs); timer.unref?.(); })]).then(health => {
      clearTimeout(timer); running.delete(msg.id); callDetails.delete(msg.id);
      if (generation !== stopGeneration || closing || disposed) { leaseStop(msg, 'this call was stopped.'); stoppedClients.add(msg.id); return; }
      if (!appRunning(health)) {
        trace('recovery-refused', { id: msg.id, reason: health?.status === 'absent' ? 'not-running' : 'unconfirmed' });
        if (!splitSave(msg)) handleClient(msg);
        return;
      }
      if (!splitAcquisition(msg, appId) && !splitSave(msg)) handleClient(msg);
    });
  }
  // browser_open on the engine path: the acquisition as sleight's own js call, then, under Claude's id, Cmd+T, the URL and
  // Return as a second js call. The first result sets the lease and the tree the tab continuation counts tabs against, so
  // the URL usually follows Cmd+T in the same model turn. Keys go out only to an app the relay knows is a web browser.
  function engineOpen(msg) {
    const refuse = text => { finishedCall(msg.id); blockStop(msg, text); };
    let open;
    try { open = parseEngineOpen(msg.params.arguments); } catch (error) { refuse(error.message); return; }
    if (documentMode) { refuse(DOCUMENT_SCOPE_NOTE); return; }
    if (tabCleanupPending) { refuse(promptNotice(CLEANUP_NOTE, prompt)); return; }
    // The user's site limits judge the destination before anything is sent, as turbo's open does.
    const site = permissions?.sitesLimited?.() ? permissions.page(siteOf(open.url)) : undefined;
    if (site) { refuse(site); return; }
    const n = nextInternalId++, handle = `sleightBrowser${n}`, id = `sleight-browser-open-${n}`, generation = stopGeneration;
    const print = JSON.stringify(['browser_open', open]);
    engineOpenPrints.set(msg.id, print); engineOpenAcquisitions.add(id);
    callGenerations.set(id, generation);
    splitCalls.set(id, reply => {
      engineOpenAcquisitions.delete(id);
      // A failed attempt was still the identical retry a flow exception allowed, so it uses the exception up.
      const spent = () => { engineOpenPrints.delete(msg.id); if (flowPermit?.fingerprint === print) flowPermit = undefined; };
      const end = message => { retainEngineDocs(reply.result?.content); spent(); toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: message }] } }); };
      if (generation !== stopGeneration || closing || disposed) { end(STOPPED_NOTE); stoppedClients.add(msg.id); return; }
      if (reply.error || reply.result?.isError) {
        spent();
        // The engine puts first-call documentation before Invalid app. Claude Code can truncate that error away
        // (AOd Firefox smoke), so explain the failed target first and retain all engine instructions after it.
        const invalid = invalidAppReply(reply, open.browser);
        toClient({ ...reply, id: msg.id, ...(invalid ? { result: { ...reply.result,
          content: [{ type: 'text', text: promptNotice(invalidAppNote(open.browser), prompt) }, ...reply.result.content] } } : {}) });
        return;
      }
      const acquiredText = (reply.result?.content ?? []).filter(item => item?.type === 'text').map(item => item.text).join('\n');
      const shown = windowFromText(acquiredText);
      const appId = reply.result?._meta?.['codex/toolSurface']?.app?.appId, app = shown?.app ?? open.browser;
      const browser = typeof appId === 'string' && appId ? webBrowser(appId) : false;
      if (browser !== true) { end(promptNotice(browser === undefined ? unknownBrowserNote(app) : notBrowserNote(app), prompt)); return; }
      const problem = browserWindowProblem(acquiredText, app);
      if (problem) { end(promptNotice(problem, prompt)); return; }
      // The acquisition's own read moved the flow revision; a permit for this exact call still covers its keys.
      if (flowRules && flowPermit?.fingerprint === print) flowPermit = { ...flowPermit, revision: flowRules.revision };
      splitHeads.set(msg.id, [{ type: 'text', text: promptNotice(openedNote(handle), prompt) }, ...(reply.result?.content ?? [])]);
      handleClient({ ...msg, params: { name: 'js', arguments: { code: openCode(handle, open.url, acquiredText) } } });
    });
    trace('browser-open-split', { id: msg.id, acquisition: id });
    callSeqs.set(id, callSeqs.get(msg.id)); callSeqs.set(msg.id, ++callSeq);
    handleClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: acquisitionCode(handle, open.browser) } } });
  }
  function splitAcquisition(msg, probed) {
    if (pauseBlocked(msg)) { pauseReply(msg); return true; }
    if (documentMode || msg.method !== 'tools/call' || msg.params?.name !== 'js' ||
        msg.id === undefined || typeof msg.params.arguments?.code !== 'string') return false;
    const code = msg.params.arguments.code;
    const action = compactor.beginAction(code), saveRead = action?.save && !action.before && !action.mixedSave;
    if (!inputLease && !saveRead) return false;
    const prefix = selectedWindow
      ? /^\s*((?:(?:(?:let|const|var)\s+)?[A-Za-z_$][\w$]*\s*=\s*)?await\s+cua\.getApp\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{\s*(?:windowId|"windowId")\s*:\s*\d+\s*\})\s*\)\s*;?)/
      : (leaseWindow?.appId || !recoveryKnown || !lastConfirmedWindow ? DECLARED_ACQUISITION : ASSIGNED_ACQUISITION);
    // With the lease dropped and a recovery target kept, `app = await cua.getApp("Google Chrome")` is an acquisition too.
    // Recovery used to replace it with a getApp of the last app (GA1, 2026-10-18: Helium launched).
    const m = code.match(prefix);
    let acquire = m?.[1], rest = m && code.slice(m[0].length).trim();
    if (selectedWindow && !rest) return false;
    // An action with no confirmed window yet, such as the call after a failed one, used to be
    // refused with the acquisition to send first: 13 refusals in 29 TextEdit runs, a turn each
    // (2026-10-10). The relay now sends that acquisition and then the call.
    // Only for a bundle ID the engine confirmed: an unconfirmed name keeps the refusal.
    // The call goes on only when the acquisition shows the window the lease last had: after an
    // error the front window may have changed, and keys or text would land in it unseen.
    let expected = selectedWindow, saveBaseline = false, saveHandle;
    // Without an earlier tree there is no AXDocument URL to stat. Read it inside this tool call,
    // then beginAction samples its mtime before forwarding Save. No file contents are read.
    if (!rest && saveRead && (!inputLease || leaseWindow?.appId)) {
      const handle = /^\s*await\s+([A-Za-z_$][\w$]*)\.(?:pressKey|click)\(/.exec(code)?.[1];
      if (handle && nativeHandles.has(handle)) {
        acquire = `await ${handle}.getAXState({ disableDiffing: true })`; rest = code;
        expected = inputLease ? leaseWindow : undefined;
        saveBaseline = true; saveHandle = handle;
      }
    }
    // The recovery re-acquisition after the lease dropped. When its window was a dialog or palette that has since closed,
    // the window it covered may become the lease (parentLeaseRefusal), judged against what the last result showed.
    let recovered = false;
    const shown = lastShown;
    // Never for a call that names its own app (GA1: a recovery getApp of the last app launched it), for an unknown handle, or
    // for an app that isn't running (the engine launches a quit app on getApp).
    if (!rest && !leaseWindow?.appId && recoveryKnown && lastConfirmedWindow && !isLeaseRead(code) && !reachesGetApp(code)) {
      const plan = recoveryPlan(code);
      // No probe, no recovery: the running check is what keeps recovery from launching an app.
      if (!plan || !runningProbe) trace('recovery-refused', { id: msg.id, reason: plan ? 'no-probe' : 'handle' });
      else {
        let ok = probed === plan.appId;
        if (!ok) {
          if (running.size) return false;
          let answer;
          try { answer = runningProbe(plan.appId); } catch { /* No answer refuses. */ }
          if (typeof answer?.then === 'function') { probeThenResume(msg, plan.appId, answer); return true; }
          ok = appRunning(answer);
          if (!ok) trace('recovery-refused', { id: msg.id, reason: 'unconfirmed' });
        }
        if (ok) { acquire = plan.acquire; rest = code; expected = plan.expected; recovered = true; }
      }
    }
    if (!rest) return false;
    // Split even for the app the lease holds: the guard's setup refers to `app` before a `let app`
    // in the same script, which throws (2/3 simulator-form runs, 2026-10-08).
    const prefixId = `sleight-acquire-${nextInternalId++}`;
    const numbers = literalNumbers(rest), generation = stopGeneration, trees = numbers.length > 0 && compactor.trees();
    callGenerations.set(prefixId, generation);
    splitCalls.set(prefixId, reply => {
      const raw = rawHeads.get(prefixId); rawHeads.delete(prefixId);
      const ended = () => {
        if (generation === stopGeneration && !closing && !disposed) return false;
        leaseStop(msg, 'this call was stopped.'); stoppedClients.add(msg.id); return true;
      };
      if (ended()) return;
      if (reply.error || reply.result?.isError) { toClient({ ...reply, id: msg.id }); return; }
      const acquiredNumber = acquire.match(/cua\.getApp\(\s*\{\s*(?:windowId|"windowId")\s*:\s*(\d+)\s*\}\s*\)/)?.[1];
      const unchanged = !expected || leaseWindow?.appId === expected.appId && sameWindow(leaseWindow, expected) &&
          (!selectedWindow || !acquiredNumber || Number(acquiredNumber) === expected.windowNumber);
      // The same native window under a title the previous result already showed: a page that loaded after the
      // lease was taken, or a result whose trees named two titles. Claude acted on the new title, so the number
      // must still be the leased window's, and the helper has to see that number under that title.
      const retitled = unchanged || saveBaseline || !windowIdentity || !leaseWindow?.appId || leaseWindow.appId !== expected.appId || leaseWindow.app !== expected.app ||
        !shown.has(documentKey({ title: leaseWindow.title, app: leaseWindow.app, url: leaseWindow.url })) ? undefined
        : (sameWindow(expected, selectedWindow) ? selectedWindow.windowNumber : undefined) ?? expected.nativeIdentity?.windowNumber;
      if (!unchanged && Number.isSafeInteger(retitled) && retitled > 0 && (!acquiredNumber || Number(acquiredNumber) === retitled)) {
        const target = leaseWindow;
        running.add(msg.id); callDetails.set(msg.id, 'retitled window check');
        menuIdentity(windowIdentity, { appId: target.appId, title: target.title, url: target.url, windowNumber: retitled }, menuContinuationTimeoutMs).then(observed => {
          running.delete(msg.id); callDetails.delete(msg.id);
          if (ended()) return;
          if (!observed || leaseWindow !== target || observed.windowNumber !== retitled) { trace('retitle-refused', { id: msg.id }); changed(); return; }
          noteProcess(observed);
          target.nativeIdentity = observed; target.identityRequired = true;
          trace('retitle-accepted', { id: msg.id });
          proceed();
        });
        return;
      }
      // A call that only reads and prints sends no input, so a window that changed since the last result is
      // the window its acquisition just showed (wikipedia, 2026-10-18: a filtered read refused as stale).
      if (!unchanged && !saveBaseline && isFilteredRead(rest)) { trace('filtered-read-stale-window', { id: msg.id }); proceed(); return; }
      if (!unchanged) { changed(); return; }
      proceed();
      function changed() {
        const stale = () => {
          // The window changed: Claude acts on the tree above, so a compacted re-acquisition goes out whole.
          if (raw) reply = { ...reply, result: { ...reply.result, content: compactor.process(raw, { forceFull: true }) } };
          toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [...(reply.result?.content ?? []),
            { type: 'text', text: promptNotice(`sleight: nothing from this call ran. ${expected.app}'s window changed since the last call (it was ${documentLabel(expected)}). Act on the window above.`, prompt) }] } });
        };
        const parent = expected.parent;
        const gate = parentLeaseGate({ enabled: parentLease, recovered, selected: !!selectedWindow, documentMode, changeReview,
          helper: !!windowIdentity, numbers, browser: !!browserPlan(rest), stale: expected, window: leaseWindow });
        if (gate) {
          if (parent && !['off', 'not-recovered'].includes(gate)) trace('parent-lease-refused', { id: msg.id, reason: gate });
          stale(); return;
        }
        const target = leaseWindow, text = (raw ?? reply.result?.content ?? []).filter(item => item?.type === 'text').map(item => item.text).join('\n');
        const certified = parent.nativeIdentity?.windowNumber > 0 ? { windowNumber: parent.nativeIdentity.windowNumber, nativeIdentity: parent.nativeIdentity } : {};
        const look = request => { let timer; return Promise.race([Promise.resolve().then(() => windowIdentity(request)),
          new Promise(resolve => { timer = setTimeout(resolve, menuContinuationTimeoutMs); })]).catch(() => undefined).finally(() => clearTimeout(timer)); };
        running.add(msg.id); callDetails.set(msg.id, 'parent lease check');
        windowGone(windowIdentity, { appId: expected.appId, title: expected.title, url: expected.url }, menuContinuationTimeoutMs)
          .then(async gone => ({ gone, observed: gone ? await look({ appId: parent.appId, title: parent.title, url: parent.url, ...certified, focus: true }) : undefined }))
          .then(({ gone, observed }) => {
            running.delete(msg.id); callDetails.delete(msg.id);
            if (ended()) return;
            const reason = leaseWindow !== target ? 'lease-moved'
              : parentLeaseRefusal({ stale: expected, shown, reply: text, gone, observed, now: clock() });
            if (reason) { trace('parent-lease-refused', { id: msg.id, reason }); stale(); return; }
            noteProcess(observed);
            // Pinned to the native window just observed: the rest's admission checks it again before anything is sent.
            // The pin ends with this call (parentPin), so a later helper epoch doesn't refuse the document.
            target.parentPin = { id: msg.id, nativeIdentity: target.nativeIdentity, identityRequired: target.identityRequired };
            target.nativeIdentity = observed; target.identityRequired = true;
            parentPins.set(msg.id, target);
            trace('parent-lease', { id: msg.id, over: parent.over });
            proceed();
          });
        return;
      }
      function proceed() {
        // A metadata read must not replace the lease's native identity with the newly observed one.
        // The action still checks the window and focus against the target from before this read.
        if (saveBaseline && expected) {
          leaseWindow = lastConfirmedWindow = expected;
          if (handleBundles.has(saveHandle)) handleBundles.set(saveHandle, expected);
        }
        // The rest's literal numbers name lines in the tree Claude had before this call. When the head shows
        // a line inserted or removed at or below them, they shifted, and the head's own read makes every number
        // look current to the stale check: click(58) meant for a row would land on a popup above it (LS1).
        if (trees && compactor.numbersMoved(trees, reply.result?.content, Math.max(...numbers))) {
          trace('acquisition-changed', { id: msg.id });
          toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [...(reply.result?.content ?? []),
            { type: 'text', text: promptNotice('sleight: the window changed before this call\'s actions ran, so nothing after the acquisition was sent. Act again with the numbers above, or with { id } or { label }.', prompt) }] } });
          return;
        }
        splitHeads.set(msg.id, reply.result?.content ?? []); splitCodes.set(msg.id, rest);
        const next = { ...msg, params: { ...msg.params, arguments: { ...msg.params.arguments, code: rest } } };
        if (!splitSave(next)) handleClient(next);
      }
    });
    trace('acquisition-split', { id: msg.id, acquisition: prefixId });
    // The acquisition takes this call's place in the sequence and the actions the next, so the
    // guard can reuse the acquisition's read for the first action as it does across two calls.
    callSeqs.set(prefixId, callSeqs.get(msg.id)); callSeqs.set(msg.id, ++callSeq);
    handleClient({ ...msg, id: prefixId, params: { ...msg.params, arguments: { ...msg.params.arguments, code: acquire } } });
    return true;
  }
  const closedWindowResults = new WeakSet();
  function continueMenu(msg) {
    const call = menuCalls.get(msg.id);
    if (!call) return false;
    menuCalls.delete(msg.id); menuAdmissions.delete(msg.id);
    // When the stop result arrived: a tab continuation asks for HID idle since then, not over the call.
    const stopAt = clock();
    if (!Array.isArray(msg.result?.content)) return false;
    // A confirmed close can stop an explicit observation before the tail runs.
    // A caught observation stop must not hide a later result or unrelated error.
    const closedRead = msg.result.isError && msg.result.content.some(c => c.type === 'text' && c.text?.includes('[sleight:closed-read]'));
    if (closeReadSkip && msg.result.content.some(c => c.type === 'text' && c.text?.split('\n').some(line =>
      !msg.result.isError && line === call.mark + ':closed' || closedRead && line === call.mark + ':closed-read'))) {
      closedWindowResults.add(msg);
    }
    msg.result.content = msg.result.content.map(c => c.type === 'text'
      ? { ...c, text: c.text.split('\n').filter(line => line !== call.mark + ':closed' && line !== call.mark + ':closed-read').join('\n') } : c);
    const taken = takeGuardStop(msg.result.content, call.mark);
    msg.result.content = taken.content;
    for (const decision of taken.bindings) trace('setvalue-binding', { id: msg.id, ...decision });
    for (const decision of taken.tabProbes) trace('tab-probe', { id: msg.id, ...decision });
    // The private mark proves the guard wrote these: payments it let through count for the request, and a payment stop is
    // answered by the next user message (SLEIGHT_CONFIRM_PAYMENTS=always) or by sleight's own card below.
    for (const record of taken.paid ?? []) paymentMessages.paid(record);
    const paymentStop = typeof taken.receipt?.error === 'string' && taken.receipt.error.startsWith('sleight stopped this payment:') &&
      taken.receipt.payment?.why !== 'point' ? taken.receipt.payment : undefined;
    if (paymentStop) paymentMessages.asked();
    // A tab this call opened in its window: the stop tree passes tabRefusal's checks, which tie it to that window.
    const tabOptions = { hiddenStrip: tabFirst };
    const tabStop = !msg.error && msg.result.isError && taken.receipt?.windowStop === true &&
      tabRefusal(call.plan, taken.receipt, call.target, taken.content, call.before, tabOptions) === undefined;
    // The retitled window is still the selected one and keeps its app handle, and select_window with the old title
    // would be refused (2026-10-18 Firefox race: 2 of 9 runs spent a call on it). The failure line repeats the stop's error.
    // Worded to hold whether or not the continuation then runs.
    const handle = text => tabStop ? text.replace(/Call select_window with \{[^\n]*?\}\./g, 'This window keeps its handle; send the rest on it after reading the result.') : text;
    if (tabStop) for (const item of msg.result.content) if (item?.type === 'text' && typeof item.text === 'string') item.text = handle(item.text);
    const action = resultCalls.get(msg.id);
    if (action && taken.receipt) action.failure = { message: handle(failedActionText(taken.receipt) ?? failureReason(taken.content)),
      noInput: typeof taken.receipt.error === 'string' && taken.receipt.index === 0 && taken.receipt.attempts === 1 && !taken.input &&
        !menuContinued.has(msg.id) && !splitInputs.has(msg.id) };
    // A lease on a dialog or sheet remembers the window it covered (parent), so a stop onto a standard window after the
    // call's own action is that action closing it.
    const note = !msg.error && msg.result.isError && stopNote(taken.receipt, call.plan, menuContinued.get(msg.id), { content: taken.content, seen: call.seen, uniqueSeen: call.uniqueSeen,
      closed: !!(call.target ?? leaseWindow)?.parent, tab: tabStop });
    // First, not after the tree: in an Office study (2026-10-17) the ran/not-sent line sat at line 134 of a 7 KB result.
    if (note) msg.result.content = [{ type: 'text', text: promptNotice(note, prompt) }, ...msg.result.content];
    // A payment stop asks the user in sleight's card while Claude's result waits. Allow once lets the next guarded call send
    // that one action; Cancel, a closed card or no card leaves the stop as it is.
    if (paymentCard && paymentStop && !msg.error && msg.result.isError) {
      const generation = stopGeneration, live = () => generation === stopGeneration && !closing && !disposed && !stopCollected;
      let replied = false;
      const reply = (note, content = msg.result.content, isError = true) => {
        if (replied) return;
        replied = true; clearTimeout(timer);
        msg.result = { ...msg.result, isError, content: [{ type: 'text', text: promptNotice(note, prompt) }, ...content] };
        observeServerMessage(msg);
      };
      const timer = setTimeout(() => reply(PAYMENT_WAITING), paymentCardHoldMs);
      // Each stopped call needs its own decision. Equal payment terms do not prove a retry of the same request.
      let answer;
      try { answer = paymentCard.ask({ session: clientName ?? 'the agent', site: paymentStop.site, shown: paymentStop.shown, control: paymentStop.control }); }
      catch { answer = undefined; }
      if (remoteApprovals) remotePresent().then(present => { if (!present && live()) reply(physicalApprovalNotice); });
      Promise.resolve(answer).catch(() => undefined).then(choice => {
          if (choice === 'once' && live()) {
            if (answer && typeof answer === 'object' && !grantedCards.has(answer)) { grantedCards.add(answer); paymentMessages.allowed(paymentStop); }
            // Nothing failed that Claude should report: the call ends with the note and the tree it stopped on.
            if (action) action.failure = undefined;
            reply(PAYMENT_ALLOWED, msg.result.content.flatMap(item => {
              if (item?.type !== 'text' || typeof item.text !== 'string') return [item];
              const text = item.text.split('\n').filter(line => !line.includes('sleight stopped this payment:')).join('\n');
              return text.trim() ? [{ ...item, text }] : [];
            }), false);
          } else if (!replied) { replied = true; clearTimeout(timer); observeServerMessage(msg); }
        });
      return true;
    }
    const stopped = !msg.error && msg.result.isError;
    const ineligible = !stopped ? 'no-stop' : documentMode ? 'document-scope' : changeReview ? 'change-review' : menuContinued.has(msg.id) ? 'continued'
      : guardMode?.split(',').some(mode => mode.trim() === 'careful') ? 'careful' : !call.target ? 'not-admitted' : undefined;
    const covered = !ineligible && call.target.parent;
    // Every lease stop says why no dialog continuation ran: the 2026-10-17 word-edit A/B showed only that none did.
    const refuse = reason => trace('dialog-continuation-refused', { id: msg.id, reason });
    if (stopped && (taken.receipt?.windowStop || call.target?.parent)) {
      const reason = ineligible ?? dialogRefusal(call.plan, taken.receipt, covered, taken.content);
      if (reason && reason !== 'palette-needs-close-check') refuse(reason);
    }
    // With tabFirst, a stop the tab checks pass takes the tab path before menuRemainder: its navigation branch claimed Safari's
    // Start Page (no page content) and then refused on idle over the whole call, which the engine's own Cmd+T breaks.
    const dialogRest = !ineligible && dialogRemainder(call.plan, taken.receipt, covered, taken.content);
    let remainder = !ineligible && (dialogRest || (tabFirst && tabContinuation && tabStop &&
      tabRemainder(call.plan, taken.receipt, call.target, taken.content, call.before, tabOptions)) ||
      menuRemainder(call.plan, taken.receipt, call.target, taken.content, { palette: routeSteering }));
    const refusePalette = reason => trace('palette-continuation-refused', { id: msg.id, reason });
    // Every window stop no other continuation took says why no tab continuation ran either.
    // `extra` carries what the HID-idle test saw (idleSample), once the helper has been asked.
    const refuseTab = (reason, extra) => trace('tab-continuation-refused', { id: msg.id, reason, ...extra });
    if (stopped && taken.receipt?.windowStop && !remainder) {
      const reason = ineligible ?? (!tabContinuation ? 'off' : tabRefusal(call.plan, taken.receipt, call.target, taken.content, call.before, tabOptions));
      if (reason) refuseTab(reason);
      else remainder = tabRemainder(call.plan, taken.receipt, call.target, taken.content, call.before, tabOptions);
    } else if (stopped && taken.receipt?.windowStop && !remainder.tab) {
      // With tabFirst the tab checks ran first; say why they refused before another continuation took the stop.
      refuseTab('other-continuation', tabFirst && tabContinuation ? { tab: tabRefusal(call.plan, taken.receipt, call.target, taken.content, call.before, tabOptions) ?? null } : undefined);
    }
    if (remainder?.dialog && !call.baseline) refuse('no-baseline');
    // The helper skips windows without a title, so an untitled popover would look gone while still open.
    if (popoverContinuation && remainder?.closeCheck && !call.target.title) { refuse('palette-untitled'); return false; }
    if (remainder?.tab && !call.baseline) refuseTab('no-baseline');
    // The tab's native check pins the window by its number, so a baseline without one can't continue.
    if (remainder?.tab && call.baseline && !(Number.isSafeInteger(call.baseline.windowNumber) && call.baseline.windowNumber > 0)) {
      refuseTab('no-window-number'); return false;
    }
    if (remainder?.tab && splitCalls.has(msg.id)) refuseTab('split-call');
    if (!remainder || !call.baseline || splitCalls.has(msg.id)) return false;
    const continuationPauseCheck = pauseChecks.get(msg.id) ?? pause.checkpoint();
    const stoppedByPause = () => {
      let cut = pausedCalls.has(msg.id);
      try { continuationPauseCheck(); } catch { cut = true; }
      if (!cut) return false;
      msg.result.content.push({ type: 'text', text: NATIVE_PAUSE_CUT_NOTE });
      return true;
    };
    if (stoppedByPause()) return false;
    const current = () => call.generation === stopGeneration && !closing && !disposed && !stopCollected;
    // A tab continuation also asks the helper for the window's sheets and focused element.
    // A palette is a window of its own: the helper must find it focused, under its title and with no URL (paletteRefusal).
    const expected = remainder.dialog ? { appId: covered.appId, title: covered.title, app: covered.app, url: covered.url }
      : remainder.palette ? { appId: call.target.appId, title: remainder.window.title, app: remainder.window.app, url: null }
      : remainder.navigation ? { ...call.target, ...remainder.window, windowNumber: call.baseline.windowNumber, nativeIdentity: call.baseline,
        ...(remainder.tab ? { focus: true, ...(ck3 ? { tabCertificate: true } : {}) } : {}) } : call.target;
    // A palette the lease held must be gone, not just behind the document, unless Escape closed it.
    const gone = remainder.closeCheck ? windowGone(windowIdentity, { appId: covered.appId, title: call.target.title, url: call.target.url }, menuContinuationTimeoutMs)
      : Promise.resolve(true);
    const probeAt = clock();
    gone.then(closed => closed ? menuIdentity(windowIdentity, expected, menuContinuationTimeoutMs, remainder.dialog ? error => refuse(`identity: ${error}`)
      : remainder.tab ? error => refuseTab(`identity: ${error}`) : remainder.palette ? error => refusePalette(`identity: ${error}`) : undefined)
      : (refuse('palette-still-open'), undefined)).then(observed => {
      if (!current()) { if (remainder.tab) refuseTab('call-superseded'); observeServerMessage(msg); return; }
      if (stoppedByPause()) { observeServerMessage(msg); return; }
      if (remainder.dialog) noteProcess(observed);
      const since = Math.min(call.forwardedAt, call.sampledAt ?? call.forwardedAt);
      // HID idle from when the covered window was last seen standard, through the dialog, to now.
      // The covered window must have been seen standard in the process the dialog's baseline has.
      const refusal = leaseWindow !== call.target ? 'lease-moved' : remainder.dialog ? observed && (covered.seen?.process !== processKey(call.baseline)
        ? 'covered-process-changed' : returnRefusal(covered, call.baseline, observed, Math.min(since, covered.at, covered.seenAt), clock()))
        : remainder.tab ? menuWindowRefusal(expected, call.baseline, observed, stopAt, clock()) || tabFocusRefusal(observed)
        : remainder.palette ? observed && paletteRefusal(expected, call.baseline, observed, since, clock())
        : !unchangedMenuWindow(expected, call.baseline, observed, since) && 'menu-window-changed';
      if (refusal || !observed) {
        if (remainder.dialog && refusal) refuse(refusal);
        if (remainder.palette && refusal) refusePalette(refusal);
        // Without an observation, menuIdentity already traced why.
        if (remainder.tab && refusal && observed) refuseTab(refusal, idleSample(observed, stopAt, clock(), since));
        observeServerMessage(msg); return;
      }
      // The sample also says whether idle over the whole call held: the cause of 0 of 9 Firefox continuations (2026-10-18) was not recorded.
      // With the stopped call's own engine time and the probe's: the client's result reports only the rest's engine time,
      // so Firefox's 1.13 to 1.70 s per Cmd+T call outside it (loss study, 2026-10-19) had no split.
      if (remainder.tab) trace('tab-continuation-checked', { id: msg.id, ...idleSample(observed, stopAt, clock(), since),
        stopEngineMs: msg.result._meta?.['codex/nodeReplExecutionDurationMs'] ?? null, probeMs: Math.round(clock() - probeAt) });
      // The rest goes to the covered window under its own lease, pinned to the native window just observed. A palette's rest
      // is pinned to the palette the same way and keeps the call's lease, as a menu's does.
      const pinned = remainder.dialog || remainder.palette;
      const baseline = pinned || remainder.tab && ck3 ? observed : call.baseline, lease = remainder.dialog ? covered : call.target;
      const forward = pinned ? { ...expected, windowNumber: observed.windowNumber } : expected;
      const original = structuredClone(msg), head = splitHeads.get(msg.id);
      // Keep output from before the refused action, drop its exception, then let the normal
      // result path record the menu tree. The remainder goes through the ordinary admission gates.
      // The real engine puts the exception first, so the head opens with the stop it no longer is (6 of 6 continued
      // Office calls, 2026-10-17); the final result leads with continuedNote instead.
      msg.result = { ...msg.result, isError: false, content: [...taken.head.filter(item => !(item?.type === 'text' && STOP_LINE.test(item.text ?? ''))),
        { type: 'text', text: GUARD_MARK + remainder.tree + GUARD_END }] };
      menuContinued.set(msg.id, taken.receipt.index);
      const kind = remainder.dialog ? 'dialog' : remainder.tab ? 'tab' : remainder.navigation ? 'navigation' : remainder.palette ? 'palette' : 'menu';
      trace('menu-continuation', { id: msg.id, ran: taken.receipt.index, kind });
      splitCalls.set(msg.id, reply => {
        if (!current()) { toClient({ ...reply, result: { ...reply.result, isError: true } }); return; }
        // A tab or navigation continuation returns the page it reached, not the stop's tree (kept only if the reply has none).
        const passed = remainder.navigation ? withoutStopTree(reply.result?.content ?? []) : undefined;
        continuedLeads.set(msg.id, { plan: call.plan, ran: taken.receipt.index, kind, over: covered?.over, title: remainder.window?.title,
          stopTree: passed?.tree });
        splitHeads.set(msg.id, [...(splitHeads.get(msg.id) ?? []), ...(passed?.content ?? reply.result?.content ?? [])]);
        leaseWindow = lease;
        menuBaselines.set(msg.id, remainder.window);
        // A tab rest that ends by pressing Return loads a page: its result waits for the tree to land (LB6, landTab).
        const last = call.plan.actions.at(-1).selector;
        const landing = remainder.tab && tabFirst && last?.kind === 'key' && /^(?:return|enter)$/i.test(last.value) ? call.plan.actions[0].handle : undefined;
        menuForwards.set(msg.id, { call, expected: forward, baseline, lease, original, head, current, tab: !!remainder.tab, stopAt, landing });
        nativeChecked.set(msg.id, undefined); focusedChecked.add(msg.id);
        handleClient({ ...call.request, params: { ...call.request.params,
          arguments: { ...call.request.params.arguments, code: remainder.code } } });
      });
      // The rest runs the stopped action again, so the head's outcomes leave it out and the rest's number on from them.
      continuedOutcomes.set(msg.id, { head: true });
      observeServerMessage(msg);
    });
    return true;
  }
  // LB6: a tab continuation's rest pressed Return and its result's tree still shows the new tab under a header that names the
  // page (Firefox mdn inside Codex, 2 of 37: Sol then spent a 3.3 s turn reading again). Read the window again, full, every
  // tabLandingIntervalMs until a tree names the header's page or tabLandingMs pass, and deliver the latest read in place of
  // the stale tree. A read that fails, or a stop meanwhile, delivers what the call had.
  function landTab(msg) {
    const forward = menuForwards.get(msg.id) ?? tabLandings.get(msg.id);
    if (!forward?.landing || forward.landed || msg.error || msg.result?.isError || !Array.isArray(msg.result?.content)) return false;
    const text = () => msg.result.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
    if (!landingRefusal(text())) return false;
    forward.landed = true; // once: the reply comes back through here when the wait ends
    // The read is the app's, not pinned to a window: it stands in only while it shows the window the result's header named.
    const shown = lastHeader(text());
    const generation = stopGeneration, started = clock(), live = () => generation === stopGeneration && !closing && !disposed && !stopCollected;
    const read = timeoutMs => new Promise(resolve => {
      const id = `sleight-tab-landing-${nextInternalId++}`;
      const timer = setTimeout(() => { internalRequests.delete(id); pauseChecks.delete(id); lateHelperReplies.add(id); resolve(undefined); }, timeoutMs);
      internalRequests.set(id, reply => { clearTimeout(timer); resolve(reply); });
      toServer({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js',
        arguments: { code: `await ${forward.landing}.getAXState({ disableDiffing: true })` }, _meta: engineMeta() } });
    });
    (async () => {
      let reads = 0, landed = false, other = false;
      // At most one read per interval within the cap, so a clock that stands still can't loop.
      const most = Math.max(1, Math.floor(tabLandingMs / Math.max(1, tabLandingIntervalMs)));
      while (live() && reads < most && clock() - started < tabLandingMs) {
        await new Promise(resolve => setTimeout(resolve, tabLandingIntervalMs));
        if (!live()) break;
        const reply = await read(Math.max(300, tabLandingMs - (clock() - started)));
        reads++;
        if (!live() || !reply?.result || reply.error || reply.result.isError) break;
        const fresh = (reply.result.content ?? []).filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
        const now = lastHeader(fresh);
        if (!shown || !now || ['title', 'app', 'url'].some(key => now[key] !== shown[key])) { other = true; break; }
        const content = replaceLastTree(msg.result.content, fresh);
        if (!content) break;
        msg.result.content = content;
        if (!landingRefusal(fresh)) { landed = true; break; }
      }
      trace('tab-landing', { id: msg.id, reads, landed, other, waitedMs: Math.round(clock() - started) });
    })().catch(() => {}).finally(() => observeServerMessage(msg));
    return true;
  }
  function handleClient(msg) {
    if (pauseBlocked(msg)) { pauseReply(msg); return; }
    if (msg.result?.action === 'accept' && (pause.paused || pausedCalls.size)) {
      for (const id of pausedCalls) nativePauseCuts.add(id);
      msg = { ...msg, result: { action: 'decline' } };
    }
    if (nativeHandoff && msg.method === 'notifications/cancelled' && msg.params?.requestId === nativeHandoff.id) {
      nativeHandoff.cancel?.(); return;
    }
    if (nativeHandoff && msg.method === 'tools/call' && msg.params?.name === TURN_END_TOOL) {
      const state = nativeHandoff;
      state.cancel?.();
      Promise.resolve(state.done).then(() => handleClient(msg)); return;
    }
    if (nativeHandoff && msg.method === 'tools/call' && msg.params?.name !== TURN_END_TOOL && (msg.id === undefined || msg.id !== nativeHandoff.readId)) {
      leaseStop(msg, promptNotice('handoff pending; the user must finish in the app.', prompt)); return;
    }
    // js can retain a tab handle; local app tools can target its browser window
    // directly. Fence both routes, including presence reads before dispatch.
    if (msg.method === 'tools/call' && ['js', 'drag', 'hover', 'menu_bar', 'notifications', 'open_file', 'select_window'].includes(msg.params?.name) &&
        (handoffPresencePending || directBrowser?.handoffPending?.())) {
      if (msg.id !== undefined) toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true,
        content: [{ type: 'text', text: handoffMessages.pending }] } });
      return;
    }
    if (msg.method === 'tools/call' && msg.params?.name === NATIVE_HANDOFF_TOOL.name) {
      const pending = handoffNativeApp(msg);
      if (nativeHandoff?.id === msg.id) nativeHandoff.done = pending;
      return;
    }
    if (msg.method === undefined && grokElicitations.delete(msg.id) && msg.result?.action === 'accept') {
      msg.result = { ...msg.result, _meta: { ...msg.result._meta, persist: 'session' } };
    }
    if (directNames.has(msg.params?.name) && msg.method === 'tools/call') {
      if (msg.id === undefined) return;
      if (!directBrowser) {
        const tell = !turboNoticeShown; turboNoticeShown = true;
        toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true,
          content: [{ type: 'text', text: `${tell ? 'Tell the user: ' : ''}Turbo is off (${turboUnavailable}). Use the engine browser path.` }] } });
        return;
      }
      if (closing || disposed) { leaseStop(msg, 'this session is closing.'); return; }
      if (handoffPresencePending) {
        toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: handoffMessages.pending }] } }); return;
      }
      // In Codex, only a call from the thread and turn the prompt hook bound reaches the worker.
      const owner = codexTurbo() ? codexCallTurn(msg.params._meta) : undefined;
      if (codexTurbo() && (!owner || !codexBinding || owner.thread !== codexBinding.thread || owner.turn !== codexBinding.turn)) {
        const unbound = turboFailure(); // the worker's own words for an unbound turn
        toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: unbound.isError, content: [{ type: 'text', text: unbound.text }] } });
        return;
      }
      // Turbo acts in its browser app, so blocking that app stops turbo too.
      const browserBlock = permissions?.app({ name: directBrowser.application, bundleId: browserBundleId(directBrowser.application) });
      if (browserBlock) { blockStop(msg, browserBlock); return; }
      running.add(msg.id);
      callDetails.set(msg.id, msg.params.name);
      recordAction('sent', msg.id);
      pauseHost?.activity();
      const directCall = { name: msg.params.name, arguments: msg.params.arguments, ...callNarration.has(msg.id) ? { say: callNarration.get(msg.id) } : {} };
      const waitingHandoff = msg.params.name === 'browser_tabs' && msg.params.arguments?.do === 'handoff' && msg.params.arguments.wait === true;
      const generation = stopGeneration, handoffTurn = turnId;
      const presenceCheck = waitingHandoff ? {} : undefined;
      if (presenceCheck) handoffPresencePending = presenceCheck;
      const called = waitingHandoff ? remotePresent().then(present => {
        if (closing || disposed || generation !== stopGeneration || handoffTurn !== turnId) throw Error('SESSION_ENDED');
        return directBrowser.call(directCall, { handoffPresent: present });
      }) : directBrowser.call(directCall);
      called.then(result => {
        const handoffPending = directBrowser.handoffPending?.() === true;
        cursorStatus(handoffPending ? 'handback' : result.isError ? 'error' : 'done', { say: callNarration.get(msg.id) });
        if (!result.isError && !handoffPending) cursorStatus('thinking', { say: callNarration.get(msg.id) });
        finishedCall(msg.id);
        const rendered = result.text;
        const content = [{ type: 'text', text: rendered }, ...(result.images ?? [])];
        tagRunScreenshots(result.images, { source: 'turbo' });
        const rules = rulesFor(true);
        if (rules) content.push(ruleItem(rules));
        toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: result.isError,
          content } }, delivered => {
          // Baselines and submit fences advance only after the exact projection
          // reached this client stream, never on a private preparation read.
          if (!delivered.result?.isError && delivered.result?.content?.some(item => item.type === 'text' &&
              item.text === rendered)) directBrowser.delivered(result);
        });
      }).catch(() => {
        cursorStatus('error');
        finishedCall(msg.id);
        toClient({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Direct browser route unavailable.' } });
      }).finally(() => { if (presenceCheck && handoffPresencePending === presenceCheck) handoffPresencePending = undefined; });
      return;
    }
    if (replWarmup.hold(msg)) return;
    if (msg.method === 'tools/call' && msg.id !== undefined && !callGenerations.has(msg.id)) callGenerations.set(msg.id, stopGeneration);
    if (msg.method === 'initialize') {
      try { cursor?.host(/codex/i.test(msg.params?.clientInfo?.name ?? '') ? 'codex' : /claude/i.test(msg.params?.clientInfo?.name ?? '') ? 'claude-code' : 'other'); } catch {}
      onInitialize(msg.params?.clientInfo);
      clientHost = hostLabel(msg.params?.clientInfo);
      grokClient = isGrokClient(msg.params?.clientInfo);
      if (grokClient) resultBudget = createResultBudget({ limit: 16000 });
      if (typeof msg.params?.clientInfo?.name === 'string') clientName = msg.params.clientInfo.name.slice(0, 64);
      const capabilities = msg.params?.capabilities ?? {};
      const elicitation = capabilities.elicitation;
      // MCP 2025-06-18 used {}; later versions distinguish form and URL prompts.
      clientCanElicit = !!elicitation && typeof elicitation === 'object' &&
        !Array.isArray(elicitation) && (Object.keys(elicitation).length === 0 ||
          (elicitation.form !== null && typeof elicitation.form === 'object' && !Array.isArray(elicitation.form)));
      if (!ask && !clientCanElicit) ask = fallbackAsk;
      if (ask || !clientCanElicit) {
        // The relay, rather than the client, can answer the engine's form requests.
        msg = { ...msg, params: { ...msg.params, capabilities: {
          ...capabilities, elicitation: { ...elicitation, form: {} },
        } } };
      }
      initialization = structuredClone(msg);
      startup?.initialize(msg);
    }
    if (msg.method === 'server/discover' && msg.id !== undefined) {
      toClient({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    if (msg.method === undefined && typeof msg.id === 'string' && msg.id.startsWith('sleight-elicit-')) {
      elicitations.get(msg.id)?.(msg);
      return;
    }
    if (msg.method === 'tools/call' && msg.params?.name === TURN_END_TOOL && msg.params.arguments?.sleight_resume === true) {
      resumeRequested = true; resumeAfterStop();
      toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [] } }); return;
    }
    // Codex's Stop hook ends every turn, including the ones sleight sat out. With nothing to end, answer here, so an
    // unused turn neither reaches the engine nor writes a receipt. The mod calls only after a used turn.
    // Codex's Stop and Interrupt hooks end the turbo turn first, used or not: the revoke takes effect at once.
    if (msg.method === 'tools/call' && msg.params?.name === TURN_END_TOOL && msg.id !== undefined && codexTurbo() && codexBinding &&
        Object.keys(msg.params.arguments ?? {}).every(key => HOOK_ARGS.includes(key))) {
      codexBinding = undefined; codexEpoch++;
      void directBrowser?.end();
    }
    if (msg.method === 'tools/call' && msg.params?.name === TURN_END_TOOL && msg.id !== undefined && !modHost() &&
        Object.keys(msg.params.arguments ?? {}).every(key => HOOK_ARGS.includes(key))) {
      if (!turnUsed && !failedTurnEnds.size && !running.size && !tabsMayNeedCleanup && !tabCleanupPending) {
        // A call refused after taking the input lease leaves the turn unused; let go of the lease all the same.
        releaseLeases();
        toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [] } }); return;
      }
      // Codex fires Interrupt while the interrupted call may still run, and gives the hook 3 seconds. Answer now and end
      // the turn once the call finishes, instead of refusing it and leaving the turn to the 30-second idle end.
      // Only with an input lease, whose drain wait keeps the turn open until the call has finished.
      if (running.size && inputLease && msg.params.arguments?.hook_event_name === 'Interrupt') {
        toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [] } });
        endOpenTurn(true, undefined, 'Interrupt').catch(error => trace('interrupt-end-error', { error: error?.message })); return;
      }
    }
    if (msg.method === 'tools/call' && msg.params?.name === TURN_END_TOOL && msg.params.arguments?.sleight_stop === true && stopEngine) {
      if (closing) { leaseStop(msg, 'stop is already pending or the session is closing.'); return; }
      void interruptTurn(msg); return;
    }
    if (closing && msg.method === 'tools/call') { leaseStop(msg, 'this session is closing.'); return; }
    if (backendRestartUnconfirmed && msg.method === 'tools/call') {
      leaseStop(msg, 'Engine collection is unconfirmed. Run /sleight stop before retrying.'); return;
    }
    if (!restarting && !stopCollected && engineChanged && stopEngine && restartEngine &&
        msg.method === 'tools/call' && ['js', 'js_reset'].includes(msg.params?.name) && !updateRetries.has(msg.id) && engineChanged() === true) {
      if (running.size || localRunning.size || internalRequests.size || approvalRequests.size || listRequests.size) {
        leaseStop(msg, 'another call in this session is pending. Retry after it finishes.'); return;
      }
      updateRetries.add(msg.id);
      reconnectEngine(msg.id);
    }
    if (!restarting && !stopCollected && backendChanged && stopEngine && restartEngine &&
        msg.method === 'tools/call' && ['js', 'js_reset'].includes(msg.params?.name) && backendChanged() === true) {
      if (running.size || localRunning.size || internalRequests.size || approvalRequests.size) {
        leaseStop(msg, 'another call in this session is pending. Retry after it finishes.'); return;
      }
      const generation = stopGeneration, attempt = { generation };
      restarting = attempt;
      beginStop();
      attempt.promise = (async () => {
        const receipt = await stopEngine();
        if (generation !== stopGeneration || closing || disposed) throw new Error(/* notice */ 'Engine restart was stopped.');
        stopCollected = receipt?.collected === true;
        if (!stopCollected) { stopUnconfirmed = true; throw new Error('Engine collection is unconfirmed. Run /sleight stop before retrying.'); }
        invalidateDiagnostics(); forgetHandles(); browserRecovery.reset();
        await restartCollectedEngine(true);
      })().catch(error => { backendRestartUnconfirmed = !stopCollected; throw error; })
        .finally(() => { if (restarting === attempt) restarting = undefined; });
    }
    if (restarting && restarting.generation !== stopGeneration && !stopCollected && msg.method === 'tools/call') {
      leaseStop(msg, promptNotice('engine initialization was stopped and collection is unconfirmed. Run /sleight stop again before retrying.', prompt)); return;
    }
    if ((stopCollected || restarting) && msg.method === 'tools/call' && restartEngine) {
      const generation = stopGeneration;
      if (!restarting || restarting.generation !== generation) {
        const attempt = { generation };
        restarting = attempt;
        attempt.promise = restartCollectedEngine(false, updatePending).finally(() => { if (restarting === attempt) restarting = undefined; });
      }
      restarting.promise.then(() => {
        if (generation !== stopGeneration || closing || disposed) { leaseStop(msg, 'this call was stopped.'); return; }
        handleClient(msg);
      }, error => { if (generation === stopGeneration) leaseStop(msg, error.message); });
      return;
    }
    if (msg.method === 'tools/call' && (serverIn.writableEnded || serverIn.destroyed)) {
      leaseStop(msg, promptNotice('the engine connection ended during stop. Reconnect sleight for a fresh engine and app read.', prompt)); return;
    }
    if (msg.method === 'tools/call') {
      if (disposed) { changeStop(msg, 'session has ended'); return; }
      if (flowAsking) { flowStop(msg, 'wait for the user decision'); return; }
      if (flowRules && msg.params?.name === FLOW_TOOL.name) { flowException(msg); return; }
      if (flowRules && !['js', 'drag', 'menu_bar'].includes(msg.params?.name)) { flowPermit = undefined; flowPending = undefined; }
      if (changeReview && msg.params?.name === REVIEW_TOOL.name) { reviewChanges(msg); return; }
      if (reviewing) { changeStop(msg, 'the user is reviewing changes, wait for their decision'); return; }
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'js' && typeof msg.params.arguments?.code === 'string') {
      msg.params.arguments.code = autoPrintCode(msg.params.arguments.code, process.env.SLEIGHT_AUTOPRINT === '1');
    }
    let retryClient = structuredClone(msg);
    let originalCode = msg.params?.arguments?.code;
    if (typeof originalCode === 'string') {
      for (const native of nativeBindings(originalCode, nativeHandles)) {
        browserHandles.delete(native); nativeHandles.add(native);
      }
    }
    const browser = msg.method === 'tools/call' && msg.params?.name === 'js' && browserPlan(originalCode ?? '');
    if (msg.method === 'tools/call' && msg.params?.name === 'js_reset') {
      // A reset can repair orphaned bookkeeping, but cannot release a call still on the pipe or in native admission.
      if (inputLease && (engineCalls.size || localRunning.size || [...pendingClients.keys()].some(id => id !== msg.id))) {
        leaseStop(msg, 'another call in this session is pending.'); return;
      }
      clearStaleCalls(msg.id);
    }
    if (msg.method === 'tools/call' && ['js', 'js_reset'].includes(msg.params?.name) && browserCalls.size) {
      leaseStop(msg, 'a browser candidate is pending; wait for its guarded result.'); return;
    }
    if (browser && (msg.id === undefined || running.size)) {
      leaseStop(msg, 'browser candidates need a request id and no pending call.'); return;
    }
    const healthPlan = msg.method === 'tools/call' && msg.params?.name === 'js' && !browser ? helperPlan(originalCode) : undefined;
    if (healthPlan?.acquisition && healthPlan.handle) nativeHandles.add(healthPlan.handle);
    if (!healthPlan?.read && healthPlan?.keys?.some(key =>
      [...helperProbes.values()].some(probe => probe.control?.key === key) || [...lateDiagnosticControls.values()].some(control => control.key === key && control.generation === diagnosisGeneration))) {
      toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: promptNotice('A diagnostic read of this app is still pending. Wait for it to finish, then send a standalone full app read before acting.', prompt) }] } });
      return;
    }
    const blockedApp = (healthPlan?.read ? [healthPlan.key] : healthPlan?.keys ?? []).find(key => {
      const state = helperStates.get(key);
      return state?.stuck && (!healthPlan.read || state.pending !== undefined || Date.now() < state.retryAt);
    });
    if (blockedApp) {
      toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: helperAdvice(blockedApp) }] } });
      return;
    }
    const needsFullRead = !healthPlan?.read && healthPlan?.keys?.find(key => helperFullReads.has(key));
    if (needsFullRead) {
      toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: promptNotice(`Computer use recovered for ${needsFullRead}. Send a standalone app read before acting. sleight will make it a full read because automatic recovery consumed the engine's UI diff.`, prompt) }] } });
      return;
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'js_reset') {
      browserRecovery.reset();
      forgetGuard(); compactor.reset();
      for (const action of resultCalls.values()) { action.before = undefined; action.overlap = true; }
      invalidateDiagnostics(); helperHandles.clear(); helperControls.clear(); helperActive = undefined; docsShown = false;
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'js' && msg.id !== undefined) jsCalls.set(msg.id, originalCode ?? '');
    let flowPlan, clipboardAction;
    if (clipboard && msg.method === 'tools/call' && ['js', 'js_reset'].includes(msg.params?.name) && clipboard.pending) {
      clipboardStop(msg, /* notice */ 'Clipboard: wait for the pending clipboard action, then retry.'); return;
    }
    if (clipboard && msg.method === 'tools/call' && msg.params?.name === 'js' && typeof originalCode === 'string') {
      try { clipboardAction = clipboardPlan(originalCode); }
      catch (error) { clipboardStop(msg, error.message); return; }
    }
    // A failed action without await, with more code after it, can end the engine's session and
    // every handle (3/3, 2026-10-07), so it never reaches the engine.
    const unawaited = msg.method === 'tools/call' && msg.params?.name === 'js' && msg.id !== undefined &&
      typeof originalCode === 'string' && unawaitedCall(originalCode);
    if (unawaited) {
      toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text:
        promptNotice(`sleight stopped this call before it ran: \u0060${unawaited.method}…)\u0060 has no await and more code follows it. A failed action without await can end the engine's session and lose every handle. Add await at line ${unawaited.line} and send it again.`, prompt) }] } });
      return;
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'js' && msg.id !== undefined &&
        typeof originalCode === 'string' && usesRequire(originalCode)) {
      if (requireOnly(originalCode)) {
        jsCalls.delete(msg.id);
        toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: requireNote(true, saveReceipted, prompt) }] } });
        return;
      }
      requireNotes.set(msg.id, requireNote(false, saveReceipted, prompt));
    }
    if (openedFlowPlans.has(msg.id) || openedWindowCalls.has(msg.id)) flowPlan = openedFlowPlans.get(msg.id);
    else if (!openedWindowReads.has(msg.id) && flowRules && msg.method === 'tools/call' && ['js', 'drag', 'menu_bar'].includes(msg.params?.name)) {
      if (running.size || localRunning.size || documentAsking || reviewing) { flowStop(msg, 'wait for the pending call or prompt'); return; }
      if (msg.id === undefined || (msg.params.name === 'js' && typeof originalCode !== 'string')) { flowStop(msg, 'a request id and JavaScript code are required'); return; }
      flowPlan = flowRules.analyze(msg.params.name, msg.params.arguments, lastWindow);
      const print = fingerprint(msg);
      const permitted = flowPermit?.fingerprint === print && flowPermit.revision === flowRules.revision ||
        engineOpenAllowed.has(msg.id) && engineOpenAllowed.get(msg.id) === print;
      if (permitted && engineOpenPrints.has(msg.id)) engineOpenAllowed.set(msg.id, print);
      // browser_open's own acquisition is part of the call a permit names, so it leaves the permit for the keys.
      if (!engineOpenAcquisitions.has(msg.id)) flowPermit = undefined;
      if (flowPlan.violations.length && !permitted) {
        const reason = flowPlan.violations.map(v => `rule '${v.rule}' stopped a transfer${v.source ? ` from ${v.source}` : ''} to ${v.app}`).join('; ');
        flowPending = { fingerprint: print, name: msg.params.name, args: structuredClone(msg.params.arguments ?? {}), reason, rules: flowPlan.violations.map(v => v.rule) };
        trace('flow-refused', { id: msg.id, violations: flowPlan.violations });
        flowStop(msg, reason); return;
      }
      flowPending = undefined;
    }
    if (openedWindowCall(msg, flowPlan)) return;
    if (windowIdentity && inputLease && !running.size && !documentMode && !changeReview && leaseWindow?.appId &&
        msg.method === 'tools/call' && msg.params?.name === 'js' && !browserPlan(msg.params.arguments?.code ?? '') &&
        !menuContinued.has(msg.id) && !menuAdmissions.has(msg.id) && !splitCalls.has(msg.id)) {
      // A renamed handle counts only when it is open_file's or bound to the leased app.
      const plan = splitMenuActions(msg.params.arguments?.code, { alias: name => handleBundles.has(name)
        ? handleBundles.get(name)?.appId === leaseWindow.appId : /^__sleightOpenedApp\d+$/.test(name) });
      if (plan && plan.actions.some((action, i) => action.selector && i < plan.actions.length - 1)) {
        if (flowPlan) openedFlowPlans.set(msg.id, flowPlan);
        const target = leaseWindow, generation = stopGeneration;
        // The window's lines as Claude last saw them, for the tab continuation to count its tabs against.
        const admission = { plan, target, generation, before: compactor.seenLines(target, undefined, true) };
        menuAdmissions.set(msg.id, admission);
        running.add(msg.id); callDetails.set(msg.id, 'menu window admission');
        // The baseline is sampled before the call is sent, so HID idle has to cover the call from this moment.
        admission.sampledAt = clock();
        admission.nativeTab = ck3 && tabContinuation && tabFirst && guardMode !== 'careful' && nativeTabPlan(plan);
        admission.identity = Promise.resolve().then(() => windowIdentity(admission.nativeTab ? { ...target, tabCertificate: true } : target));
        menuIdentity(() => admission.identity, target, menuContinuationTimeoutMs).then(baseline => {
          if (generation !== stopGeneration || leaseWindow !== target || closing || disposed || stopCollected) {
            menuAdmissions.delete(msg.id); finishedCall(msg.id);
            const error = new Error(/* notice */ 'Input lease: window changed while checking. Read again.');
            if (!disposed && !stopCollected) leaseStop(msg, error.message);
            return;
          }
          admission.baseline = baseline; noteProcess(baseline);
          running.delete(msg.id); handleClient(msg);
        });
        return;
      }
    }
    if (windowIdentity && inputLease && msg.method === 'tools/call' && msg.params?.name === 'js' &&
        !isLeaseRead(msg.params.arguments?.code) && !browserPlan(msg.params.arguments?.code ?? '') &&
        leaseWindow && (leaseWindow.identityRequired || treeFreeFirstAction(msg.params.arguments?.code) || selectedCancel(msg.params.arguments?.code)) && !nativeChecked.has(msg.id)) {
      if (running.size) { leaseStop(msg, 'another call in this session is pending.'); return; }
      if (leaseWindow.identityError) { leaseStop(msg, leaseWindow.identityError); return; }
      if (leaseWindow.identityRequired && !leaseWindow.nativeIdentity) { leaseStop(msg, 'native window identity has no successful baseline. Read the app again.'); return; }
      if (flowPlan) openedFlowPlans.set(msg.id, flowPlan);
      const target = leaseWindow;
      // A menu header can omit the document URL; Cancel still checks the selected native window.
      const expected = target.selectedParent ? { ...target.selectedParent, nativeIdentity: target.nativeIdentity, identityRequired: true }
        : selectedCancel(msg.params.arguments?.code) && selectedWindow.windowNumber !== undefined
          ? { ...target, windowNumber: selectedWindow.windowNumber } : target;
      const generation = stopGeneration;
      running.add(msg.id);
      callDetails.set(msg.id, 'native window admission');
      const started = performance.now();
      Promise.resolve().then(() => menuAdmissions.get(msg.id)?.identity ?? windowIdentity(expected)).then(observed => {
        // The parent lease's pin fails closed: an unavailable or ambiguous identity stops instead of dropping the pin. It
        // holds until the pinned call's reply, so it covers the calls split from it (a text write's head) too.
        const identity = target.parentPin || target.selectedParent ? verifyWindowIdentity(expected, observed) : nativeIdentity(expected, observed);
        noteProcess(identity);
        if (generation !== stopGeneration || leaseWindow !== target || closing || disposed) throw new Error(/* notice */ 'Input lease: window changed while checking. Read again.');
        if (!identity) { expected.identityRequired = false; delete expected.nativeIdentity; }
        else focusedChecked.add(msg.id);
        trace('native-window-admission', { id: msg.id, ms: performance.now() - started, confirmed: !!identity });
        running.delete(msg.id); nativeChecked.set(msg.id, identity); handleClient(msg);
      }).catch(error => { if (stopCollected || generation !== stopGeneration) return;
        // An optional focus probe that is unavailable leaves the full first read in place.
        // Existing identity requirements and confirmed mismatches still stop admission.
        if (!expected.identityRequired && !/^Input lease:/.test(error.message)) {
          running.delete(msg.id); nativeChecked.set(msg.id, undefined); handleClient(msg); return;
        }
        finishedCall(msg.id); leaseStop(msg, error.message);
      });
      return;
    }
    if (inputLease && msg.method === 'tools/call' && msg.params?.name === 'js' && typeof msg.params.arguments?.code === 'string' && !browserPlan(msg.params.arguments.code)) {
      if (numberedHandles(msg.params.arguments.code).length > 1) {
        leaseStop(msg, promptNotice('send numbered actions on one handle per call. Read that window before acting.', prompt)); return;
      }
      const ids = compactor.numberIds(numberWindow(msg.params.arguments.code, leaseWindow), msg.params.arguments.code);
      if (ids) {
        msg = { ...msg, params: { ...msg.params, arguments: { ...msg.params.arguments, code: ids.code } } };
        for (const sent of ids.sent) {
          const line = sent.line.length > 60 ? sent.line.slice(0, 57) + '...' : sent.line;
          remapNotes.set(msg.id, (remapNotes.has(msg.id) ? remapNotes.get(msg.id) + '\n' : '') + `sleight: { id: "${sent.id}" } was sent as element ${sent.number}, ${line}.`);
        }
        trace('id-numbers', { id: msg.id, numbers: ids.sent.map(s => s.number) });
      }
      const stale = compactor.remapStale(numberWindow(msg.params.arguments.code, leaseWindow), msg.params.arguments.code);
      if (stale) {
        msg = { ...msg, params: { ...msg.params, arguments: { ...msg.params.arguments, code: stale.code } } };
        remapNotes.set(msg.id, (remapNotes.has(msg.id) ? remapNotes.get(msg.id) + '\n' : '') + 'sleight: numbers in this window changed since you saw them, so ' +
          stale.remapped.map(r => `${r.number} was found by its line ${JSON.stringify(r.line)}`).join(', ') + promptNotice('. Use the numbers in this result from now on.', prompt));
        trace('stale-remapped', { id: msg.id, numbers: stale.remapped.map(r => r.number) });
      }
    }
    originalCode = msg.params?.arguments?.code;
    retryClient = structuredClone(msg);
    if (msg.method === 'tools/call' && msg.params?.name === 'js' && msg.id !== undefined) jsCalls.set(msg.id, originalCode ?? '');
    if (documentMode && msg.method === 'tools/call' && !browser) {
      const name = msg.params?.name;
      if (name === DOCUMENT_TOOL.name) { approveDocument(msg); return; }
      if (name === 'select_window') {
        if (running.size || documentAsking) { documentStop(msg, 'another call or approval is pending'); return; }
        if (!prepareLease(msg)) return;
      } else if (name !== 'js' && name !== TURN_END_TOOL) {
        documentStop(msg, `${name} is unavailable in document mode`);
        return;
      }
      if (name === 'js') {
        if (running.size || documentAsking) { documentStop(msg, 'another call or approval is pending'); return; }
        const code = msg.params.arguments?.code;
        if (typeof code !== 'string' || msg.id === undefined) { documentStop(msg, 'js needs code and a request id'); return; }
        const read = isDocumentRead(code);
        if (!read && !documentAllowed()) { documentStop(msg, 'this window is not approved'); return; }
        if (!prepareLease(msg)) return;
        documentCalls.set(msg.id, { read, expected: read ? undefined : documentKey(observedDocument),
          observe: !isLeaseRead(code) || !/getScreenshot|rewriteDocumentation/.test(code), engines: new Set(), risks: new Set() });
      } else if (name !== 'select_window' && !prepareLease(msg)) return;
    } else if (!prepareLease(msg, browser)) return;
    refreshHeartbeat();
    if (msg.method === 'tools/call' && localNames.has(msg.params?.name)) {
      // The local pointer tools check what covers the window and move the real pointer: no hand on screen.
      if (msg.params.name === 'drag' || msg.params.name === 'hover') hand?.hide();
      try {
        const name = msg.params.name, op = msg.params.arguments?.op;
        const kind = ({ drag: 'drag', hover: 'move', open_file: 'navigate', select_window: 'select' })[name] ??
          (name === 'menu_bar' && op !== 'apps' ? 'select' : name === 'notifications' && op === 'press' ? 'click' : undefined);
        if (kind && cursor?.enabled) {
          const record = { ...cursorRecord({ action: { kind } }), call: cursor.call(), index: 0, source: 'local', say: callNarration.get(msg.id) };
          localCursor.set(msg.id, record); cursor.action({ ...record, phase: 'act' });
        }
      } catch {}
      trace('from-client', msg);
      if (flowPlan) flowRules.forward(flowPlan);
      turnUsed = true;
      clearTimeout(idleTimer);
      running.add(msg.id);
      callDetails.set(msg.id, msg.params.name);
      callLocal(msg, flowPlan);
      return;
    }
    if (msg.method === 'tools/list' && msg.id !== undefined) listRequests.add(msg.id);
    if (msg.method === undefined && approvalRequests.has(msg.id)) {
      const { key, generation } = approvalRequests.get(msg.id);
      approvalRequests.delete(msg.id);
      if (generation !== stopGeneration || closing || disposed) {
        alwaysOffered.delete(msg.id); toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } }); return;
      }
      const always = alwaysOffered.get(msg.id);
      alwaysOffered.delete(msg.id);
      // The engine didn't ask for this field: answer it here and pass the engine an empty form.
      if (msg.result?.content && 'remember' in msg.result.content) {
        if (!grokClient && always && msg.result.action === 'accept' && msg.result.content.remember === 'Always' && !reviewerAnswer(msg.result)) rememberAlways(always);
        const { remember: _remember, ...content } = msg.result.content;
        msg.result = { ...msg.result, content };
      }
      if (msg.result?.action === 'accept') {
        approved.add(key);
        if (grokClient || msg.result._meta?.persist === undefined) {
          msg.result._meta = { ...msg.result._meta, persist: 'session' };
        }
      }
    }
    if (msg.method === 'tools/call' && msg.params) {
      const { name } = msg.params;
      if (clipboard && name === 'js_reset') clipboardResets.add(msg.id);
      if (name === TURN_END_TOOL) {
        const wantStats = modHost() && statsId(msg.params.arguments?.sleight_stats);
        collectDirectEnd(msg.id);
        // The mod's Stop or Interrupt: the user's turn is over, and so is the payment gate's copy of their message.
        if (msg.params.arguments?.hook_event_name) paymentMessages.end();
        const generation = stopGeneration;
        const end = note => {
          if (generation !== stopGeneration || disposed) return;
          // Buffer even an immediate engine reply until the private metadata is ready. Send cleanup
          // first so parsing and synchronous file I/O cannot delay the engine receiving it.
          const ending = { pending: true, replies: [] };
          if (journal) receiptEnds.set(msg.id, ending);
          msg.params.arguments = endTurnArgs(msg.params.arguments);
          if (msg.id !== undefined) trackTurnEnd(msg.id, msg.params.arguments);
          if (note && msg.id !== undefined) tabCleanupNotes.set(msg.id, note);
          if (keyboardTaps && msg.id !== undefined && drivenApps.size) turnEnds.add(msg.id);
          if (outcomes && msg.id !== undefined) {
            const pending = [...outcomeCalls.values()].filter(call => call.turn === turnOutcomes && !call.recorded).length;
            const summary = turnOutcomes.text(pending);
            if (summary) outcomeEnds.set(msg.id, summary);
          }
          if (msg.id !== undefined && wantStats) try {
            if (statsEnds.size >= 200) statsEnds.delete(statsEnds.keys().next().value);
            statsEnds.set(msg.id, finishStats(wantStats));
          } catch {}
          toServer(msg);
          const receipt = finishReceipt();
          if (journal) receiptEnds.set(msg.id, receipt);
          for (const reply of ending.replies) toClient(reply);
          rotateTurn();
        };
        if (tabsMayNeedCleanup || tabCleanupPending) cleanupBrowserTabs().then(end);
        else end();
        return;
      }
      if (name === 'js') {
        const copies = !clipboard && typeof originalCode === 'string' ? clipboardActions(originalCode) : [];
        if (copies.includes('c') || copies.includes('x')) nativeCopies.set(msg.id, copies.includes('x'));
        const read = typeof originalCode === 'string' && isLeaseRead(originalCode);
        const key = lastWindow && (helperAliases.get(lastWindow.app.toLowerCase()) ?? lastWindow.app.toLowerCase());
        const swipeCode = !browser && !read ? chromeScrollCode(originalCode, lastWindowText,
          screenshots.get(lastWindow?.app.toLowerCase())?.byTitle[lastWindow?.title],
          new Set([...helperHandles].filter(([, plan]) => plan.key === key).map(([handle]) => handle))) : originalCode;
        const safe = read || (typeof originalCode === 'string' && isChangeCancel(originalCode, lastWindowText));
        let entry, nativeDenied = leaseCalls.get(msg.id)?.nativeDenied;
        try {
          if (changeReview && !safe && lastWindow && changeCalls.size) throw new Error(/* notice */ 'another engine call is pending, wait for its result');
          if (changeReview && !safe && lastWindow?.url?.startsWith('file://')) {
            entry = changes.before(lastWindow);
            trace('snapshot-before-call', { id: msg.id, path: entry.path, directory: changes.directory, snapshot: entry.snapshot });
          }
        } catch (err) {
          if (browser) {
            nativeDenied = /* notice */ promptNotice(`Native access stopped: send a standalone native app read before acting. Cannot snapshot before acting: ${err.message}`, prompt);
          } else { documentCalls.delete(msg.id); finishedCall(msg.id); changeStop(msg, `cannot snapshot before acting: ${err.message}`); return; }
        }
        if (healthPlan?.read && msg.id !== undefined) {
          helperReads.set(msg.id, healthPlan);
          let state = helperStates.get(healthPlan.key);
          if (!state) { state = { key: healthPlan.key, timeouts: 0, probe: healthPlan.probe }; helperStates.set(healthPlan.key, state); }
          if (state.stuck) { state.pending = msg.id; state.retryAt = Date.now() + 20000; clearTimeout(state.timer); }
          if (!helperProbes.has(msg.id)) {
            helperActive = healthPlan.key;
            if (healthPlan.handle) helperHandles.set(healthPlan.handle, healthPlan);
            // An app read also checks, alongside the engine, whether the app's windows are on the
            // current Space, so Claude hears it before a drag fails. An Open panel can be on the
            // current Space while the document it opens isn't (TextEdit, 2026-10-09), so every
            // read checks.
            if (spaceProbe && healthPlan.selector && !healthPlan.key.startsWith('window:')) {
              spaceChecks.set(msg.id, { key: healthPlan.key, health: Promise.resolve().then(() => spaceProbe(healthPlan.key)).catch(() => undefined) });
            }
          }
        }
        changeCalls.set(msg.id, { read, safe, entry, window: lastWindow, expected: documentKey(lastWindow), target: leaseWindow ?? lastWindow,
          observe: !browser && (!read || (!isInventoryRead(originalCode) && /cua\.getApp\(|\.(?:getAXState|getAXStateAndScreenshot)\(/.test(originalCode))) });
        if (typeof originalCode === 'string') {
          const setup = { reuseSetup: guardReady, acknowledge: true, prompt, ...outcomeSetup, ...(kernelEpoch ? { kernel: kernelEpoch } : {}) };
          const modes = guardMode?.split(',').map(mode => mode.trim()) ?? [], careful = modes.includes('careful');
          const target = documentMode ? observedDocument : inputLease ? leaseWindow : lastWindow;
          const reason = /* notice */ documentMode ? undefined : selectedWindow ? `Selected window changed. ${selectionRecovery()}` : inputLease
            ? promptNotice('Input lease stopped this action: window or URL changed. Read the intended window again before acting.', prompt)
            : promptNotice('Change review stopped this action: window or URL changed. Read the intended window with one standalone cua.getApp call before editing.', prompt);
          if (browser) {
            msg.params.arguments.code = guardedCode(selectedBrowserCode(browserRecovery.code(originalCode), browserChoice, `${sessionId}:${turnId}`), target, reason,
              inputLease && leaseCalls.get(msg.id)?.key ? inputLease.grant(leaseCalls.get(msg.id).key) : undefined,
              { ...setup, timing: guardTiming, careful, fileOnly: changeReview, browserCandidate: true,
                skipAppWrap: browserHandles.has('app') || browser.handles.includes('app'),
                nativeDenied: nativeDenied ?? promptNotice(NATIVE_DENIED, prompt) });
          } else if (read) {
            let code = originalCode;
            if (healthPlan && !helperProbes.has(msg.id) && helperFullReads.has(healthPlan.key)) {
              if (/\.(?:getAXState|getAXStateAndScreenshot)\(/.test(code)) {
                code = code.replace(/(\.(?:getAXState|getAXStateAndScreenshot)\()\s*(\{[^}]*\})?\s*\)/,
                  (_, prefix, options) => `${prefix}${options ? options.replace(/disableDiffing\s*:\s*(?:true|false)\s*,?/g, '').replace(/^\{\s*/, '{ disableDiffing: true, ') : '{ disableDiffing: true }'})`);
              } else if (healthPlan.handle) {
                code += `\nnodeRepl.write(await ${healthPlan.handle}.getAXState({ disableDiffing: true, emit: false }));`;
              }
              healthPlan.fullVisible = true;
            }
            msg.params.arguments.code = readCode(code, setup);
          }
          else if (documentMode || inputLease || (changeReview && target)) {
            const seenWindow = numberWindow(originalCode, target), numbers = literalNumbers(originalCode);
            const seenLines = compactor.seenLines(seenWindow, numbers), uniqueSeen = compactor.uniqueSeen(seenWindow, numbers);
            // The acquisition just before this call, if it read this same app less than 10 s ago.
            // Reuse is for the default mode, and only when reads are slow: a settled read before an action
            // takes about 50 ms, but 17 to 57 s on a loaded Mac (2026-10-09), and without it a window
            // that renumbered after Claude's read went unnoticed (textedit-save, the same day). Document
            // scope, change review and careful reads always read before acting.
            // A first action that sends keys, text or coordinates reuses it whatever the read took
            // (owner, 2026-10-10, for about 0.35 s a run): a window switch between calls isn't caught
            // before that action. Numbered, ID and label actions keep the read unless reads are slow.
            const prior = !documentMode && !changeReview && !careful && (!treeFreeFirstAction(originalCode) || focusedChecked.has(msg.id)) && priorRead && (priorRead.split || priorRead.ms > 2000 || treeFreeFirstAction(originalCode)) && priorRead.seq + 1 === callSeqs.get(msg.id) && Date.now() - priorRead.at < 10000 &&
              target?.app === priorRead.app && sameWindow(seenWindow, target) ? { text: priorRead.text, id: priorRead.id, title: priorRead.title, windows: priorRead.windows, split: priorRead.split } : undefined;
            const menuBaseline = menuBaselines.get(msg.id);
            const stopMark = guardStopMark();
            menuCalls.set(msg.id, { ...menuAdmissions.get(msg.id), mark: stopMark, seen: seenLines, uniqueSeen,
              request: { ...msg, params: { ...msg.params, arguments: { ...msg.params.arguments, code: originalCode } } } });
            const handBindingMark = hand ? filteredReadMark() : undefined;
            if (handBindingMark) handBindingMarks.set(msg.id, handBindingMark);
            const filterMark = filteredReadMark(), filteredCode = filteredReadCode(swipeCode, filterMark);
            const typingAction = compactor.beginAction(originalCode);
            const typedTarget = typingAction?.typedTarget;
            const receiptTyping = typingReceiptCall(originalCode) && !!typingReceiptTarget(typingAction);
            // The guard's action records come back under this call's mark, so window text can't forge one.
            const outcomeMark = outcomes || actionLog ? filterMark : undefined;
            if (filteredCode !== swipeCode || typedTarget || receiptTyping || outcomeMark) filterMarks.set(msg.id, filterMark);
            const light = lightReturn && inputLease && !careful && !documentMode && !changeReview && !menuBaseline &&
              target === leaseWindow && lightReturnCode(originalCode) ? lightReturn.begin(msg.id, leaseWindow) : undefined;
            // A unique file window may have no stored identity baseline. Its current
            // admission still supplies DP1's leased process and window for this call.
            const admitted = closeReadSkip && target === leaseWindow && nativeChecked.get(msg.id);
            const closeWindow = admitted ? { ...target, nativeIdentity: admitted } : target;
            const close = closeRead && closeWindow?.nativeIdentity &&
              /\.\s*pressKey\s*\(\s*(['"`])(?:super|cmd|command|meta)\+(?:shift\+w|w|q)\1\s*\)/i.test(originalCode)
              ? closeRead.begin(msg.id, closeWindow) : undefined;
            const tabForward = menuForwards.get(msg.id);
            const tabAdmission = menuAdmissions.get(msg.id);
            const probe = tabForward?.tab && !careful && !documentMode && !changeReview
              ? tabProbe?.begin(msg.id, { ...tabForward.expected, nativeIdentity: tabForward.baseline },
                Date.now() - Math.max(0, clock() - tabForward.stopAt))
              : tabAdmission?.nativeTab && tabAdmission.baseline?.chrome?.complete && !careful && !documentMode && !changeReview
                ? tabProbe?.begin(msg.id, { ...target, windowNumber: tabAdmission.baseline.windowNumber, nativeIdentity: tabAdmission.baseline },
                  Date.now() - Math.max(0, clock() - tabAdmission.sampledAt), 'new-tab') : undefined;
            if (probe?.mode === 'new-tab') tabLandings.set(msg.id, { landing: tabAdmission.plan.actions[0].handle });
            msg.params.arguments.code = guardedCode(filteredCode, menuBaseline ?? closeWindow, reason,
              inputLease ? inputLease.grant(leaseCalls.get(msg.id)?.key) : undefined,
              { ...setup, dp1: closeReadSkip, handBindingMark, guardStopMark: stopMark, resultMark: typedTarget ? filterMark : undefined, ...(outcomeMark ? { outcomeMark } : {}), timing: guardTiming, careful: careful || documentMode || !!menuBaseline, fileOnly: changeReview && !documentMode, cancelOnly: changeReview && !documentMode && safe,
                firstOff: !careful && !documentMode && !changeReview,
                focused: focusedChecked.has(msg.id),
                quietEdits: !careful && !documentMode && !changeReview,
                bind: !careful && !documentMode && !changeReview,
                adoptUrl: !documentMode && !changeReview && !menuBaseline, skipAppWrap: browserHandles.has('app'), prior,
                lastTree: lastTree && lastTree.seq + 1 === callSeqs.get(msg.id) && sameWindow(lastTree.window, target) ? lastTree.text : undefined,
                actions: guardActions(originalCode),
                ...(light ? { lightReturn: light } : {}),
                ...(probe ? { tabProbe: probe } : {}),
                ...(close ? { closeRead: { path: close.path } } : {}),
                // The lines Claude last saw for the numbers it acts on, so the first action stops when
                // the window renumbered between Claude's read and this call.
                seenLines, seenParents: compactor.seenParents(seenWindow, numbers), literals: numbers, literalOrder: literalElements(originalCode),
                uniqueSeen, payment: paymentMessages.guard(confirmPayments) });
            if (receiptTyping) msg.params.arguments.code += typingReceiptCode(filterMark);
          } else msg.params.arguments.code = swipeCode;
          if (msg.params.arguments.code !== originalCode) guardCalls.set(msg.id, guardGeneration);
          const restore = restoreEngineBindings(originalCode);
          if (restore) msg.params.arguments.code = readCode(restore, { prompt, ...outcomeSetup }) + '\n' + msg.params.arguments.code;
          if (clipboard) msg.params.arguments.code = clipboardCode(msg.params.arguments.code, clipboardAction);
          msg.params.arguments.code = fillFormCode(msg.params.arguments.code);
          msg.params.arguments.code = dragToCode(msg.params.arguments.code);
          msg.params.arguments.code = reorderCode(msg.params.arguments.code);
          msg.params.arguments.code = pickFromListCode(msg.params.arguments.code, completeness);
          if (browser) msg.params.arguments.code = browserStale.code(msg.params.arguments.code, originalCode, prompt);
          const tabCode = tabCleanupCode(browser ? backgroundLinksCode(msg.params.arguments.code) : msg.params.arguments.code);
          if (/\bcua\.createBrowserTab\s*\(|\.tabs\.new\s*\(/.test(originalCode)) tabsMayNeedCleanup = true;
          msg.params.arguments.code = tabReuseCode(tabCode, msg.id);
          if (browser) msg.params.arguments.code = browserAliasesCode(msg.params.arguments.code);
          if (browser || /\bagent\.browsers\.get\s*\(/.test(originalCode))
            msg.params.arguments.code = clickResults.code(msg.params.arguments.code);
        }
      }
      if (browser) browserCalls.set(msg.id, browser);
      if (name === 'js' && msg.id !== undefined) {
        // Only this relay-owned acquisition gets pixels. Classify and guard the original read
        // first, so the optional screenshot adds no action lease or approval (SH1, 2026-10-17).
        const shotHandle = openShots.get(msg.id);
        if (shotHandle) msg.params.arguments.code += `;\ntry { await ${shotHandle}.getScreenshot(); } catch {}`;
        resultBudget.request(msg.id, { browser: !!browser, code: originalCode });
        if (typeof msg.params.arguments?.code === 'string') msg.params.arguments.code = resultBudget.code(msg.params.arguments.code);
      }
      if (name === 'js' && typeof msg.params.arguments?.code === 'string') {
        msg.params.arguments.code = browserWarmupUseCode(msg.params.arguments.code,
          { browserChoice, scope: `${sessionId}:${turnId}`, token: browserWarmToken, confirmed: browserWarmConfirmed });
      }
      msg.params._meta = { ...msg.params._meta, [META_KEY]: turnMeta() };
      turnUsed = true;
      clearTimeout(idleTimer);
      if (running.size) for (const action of resultCalls.values()) action.overlap = true;
      if (name === 'js' && !browser && msg.id !== undefined) {
        const action = compactor.beginAction(originalCode);
        if (action) { action.overlap = running.size > 0; resultCalls.set(msg.id, action); }
      }
      if (msg.id !== undefined) running.add(msg.id);
      if (flowPlan) { flowRules.forward(flowPlan); flowCalls.set(msg.id, flowPlan); }
      // Admission has decided. The hand plans on a later tick, outside the guard path, from what Claude last saw.
      if (hand && name === 'js' && (!browser || cursor?.enabled) && msg.id !== undefined && typeof originalCode === 'string' && ACTION.test(originalCode)) {
        const target = documentMode ? observedDocument : inputLease ? leaseWindow : lastWindow, seen = numberWindow(originalCode, target);
        hand.admit(msg.id, { code: originalCode, target, say: callNarration.get(msg.id), ...(browser ? { unplanned: true } : {}), lines: () => compactor.seenLines(seen),
          screenshotSize: () => screenshots.get(target?.app?.toLowerCase())?.byTitle[target?.title] });
      }
    }
    if (jsCalls.has(msg.id)) {
      const origin = syntaxOrigin(msg.params?.arguments?.code, jsCalls.get(msg.id));
      if (origin) syntaxOrigins.set(msg.id, origin);
    }
    if (clipboardAction) {
      const generation = stopGeneration;
      let response;
      clipboard.run(clipboardAction, () => new Promise((resolve, reject) => {
        if (generation !== stopGeneration || closing || disposed) { reject(new Error(/* notice */ 'Clipboard guard: session closed before input.')); return; }
        clipboardReplies.set(msg.id, { reject, receive: reply => {
          response = reply;
          if (reply.error || reply.result?.isError) reject(new Error(/* notice */ promptNotice('Clipboard guard: engine action failed; Copy/Cut ownership cannot be attributed.', prompt)));
          else resolve(reply);
        } });
        toServer(msg);
      })).then(({ notices }) => { clipboardNotices(response, notices); observeServerMessage(response); }, error => {
        const result = response ?? { jsonrpc: '2.0', id: msg.id, result: { content: [] } };
        result.result = { ...(result.result ?? {}), isError: true, content: [...(result.result?.content ?? []), { type: 'text', text: error.message }] };
        clipboardNotices(result, error.clipboardNotices);
        observeServerMessage(result);
      });
    } else {
      if (msg.method === 'tools/call' && msg.id !== undefined && !restartRetries.has(msg.id)) restartRetries.set(msg.id,
        { sent: JSON.stringify(msg), client: retryClient, read: !!healthPlan?.read, browserRead: !!browser && isBrowserRead(originalCode) });
      if (frontRestore && healthPlan?.acquisition && !healthPlan.selector.startsWith('{') && msg.id !== undefined) {
        forwardAcquisition(msg, healthPlan.key);
      } else toServer(msg);
    }
  }

  // The helper quits after about 20 s idle, and a call that arrives while it relaunches fails
  // before reaching any app (2026-10-05). Send that call again once, a second later, instead of
  // spending Claude's turn on it. The helper also crashes now and then (a segfault in its
  // WindowServer callback, 4 times from 2026-10-05 to 2026-10-11) and launchd relaunches it within
  // seconds: a read that met the crash is sent again too, but never a call with actions, which may
  // have run. Values are the call as sent and whether it only reads; true means it was resent.
  // Several sessions starting a cold helper together can crash it (21 SIGSEGVs in concurrent
  // getApp calls, 2026-10-19), and every session's retry then lands at the same instant on the next
  // cold helper. A random extra delay spreads those retries out.
  const restartRetries = new Map();
  const debuggerDocs = new Map();
  const HELPER_RESTARTING = /Sky Computer Use native pipe startup failed/;
  const HELPER_START_FAILED = /Sky Computer Use (?:native pipe|service) startup (?:request )?failed/;
  let staleHelperDiagnosis;
  const HELPER_CRASHED = /Sky Computer Use native pipe closed before response/;
  const DEBUGGER_UNATTACHED = /^(?:Error: )?Debugger unattached\s*$/m;
  function retriedHelperStart(msg) {
    if (msg.method !== undefined || !restartRetries.has(msg.id)) return false;
    const entry = restartRetries.get(msg.id);
    const failedWith = pattern => msg.result?.isError && (msg.result.content ?? []).some(c => c.type === 'text' && pattern.test(c.text ?? ''));
    const crashed = entry !== true && entry.read && failedWith(HELPER_CRASHED);
    const unattached = entry !== true && entry.browserRead && failedWith(DEBUGGER_UNATTACHED);
    if (entry !== true && failedWith(HELPER_RESTARTING) && stopEngine && restartEngine && engineChanged?.() === true) {
      if (updateRetries.has(msg.id) || running.size > 1 || localRunning.size || internalRequests.size || approvalRequests.size || listRequests.size || closing || disposed) {
        restartRetries.delete(msg.id); return false;
      }
      updateRetries.add(msg.id); restartRetries.set(msg.id, true);
      const generation = stopGeneration;
      // This error confirms the failed request never reached an app. Keep its
      // original client code so the replacement gets complete setup and guards.
      finishedCall(msg.id);
      reconnectEngine(msg.id).then(() => {
        if (generation !== stopGeneration || closing || disposed) return;
        handleClient(structuredClone(entry.client));
      }, error => {
        if (generation !== stopGeneration || disposed) return;
        msg.result.content.push({ type: 'text', text: `sleight: engine reconnection failed: ${error.message}. Run sleight-mcp --doctor.` });
        finishedCall(msg.id); restartRetries.delete(msg.id);
        toClient(msg);
      });
      return true;
    }
    if (!(crashed || unattached || failedWith(HELPER_RESTARTING)) || entry === true || closing) { restartRetries.delete(msg.id); return false; }
    restartRetries.set(msg.id, true);
    const docs = engineDocs(msg.result.content, unattached);
    if (docs.length) debuggerDocs.set(msg.id, docs);
    trace(unattached ? 'browser-debugger-retry' : crashed ? 'helper-crash-retry' : 'helper-restart-retry', { id: msg.id });
    const generation = stopGeneration, epoch = engineEpoch;
    setTimeout(() => {
      if (generation === stopGeneration && epoch === engineEpoch && !closing && !disposed && restartRetries.has(msg.id)) toServer(JSON.parse(entry.sent));
    }, crashed ? 2000 + helperCrashJitterMs() : 1000).unref?.();
    return true;
  }

  let detachServer;
  function bindServer() {
    serverIn.on('error', inputError);
    const input = serverIn, detachLines = lines(serverOut, serverLine);
    detachServer = () => { detachLines(); input.off('error', inputError); };
  }
  bindServer();
  function serverLine(line) {
    if (stopCollected) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      clientOut.write(line + '\n');
      return;
    }
    if (msg.method === undefined) {
      engineCalls.delete(msg.id);
      const unbound = remoteUnboundNotices.get(msg.id); remoteUnboundNotices.delete(msg.id);
      if (unbound && (msg.error || msg.result?.isError) && /approv|declin|cancel|denied|permission/i.test(JSON.stringify(msg.error ?? msg.result)))
        promptFailures.set(msg.id, unbound);
    }
    // Only the id: with to-server and to-client it splits engine time from the relay's own.
    if (msg.method !== undefined && msg.id !== undefined) {
      const id = engineEpoch ? `sleight-engine-${engineEpoch}-${nextEngineRequest++}` : msg.id;
      engineRequests.set(id, { id: msg.id, epoch: engineEpoch,
        ...(isAppApproval(msg) && msg.params?._meta?.tool_name === 'press_key'
          ? { closeKeyApp: msg.params._meta.tool_params?.app } : {}) });
      msg = { ...msg, id };
    }
    trace('from-server', { id: msg.id, method: msg.method });
    if (msg.method === undefined && jsCalls.has(msg.id) && Array.isArray(msg.result?.content)) {
      msg.result.content = stripDP1Trace(msg.result.content, event => {
        closeRead?.pause(msg.id);
        trace('dp1-decision', { id: msg.id, ...event });
      });
    }
    if (msg.method === undefined && tabCleanupNotes.has(msg.id)) {
      const text = tabCleanupNotes.get(msg.id); tabCleanupNotes.delete(msg.id);
      if (msg.result) msg.result.content = [...(msg.result.content ?? []), { type: 'text', text }];
    }
    if (msg.method === undefined && clipboardReplies.has(msg.id)) {
      const pending = clipboardReplies.get(msg.id); clipboardReplies.delete(msg.id); pending.receive(msg); return;
    }
    if (retriedHelperStart(msg)) return;
    if (msg.method === undefined && debuggerDocs.has(msg.id)) {
      if (msg.error) msg = { jsonrpc: msg.jsonrpc, id: msg.id, result: { isError: true, content: [{ type: 'text', text: msg.error.message }] } };
      if (msg.result) msg.result.content = [...debuggerDocs.get(msg.id), ...(msg.result.content ?? [])];
      debuggerDocs.delete(msg.id);
    }
    if (staleHelperCheck && msg.method === undefined && msg.result?.isError &&
      msg.result.content?.some(c => c.type === 'text' && HELPER_START_FAILED.test(c.text ?? ''))) {
      staleHelperDiagnosis ??= Promise.resolve().then(staleHelperCheck).catch(() => []);
      staleHelperDiagnosis.then(jobs => {
        if (jobs?.length) msg.result.content.push({ type: 'text', text:
          `sleight: launchd keeps an old helper job without a running process. Only the user should clear it, then retry:\n${jobs.map(job => `launchctl remove ${job}`).join('\n')}` });
      }).finally(() => observeServerMessage(msg));
      return;
    }
    if (msg.method === undefined && turnEnds.delete(msg.id)) {
      // Device Hub, left open after simulator runs, held a keyboard tap that stalled every key on the
      // Mac (2026-10-09). Name such an app once per session so the user knows what to quit.
      Promise.resolve().then(keyboardTaps).then(taps => {
        const held = [...new Set((taps ?? []).filter(t => drivenApps.has(t.app) || drivenApps.has(t.bundleId)).map(t => t.app || t.bundleId))]
          .filter(app => !tapWarned.has(app));
        if (held.length && msg.result) {
          held.forEach(app => tapWarned.add(app));
          msg.result.content = [...(msg.result.content ?? []), { type: 'text', text: `sleight-warning: ${held.join(' and ')} ${held.length > 1 ? 'hold' : 'holds'} a keyboard event tap. If your keys stop working, quit ${held.join(' and ')}.` }];
          trace('keyboard-tap-warning', { apps: held });
        }
      }, () => {}).finally(() => observeServerMessage(msg));
      return;
    }
    observeServerMessage(msg);
  }
  function observeServerMessage(msg) {
    if (msg.method === 'elicitation/create' && (pause.paused || pausedCalls.size)) {
      for (const id of pausedCalls) nativePauseCuts.add(id);
      toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'decline' } }); return;
    }
    if (msg.method === undefined && nativePauseCuts.delete(msg.id) && msg.result) {
      msg.result = { ...msg.result, content: [...msg.result.content ?? [], { type: 'text', text: NATIVE_PAUSE_CUT_NOTE }] };
    }
    docOrigin.reply(msg, documentationContext());
    if (msg.method === 'elicitation/create' || msg.error || msg.result?.isError) docOrigin.invalidate();
    // A completed warmup ID remains private, including duplicate engine replies.
    if (msg.method === undefined && docOrigin.owns(msg.id) && !internalRequests.has(msg.id)) return;
    if (msg.method === 'elicitation/create' && msg.id !== undefined) recordAction('waitStart', 's:' + msg.id);
    let certifiedRead; // { number, title } of this result's read, when its native window number is certified
    if (msg.method === undefined) {
      const stripConst = text => text.split('\n').filter(line =>
        !/^Warning: [A-Za-z_$][\w$]* was declared with const; use let for reassignable variables\.\r?$/.test(line)).join('\n');
      if (typeof msg.error?.message === 'string') msg.error.message = stripConst(msg.error.message);
      if (Array.isArray(msg.result?.content)) msg.result.content = msg.result.content.flatMap(item => {
        if (item.type !== 'text') return [item];
        const text = stripConst(item.text);
        if (text === item.text) return [item];
        return text.trim() ? [{ ...item, text }] : [];
      });
    }
    replWarmup.reply(msg);
    if (msg.method === undefined) privateWarmRequests.delete(msg.id);
    if (msg.method === undefined && nativeWarmRequests.delete(msg.id)) {
      pauseChecks.delete(msg.id);
      replWarmup.retainDocs(msg);
      flushHeldWarmPrompts();
      return;
    }
    if (stopCollected || (msg.method === undefined && stoppedClients.has(msg.id))) return;
    if (ownApproval(msg)) {
      // sleight's own consent host is declined without asking, before any other approval path (document scope, warm-up
      // prompts, the pre-approved list); the call that asked reaches Claude as the line.
      trace('own-host-approval', { id: msg.id });
      for (const id of running) if (!localRunning.has(id)) withheld.set(id, approvalLine(msg));
      toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'decline' } });
      return;
    }
    // Engine permission tokens have no parent RPC ID. Fail closed until even a late
    // private reply settles, rather than showing or accepting a warm-up prompt.
    if (msg.method === 'elicitation/create' && privateWarmRequests.size) {
      // Native inventory names no app, so an app prompt while only it is pending and a client call is in
      // flight belongs to that call. Hold it until the inventory settles, then decide.
      const app = msg.params?._meta?.tool_params?.app;
      if (typeof app === 'string' && app && pendingClients.size && [...privateWarmRequests].every(id => nativeWarmRequests.has(id))) {
        const timer = setTimeout(() => {
          if (!heldWarmPrompts.delete(msg)) return;
          if (!stopCollected && !closing && !disposed) toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'decline' } });
        }, 2000);
        timer.unref?.();
        heldWarmPrompts.set(msg, timer);
        trace('warm-prompt-held', { id: msg.id });
        return;
      }
      toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'decline' } });
      return;
    }
    if (msg.method === undefined && frontCalls.has(msg.id)) {
      const token = frontCalls.get(msg.id); frontCalls.delete(msg.id);
      const generation = stopGeneration;
      const success = generation === callGenerations.get(msg.id) && !closing && !disposed &&
        !msg.error && !msg.result?.isError && Array.isArray(msg.result?.content);
      Promise.resolve().then(() => frontRestore({ action: 'finish', token, success })).then(restored => {
        if (generation !== stopGeneration || closing || disposed || restored?.restored !== true) return;
        msg.result.content = [...(msg.result.content ?? []), { type: 'text',
          text: `sleight gave the front back to ${restored.app || restored.bundleId} after the launch` }];
        trace('front-restored', { id: msg.id, app: restored.app, bundleId: restored.bundleId, pid: restored.pid });
      }).catch(() => {}).finally(() => observeServerMessage(msg));
      return;
    }
    if (msg.method === undefined && lateHelperReplies.has(msg.id)) {
      replWarmup.retainDocs({ result: { content: engineDocs(msg.result?.content) } });
      lateHelperReplies.delete(msg.id);
      const control = lateDiagnosticControls.get(msg.id); lateDiagnosticControls.delete(msg.id);
      if (control?.generation === diagnosisGeneration) helperFullReads.add(control.key);
      callGenerations.delete(msg.id); return;
    }
    if (msg.method === undefined && callGenerations.has(msg.id) && callGenerations.get(msg.id) !== stopGeneration) {
      const health = helperStates.get(helperReads.get(msg.id)?.key);
      if (health?.pending === msg.id) {
        health.pending = undefined;
        if (!closing && !serverIn.writableEnded && !serverIn.destroyed) scheduleHelperRead(health);
      }
      documentCalls.delete(msg.id); changeCalls.delete(msg.id); jsCalls.delete(msg.id); syntaxOrigins.delete(msg.id); browserCalls.delete(msg.id);
      spaceChecks.delete(msg.id); preHealth.delete(msg.id); nativeChecked.delete(msg.id); focusedChecked.delete(msg.id); restartRetries.delete(msg.id);
      flowCalls.delete(msg.id); helperReads.delete(msg.id); remapNotes.delete(msg.id); requireNotes.delete(msg.id); preapprovalNotes.delete(msg.id);
      menuCalls.delete(msg.id); menuAdmissions.delete(msg.id);
      callSeqs.delete(msg.id); callStarts.delete(msg.id); resultCalls.delete(msg.id); guardCalls.delete(msg.id);
      finishedCall(msg.id);
      toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: promptNotice('Input lease: this call was stopped; its input outcome is unconfirmed. Read the app again.', prompt) }] } });
      stoppedClients.add(msg.id); return;
    }
    if (msg.method === undefined && continueMenu(msg)) return;
    if (msg.method === undefined && landTab(msg)) return;
    // Keep the original engine verdict even when close recovery rewrites noWindowsAvailable.
    const resultFailed = !!msg.error || !!msg.result?.isError;
    const failure = resultCalls.get(msg.id)?.failure ?? (resultFailed ?
      { message: msg.error?.message ?? failureReason(msg.result?.content) } : undefined);
    if (msg.method === undefined && guardCalls.has(msg.id)) {
      const generation = guardCalls.get(msg.id); guardCalls.delete(msg.id);
      let installed = false;
      if (Array.isArray(msg.result?.content)) msg.result.content = msg.result.content.flatMap(item => {
        if (item.type !== 'text' || !item.text?.includes(GUARD_READY)) return [item];
        const text = item.text.split('\n').filter(line => {
          if (line !== GUARD_READY) return true;
          installed = true; return false;
        }).join('\n');
        return text.trim() ? [{ ...item, text }] : [];
      });
      if (msg.error || msg.result?.isError) forgetGuard();
      else if (installed && generation === guardGeneration) guardReady = true;
    }
    if (msg.method === undefined && turnEndCalls.has(msg.id)) {
      const args = turnEndCalls.get(msg.id);
      turnEndCalls.delete(msg.id);
      if (msg.error || msg.result?.isError) {
        const attempts = turnEndAttempts.get(args.turn_id);
        if (attempts >= 3) {
          failedTurnEnds.delete(args.turn_id);
          turnEndAttempts.delete(args.turn_id);
          trace('turn-end-abandoned', { turnId: args.turn_id, attempts });
          stderr.write(`sleight: turn cleanup rejected after 3 attempts; dropping turn ${args.turn_id}\n`);
        } else {
          failedTurnEnds.set(args.turn_id, args);
          trace('turn-end-failed', { turnId: args.turn_id, attempts });
        }
      } else {
        failedTurnEnds.delete(args.turn_id);
        turnEndAttempts.delete(args.turn_id);
      }
      scheduleIdleEnd();
    }
    if (msg.method === undefined && spaceChecks.has(msg.id)) {
      // The probe takes about 150 ms against the engine's 400 ms or more, so this rarely waits.
      const check = spaceChecks.get(msg.id); spaceChecks.delete(msg.id);
      const deadline = new Promise(resolve => setTimeout(resolve, 600).unref?.());
      // An acquisition that launches the app is still launching when the first probe runs, so an
      // absent app is probed once more now that the engine has answered.
      let launched = false;
      Promise.race([check.health, deadline]).then(health => {
        launched = health?.status === 'absent';
        return launched
          ? Promise.race([Promise.resolve().then(() => spaceProbe(check.key)).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 600).unref?.())])
          : health;
      }).then(async health => {
        preHealth.set(msg.id, launched ? { ...health, launched: true } : health);
        if (launched && launchReread) await fullerLaunchRead(msg, helperReads.get(msg.id));
        const failure = msg.error?.message ?? (msg.result?.isError ? (msg.result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n') : '');
        if (health?.menuBarOnly === true && health.windows === 0 && /\btimeoutReached\b/.test(failure)) {
          // Not a stuck app or helper: no recovery reads, and the same read is pointless.
          const plan = helperReads.get(msg.id);
          helperReads.delete(msg.id);
          if (plan) {
            const state = helperStates.get(plan.key);
            if (state) { clearTimeout(state.timer); state.pending = undefined; }
            helperStates.delete(plan.key); helperControls.delete(plan.key);
          }
          const note = promptNotice(menuBarOnlyNote(health.app ?? check.key, localNames.has('menu_bar')), prompt);
          if (msg.error) msg.error.message += `\n\n${note}`;
          else msg.result.content = [...(msg.result.content ?? []), { type: 'text', text: note }];
          trace('menu-bar-only', { id: msg.id, app: check.key });
        }
        if (health && !offSpace(health)) spaceNoted.delete(check.key);
        if (offSpace(health) && !spaceNoted.has(check.key) && Array.isArray(msg.result?.content)) {
          spaceNoted.add(check.key);
          const text = msg.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          const app = windowFromText(text)?.app ?? check.key;
          msg.result.content.push({ type: 'text', text: promptNotice(offSpaceNote(app), prompt) });
          trace('off-space', { id: msg.id, app, health });
        }
        observeServerMessage(msg);
      });
      return;
    }
    const identityCall = msg.method === undefined && leaseCalls.get(msg.id);
    if (windowIdentity && selectedWindow && inputLease && !documentMode && !changeReview && identityCall?.observe &&
        !identityCall.selectedChildChecked && !msg.error && !msg.result?.isError) {
      const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const window = lastWindowFromText(text), appId = observedAppId(identityCall, window, msg.result);
      if (window && !window.url && selectedWindow.url && window.title === selectedWindow.title && window.app === selectedWindow.app &&
          (menuRoot(text) || /^0 (?:sheet|dialog)\b/m.test(text))) {
        const expected = selectedWindow, generation = stopGeneration;
        identityCall.selectedChildChecked = true;
        Promise.resolve().then(() => {
          const selector = identityCall.selector ?? handleSelectors.get(identityCall.handle);
          const acquiredNumber = selector?.match(/^\{\s*(?:windowId|"windowId")\s*:\s*(\d+)\s*\}$/)?.[1];
          const bound = identityCall.handle ? handleBundles.get(identityCall.handle) : leaseWindow;
          // A named app acquisition reads its main window, which the native check must find focused.
          // Numbered acquisitions and existing handles must also prove where this tree came from.
          const number = acquiredNumber ? Number(acquiredNumber) : identityCall.acquisition ? expected.windowNumber
            : bound?.windowNumber ?? bound?.nativeIdentity?.windowNumber;
          if (expected.windowNumber === undefined || !expected.nativeIdentity || number !== expected.windowNumber || appId !== expected.appId) {
            throw new Error('Input lease: selected child has no matching native window binding. Read the selected document again.');
          }
          return windowIdentity(expected);
        }).then(observed => {
          const identity = verifyWindowIdentity(expected, observed);
          if (generation !== stopGeneration) return;
          if (selectedWindow !== expected) throw new Error('Input lease: selection changed during the child identity check. Read the selected document again.');
          identityCall.selectedParent = expected;
          identityCall.nativeIdentity = identity; identityCall.identityRequired = true;
          expected.nativeIdentity = identity;
          noteProcess(identity);
        }).catch(error => {
          msg.result = { ...msg.result, isError: true, content: [...(msg.result.content ?? []), { type: 'text', text: error.message }] };
        }).finally(() => {
          observeServerMessage(msg);
        });
        return;
      }
    }
    if (windowIdentity && identityCall?.observe && identityCall.read && !identityCall.identityChecked && !identityCall.selectedParent) {
      const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const window = !msg.result?.isError && windowFromText(text);
      const appId = observedAppId(identityCall, window, msg.result);
      let candidates;
      for (const line of text.split('\n')) {
        if (!line.startsWith(WINDOWS_MARK)) continue;
        try {
          const apps = JSON.parse(line.slice(WINDOWS_MARK.length));
          const windows = apps.filter(app => app.id === appId).flatMap(app => app.windows ?? []);
          if (windows.length) candidates = windows.filter(w => w.title === window?.title).length;
        } catch { /* No engine inventory; use the already requested health observation. */ }
      }
      const health = preHealth.get(msg.id);
      if (window && !window.url && health?.status === 'denied') nativeIdentity(window, health);
      candidates ??= health?.windowTitles?.filter(title => title === window?.title).length ??
        (sameWindow(leaseWindow, window) ? leaseWindow?.nativeCandidates : undefined) ?? 1;
      identityCall.nativeCandidates = candidates;
      // A sheet belongs to its document; AXWindows contains parent windows, not this header.
      if (window && !window.url && !/^0 sheet\b/m.test(text) && appId && candidates > 1) {
        identityCall.identityChecked = true;
        const generation = stopGeneration;
        const selector = identityCall.selector ?? handleSelectors.get(identityCall.handle);
        const acquiredNumber = selector?.match(/^\{\s*(?:windowId|"windowId")\s*:\s*(\d+)\s*\}$/)?.[1];
        const expected = { ...window, appId, ...(sameWindow(selectedWindow, window) && selectedWindow.appId === appId
          ? { windowNumber: selectedWindow.windowNumber } : acquiredNumber ? { windowNumber: Number(acquiredNumber) } : {}) };
        Promise.resolve().then(() => windowIdentity(expected)).then(observed => {
          if (generation !== stopGeneration) return;
          identityCall.nativeIdentity = nativeIdentity(expected, observed);
          noteProcess(identityCall.nativeIdentity);
          identityCall.identityRequired = !!identityCall.nativeIdentity;
        }).catch(error => { identityCall.identityError = error.message; }).finally(() => {
          if (generation === stopGeneration || callGenerations.has(msg.id)) observeServerMessage(msg);
        });
        return;
      }
    }
    const panelHealth = preHealth.get(msg.id);
    const panelNote = Array.isArray(msg.result?.content) || typeof msg.error?.message === 'string'
      ? panelAdvice(panelHealth) : undefined;
    if (msg.method === undefined && Array.isArray(msg.result?.content)) {
      msg.result.content = stripHandBindings(msg.result.content, handBindingMarks.get(msg.id), bindings => hand?.bindings?.(msg.id, bindings));
      msg.result.content = stripGuardTiming(msg.result.content, metric => trace('guard-read', { id: msg.id, ...metric }));
    }
    const automatic = msg.method === undefined && helperProbes.has(msg.id);
    let windowNote;
    // The tree Claude saw before this result, which the change block below replaces.
    const treeBefore = lastTree;
    // The app's window count this read's health probe took (preHealth is cleared before the input-lease block): null when
    // the probe gave no answer in time, undefined when the call had no probe.
    const readHealth = msg.method === undefined && preHealth.has(msg.id) ? preHealth.get(msg.id) ?? null : undefined;
    const confirmedBrowser = msg.method === undefined && browserCalls.has(msg.id) && browserReply(msg);
    if (confirmedBrowser && !resultFailed) clickResults.observe(msg.result);
    if (browserCalls.has(msg.id) && msg.result?.content?.some(item => item.type === 'text' &&
        /^sleight: new tab \S+ created for this link\.$/m.test(item.text ?? ''))) tabsMayNeedCleanup = true;
    // An unknown read handle may turn out to be native. Its engine identity keeps later actions
    // on the native path, including the selected-window and bundle checks.
    if (msg.method === undefined && browserCalls.has(msg.id) && !confirmedBrowser &&
        msg.result?._meta?.['codex/toolSurface']?.app?.appId && isLeaseRead(jsCalls.get(msg.id))) {
      const handle = jsCalls.get(msg.id)?.match(/([A-Za-z_$][\w$]*)\.(?:getAXState|getAXStateAndScreenshot|getScreenshot)\(/)?.[1];
      if (handle) {
        nativeHandles.add(handle); browserHandles.delete(handle);
        Object.assign(leaseCalls.get(msg.id) ?? {}, { read: true, handle, observe: true });
        Object.assign(changeCalls.get(msg.id) ?? {}, { read: true, observe: true });
      }
    }
    if (msg.method === undefined && clipboardResets.delete(msg.id) && !msg.error && !msg.result?.isError) {
      clipboard.reset().then(() => observeServerMessage(msg), error => {
        msg.result = { ...(msg.result ?? {}), isError: true };
        clipboardNotices(msg, [/* notice */ 'Clipboard: reset cleanup failed: ' + error.message]);
        observeServerMessage(msg);
      });
      return;
    }
    const cut = nativeCopies.get(msg.id);
    if (msg.method === undefined && nativeCopies.delete(msg.id) && !msg.error && !msg.result?.isError) {
      // Finder ignores Cmd+X on a file, and the old line read as a cut that worked (finder-move-2, 2026-10-17).
      clipboardNotices(msg, [/* notice */ promptNotice('Copy/Cut used the native clipboard. Its contents were not restored by sleight; a successful copy remains available to menu Paste, pbpaste and browser pastes.' +
        (cut ? ' sleight can\'t see whether Cut took effect: an app that disables Cut for the selection ignores the key, and its Edit menu shows Cut disabled. Copy works there.' : ''), prompt)]);
    }
    if (msg.method === undefined && msg.id !== undefined && internalRequests.has(msg.id)) {
      // Warm-up owns its retention. Other private reads may keep only an image, a tree or a diagnostic.
      if (!String(msg.id).startsWith('sleight-warm-')) replWarmup.retainDocs({ result: { content: engineDocs(msg.result?.content) } });
      internalRequests.get(msg.id)(msg);
      internalRequests.delete(msg.id); pauseChecks.delete(msg.id); pausedCalls.delete(msg.id);
      return;
    }
    // Applied after a docs restart below. forgetHandles would otherwise drop the handles this reply just confirmed.
    let pendingBrowser;
    if (msg.method === undefined && browserCalls.has(msg.id)) {
      pendingBrowser = browserCalls.get(msg.id); browserCalls.delete(msg.id);
    }
    // The opened-tab note belongs on the engine's own last text, not on a notice sleight adds below.
    const engineLastText = Array.isArray(msg.result?.content) ? msg.result.content.findLastIndex(c => c.type === 'text') : -1;
    if (turboUnavailable && !turboNoticeShown && pendingBrowser && Array.isArray(msg.result?.content) &&
        (msg.result._meta?.['codex/toolSurface']?.kind === 'browserUse' || msg.result._meta?.['codex/toolSurface']?.app?.appId === undefined &&
          /\bcua\.(?:getBrowser|getTab|createBrowserTab|listBrowsers|listTabs)\s*\(/.test(jsCalls.get(msg.id) ?? ''))) {
      turboNoticeShown = true;
      msg.result.content.push({ type: 'text', text: promptNotice(`Tell the user: Turbo is off (${turboUnavailable}). The engine browser path is available. Check turbo settings and run sleight-mcp --doctor before retrying turbo.`, prompt) });
    }
    const jsCode = msg.method === undefined ? jsCalls.get(msg.id) : undefined;
    const firstPass = !errorNoted.has(msg);
    errorNoted.add(msg);
    if (firstPass && jsCode !== undefined && (msg.error || msg.result?.isError)) {
      const text = msg.error?.message ?? (msg.result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const missing = /^(?:Error: )?TypeError: ([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*) is not a function\b/m.exec(text);
      if (missing && !browserHandles.has(missing[1]) && (missing[1] === 'app' || nativeHandles.has(missing[1]))) {
        const advice = promptNotice('Native API names: getAXState, getScreenshot, getAXStateAndScreenshot, click, drag, scroll, selectText, setValue, performSecondaryAction, paste, pressKey, typeText, waitFor. Use the documented arguments; waitFor polls the window for an element or text.', prompt);
        if (msg.error) msg.error.message += '\n' + advice;
        else msg.result.content.push({ type: 'text', text: advice });
      }
    }
    // browser_open's acquisition sends no input. Its explicit Invalid app gets a direct correction below,
    // so a generic initialization read would send Claude through inventory before retrying a known browser.
    const invalidOpen = engineOpenAcquisitions.has(msg.id) && jsCode !== undefined && getAppTargets(jsCode).some(browser => invalidAppReply(msg, browser));
    const initializationNote = firstPass && jsCode !== undefined && !invalidOpen && initializationAdvice(msg.result?.content, !!msg.error || !!msg.result?.isError, jsCode);
    if (initializationNote) msg.result.content.push({ type: 'text', text: promptNotice(initializationNote, prompt) });
    if (msg.method === undefined && syntaxOrigins.has(msg.id)) {
      const origin = syntaxOrigins.get(msg.id); syntaxOrigins.delete(msg.id);
      // The engine can report a parse error as a JSON-RPC error as well as an error result.
      if (msg.error && typeof msg.error.message === 'string') {
        const hint = syntaxErrorHint(msg.error.message, origin);
        if (hint) msg.error.message += '\n' + promptNotice(hint, prompt);
      } else if (msg.result?.isError && Array.isArray(msg.result.content)) {
        const hint = msg.result.content.map(c => c.type === 'text' ? syntaxErrorHint(c.text, origin) : undefined).find(Boolean);
        if (hint) msg.result.content.push({ type: 'text', text: promptNotice(hint, prompt) });
      }
    }
    const emptyNote = !msg.error && !msg.result?.isError && noOutputNotice(jsCode, msg.result?.content);
    if (emptyNote) msg.result.content.push({ type: 'text', text: promptNotice(emptyNote, prompt) });
    if (jsCode !== undefined) replWarmup.attach(msg);
    if (jsCode !== undefined) browserRecovery.observe(jsCode, msg);
    if (pendingBrowser && !msg.result?._meta?.['codex/toolSurface']?.app?.appId &&
        msg.result?.isError && Array.isArray(msg.result.content)) {
      const rewritten = text => rewriteDragAttempt(
        rewriteTabError(text, { read: isLeaseRead(jsCode) || isTabBinding(jsCode), code: jsCode }), jsCode);
      if (jsCode !== undefined && createdTabCall(jsCode) && !openedReads.has(msg.id)) {
        openedReads.add(msg.id);
        const probeId = `sleight-opened-tabs-${nextInternalId++}`, generation = stopGeneration;
        const original = msg, code = jsCode;
        const finish = reply => {
          clearTimeout(timer); internalRequests.delete(probeId); pauseChecks.delete(probeId);
          if (generation !== stopGeneration) return;
          const text = (reply.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
          const opened = parseOpenedPayload(text, original.id);
          const lastText = engineLastText >= 0 ? engineLastText : original.result.content.findLastIndex(c => c.type === 'text');
          original.result.content = original.result.content.map((c, i) => {
            if (c.type !== 'text') return c;
            const text = rewritten(c.text);
            return { ...c, text: i === lastText ? openedTabNote(text, { code, opened }) : text };
          });
          observeServerMessage(original);
        };
        const timer = setTimeout(() => {
          lateHelperReplies.add(probeId);
          finish({ result: { content: [] } });
        }, 1500);
        internalRequests.set(probeId, finish);
        toServer({ jsonrpc: '2.0', id: probeId, method: 'tools/call', params: { name: 'js',
          arguments: { code: readOpened(original.id), timeout_ms: 1500 },
          _meta: engineMeta() } });
        return;
      }
      msg.result.content = msg.result.content.map(c =>
        c.type === 'text' ? { ...c, text: rewritten(c.text) } : c);
    }
    // A "call failed" line after this message sent Claude to check again (h2h-3, 2026-10-10), so the
    // close it reports gets no verified-results line.
    let closedLast = closedWindowResults.has(msg);
    // Reading after ⌘W closed the last window fails with noWindowsAvailable, but the
    // close worked (7 of 437 calls, 2026-10-07). Say so instead of reporting an error.
    if (closedLast || jsCode !== undefined && msg.result?.isError && /\bsuper\+w\b|cmd\+w\b|command\+w\b/i.test(jsCode) &&
        (msg.result.content ?? []).some(c => c.type === 'text' && /noWindowsAvailable/.test(c.text ?? ''))) {
      msg.result = { ...msg.result, isError: false, content: [...engineDocs(msg.result.content), { type: 'text', text: promptNotice('sleight: the app has no windows left, so the window this call closed was its last. Nothing more to read.', prompt) }] };
      closedLast = true;
    } else if (jsCode !== undefined && msg.result?.isError && Array.isArray(msg.result.content) &&
        msg.result.content.some(c => c.type === 'text' && /noWindowsAvailable/.test(c.text ?? ''))) {
      // The engine says this when the app's window is on another Space: the user in full
      // screen or Split View failed 8 of 21 runs on 2026-10-08, and Claude retried blind.
      msg.result.content.push({ type: 'text', text: promptNotice("sleight: noWindowsAvailable means the engine found no window of this app on the current desktop. If the app has a window, it's on another Space (the user may be in full screen or Split View), minimized or hidden. Clicks may still reach it, but drags and some reads won't. Don't retry the same call: ask the user to show the window on the current desktop, or open a window if the app has none.", prompt) });
    }
    if (msg.method === undefined && jsCalls.delete(msg.id) && Array.isArray(msg.result?.content)) {
      let policyRewritten = false;
      const docs = msg.result.content.some(c => c.type === 'text' && /(^|\n)## Computer Use\n/.test(c.text ?? ''));
      if (docs && !msg.result.content.some(c => c.type === 'text' && /^## Computer Use\n/.test(c.text ?? ''))) {
        trace('payment-confirmation-policy', { status: 'unmatched' });
      } else if (docs) msg.result.content = msg.result.content.map(c => {
        if (c.type !== 'text' || !/^## Computer Use\n/.test(c.text ?? '')) return c;
        const text = rewritePaymentPolicy(c.text, confirmPayments, trace, { SLEIGHT_RS: rs });
        policyRewritten ||= text !== c.text;
        return { ...c, text };
      });
      // Only where the guard reads after the call: a native call under the lease or document scope.
      if (docs && workflowDocs && computerSurface && (inputLease || documentMode)) msg.result.content = msg.result.content.map(c => {
        if (c.type !== 'text' || !/^## Computer Use\n/.test(c.text ?? '')) return c;
        const { text, status } = rewriteWorkflow(c.text);
        trace('workflow-docs', { status });
        return { ...c, text };
      });
      if (msg.result._meta?.['codex/toolSurface']?.kind !== 'browserUse')
        msg.result.content = msg.result.content.map((c, i, all) => c.type === 'text' && c.text?.includes('<app_specific_instructions>')
          ? { ...c, text: rewriteBrowserInstructions(c.text, trace,
            { tree: all.slice(i + 1).map(item => item.type === 'text' ? item.text ?? '' : '').join('\n') }) } : c);
      if (docs && docsShown && !requestsFullDocumentation(jsCode)) {
        // An un-awaited action that fails can end the engine's session (reproduced 2026-10-07).
        invalidateDiagnostics(); forgetHandles(); helperHandles.clear(); helperControls.clear(); helperActive = undefined;
        compactor.reset();
        for (const action of resultCalls.values()) { action.before = undefined; action.overlap = true; }
        trace('engine-session-restarted', { id: msg.id });
        msg.result.content.push({ type: 'text', text: promptNotice("sleight: the engine's JavaScript session restarted before this call, so handles from earlier calls (such as `app`) are gone. An action that fails without `await` can end the session. Acquire the app again with `let app = await cua.getApp(…)`, and await every action.", prompt) });
      }
      // Native calls get common rules with the engine docs. Browser rules wait for a browser
      // result, including an acquisition refusal, and remain in context across engine restarts.
      const browserResult = pendingBrowser && (confirmedBrowser || !msg.result._meta?.['codex/toolSurface']?.app?.appId &&
        /\bcua\.(?:getBrowser|getTab|createBrowserTab|listBrowsers|listTabs)\s*\(/.test(jsCode ?? ''));
      let rules = (docs || browserResult) && rulesFor(browserResult, policyRewritten);
      if (rules && openRules === 'short' && !browserResult && String(msg.id).startsWith('sleight-open-file-')) {
        deferredRules = ruleItem(rules);
        rules = openFileRules(rules);
      }
      if (rules) {
        const item = { type: 'text', text: rules + (docs ? promptNotice('\n\nsleight: Action results include changed lines. Don\'t reread to confirm them. Read again for missing information or required guard checks.', prompt) : '') };
        Object.assign(item, ruleBlocks.item(item.text));
        msg.result.content = rulesFirst ? beforeFirstTree(msg.result.content, item) : [...msg.result.content, item];
      }
      if (docs) docsShown = true;
      if (isNativeGetState(jsCode, msg.result)) msg.result.content.push({ type: 'text', text: promptNotice(WINDOWS_LINE, prompt) });
    }
    if (pendingBrowser) {
      for (const handle of pendingBrowser.handles) {
        if (confirmedBrowser) browserHandles.add(handle);
        else browserHandles.delete(handle);
      }
    }
    if (automatic && !helperProbes.has(msg.id)) {
      // A session restart invalidated this probe while processing its reply.
      // Keep its result internal even though the live probe record is gone.
      lateHelperReplies.delete(msg.id); lateDiagnosticControls.delete(msg.id); return;
    }
    const healthPlan = msg.method === undefined ? helperReads.get(msg.id) : undefined;
    if (healthPlan) { helperReads.delete(msg.id); updateHelperRead(healthPlan, msg); }
    const helperStuck = helperStates.get(healthPlan?.key)?.stuck;
    if (msg.method === undefined && flowCalls.has(msg.id)) {
      flowRules.observe(msg.result, flowCalls.get(msg.id));
      flowCalls.delete(msg.id);
    }
    // A blocked app's card is declined before any path answers it, the document path included.
    if (isAppApproval(msg) && declineBlockedApproval(msg)) return;
    if ((panelOnly || remoteApprovals) && isAppApproval(msg) && !shellAppCards.has(msg)) {
      const match = /^Allow Computer Use to use "([^"\r\n]+)"\?$/.exec(msg.params?.message ?? '');
      const app = msg.params?._meta?.tool_params?.app;
      // A display-name mismatch is resolved only against an engine-supplied bundle ID. Unknown names, changed
      // identities, action wording and lookup failures retain their one-action card and grant no session access.
      if (match && match[1] !== app && typeof app === 'string' && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(app) && (remoteApprovals || resolveApprovalApp)) {
        const generation = stopGeneration;
        shellAppCards.set(msg, false);
        Promise.resolve().then(async () => {
          if (!remoteApprovals) return (await resolveApprovalApp(match[1])) === app;
          await waitCatalog();
          return plainAppCard(msg, remoteCatalog.apps);
        }).catch(() => false).then(plain => {
          if (generation !== stopGeneration || closing || disposed) {
            if (remoteApprovals) toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } });
            return;
          }
          shellAppCards.set(msg, plain);
          observeServerMessage(msg);
        });
        return;
      }
      shellAppCards.set(msg, plainAppCard(msg));
    }
    if (documentMode && isAppApproval(msg)) { documentEngineApproval(msg); return; }
    if (msg.method === undefined && changeCalls.has(msg.id)) {
      const call = changeCalls.get(msg.id);
      changeCalls.delete(msg.id);
      // An acquisition's window inventory: kept for the next call's guard, never shown to Claude.
      let inventory;
      for (const c of msg.result?.content ?? []) {
        if (c.type !== 'text' || !c.text?.includes(WINDOWS_MARK)) continue;
        c.text = c.text.split('\n').filter(line => {
          if (!line.startsWith(WINDOWS_MARK)) return true;
          try { inventory = JSON.parse(line.slice(WINDOWS_MARK.length)); } catch {}
          return false;
        }).join('\n');
      }
      const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (!automatic) journal?.observe(msg.id, text);
      if (call.observe && !automatic && !confirmedBrowser) {
        lastWindowText = text; lastWindow = windowFromText(text);
        const parent = leaseCalls.get(msg.id)?.selectedParent;
        if (lastWindow && parent) lastWindow.selectedParent = parent;
      }
      // The app's windows before the acquisition; none when the acquisition launched it.
      const appId = msg.result?._meta?.['codex/toolSurface']?.app?.appId;
      const before = inventory && typeof appId === 'string' && inventory.filter(a => a.id === appId);
      // Any read with a full tree can stand in for the next call's first read, not only an
      // acquisition's: under load that read took 17 to 57 s, seconds after Claude's own (2026-10-09).
      // windows is null when no inventory came with it; the guard then relies on the 10 s window.
      // A split acquisition's read is milliseconds old when the same call's first action runs. With
      // no window list from the engine, it stands in (windows null) only for an app that was already
      // running with a window, never one the acquisition launched (owner, 2026-10-09). Refusing it
      // cost 173 reads and 98 s in the benchmark runs of 2026-10-09.
      const split = String(msg.id).startsWith('sleight-acquire-'), health = preHealth.get(msg.id);
      const settled = split && health?.status === 'responding' && !health.launched && health.windows > 0;
      priorRead = call.read && !msg.result?.isError && (!before || before.length <= 1) && lastWindow && text.includes('Window: ') &&
        /\n\t*\d+ /.test(text.slice(text.indexOf('Window: ')))
        ? { seq: callSeqs.get(msg.id), at: Date.now(), ms: Date.now() - (callStarts.get(msg.id) ?? Date.now()),
          split, app: lastWindow.app, title: lastWindow.title, id: appId,
          windows: settled ? null : before ? before[0]?.windows ?? [] : null, text: text.slice(text.indexOf('Window: ')) }
        : undefined;
      const finalTree = automatic ? undefined : text.slice(Math.max(0, text.lastIndexOf('Window: ')));
      const finalWindow = finalTree && windowFromText(finalTree);
      if (!automatic) lastTree = finalWindow && /\n\t*\d+ /.test(finalTree) ? { seq: callSeqs.get(msg.id), window: finalWindow, text: finalTree } : undefined;
      callSeqs.delete(msg.id); callStarts.delete(msg.id); preHealth.delete(msg.id);
      if (!confirmedBrowser && selectedWindow && !call.read && call.target && msg.result &&
          !sameWindow(lastWindow, call.target) &&
          !(lastWindow && newTabOf(call.target, treeBefore, finalWindow, finalTree))) {
        windowNote = `Sleight: outcome unconfirmed. Intended ${documentLabel(call.target)}. ` +
          (lastWindow ? `Observed ${documentLabel(lastWindow)}.` : 'Result missing full window header.');
      }
      // Keep the initial acquisition check, but release a verified selection
      // when a successful full observation confirms a different window. A same-title
      // header missing the selected URL is incomplete, even without a native helper.
      if (!confirmedBrowser && selectedWindow && selectionVerified && !automatic && call.observe && !msg.error && !msg.result?.isError &&
          lastWindow && !sameWindow(lastWindow, selectedWindow) &&
          (lastWindow.url || !selectedWindow.url || lastWindow.title !== selectedWindow.title || lastWindow.app !== selectedWindow.app)) clearSelection();
      // The Open click and its standalone reread can overlap. Judge safety at
      // the read's completion, after earlier action results have been recorded.
      const actionPending = [...changeCalls.values()].some(pending => !pending.safe);
      if (!confirmedBrowser && changeReview && !automatic && call.read && call.observe && actionPending && !msg.error && !msg.result?.isError) {
        msg.result.content.push({ type: 'text', text: promptNotice('Change review: an action is still pending, so this read cannot take a later copy. Wait for its result, then take another standalone cua.getApp read before editing.', prompt) });
      }
      if (!confirmedBrowser && changeReview && !automatic && call.read && call.observe && !actionPending && !msg.error && !msg.result?.isError) {
        try {
          const entry = changes.read(lastWindow);
          if (entry) trace('snapshot-after-read', { id: msg.id, path: entry.path, directory: changes.directory, snapshot: entry.snapshot });
        } catch (err) {
          trace('snapshot-read-failed', { id: msg.id, error: err.message });
          msg.result.content.push({ type: 'text', text: promptNotice(`Change review could not take a later copy: ${err.message}. Reads remain available.`, prompt) });
        }
      }
      if (!confirmedBrowser && changeReview && !call.safe) {
        const dialog = lastWindow?.app === call.window?.app && !lastWindow?.url?.startsWith('file://');
        changes.after(call.entry, !msg.error && !msg.result?.isError && (documentKey(lastWindow) === call.expected || dialog));
        // A window first identified after an action has no trustworthy before copy.
        for (const window of windowsInText(text)) {
          if (documentKey(window) !== call.expected) changes.uncaptured(window);
        }
      }
    }
    if (documentMode && msg.method === undefined && documentCalls.has(msg.id)) {
      const call = documentCalls.get(msg.id);
      documentCalls.delete(msg.id);
      if (call.observe && !automatic) {
        const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        observedDocument = windowFromText(text);
        if (call.read) {
          observedEngines = call.engines;
          observedRisks = call.risks;
          const appId = msg.result?._meta?.['codex/toolSurface']?.app?.appId;
          if (typeof appId === 'string') observedEngines.add(appId);
        }
        if (!helperStuck && !msg.error && (!observedDocument || (call.expected && call.expected !== documentKey(observedDocument)))) {
          msg.result = { ...(msg.result ?? {}), isError: true, content: [...(msg.result?.content ?? []), { type: 'text', text:
            promptNotice('Document scope stopped: Window or URL changed, or a full header is missing. That call may already have acted. Stop and read the intended window, then ask the user with document_scope.', prompt) }] };
          if (!call.read) observedDocument = undefined;
        }
      }
    }
    if (inputLease && !automatic && !confirmedBrowser && msg.method === undefined && leaseCalls.get(msg.id)?.observe) {
      const call = leaseCalls.get(msg.id);
      const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      lastShown = msg.error ? new Set() : shownStandardWindows(text);
      const shownId = msg.error ? undefined : rootWindowId(text);
      // A guard stop happens before its action and carries the header it just read.
      // A window-change stop carries the window it saw, and the lease moves to it. Leasing that
      // window still refuses if another session holds it.
      const guardStop = msg.result?.isError && /^(?:Error: )?(?:sleight stopped before |Input lease stopped this action: (?:window or URL|app) changed)/m.test(text);
      const window = !msg.error && (!msg.result?.isError || guardStop) && lastWindowFromText(text);
      if (window && call.selectedParent) window.selectedParent = call.selectedParent;
      const known = observedAppId(call, window, msg.result);
      // A pop-up the action brought up, or the window it returns to (SW1, popup-window.mjs). It gets the note below even
      // under its opener's title and URL, and the selected-window path's "outcome unconfirmed" note gets the same line.
      const failed = !!(msg.error || msg.result?.isError);
      const popupLine = call.key && window && !failed ? popups.note(leaseWindow, { ...window, rootId: shownId }) : popups.see(shownId);
      if (call.key && failed && shownId && leaseWindow?.rootId && shownId !== leaseWindow.rootId) {
        trace('popup-window', { event: 'no-line', app: window?.app ?? null, from: leaseWindow.rootId, to: shownId, reason: 'failed-call' });
      }
      if (call.read && window && !failed) popups.count(window.app, readHealth, shownId);
      if (failed) { popups.stopped(leaseWindow?.app, shownId); if (window?.app !== leaseWindow?.app) popups.stopped(window?.app, shownId); }
      // An action whose result shows another window of the same app (a close, a new window). Said
      // plainly, or a "no change" about the window now in front reads as a failed action: Claude
      // probed after closing a Chess game in 4/6 runs (2026-10-08).
      if (call.key && !windowNote && window && !msg.result?.isError && leaseWindow?.app === window.app && (popupLine ||
          !sameWindow(leaseWindow, window) && !newTabOf(leaseWindow, treeBefore, window, text.slice(text.lastIndexOf('Window: '))))) {
        windowNote = `sleight: this call acted on ${documentLabel(leaseWindow)}. The window it shows now is ${documentLabel(window)}.`;
      }
      if (popupLine && windowNote) {
        windowNote += ' ' + popupLine;
        trace('popup-window', { event: popupLine.startsWith('It has') ? 'opener-line' : 'popup-line', id: msg.id, app: window.app });
      } else if (popupLine) trace('popup-window', { event: 'no-line', id: msg.id, app: window.app, reason: 'no-window-note' });
      const previous = leaseWindow;
      if (guardStop && window && selectedWindow && window.app !== selectedWindow.app) clearSelection();
      leaseWindow = window ? { ...window, ...(known ? { appId: known } : {}), ...(shownId ? { rootId: shownId } : {}) } : undefined;
      if ((call.read || call.acquisition) && leaseWindow?.appId === openedWindow?.appId &&
          !sameWindow(leaseWindow, openedWindow)) openedWindow = undefined;
      if (ownWindow(leaseWindow)) withheld.set(msg.id, ownLine(leaseWindow.appId, leaseWindow.app));
      else if (leaseWindow) {
        // The site this read shows. A read without web-area lines (a diff) keeps what the same window showed before.
        const page = pageSite(text, window);
        if (page) leaseWindow.page = page; else if (previous?.page && sameWindow(previous, window)) leaseWindow.page = previous.page;
        const line = appLine(leaseWindow.appId, leaseWindow.app) ?? pageLine(leaseWindow, true);
        if (line) withheld.set(msg.id, line);
        else if (leaseWindow.appId) permissions?.noteApp?.({ bundleId: leaseWindow.appId, name: leaseWindow.app });
      }
      if (leaseWindow?.appId) lastConfirmedWindow = leaseWindow;
      else if (!window && !msg.error && !msg.result?.isError && lastConfirmedWindow) {
        // An acquisition of another app, or a last-window close, whose result shows no single window (a write that echoed
        // only a `Window:` line, or no windows left) says nothing about the app the lease held before it. The old target
        // would send the next action to an app this call moved off, or launch it (GA1). The next refusal names the app
        // this call acquired. The same app again keeps its target: only its window is unknown.
        const acquired = reachesGetApp(jsCode)
          ? [...String(jsCode).matchAll(/\bcua\.getApp\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/g)].map(m => m[1]) : undefined;
        const same = literal => [lastConfirmedWindow.appId, lastConfirmedWindow.app].some(name =>
          typeof name === 'string' && name.toLowerCase() === literal.slice(1, -1).toLowerCase());
        if (closedLast || acquired && (!acquired.length || !acquired.every(same))) {
          recoveryKnown = false; lastConfirmedWindow = undefined;
          if (!closedLast) recoveryTarget = acquired.length === 1 ? `cua.getApp(${acquired[0]})` : undefined;
        }
      }
      if (leaseWindow && !call.read && sameWindow(previous, window)) {
        // The parent lease's pin lasts one call; what the window had before it carries on.
        const kept = previous.parentPin?.id === msg.id ? { ...previous, nativeIdentity: previous.parentPin.nativeIdentity,
          identityRequired: previous.parentPin.identityRequired } : previous;
        for (const key of ['nativeCandidates', 'nativeIdentity', 'identityRequired', 'identityError']) {
          if (kept[key] !== undefined) leaseWindow[key] = kept[key];
        }
      }
      if (leaseWindow && call.nativeCandidates !== undefined) leaseWindow.nativeCandidates = call.nativeCandidates;
      if (leaseWindow && call.identityRequired) leaseWindow.identityRequired = true;
      if (leaseWindow && call.nativeIdentity) leaseWindow.nativeIdentity = call.nativeIdentity;
      if (leaseWindow && call.identityError) leaseWindow.identityError = call.identityError;
      // A dialog or sheet remembers the standard window it covered, so a call whose own action closes it can go on
      // there. Word shows a document with a sheet as a dialog root, under the title and URL it had as a standard window,
      // so standard windows are kept by title, app and URL apart from the lease object: in 19-02-45 a degraded read
      // dropped the lease, the relay re-acquired the document as a dialog root, and the alert found nothing to cover.
      // Two untitled dialogs compare equal, so the parent carries the time it was set, and continuing needs HID idle
      // since then.
      if (window && known && /^Window: .*\r?\n0 standard window\b/m.test(text)) {
        const key = documentKey(window), seen = { at: clock(), appId: known, process: appProcesses.get(known) };
        standardWindows.set(key, seen);
        // No process known for the app yet: ask, or the first note could come from a relaunched process and keep this
        // window as its own. One probe per app; after a failure, the next admission's note places later reads.
        if (seen.process === undefined && windowIdentity && inputLease && !documentMode && !changeReview && !processProbes.has(known)) {
          processProbes.set(known, 'pending');
          Promise.resolve().then(() => windowIdentity({ ...window, appId: known })).then(observed => {
            if (observed?.status !== 'ok' || observed.appId !== known || !Number.isSafeInteger(observed.pid) || !Number.isFinite(observed.processStart)) throw new Error('no process');
            if (processProbes.get(known) === 'pending') processProbes.delete(known);
            if (standardWindows.get(key) === seen && seen.process === undefined) seen.process = processKey(observed);
            noteProcess(observed);
          }).catch(() => { if (processProbes.get(known) === 'pending') processProbes.set(known, 'failed'); });
        }
      }
      // A gallery or panel with a plain window root (Word's Styles, which Escape closed in 19-02-45) covers it the same way.
      // The bundle ID comes from the handle, so the header's app must match too: another app's dialog (SecurityAgent)
      // over the document is not the document's.
      const over = (popoverContinuation ? /^Window: .*\r?\n0 (sheet|dialog|window|floating window|popover|system dialog)\b/m
        : /^Window: .*\r?\n0 (sheet|dialog|window|floating window|system dialog)\b/m).exec(text)?.[1];
      if (over && leaseWindow?.appId && previous?.appId === leaseWindow.appId && window.app === previous.app) {
        const key = documentKey({ title: previous.title, app: previous.app, url: previous.url });
        if (sameWindow(previous, window)) {
          if (previous.parent) { const { selectedParent: _, ...parent } = previous.parent; leaseWindow.parent = parent; }
        }
        else if ((previous.title || previous.url) && standardWindows.has(key)) {
          const { parent: _, selectedParent: __, ...covered } = previous;
          const seen = standardWindows.get(key);
          leaseWindow.parent = { ...covered, at: clock(), seenAt: seen.at, seen, over };
        }
      }
      if (leaseWindow?.appId && call.read && !msg.result?.isError) {
        const selector = call.selector ?? handleSelectors.get(call.handle);
        const acquiredNumber = selector?.match(/^\{\s*(?:windowId|"windowId")\s*:\s*(\d+)\s*\}$/)?.[1];
        const number = leaseWindow.nativeIdentity?.windowNumber ?? (acquiredNumber ? Number(acquiredNumber) : undefined);
        if (Number.isSafeInteger(number) && number > 0) {
          const key = `${leaseWindow.appId}:${number}`;
          dragWindows.delete(key);
          if (!call.identityError && !leaseWindow.identityError && (!leaseWindow.identityRequired || leaseWindow.nativeIdentity)) {
            dragWindows.set(key, { ...leaseWindow, windowNumber: number });
            certifiedRead = { number, title: leaseWindow.title, app: leaseWindow.app };
          }
        }
      }
      if (window?.app) drivenApps.add(window.app);
      if (known) drivenApps.add(known);
      if (call.handle) {
        if (known) {
          const rebound = handleBundles.get(call.handle)?.appId !== known;
          const { selectedParent: _, ...boundWindow } = leaseWindow;
          handleBundles.set(call.handle, boundWindow); unconfirmedHandles.delete(call.handle);
          // A read that rebinds the handle to another app makes its acquisition argument stale.
          if (call.acquisition) handleOrigins.set(call.handle, call.selector); else if (rebound) handleOrigins.delete(call.handle);
        }
        else if (call.acquisition) {
          handleBundles.delete(call.handle); handleOrigins.delete(call.handle);
          // A failed acquisition leaves the handle as it was.
          if (!msg.error && !msg.result?.isError) unconfirmedHandles.add(call.handle);
        }
      }
      if (known) {
        recoveryTarget = `cua.getApp(${JSON.stringify(known)})`; recoveryKnown = true;
        if (call.selector) selectorWindows.set(call.selector, { window, appId: known });
        selectorWindows.set(JSON.stringify(known), { window, appId: known });
      } else if (window) {
        // A failed acquisition (an invalid app name) never becomes the advice.
        const selector = call.selector ?? handleSelectors.get(call.handle);
        recoveryTarget = selector ? `cua.getApp(${selector})` : `cua.getApp(${JSON.stringify(window.app)})`; recoveryKnown = false;
      }
      if (selectedWindow && call.acquisition) {
        if (known && known !== selectedWindow.appId) {
          // A deliberate acquisition of another app ends this selection.
          clearSelection();
        } else {
          selectionVerified = !msg.result?.isError && sameHeader(window, selectedWindow) && known === selectedWindow.appId;
          if (!selectionVerified && !window?.selectedParent) windowNote = `Sleight: selected window not observed. ${selectionRecovery()}`;
        }
      }
    }
    if (identityWarning && msg.result) {
      identityWarning = false;
      msg.result.content = [...(msg.result.content ?? []), { type: 'text', text:
        promptNotice('sleight-warning: native window identity is inconclusive or lacks Accessibility permission. Continuing with the engine header and existing window guards; equal-title replacement detection is unavailable.', prompt) }];
    }
    if (windowNote && msg.result) msg.result.content = [...(msg.result.content ?? []), { type: 'text', text: windowNote }];
    if (msg.method === undefined && remapNotes.has(msg.id)) {
      if (msg.result) msg.result.content = [...(msg.result.content ?? []), { type: 'text', text: remapNotes.get(msg.id) }];
      remapNotes.delete(msg.id);
    }
    if (msg.method === undefined && requireNotes.has(msg.id)) {
      if (msg.result) msg.result.content = [...(msg.result.content ?? []), { type: 'text', text: requireNotes.get(msg.id) }];
      else if (msg.error) msg.error.message += '\n' + requireNotes.get(msg.id);
      requireNotes.delete(msg.id);
    }
    // The engine refuses Terminal, iTerm2 and OpenAI's own apps before any
    // approval, so a user consent can never enable the engine on them. Say so,
    // with the setting only the user may change.
    // The helper quits after about 20 s idle and relaunches on the next call;
    // a call during that restart can fail before reaching any app (2026-10-05).
    if (msg.method === undefined && msg.result?.isError && Array.isArray(msg.result.content) &&
      msg.result.content.some(c => c.type === 'text' && HELPER_START_FAILED.test(c.text ?? ''))) {
      msg.result.content.push({ type: 'text', text: promptNotice(updateRetries.has(msg.id)
        ? "sleight: the fresh engine still couldn't reach its helper after one reconnection. Stop and tell the user; `sleight-mcp --doctor` prints a fix when macOS won't relaunch the helper."
        : "sleight: the engine couldn't reach its helper (SkyComputerUseService), so this call never reached an app. The helper quits after about 20 seconds idle and restarts on the next call, which can race. sleight already sent this call again once. Call js_reset and retry. If that fails too, tell the user; `sleight-mcp --doctor` prints a fix when macOS won't relaunch the helper.", prompt) });
    } else if (msg.method === undefined && msg.result?.isError && Array.isArray(msg.result.content) &&
      msg.result.content.some(c => c.type === 'text' && HELPER_CRASHED.test(c.text ?? ''))) {
      msg.result.content.push({ type: 'text', text: promptNotice("sleight: the engine's helper (SkyComputerUseService) crashed during this call; that is the engine's bug, and macOS restarts the helper within seconds. Any action in this call may or may not have run, so read the app before you repeat one. A read alone is safe to repeat.", prompt) });
    }
    if (msg.method === undefined && msg.result) {
      const text = (msg.result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const refused = refusedApp(text);
      if (refused) {
        trace('blocked-app-refusal', { app: refused });
        msg.result = { ...msg.result, content: [...(msg.result.content ?? []), { type: 'text', text:
          promptNotice(refusalNotice(refused), prompt) }] };
      }
    }
    if (msg.method === undefined) {
      const aliases = openedAliases.get(msg.id);
      if (aliases) for (const [handle, target] of aliases) {
        if (!msg.error && !msg.result?.isError) openedWindows.set(handle, target);
        else if (openedWindows.get(handle) !== target) openedWindows.delete(handle);
      }
      cursorStatus(msg.error || msg.result?.isError ? 'error' : 'done', { say: callNarration.get(msg.id) });
      if (!msg.error && !msg.result?.isError) cursorStatus('thinking', { say: callNarration.get(msg.id) });
      hand?.result(msg.id, !!(msg.error || msg.result?.isError)); reportPreapprovals(msg); finishedCall(msg.id);
    }
    if (engineForbiddenTargets && isAppApproval(msg)) {
      const warning = forbiddenTargetWarning(msg.params?._meta?.tool_params?.app);
      if (warning && msg.params) msg.params.message = `${msg.params.message ?? 'Allow Computer Use?'} ${warning}`;
    }
    if (remoteApprovals && msg.method === 'elicitation/create' &&
        (!plainCard(msg) || approvalKey(msg) === undefined)) {
      remoteAppCard(msg); return;
    }
    // A shell action confirmation must reach the panel even when its app is pre-approved.
    if (isAppApproval(msg) && (!panelOnly || plainCard(msg))) {
      hand?.approval(msg.id, msg.params?._meta);
      // Observation only: the answer below is unchanged. The light check needs the key's time.
      if (msg.params?._meta?.tool_name === 'press_key') lightReturn?.keyPressed(msg.params._meta.tool_params?.app);
      const diagnostic = [...helperProbes.entries()].filter(([id, probe]) => probe.control && running.has(id));
      const app = msg.params?._meta?.tool_params?.app;
      const key = typeof app === 'string' ? helperSelector(JSON.stringify(app)) : undefined;
      const expired = [...lateDiagnosticControls.values()].some(control => control.key === key);
      // Native approval tokens are not relay RPC IDs. While a read may still
      // elicit, accept only a grant that already covers this app and risk.
      if (expired || diagnostic.some(([, probe]) => key === probe.control.key) ||
          (diagnostic.length && running.size === diagnostic.length)) {
        let allowed = approved.has(approvalKey(msg));
        try { allowed ||= userListGrant(app, msg.params?._meta?.riskLevel, 'engine', [...diagnostic.map(([id]) => id), ...lateDiagnosticControls.keys()]); } catch { allowed = false; }
        toServer({ jsonrpc: '2.0', id: msg.id, result: { action: allowed ? 'accept' : 'decline', ...(allowed ? { content: {} } : {}) } });
        return;
      }
      if (remoteApprovals && plainCard(msg) && approvalKey(msg) !== undefined) {
        remoteAppCard(msg); return;
      }
      let granted;
      try {
        granted = userListGrant(msg.params?._meta?.tool_params?.app,
          msg.params?._meta?.riskLevel, 'engine', [...running].filter(id => !localRunning.has(id)));
      } catch {
        // An audit failure must reach a person, even with a remembered approval.
        if (ask) askUser(msg, true);
        else if (clientCanElicit === false) toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } });
        else {
          const key = approvalScope === 'session' ? approvalKey(msg) : undefined;
          if (key !== undefined) approvalRequests.set(msg.id, { key, generation: stopGeneration });
          toClient(msg);
        }
        return;
      }
      if (granted) {
        // No engine persistence: check and audit the user's startup list on every request.
        toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept', content: {} } });
        return;
      }
    }
    if (ask && (isAppApproval(msg) || (msg.method === 'elicitation/create' && (panelOnly || msg.params?._meta?.connector_id === 'browser-use')))) {
      askUser(msg);
      return;
    }
    if (clientCanElicit === false && msg.method === 'elicitation/create') {
      toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } });
      return;
    }
    const key = approvalScope === 'session' ? approvalKey(msg) : undefined;
    if (key !== undefined) {
      if (approved.has(key)) {
        trace('answered-for-session', msg);
        toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept', content: {}, _meta: { persist: 'session' } } });
        return;
      }
      approvalRequests.set(msg.id, { key, generation: stopGeneration });
      const always = grokClient ? undefined : alwaysChoice(msg);
      if (always) {
        alwaysOffered.set(msg.id, always);
        const schema = msg.params.requestedSchema ?? { type: 'object', properties: {} };
        msg.params.requestedSchema = { ...schema, properties: { ...schema.properties,
          remember: { type: 'string', title: 'Remember this choice', enum: ['This session', 'Always'], default: 'This session',
            description: 'Always adds the app to your pre-approved list (sleight-mcp allow remove takes it off).' } } };
      }
    }
    // The handshake cache checks and records the engine's own replies, before this session's rewrites.
    const engineReply = msg.method === undefined && startup?.expects(msg.id) ? structuredClone(msg) : undefined;
    if (msg.method === undefined && listRequests.delete(msg.id) && Array.isArray(msg.result?.tools)) msg.result = clientTools(msg.result);
    if (panelNote) {
      if (Array.isArray(msg.result?.content)) msg.result.content.push({ type: 'text', text: panelNote });
      else if (msg.error && typeof msg.error.message === 'string') msg.error.message += '\n' + panelNote;
    }
    // Last, after every check above has read the full tree.
    let chromeSettle = false, listClicks = [], stuckPlan;
    if (msg.method === undefined && Array.isArray(msg.result?.content)) {
      chromeSettle = !automatic && !confirmedBrowser && jsCode !== undefined && !msg.error &&
        !msg.result?.isError && shouldSettleChromeScreenshot(jsCode, msg.result.content);
      const screenshotCode = codeOnly(jsCode ?? '');
      const screenshotHandles = new Set([...screenshotCode.matchAll(/\b([A-Za-z_$][\w$]*)\.(?:getScreenshot|getAXStateAndScreenshot)\s*\(/g)].map(match => match[1]));
      const screenshotHandle = screenshotHandles.size === 1 ? [...screenshotHandles][0] : undefined;
      const screenshotReassigned = screenshotHandle && new RegExp(`(?:^|[^\\w$.])${screenshotHandle.replace(/\$/g, '\\$')}\\s*=(?!=)`).test(screenshotCode);
      const screenshotTarget = screenshotHandle && !screenshotReassigned && handleBundles.get(screenshotHandle);
      const screenshotAppId = msg.result._meta?.['codex/toolSurface']?.app?.appId;
      const screenshotWindow = !automatic && !confirmedBrowser && !msg.result.isError && screenshotTarget &&
        (!screenshotAppId || screenshotAppId === screenshotTarget.appId) ? screenshotTarget : undefined;
      if (jsCode !== undefined) {
        recordScreenshot(msg.result.content, certifiedRead, screenshotWindow);
        tagRunScreenshots(msg.result.content, { source: 'native', windowId: certifiedRead?.number ?? screenshotWindow?.windowNumber ?? screenshotWindow?.nativeIdentity?.windowNumber });
      }
      if (simFocusNote && !automatic && !confirmedBrowser && !msg.result.isError && typeof jsCode === 'string') {
        // A screenshot need not contain a Window header. Associate only the one acquired handle the
        // code screenshots and doesn't reassign, never the session's most recently observed app.
        // Batches count: both Firefox settings runs (2026-10-17) took their first screenshot with
        // emitImage or a later write, got no note, and sent drags in the shown image's frame.
        const target = screenshotWindow;
        // emitImage repeats the same picture; dropRepeatedImages removes the copy below.
        const note = target &&
          simulatorScreenshotNote(dropRepeatedImages(msg.result.content), target, imageSize);
        // Once per window and size: Claude Code's own line repeats the multiplier on every image.
        const key = note && JSON.stringify([target.appId ?? target.app, target.title, imageSize(msg.result.content.find(c => c?.type === 'image').data)]);
        if (note && !framesNoted.has(key)) {
          framesNoted.add(key);
          msg.result.content.push({ type: 'text', text: promptNotice(note, prompt) });
        }
      }
      if (!automatic && jsCode !== undefined) {
        if (!msg.result.isError) {
          // A split call's acquisition result joins this one in toClient, after these notes.
          const head = splitHeads.get(msg.id) ?? [];
          const closed = closedMenuContent(msg.result.content, jsCode, window => openMenus.has(menuWindowKey(window)), prompt, head);
          if (closed) { msg.result.content = closed.content; if (splitHeads.has(msg.id)) splitHeads.set(msg.id, closed.head); }
          const paste = pasteHereNote([...(splitHeads.get(msg.id) ?? []), ...msg.result.content], jsCode, { menu: lastMenuTree, files: key => fileLists.get(key) }, prompt);
          if (paste) msg.result.content.push({ type: 'text', text: paste });
        }
        const text = msg.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        const tree = text.slice(Math.max(0, text.lastIndexOf('Window: ')));
        const treeWindow = windowFromText(tree), listing = fileListing(tree);
        if (treeWindow && isMenuTree(tree)) { openMenus.add(menuWindowKey(treeWindow)); lastMenuTree = tree; }
        else if (treeWindow && WINDOW_ROOT.test(tree)) { openMenus.delete(menuWindowKey(treeWindow)); lastMenuTree = undefined; }
        if (treeWindow && listing) fileLists.set(documentKey(treeWindow), listing);
        const key = documentKey(windowFromText(tree));
        // A different selected title in the same episode starts its count at the short note.
        const entry = selectedMenuEntry(tree), prior = key ? stuckMenus.get(key) : undefined;
        const shown = !prior ? 0 : prior.title === entry?.title ? prior.shown : 1;
        const note = openMenuNote(tree, prompt, shown);
        if (key && entry) stuckMenus.set(key, { title: entry.title, shown: OPEN_MENU.test(tree) ? shown : shown + 1 });
        else if (key && !msg.result.isError && /^\d+ (?:standard window|window|sheet|dialog)\b/m.test(tree) &&
            !/…\(\d+\)|^[+~\-] |sleight: (?:lines changed|no change since)/m.test(tree)) stuckMenus.delete(key);
        // The Escape is for the leased, engine-confirmed app only, and only when this tree shows the lease's window.
        // One per app, whatever its window's title does, until the app's own menu bar reads clear.
        const escapeApp = stuckEscape && inputLease && !confirmedBrowser && key && leaseWindow?.appId && sameWindow(leaseWindow, treeWindow)
          ? leaseWindow.appId : undefined;
        const opened = OPEN_MENU.test(tree);
        const cleared = !entry && !opened && !msg.result.isError && /^\d+ (?:standard window|window|sheet|dialog)\b/m.test(tree) &&
          !/…\(\d+\)|^[+~\-] |sleight: (?:lines changed|no change since)/m.test(tree);
        const due = stuckEscapes.observe(escapeApp, { stuck: !!entry && !opened, cleared });
        if (due === 'confirm') {
          const window = leaseWindow;
          Promise.resolve().then(() => stuckEscape.check(window)).catch(() => undefined).then(menu => {
            stuckEscapes.confirmed(escapeApp, menu);
            trace('stuck-escape-check', { appId: escapeApp, selected: menu?.selected ?? null, open: menu?.open ?? null });
          });
        }
        if (due === 'escape' && !running.size) {
          stuckPlan = { appId: escapeApp, number: entry.number, window: leaseWindow, note, since: clock() };
        } else if (note) msg.result.content.push({ type: 'text', text: note });
      }
      // Explicit reads stay whole unless Claude printed a derived value. Recovery still forces
      // full output; neither choice skips the action's UI comparison.
      const input = automatic ? undefined : dropRepeatedImages(dropRepeatedText(msg.result.content), prompt);
      if (input && compactReacquire && healthPlan?.acquisition && splitCalls.has(msg.id) && String(msg.id).startsWith('sleight-acquire-')) rawHeads.set(msg.id, input);
      const typingReceipt = !automatic && typingReceiptCall(jsCode) && typedTextReceipt({
        action: resultCalls.get(msg.id), content: input, mark: filterMarks.get(msg.id),
        failed: resultFailed || !!msg.result?.isError });
      const continued = continuedOutcomes.get(msg.id);
      if (!automatic) msg.result.content = compactor.process(withoutTypingReceipt(input, filterMarks.get(msg.id)),
        { code: jsCode, screenshotWindow, outcomeStart: continued?.start ?? 0, outcomeContinuing: !!continued?.head, acquisition: healthPlan?.acquisition === true, filterMark: filterMarks.get(msg.id) ?? null,
          forceFull: healthPlan?.fullVisible === true,
          explicitFull: /\bdisableDiffing\s*:\s*true\b/.test(jsCode ?? ''),
          action: closedLast ? undefined : resultCalls.get(msg.id), failure, failed: !closedLast && (resultFailed || !!msg.result?.isError) });
      // Claude's code can reach the guard's state, so the record's shape is checked, not trusted.
      const record = automatic ? undefined : compactor.takeOutcomes();
      const kept = !Array.isArray(record?.outcomes) ? undefined : continued?.head ? { ...record, outcomes: record.outcomes.filter(rec => rec?.x !== 'refused') } : record;
      if (outcomes && kept && outcomeCalls.has(msg.id)) {
        outcomeCalls.get(msg.id).turn.native(kept);
        outcomeCalls.get(msg.id).recorded = true;
      }
      if (continued?.head) continuedOutcomes.set(msg.id, { start: (continued.start ?? 0) + (kept?.outcomes?.length ?? 0) });
      const savedReads = automatic ? 0 : compactor.takeSaved();
      recordAction('outcomes', msg.id, kept); recordAction('saved', msg.id, savedReads);
      if (!automatic && elementVisibility && jsCode !== undefined && !msg.result.isError) listClicks = compactor.listClicks();
      if (typingReceipt) msg.result.content.push({ type: 'text', text: typingReceipt });
      if (!automatic && openReads.has(msg.id) && !msg.result.isError && compactor.lastReadNoted()) textlessOpens.add(msg.id);
      filterMarks.delete(msg.id);
    }
    if (msg.method === undefined && resultCalls.has(msg.id)) {
      if (msg.error) msg.error.message += '\n' + compactor.process([], { action: resultCalls.get(msg.id), failed: true, failure })[0].text;
      resultCalls.delete(msg.id);
    }
    if (msg.method === undefined) filterMarks.delete(msg.id);
    // A reply gives Claude only a line, before anything is delivered: the line a read or approval withheld, the user's line for
    // a blocked app the engine's app id names (reached by a name the call's strings didn't show), or sleight's own consent
    // host's line when the reply's window is it, by the engine's app id or the header's app.
    if (msg.method === undefined && (msg.result || msg.error)) {
      const shown = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const appId = msg.result?._meta?.['codex/toolSurface']?.app?.appId;
      const line = withheld.get(msg.id) ?? (typeof appId === 'string' ? appLine(appId) : undefined) ??
        ((window => ownWindow(window) ? ownLine(window.appId, window.app) : undefined)(lastWindowFromText(shown) || undefined));
      withheld.delete(msg.id);
      if (line) { delete msg.error; msg.result = { isError: true, content: [{ type: 'text', text: line }] }; listClicks = []; stuckPlan = undefined; }
    }
    const deliver = () => {
      if (chromeSettle && !chromeSettled.has(msg.id)) {
        const handle = chromeSettleHandle(jsCode);
        const first = lastImageData(msg.result.content);
        if (handle && first !== undefined) {
          chromeSettled.add(msg.id);
          const generation = stopGeneration;
          waitForMatchingScreenshots({
            first, take: () => extraChromeScreenshot(handle), now, sleep: chromeSettleSleep,
            limitMs: chromeSettleMs, intervalMs: chromeSettleIntervalMs,
          }).then(result => {
            if (generation !== stopGeneration || disposed || closing) return;
            if (result.data !== undefined && result.data !== first) {
              msg.result.content = replaceLastImage(msg.result.content, result.data);
            }
            trace('chrome-settle', { id: msg.id, waitedMs: result.waitedMs, matched: result.matched, shots: result.shots });
            toClient(msg);
          }).catch(error => {
            if (generation !== stopGeneration || disposed || closing) return;
            trace('chrome-settle', { id: msg.id, error: error.message });
            toClient(msg);
          });
          return;
        }
      }
      if (!startup?.reply(msg, engineReply)) toClient(msg);
    };
    // A list row the call's click left unchanged: the helper says whether it lies outside the list's visible
    // frame, and its note replaces "UI changed". The result waits for at most the helper's deadline.
    const finish = () => {
      if (!listClicks.length) return deliver();
      const generation = stopGeneration, appId = msg.result._meta?.['codex/toolSurface']?.app?.appId;
      offscreenNotes(listClicks, elementVisibility, { ...listClicks[0].window, appId }, prompt).catch(() => []).then(notes => {
        if (generation !== stopGeneration || disposed || closing) return;
        trace('offscreen-click', { id: msg.id, clicks: listClicks.length, notes: notes.length });
        if (notes.length) msg.result.content = withOffscreenNotes(msg.result.content, notes);
        deliver();
      });
    };
    if (stuckPlan) {
      // One try per episode, whatever the checks decide. It counts as running, so no action starts while it posts.
      const plan = stuckPlan, generation = stopGeneration, id = `sleight-stuck-escape-${nextInternalId++}`;
      stuckEscapes.tried(plan.appId);
      running.add(id); callDetails.set(id, 'stuck-menu Escape');
      Promise.resolve().then(() => generation !== stopGeneration || disposed || closing ? { posted: false, reason: 'call stopped' }
        : stuckEscape.send(plan.window, inputLease.grant(inputLease.acquire(plan.window)), { since: plan.since, clock }))
        .catch(error => ({ posted: false, reason: String(error?.message ?? error) }))
        .then(result => {
          finishedCall(id);
          if (result?.posted) stuckEscapes.posted(plan.appId, result.selected ?? null);
          trace('stuck-escape', { id: msg.id, appId: plan.window.appId, item: plan.number, posted: result?.posted === true,
            ...(result?.posted ? { selected: result.selected ?? null } : { reason: result?.reason ?? 'unknown' }) });
          if (generation !== stopGeneration || disposed || closing) return;
          const text = stuckEscapeNote(result, plan.window.app, plan.number, plan.note, prompt);
          if (text) msg.result.content.push({ type: 'text', text });
          finish();
        });
      return;
    }
    finish();
  }

  // Ends the open turn, if any call used it. Resolves once the server answers
  // or after a short grace period.
  async function endOpenTurn(cleanupTabs = true, carryId, event) {
    if (inputLease && running.size) {
      const ready = await new Promise(resolve => {
        const done = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => { drained.delete(done); resolve(false); }, stopGraceMs);
        drained.add(done);
      });
      if (!ready) return false;
    }
    if (cleanupTabs && (tabsMayNeedCleanup || tabCleanupPending)) await cleanupBrowserTabs();
    const owed = [...failedTurnEnds.values(), ...(turnUsed ? [endTurnArgs(event ? { hook_event_name: event } : {})] : [])];
    failedTurnEnds.clear();
    const done = owed.map(args => {
      const id = `sleight-${nextInternalId++}`;
      const answered = new Promise(resolve => {
        internalRequests.set(id, resolve);
        setTimeout(resolve, SHUTDOWN_GRACE_MS).unref();
      });
      trackTurnEnd(id, args);
      toServer({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: TURN_END_TOOL, arguments: args } });
      return answered;
    });
    if (turnUsed) {
      // The call that triggered a reconnect belongs to the next turn's receipt, not the one being closed.
      const carried = carryId === undefined ? undefined : journal?.take(carryId);
      finishReceipt(); journal?.put(carried); rotateTurn(carryId);
    }
    return Promise.all(done);
  }

  async function interruptTurn(msg) {
    let tabNote;
    // Revocation enters synchronously. Collecting the owned engine does not
    // cancel a separate broker operation or prove its resource cleanup.
    const directEnd = directBrowser?.end();
    closing = true;
    replWarmup.cancel();
    stopFinished = false;
    // A Stop starts a fresh engine and turn, even after a failed update reconnect.
    updatePending = false;
    stopGeneration++;
    remoteRefusedCalls.clear(); remoteUnboundNotices.clear();
    cancelFrontCalls();
    invalidateDiagnostics();
    resumeRequested = false;
    clearTimeout(idleTimer);
    beginStop();
    const inFlight = [...pendingClients].filter(([id]) => id !== msg.id).map(([, detail]) => detail);
    for (const resolve of elicitations.values()) resolve({ result: { action: 'cancel' } });
    elicitations.clear();
    const report = await checkedStop({ inFlight,
      endTurn: async () => {
        if (running.size) {
          const drainedInTime = await new Promise(resolve => {
            const done = () => { clearTimeout(timer); resolve(true); };
            const timer = setTimeout(() => { drained.delete(done); resolve(false); }, stopGraceMs);
            drained.add(done);
          });
          if (!drainedInTime) return false;
        }
        if (tabsMayNeedCleanup || tabCleanupPending) tabNote = await cleanupBrowserTabs();
        const id = `sleight-stop-${nextInternalId++}`;
        const ended = await new Promise(resolve => {
          const timer = setTimeout(() => { internalRequests.delete(id); pauseChecks.delete(id); resolve(undefined); }, stopGraceMs);
          internalRequests.set(id, reply => { clearTimeout(timer); resolve(reply); });
          toServer({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: TURN_END_TOOL,
            arguments: endTurnArgs({ hook_event_name: 'Interrupt' }) } });
        });
        return !!ended?.result && !ended.error && !ended.result.isError;
      },
      collect: async () => {
        const engine = await stopEngine();
        if (engine?.collected === true) {
          stopCollected = true;
          backendRestartUnconfirmed = false;
          // The collected engine cannot send a late private permission prompt.
          privateWarmRequests.clear();
          cancelInternalRequests('Engine collected.');
          dropHeldWarmPrompts();
        }
        return engine;
      },
      release: async () => {
        // Collection makes late results impossible. Resolve pending caller requests explicitly.
        for (const pending of clipboardReplies.values()) pending.reject(new Error(/* notice */ 'Stopped: engine collected.'));
        clipboardReplies.clear();
        menuAdmissions.clear(); menuCalls.clear(); menuBaselines.clear(); menuContinued.clear(); menuForwards.clear(); continuedLeads.clear(); splitInputs.clear();
        engineOpenPrints.clear(); engineOpenAcquisitions.clear(); engineOpenAllowed.clear();
        filterMarks.clear(); splitCalls.clear(); splitHeads.clear(); splitCodes.clear(); rawHeads.clear(); openShots.clear(); openReads.clear(); textlessOpens.clear(); helperDiagnosticReplies.clear(); promptFailures.clear(); callGenerations.clear();
        for (const id of [...pendingClients.keys()].filter(id => id !== msg.id)) {
          leaseStop({ id }, 'stopped while in flight; its input outcome is unconfirmed.');
          stoppedClients.add(id);
        }
        for (const id of [...running]) { stoppedClients.add(id); finishedCall(id); }
        for (const probe of helperProbes.values()) { clearTimeout(probe.timer); probe.receive?.({ error: { message: 'engine collected' } }); }
        helperProbes.clear(); helperReads.clear(); helperControls.clear(); helperFullReads.clear(); lateDiagnosticControls.clear();
        for (const state of helperStates.values()) clearTimeout(state.timer);
        helperStates.clear(); helperHandles.clear(); helperAliases.clear();
        leaseCalls.clear(); changeCalls.clear(); documentCalls.clear(); jsCalls.clear(); syntaxOrigins.clear(); browserCalls.clear();
        engineCalls.clear();
        spaceChecks.clear(); preHealth.clear(); nativeChecked.clear(); focusedChecked.clear(); restartRetries.clear(); debuggerDocs.clear();
        // The stopped turn's receipt keeps its unanswered calls as unknown; nothing carries into the next engine.
        resultCalls.clear(); guardCalls.clear(); finishReceipt();
        // A collected engine can't take an old turn's cleanup; the next engine starts its own turns.
        turnEndCalls.clear(); failedTurnEnds.clear(); turnEndAttempts.clear();
        await clipboard?.close();
        stopHeartbeat();
        inputLease?.releaseChecked();
        turnUsed = false;
      },
      inspect: inspectInput ?? (async () => ({ ok: false, error: 'Input inspection unavailable' })),
    });
    if (directEnd) {
      report.directBrowser = await directEnd;
      if (report.directBrowser.revoked !== true || report.directBrowser.cleanup.some(row =>
        !['closed', 'released'].includes(row.status))) report.resources = 'unconfirmed';
    }
    trace('stop-receipt', report);
    if (outcomes) {
      const pending = [...outcomeCalls.values()].filter(call => call.turn === turnOutcomes && !call.recorded).length;
      const summary = turnOutcomes.text(pending);
      if (summary) outcomeEnds.set(msg.id, summary);
    }
    turnOutcomes = new TurnOutcomes();
    outcomeCalls.clear();
    completenessCalls.clear();
    toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: report.resources !== 'clear' || report.leases !== 'released and checked',
      content: [{ type: 'text', text: promptNotice(stopText(report), prompt) }, ...(report.directBrowser ? [{ type: 'text',
        text: JSON.stringify({ directBrowser: report.directBrowser }) }] : []), ...(tabNote ? [{ type: 'text', text: tabNote }] : [])], _meta: { 'sleight/stop': report } } });
    onStopReported(report);
    stopUnconfirmed = report.engine === 'unconfirmed'; stopFinished = true;
    resumeAfterStop();
  }

  function dispose() {
    if (disposed) return;
    for (const log of turnStats.values()) log.reset();
    turnStats.clear(); statsCalls.clear(); closedStats.clear(); statsEnds.clear();
    finishReceipt();
    disposed = true;
    nativeHandoff?.cancel?.();
    replWarmup.cancel();
    startup?.close();
    cancelFrontCalls();
    detachServer();
    cancelInternalRequests('Session ended.');
    clearTimeout(idleTimer);
    turnEndCalls.clear(); failedTurnEnds.clear(); turnEndAttempts.clear();
    for (const resolve of elicitations.values()) resolve({ result: { action: 'cancel' } });
    elicitations.clear();
    lightReturn?.dispose();
    tabProbe?.dispose();
    tabLandings.clear();
    closeRead?.dispose();
    paymentCard?.close?.();
    promptFailures.clear();
    flowRules?.dispose();
    flowCalls.clear(); flowPending = undefined; flowPermit = undefined;
    preapprovalNotes.clear();
    helperReads.clear();
    guardCalls.clear(); forgetGuard();
    for (const state of helperStates.values()) clearTimeout(state.timer);
    for (const probe of helperProbes.values()) { clearTimeout(probe.timer); probe.receive?.({ error: { message: 'session ended' } }); }
    helperControls.clear(); helperDiagnosticReplies.clear(); lateDiagnosticControls.clear();
    helperStates.clear(); helperHandles.clear(); helperAliases.clear(); helperProbes.clear(); helperFullReads.clear();
    changes.dispose();
    trace('change-snapshots-deleted', { directory: changes.directory });
  }
  function clearStaleCalls(resetId) {
    // Keep live work and app-health faults. Only bookkeeping with no caller, native operation or engine RPC is stale.
    const ids = new Set([...running, ...leaseCalls.keys(), ...openedWindowLeases.keys(), ...browserCalls.keys()]);
    for (const id of ids) {
      if (id === resetId || engineCalls.has(id) || localRunning.has(id) || pendingClients.has(id)) continue;
      splitCalls.delete(id); browserCalls.delete(id);
      nativeChecked.delete(id); focusedChecked.delete(id); restartRetries.delete(id);
      finishedCall(id); stoppedClients.add(id);
    }
  }
  function clearPendingCalls(message) {
    nativeHandoff?.cancel?.();
    // Split reads have no pendingClients entry. Invalidate their continuations before settling either parent or child.
    stopGeneration++;
    remoteRefusedCalls.clear(); remoteUnboundNotices.clear();
    clearTimeout(idleTimer);
    // Failure replies also call finishedCall. Remove renewal keys before any reply or callback can finish a call.
    stopHeartbeat(); leaseCalls.clear(); openedWindowLeases.clear();
    cancelFrontCalls();
    splitCalls.clear();
    cancelInternalRequests(message);
    for (const pending of clipboardReplies.values()) pending.reject(new Error(message));
    clipboardReplies.clear(); clipboardResets.clear();
    for (const resolve of elicitations.values()) resolve({ result: { action: 'cancel' } });
    elicitations.clear(); approvalRequests.clear(); listRequests.clear(); engineRequests.clear();
    for (const id of [...pendingClients.keys()]) {
      // Suppress late engine, local-tool and direct-browser results after the one failure reply.
      leaseStop({ id }, promptNotice(`${message} Input outcome is unconfirmed; read the app again.`, prompt));
      stoppedClients.add(id);
    }
    pendingClients.clear();
    // The caller releases reservations after removing all call markers.
    for (const id of [...running]) { stoppedClients.add(id); finishedCall(id); }
    localRunning.clear();
    callDetails.clear();
    openedWindowCalls.clear(); openedFlowPlans.clear(); openedWindowReads.clear(); openedAliases.clear();
    menuAdmissions.clear(); menuCalls.clear(); menuBaselines.clear(); menuContinued.clear(); menuForwards.clear(); continuedLeads.clear(); splitInputs.clear();
    engineOpenPrints.clear(); engineOpenAcquisitions.clear(); engineOpenAllowed.clear();
    filterMarks.clear(); splitHeads.clear(); splitCodes.clear(); rawHeads.clear(); openShots.clear(); openReads.clear(); textlessOpens.clear();
    invalidateDiagnostics();
    for (const probe of helperProbes.values()) { clearTimeout(probe.timer); probe.receive?.({ error: { message } }); }
    for (const state of helperStates.values()) clearTimeout(state.timer);
    helperProbes.clear(); helperStates.clear(); helperReads.clear(); helperControls.clear(); helperFullReads.clear(); helperDiagnosticReplies.clear(); lateDiagnosticControls.clear();
    helperHandles.clear(); helperAliases.clear(); helperActive = undefined;
    changeCalls.clear(); documentCalls.clear(); jsCalls.clear(); syntaxOrigins.clear(); browserCalls.clear();
    spaceChecks.clear(); preHealth.clear(); nativeChecked.clear(); focusedChecked.clear(); restartRetries.clear(); debuggerDocs.clear();
    flowCalls.clear(); flowPending = undefined; flowPermit = undefined;
    resultCalls.clear(); guardCalls.clear(); promptFailures.clear();
    stopHeartbeat();
    engineCalls.clear();
    callGenerations.clear();
  }
  function engineEnded(message) {
    if (disposed) return;
    const leaseFailed = !!leaseFault;
    stopCollected = true; updatePending = true;
    // An engine that died unplanned leaves direct browser work with no owner; revoke it as a Stop does.
    directBrowser?.end();
    startup?.close(); startup = undefined;
    replWarmup.cancel();
    privateWarmRequests.clear(); nativeWarmRequests.clear(); dropHeldWarmPrompts();
    browserWarmConfirmed = false;
    clearPendingCalls(message);
    forgetHandles(); browserRecovery.reset();
    lastConfirmedWindow = undefined; recoveryKnown = false; recoveryTarget = undefined;
    priorRead = undefined; lastTree = undefined;
    turnEndCalls.clear(); failedTurnEnds.clear(); turnEndAttempts.clear();
    releaseLeases();
    // A stream or renewal fault stopped the engine. Its confirmed exit permits a fresh read on a replacement.
    if (leaseFailed) closing = false;
  }
  function close() {
    closing = true;
    releasePause(); pauseChecks.clear(); pausedCalls.clear(); nativePauseCuts.clear();
    for (const pending of clipboardReplies.values()) pending.reject(new Error(/* notice */ 'Clipboard guard: engine connection closed.'));
    clipboardReplies.clear();
    clearTimeout(idleTimer);
    hand?.close();
    localCursor.clear();
    const recordingClosed = cursor?.close();
    try { dispose(); } finally { releaseLeases(); }
    return Promise.all([clipboard?.close(), directBrowser?.end(), recordingClosed]);
  }
  async function shutdown() {
    closing = true;
    directBrowser?.end();
    replWarmup.cancel();
    if (await endOpenTurn() === false) return false;
    await close();
    return true;
  }
  if (pause.paused) applyPause(true);
  return { endOpenTurn, shutdown, engineEnded, close, dispose: close, get snapshotDirectory() { return changes.directory; }, get sessionId() { return sessionId; }, get turnId() { return turnId; } };
}
