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
// When the local blocked_app tool is registered, the relay annotates the
// engine's refusals of Terminal, iTerm2 and OpenAI's own apps with an offer of
// it: that tool drives those apps through sleight's own Accessibility path
// (see blocked-apps.mjs), and the user's approval of the prompt is the whole
// opt-in. The refusal itself is OpenAI's and is never changed.
//
// `idleTurnEndMs`, when given, ends a used turn once no engine call has been
// running for that long. Hosts without the mod (the desktop app's Claude Code)
// never end the engine's turn, and the engine keeps holding the app (its badge
// on the window) until the session closes.
//
// `trace`, when given, receives every message as it passes, for debugging.

import { randomUUID } from 'node:crypto';
import { DOCUMENT_TOOL, documentKey, documentLabel, windowFromText, isDocumentRead, readCode, guardedCode } from './document-scope.mjs';
import { ChangeReview, REVIEW_TOOL, isChangeCancel } from './change-review.mjs';
import { FLOW_TOOL } from './flow-rules.mjs';
import { browserCall, browserReply } from './browser-call.mjs';
import { isLeaseRead } from './input-lease.mjs';
import { stripGuardTiming } from './guard-timing.mjs';
import { isInventoryRead } from './inventory-read.mjs';
import { createReadCompactor } from './compact-reads.mjs';
import { forbiddenTargetWarning, isForbiddenSettingsWindow, refusedApp } from './blocked-apps.mjs';
import { clipboardCode, clipboardPlan, clipboardActions, createClipboardSession, createNativeClipboardIO } from './clipboard.mjs';

const META_KEY = 'x-codex-turn-metadata';
const HIDDEN_TOOLS = new Set(['js_add_node_module_dir']);
const TURN_END_TOOL = 'turn_ended';
const TURN_END_DESCRIPTION = 'Internal to sleight: its hooks call this when a Claude turn ends. Never call it yourself.';
const SHUTDOWN_GRACE_MS = 3000;

// Splits a stream into newline-delimited JSON-RPC messages.
// getScreenshot() already shows its image, so passing it to nodeRepl.emitImage
// shows it twice: 2 images per step, 64 in one iPhone Mirroring session
// (2026-10-07). Drop exact repeats within a result and say so once.
export function dropRepeatedImages(content) {
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
  kept.push({ type: 'text', text: `sleight: dropped ${copies} of the same image. getScreenshot() already shows its picture, so don't pass it to nodeRepl.emitImage too.` });
  return kept;
}

function lines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
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

function windowsInText(text) {
  const starts = [...text.matchAll(/^Window: /gm)].map(m => m.index);
  return starts.map((start, i) => windowFromText(text.slice(start, starts[i + 1]))).filter(Boolean);
}

// The server marks turn_ended with `_meta.ui.visibility: []`, which Claude Code
// reads as "callable by no one", the mod included. Drop that, and describe it
// as internal; the mod refuses model calls to it.
function internalTurnEnd(tool) {
  const { _meta, ...rest } = tool;
  const { ui, ...otherMeta } = _meta ?? {};
  return {
    ...rest,
    description: TURN_END_DESCRIPTION,
    ...(Object.keys(otherMeta).length ? { _meta: otherMeta } : {}),
  };
}

export function createRelay({
  clientIn, clientOut, serverIn, serverOut,
  sessionId = randomUUID(),
  approvalScope = 'session',
  ask,
  preapproved,
  grantAudit = () => {},
  stderr = process.stderr,
  localTools,
  clipboardHelper,
  clipboardIO,
  clipboardMode,
  flowRules,
  changeReview = true,
  idleTurnEndMs,
  inputLease,
  onLeaseFault = () => {},
  engineForbiddenTargets = false,
  guardTiming = false,
  firstCallRules,
  trace: writeTrace = () => {},
}) {
  const compactor = createReadCompactor();
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
  const clipboard = clipboardMode === 'preserve' && (clipboardIO || clipboardHelper) ? createClipboardSession(clipboardIO ?? createNativeClipboardIO(clipboardHelper)) : undefined;
  const clipboardReplies = new Map();
  const clipboardResets = new Set();
  const nativeCopies = new Set();
  const listRequests = new Set();
  const internalRequests = new Map();
  const approvalRequests = new Map(); // server request id -> approval key
  const approved = new Set(); // approval keys the user accepted this session
  let asking = Promise.resolve(); // `ask` prompts, one at a time
  const localNames = new Set(localTools?.tools.map(t => t.name) ?? []);
  const elicitations = new Map(); // our elicitation id -> resolve
  const running = new Set(); // ids of engine calls waiting for a result
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
  const browserCalls = new Map();
  const helperStates = new Map();
  const helperHandles = new Map();
  // js calls awaiting a reply, and whether this engine session has shown its first-call docs:
  // docs again without a js_reset mean the session restarted and every handle is gone.
  const jsCalls = new Map();
  let docsShown = false;
  // Once per session: Claude keeps them in context across engine restarts.
  let rulesShown = false;
  const helperAliases = new Map();
  const helperReads = new Map();
  const helperProbes = new Map();
  const helperFullReads = new Set();
  const lateHelperReplies = new Set();
  let helperActive;
  const helperAdvice = key => `The SkyComputerUseService helper appears stuck when reading ${key}. Stop retrying. Tell the user they need to restart ChatGPT to recover computer use. sleight will retry by itself with one standalone read every 20 s and resume this app after a successful read. Restarting ends their Codex sessions; never restart or quit ChatGPT yourself. If other apps still answer, ${key} itself may be hung instead (TextEdit hung this way 3 times on 2026-10-05): tell the user, since quitting that app is the first fix to try.`;

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
      return { read, key, selector, handle: acquisition[1] ?? 'app', probe: `var __sleightHelperRecovery = await cua.getApp(${selector})` };
    }
    const handles = [...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\./g)].map(m => m[1]);
    if (read) {
      const handle = handles.find(h => !['nodeRepl', 'cua'].includes(h));
      const known = helperHandles.get(handle);
      return { read, handle, key: known?.key ?? `handle:${handle}`, probe: known?.probe ?? code };
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
      return;
    }
    state.timeouts = /\btimeoutReached\b/.test(error) ? state.timeouts + 1 : 0;
    if (state.timeouts >= 2 && !state.stuck) {
      state.stuck = true; state.retryAt = Date.now() + 20000;
      trace('helper-stuck', { id: msg.id, app: plan.key, consecutiveReadTimeouts: state.timeouts });
    }
    if (state.stuck) {
      scheduleHelperRead(state);
      if (msg.error) msg.error.message += `\n\n${helperAdvice(plan.key)}`;
      else msg.result = { ...msg.result, isError: true, content: [...(msg.result?.content ?? []), { type: 'text', text: helperAdvice(plan.key) }] };
    }
  }
  const flowCalls = new Map();
  let flowPending;
  let flowPermit;
  let flowAsking = false;
  const fingerprint = msg => JSON.stringify([msg.params.name, msg.params.arguments ?? {}]);
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
      const answer = asking.then(() => ask ? ask('Allow one flow-rule exception?', false, { kind: 'flow', detail }) : elicit(detail));
      asking = answer.catch(() => 'cancel');
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
    msg.result = { ...(msg.result ?? {}), content: [...(msg.result?.content ?? []), ...notices.map(text => ({ type: 'text', text }))] };
  }

  async function reviewChanges(msg) {
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
        const detail = changes.describe(entry);
        const answer = asking.then(() => ask
          ? ask(`Review ${entry.title}`, false, { kind: 'review', detail })
          : elicitReview(`Review ${entry.title}\n${detail}\nChoose Keep, Undo or Later. Undo restores the saved copy shown above. Reopen it in the app afterward.`));
        asking = answer.catch(() => 'cancel');
        const decision = await answer.catch(() => 'cancel');
        if (disposed) return;
        trace('review-decision', { path: entry.path, decision });
        try {
          if (['keep', 'undo'].includes(decision)) {
            if (closing || leaseFault) throw new Error('Input lease: this session is closing.');
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
  let recoveryTarget;
  let selectedWindow;
  let selectionVerified = false;
  function clearSelection() { selectedWindow = undefined; selectionVerified = false; }
  const sameWindow = (a, b) => a && b && ['title', 'app', 'url'].every(key => a[key] === b[key]);
  function selectionRecovery() {
    const args = { app: selectedWindow.appId, ...(selectedWindow.url ? { url: selectedWindow.url } : { title: selectedWindow.title }) };
    return `Call select_window with ${JSON.stringify(args)}, then send exactly \u0060${constApp ? '' : 'let app = '}await cua.getApp(${JSON.stringify(selectedWindow.appId)})\u0060 in js and check its Window and URL.`;
  }
  let constApp = false;
  // After js_reset, or when the engine's session restarts on its own, no handle survives.
  function forgetHandles() {
    clearSelection(); browserHandles.clear(); leaseWindow = undefined; handleBundles.clear(); handleSelectors.clear(); constApp = false;
  }
  const handleBundles = new Map();
  const handleSelectors = new Map();
  const selectorWindows = new Map();
  let leaseFault;
  let leaseTimer;
  let closing;
  let renewalFailures = 0;
  const leaseCalls = new Map();
  const drained = new Set();
  function stopHeartbeat() { clearInterval(leaseTimer); leaseTimer = undefined; }

  function failLease(error) {
    leaseFault = error.message;
    trace('input-lease-error', { error: leaseFault });
    closing = true;
    stopHeartbeat();
    onLeaseFault(error);
  }

  function leaseStop(msg, reason) {
    toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true,
      content: [{ type: 'text', text: reason.startsWith('Input lease:') ? reason : `Input lease: ${reason}` }] } });
  }
  function refreshHeartbeat() {
    if (disposed) { stopHeartbeat(); return; }
    const keys = [...leaseCalls.values()].map(c => c.key).filter(Boolean);
    if (!keys.length) { stopHeartbeat(); return; }
    if (leaseTimer) return;
    leaseTimer = setInterval(() => {
      const active = new Set([...leaseCalls.values()].map(c => c.key).filter(Boolean));
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
    if (!inputLease || msg.method !== 'tools/call') return true;
    const name = msg.params?.name;
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
    if (name === 'js' && browser && !documentMode) {
      if (running.size) { leaseStop(msg, 'another call in this session is pending.'); return false; }
      // A candidate can browse without a native target, but cannot inherit an
      // earlier native grant. The injected guard denies native access in that case.
      let key, nativeDenied;
      if (leaseFault || !leaseWindow?.appId || (selectedWindow &&
          (!selectionVerified || !sameWindow(leaseWindow, selectedWindow) || leaseWindow.appId !== selectedWindow.appId))) {
        nativeDenied = 'Native access stopped: send a standalone native app read before acting. ' + (leaseFault ?? 'No confirmed native window.');
      } else {
        try { key = inputLease.acquire(leaseWindow); }
        catch (err) { nativeDenied = 'Native access stopped: send a standalone native app read before acting. ' + err.message; }
      }
      leaseCalls.set(msg.id, { key, nativeDenied, observe: true });
      return true;
    }
    const read = name === 'js' ? typeof code === 'string' && isLeaseRead(code)
      : (name === 'menu_bar' && args.op === 'apps') || (name === 'notifications' && args.op === 'list') ||
        (name === 'blocked_app' && args.op === 'read');
    const acquisition = read && code?.trim().match(/^(?:(?:(let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*)?await\s+cua\.getApp\(\s*(.*?)\s*\)\s*;?$/s);
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
      if (name !== 'js') {
        leaseCalls.set(msg.id, { localAction: true }); return true;
      }
      if (selectedWindow && (!selectionVerified || leaseWindow?.appId !== selectedWindow.appId || !sameWindow(leaseWindow, selectedWindow))) {
        leaseStop(msg, `selected window is not confirmed. ${selectionRecovery()}`); return false;
      }
      if (!leaseWindow?.appId) {
        // `let`: a failed `let app = …` leaves no binding, so a bare `app = …` would fail, and the
        // engine accepts `let` again for a name it already has (both checked 2026-10-07).
        // With no app read yet, an app named in this call beats getState, which acquires nothing.
        const named = code.match(/cua\.getApp\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/)?.[1];
        const target = recoveryTarget ?? (named && `cua.getApp(${named})`);
        const recovery = target ? `${constApp ? '' : 'let app = '}await ${target}` : 'await cua.getState()';
        const inventory = /\bcua\.(?:listApps|listWindows|getState)\(/.test(code)
          ? ' To look up apps or windows, send one expression, such as \u0060(await cua.listApps()).map(a => a.id).join("\\n")\u0060.' : '';
        leaseStop(msg, `a bundle ID and full window header are required. Send exactly \u0060${recovery}\u0060 in js, then read the intended window before acting.${inventory}`);
        return false;
      }
      const stale = name === 'js' ? compactor.staleIndex(leaseWindow, code) : undefined;
      if (stale) {
        leaseStop(msg, stale.number !== undefined
          ? `element ${stale.number} may be stale. Numbers in this window changed since your last full read, and ${stale.number} isn't one you've seen since. Use a number from a + line in the latest result, or read the window again with getAXState({ disableDiffing: true }) first.`
          : `this call computes an element number (${stale.computed}), and numbers in this window changed since your last full read. Use a literal number from a + line in the latest result, or read the window again with getAXState({ disableDiffing: true }) first.`);
        return false;
      }
      if (engineForbiddenTargets && isForbiddenSettingsWindow(leaseWindow)) {
        leaseStop(msg, `${leaseWindow.app}'s settings window is refused, so Claude can't change its approval or safety settings. Close it or read another window.`);
        return false;
      }
      try { key = inputLease.acquire(leaseWindow); }
      catch (err) { leaseStop(msg, err.message); return false; }
    }
    const observe = name === 'js' && (!read || (!isInventoryRead(code) && /cua\.getApp\(|\.(?:getAXState|getAXStateAndScreenshot)\(/.test(code)));
    leaseCalls.set(msg.id, { key, observe, selector, handle, acquisition: !!acquisition });
    return true;
  }

  const documentAllowed = () => documentGrants.has(documentKey(observedDocument));
  function documentStop(msg, reason) {
    toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text:
      `Document scope: ${reason}. ${observedDocument ? `Observed ${documentLabel(observedDocument)}. ` : ''}` +
      'Stop actions. Read the intended window with one standalone cua.getApp call, then ask the user with document_scope.' }] } });
  }

  function askDocument(message, scoped) {
    const answer = asking.then(() => ask ? ask(message, scoped) : elicit(message));
    asking = answer.catch(() => 'cancel');
    return answer.catch(() => 'cancel');
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
        'Scope checks read window contents. This guards mistakes, not malicious JavaScript.', true);
      documentAsking = false;
      if (action !== 'accept') { documentStop(msg, 'the user did not approve this document'); return; }
      documentGrants.add(key);
      for (const risk of observedRisks) documentRisks.add(JSON.stringify([key, risk]));
    }
    toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Approved ${documentLabel(target)} for this session.` }] } });
  }

  async function documentEngineApproval(msg) {
    const call = [...documentCalls.values()][0];
    const engine = msg.params?._meta?.tool_params?.app;
    const risk = approvalKey(msg);
    let action = 'decline';
    if (call?.read && typeof engine === 'string') {
      call.engines.add(engine);
      if (risk) call.risks.add(risk);
      action = await askDocument(`Read one window in ${engine} to identify its document? This read does not approve actions.`, false);
    } else if (call && documentAllowed() && observedEngines.has(engine) && risk) {
      const key = JSON.stringify([documentKey(observedDocument), risk]);
      if (documentRisks.has(key)) action = 'accept';
      else {
        action = await askDocument(`Allow Claude to use ${documentLabel(observedDocument)} at risk level ` +
          `${msg.params?._meta?.riskLevel ?? 'unspecified'} for this session?`, true);
        if (action === 'accept') documentRisks.add(key);
      }
    }
    // Keep document grants here. Never persist a whole-app grant in the engine.
    toServer({ jsonrpc: '2.0', id: msg.id, result: { action, ...(action === 'accept' ? { content: {} } : {}) } });
  }

  function scheduleIdleEnd() {
    clearTimeout(idleTimer);
    if (!idleTurnEndMs || running.size || reviewing || !turnUsed) return;
    idleTimer = setTimeout(() => {
      trace('idle-turn-end', { turnId });
      endOpenTurn();
    }, idleTurnEndMs);
    idleTimer.unref?.();
  }
  let nextElicitId = 0;

  const toServer = msg => {
    if (serverIn.writableEnded || serverIn.destroyed) { trace('server-input-closed', { id: msg.id }); return; }
    trace('to-server', msg);
    serverIn.write(JSON.stringify(msg) + '\n');
  };
  const toClient = msg => {
    if (helperProbes.has(msg.id) && msg.method === undefined) {
      clearTimeout(helperProbes.get(msg.id).timer); helperProbes.delete(msg.id);
      trace('helper-recovery-result', msg); return;
    }
    if (clientOut.writableEnded || clientOut.destroyed) { trace('client-output-closed', { id: msg.id }); return; }
    trace('to-client', msg);
    clientOut.write(JSON.stringify(msg) + '\n');
  };
  for (const [name, stream] of [['server-input', serverIn], ['client-output', clientOut]]) {
    stream.on('error', err => {
      trace('stream-error', { stream: name, error: err.message });
      failLease(err);
    });
  }

  function turnMeta() {
    return JSON.stringify({ session_id: sessionId, turn_id: turnId });
  }

  function userListGrant(app, riskLevel, tool, ids) {
    if (!preapproved?.allows(app, riskLevel)) return false;
    const grant = { app, riskLevel, tool, source: '~/Library/Application Support/sleight/preapproved.json' };
    // Audit before answering. A failed audit must not grant approval.
    grantAudit(grant);
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
    const text = grants.map(g => `${g.app} (${g.riskLevel}, ${g.tool}) was pre-approved by the user's list at ${g.source}.`).join('\n');
    if (msg.result) msg.result = { ...msg.result, content: [...(msg.result.content ?? []), { type: 'text', text }] };
    else if (msg.error) msg.error = { ...msg.error, data: { detail: msg.error.data, preapprovals: grants } };
  }

  function endTurnArgs(args = {}) {
    return {
      hook_event_name: args.hook_event_name || 'Stop',
      session_id: sessionId,
      turn_id: turnId,
    };
  }

  // Answers an app approval through `ask`. Prompts queue, so a second request
  // for an app the user is still being asked about waits for that answer.
  function askUser(msg, ignoreMemory = false) {
    const key = approvalScope === 'session' ? approvalKey(msg) : undefined;
    asking = asking.then(async () => {
      if (!ignoreMemory && key !== undefined && approved.has(key)) {
        trace('answered-for-session', msg);
        return { action: 'accept', content: {}, _meta: { persist: 'session' } };
      }
      let action;
      try {
        action = await ask(msg.params?.message ?? 'Allow Computer Use?', key !== undefined);
      } catch {
        action = 'cancel';
      }
      if (action !== 'accept') return { action };
      if (key === undefined) return { action, content: {} };
      approved.add(key);
      return { action, content: {}, _meta: { persist: 'session' } };
    }).then(result => {
      trace('answered-by-ask', { id: msg.id, result });
      toServer({ jsonrpc: '2.0', id: msg.id, result });
    });
  }

  // Asks Claude Code's user through an elicitation of our own.
  function elicit(message) {
    const id = `sleight-elicit-${nextElicitId++}`;
    const answer = new Promise(resolve => elicitations.set(id, resolve));
    toClient({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message, mode: 'form', requestedSchema: { type: 'object', properties: {} } } });
    return answer.then(msg => msg.result?.action ?? 'cancel');
  }

  function elicitReview(message) {
    const id = `sleight-elicit-${nextElicitId++}`;
    const answer = new Promise(resolve => elicitations.set(id, resolve));
    toClient({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message, mode: 'form', requestedSchema: {
      type: 'object', properties: { decision: { type: 'string', enum: ['keep', 'undo', 'later'], title: 'Your decision' } }, required: ['decision'],
    } } });
    return answer.then(msg => msg.result?.action === 'accept' ? msg.result.content?.decision : 'cancel');
  }

  // Approval for a local tool: once per key and session, like app approvals.
  // options.once asks and is never remembered, for sends that must reach the
  // user every time (a terminal command send). The user's pre-approved list
  // covers drag, menu_bar and blocked_app's per-app consent at the same risk
  // level as the other local tools, but never a once ask.
  function approve(keyParts, message, callId, options = {}) {
    const key = JSON.stringify(['sleight', ...keyParts]);
    // A once ask must reach the user every time: never answered from the
    // pre-approved list and never from session memory.
    const scoped = approvalScope === 'session' && !options.once;
    const preapprovable = !options.once && keyParts.length === 2 &&
      ['drag', 'menu_bar', 'blocked_app'].includes(keyParts[0]);
    const decided = asking.then(async () => {
      let auditFailed = false;
      try {
        if (preapprovable && userListGrant(keyParts[1], 'high', keyParts[0], [callId])) return true;
      } catch { auditFailed = true; }
      if (!auditFailed && scoped && approved.has(key)) return true;
      let action;
      try {
        action = ask
          ? await ask(message, scoped, options.kind ? { kind: options.kind, detail: options.detail } : undefined)
          : await elicit(options.detail ? `${message} ${options.detail}` : message);
      } catch {
        action = 'cancel';
      }
      trace('local-approval', { key, action, ...(options.once ? { once: true } : {}) });
      if (action !== 'accept') return false;
      if (scoped) approved.add(key);
      return true;
    });
    asking = decided.catch(() => {});
    return decided;
  }

  async function callLocal(msg, plan) {
    localRunning.add(msg.id);
    let result;
    const name = msg.params.name;
    const args = msg.params.arguments ?? {};
    let resolved;
    if (name === 'select_window') clearSelection();
    try {
      // blocked_app reserves the whole app for its actions, like drag and
      // hover, and its consent names the resolved app even on reads.
      const appTool = ['drag', 'hover', 'blocked_app', 'select_window'].includes(name);
      if (appTool) {
        if (closing) throw new Error('Input lease: this session is closing.');
        resolved = await (localTools.target?.(args) ?? Promise.resolve(
          [leaseWindow?.app, leaseWindow?.appId].includes(args.app) ? leaseWindow : undefined));
      }
      if (leaseCalls.get(msg.id)?.localAction) {
        const target = resolved ?? { appId: 'desktop', app: 'macOS', title: 'local desktop controls', url: null };
        const key = inputLease.acquire(target, appTool ? 'app' : 'desktop');
        leaseCalls.set(msg.id, { key }); refreshHeartbeat();
      }
      const callArgs = name === 'select_window' && resolved
        ? { ...args, expectedAppId: resolved.appId } : args;
      result = await localTools.call(name, callArgs, async (parts, message, options) => {
        const allowed = await approve(parts, message, msg.id, options);
        if (closing || disposed) throw new Error('Input lease: this session is closing.');
        if (allowed) {
          const key = leaseCalls.get(msg.id)?.key;
          if (key) inputLease.renew([key]);
        }
        return allowed;
      // The fourth argument stays runLocal for callLocalTool; the resolved
      // lease target rides fifth, where blocked_app reads it.
      }, undefined, resolved);
      if (msg.params.name === 'select_window' && !result.isError) {
        const value = JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}');
        if (!value.ok || !value.target?.appId || typeof value.target?.title !== 'string' ||
            (resolved && value.target.appId !== resolved.appId)) throw new Error('Window selection returned no matching target');
        selectedWindow = value.target;
        leaseWindow = undefined;
      }
    } catch (err) {
      result = { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true };
    }
    localRunning.delete(msg.id);
    if (plan) flowRules.observe(result, plan);
    finishedCall(msg.id);
    const reply = { jsonrpc: '2.0', id: msg.id, result };
    reportPreapprovals(reply);
    toClient(reply);
  }

  function rotateTurn() {
    releaseLeases();
    turnId = randomUUID();
    turnUsed = false;
  }

  lines(clientIn, line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (documentMode || flowRules) return;
      serverIn.write(line + '\n');
      return;
    }
    // When each tool call arrived, so a trace can time the relay's own work on it.
    if (msg.method === 'tools/call') trace('call-received', { id: msg.id, method: msg.method, params: { name: msg.params?.name } });
    // Claude sometimes sends js the Bash tool's parameter name (6 of 437 calls, 2026-10-07).
    const jsArgs = msg.method === 'tools/call' && msg.params?.name === 'js' ? msg.params.arguments : undefined;
    if (jsArgs && jsArgs.code === undefined && typeof jsArgs.command === 'string') {
      const { command, ...rest } = jsArgs;
      msg.params.arguments = { ...rest, code: command };
    }
    // `let app = await cua.getApp("X"); app` echoes the handle it just bound, which the
    // acquisition adds nothing to. Haiku 5.5 sent it 3 times on 2026-10-08, and the lease
    // refused each one as an action.
    const echo = typeof msg.params?.arguments?.code === 'string' && jsArgs &&
      msg.params.arguments.code.trim().match(/^((?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.getApp\([^;]*\))\s*;\s*([A-Za-z_$][\w$]*)\s*;?$/);
    if (echo && echo[2] === echo[3]) msg.params.arguments.code = echo[1];
    handleClient(msg);
  });
  function handleClient(msg) {
    if (msg.method === 'server/discover' && msg.id !== undefined) {
      toClient({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    if (msg.method === undefined && elicitations.has(msg.id)) {
      elicitations.get(msg.id)(msg);
      elicitations.delete(msg.id);
      return;
    }
    if (closing && msg.method === 'tools/call') { leaseStop(msg, 'this session is closing.'); return; }
    if (msg.method === 'tools/call') {
      if (disposed) { changeStop(msg, 'session has ended'); return; }
      if (flowAsking) { flowStop(msg, 'wait for the user decision'); return; }
      if (flowRules && msg.params?.name === FLOW_TOOL.name) { flowException(msg); return; }
      if (flowRules && !['js', 'drag', 'menu_bar', 'blocked_app'].includes(msg.params?.name)) { flowPermit = undefined; flowPending = undefined; }
      if (changeReview && msg.params?.name === REVIEW_TOOL.name) { reviewChanges(msg); return; }
      if (reviewing) { changeStop(msg, 'the user is reviewing changes, wait for their decision'); return; }
    }
    const originalCode = msg.params?.arguments?.code;
    if (typeof originalCode === 'string') {
      const native = originalCode.match(/([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.getApp\(/);
      if (native) browserHandles.delete(native[1]);
    }
    const browser = msg.method === 'tools/call' && msg.params?.name === 'js' && browserCall(originalCode ?? '', browserHandles);
    if (msg.method === 'tools/call' && ['js', 'js_reset'].includes(msg.params?.name) && browserCalls.size) {
      leaseStop(msg, 'a browser candidate is pending; wait for its guarded result.'); return;
    }
    if (browser && (msg.id === undefined || running.size)) {
      leaseStop(msg, 'browser candidates need a request id and no pending call.'); return;
    }
    const healthPlan = msg.method === 'tools/call' && msg.params?.name === 'js' && !browser ? helperPlan(originalCode) : undefined;
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
      toClient({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `Computer use recovered for ${needsFullRead}. Send a standalone app read before acting. sleight will make it a full read because automatic recovery consumed the engine's UI diff.` }] } });
      return;
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'js_reset') { helperHandles.clear(); helperActive = undefined; docsShown = false; }
    if (msg.method === 'tools/call' && msg.params?.name === 'js' && msg.id !== undefined) jsCalls.set(msg.id, originalCode ?? '');
    let flowPlan, clipboardAction;
    if (clipboard && msg.method === 'tools/call' && ['js', 'js_reset'].includes(msg.params?.name) && clipboard.pending) {
      clipboardStop(msg, 'Clipboard: wait for the pending clipboard action, then retry.'); return;
    }
    if (clipboard && msg.method === 'tools/call' && msg.params?.name === 'js' && typeof originalCode === 'string') {
      try { clipboardAction = clipboardPlan(originalCode); }
      catch (error) { clipboardStop(msg, error.message); return; }
    }
    if (flowRules && msg.method === 'tools/call' && ['js', 'drag', 'menu_bar', 'blocked_app'].includes(msg.params?.name)) {
      if (running.size || localRunning.size || documentAsking || reviewing) { flowStop(msg, 'wait for the pending call or prompt'); return; }
      if (msg.id === undefined || (msg.params.name === 'js' && typeof originalCode !== 'string')) { flowStop(msg, 'a request id and JavaScript code are required'); return; }
      flowPlan = flowRules.analyze(msg.params.name, msg.params.arguments, lastWindow);
      const print = fingerprint(msg);
      const permitted = flowPermit?.fingerprint === print && flowPermit.revision === flowRules.revision;
      flowPermit = undefined;
      if (flowPlan.violations.length && !permitted) {
        const reason = flowPlan.violations.map(v => `rule '${v.rule}' stopped a transfer${v.source ? ` from ${v.source}` : ''} to ${v.app}`).join('; ');
        flowPending = { fingerprint: print, name: msg.params.name, args: structuredClone(msg.params.arguments ?? {}), reason, rules: flowPlan.violations.map(v => v.rule) };
        trace('flow-refused', { id: msg.id, violations: flowPlan.violations });
        flowStop(msg, reason); return;
      }
      flowPending = undefined;
    }
    if (documentMode && msg.method === 'tools/call') {
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
      trace('from-client', msg);
      if (flowPlan) flowRules.forward(flowPlan);
      turnUsed = true;
      clearTimeout(idleTimer);
      running.add(msg.id);
      callLocal(msg, flowPlan);
      return;
    }
    if (msg.method === 'tools/list' && msg.id !== undefined) listRequests.add(msg.id);
    if (msg.method === undefined && approvalRequests.has(msg.id)) {
      const key = approvalRequests.get(msg.id);
      approvalRequests.delete(msg.id);
      if (msg.result?.action === 'accept') {
        approved.add(key);
        if (msg.result._meta?.persist === undefined) {
          msg.result._meta = { ...msg.result._meta, persist: 'session' };
        }
      }
    }
    if (msg.method === 'tools/call' && msg.params) {
      const { name } = msg.params;
      if (clipboard && name === 'js_reset') clipboardResets.add(msg.id);
      if (name === TURN_END_TOOL) {
        msg.params.arguments = endTurnArgs(msg.params.arguments);
        toServer(msg);
        rotateTurn();
        return;
      }
      if (name === 'js') {
        if (!clipboard && typeof originalCode === 'string' && clipboardActions(originalCode).some(action => ['c', 'x'].includes(action))) nativeCopies.add(msg.id);
        const read = typeof originalCode === 'string' && isLeaseRead(originalCode);
        const safe = read || (typeof originalCode === 'string' && isChangeCancel(originalCode, lastWindowText));
        let entry, nativeDenied = leaseCalls.get(msg.id)?.nativeDenied;
        try {
          if (changeReview && !safe && lastWindow && changeCalls.size) throw new Error('another engine call is pending, wait for its result');
          if (changeReview && !safe && lastWindow?.url?.startsWith('file://')) {
            entry = changes.before(lastWindow);
            trace('snapshot-before-call', { id: msg.id, path: entry.path, directory: changes.directory, snapshot: entry.snapshot });
          }
        } catch (err) {
          if (browser && !documentMode) {
            nativeDenied = `Native access stopped: send a standalone native app read before acting. Cannot snapshot before acting: ${err.message}`;
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
          }
        }
        changeCalls.set(msg.id, { read, safe, entry, window: lastWindow, expected: documentKey(lastWindow), target: leaseWindow ?? lastWindow,
          observe: !read || (!isInventoryRead(originalCode) && /cua\.getApp\(|\.(?:getAXState|getAXStateAndScreenshot)\(/.test(originalCode)) });
        if (typeof originalCode === 'string') {
          const target = documentMode ? observedDocument : inputLease ? leaseWindow : lastWindow;
          const reason = documentMode ? undefined : selectedWindow ? `Selected window changed. ${selectionRecovery()}` : inputLease
            ? 'Input lease stopped this action: window or URL changed. Read the intended window again before acting.'
            : 'Change review stopped this action: window or URL changed. Read the intended window with one standalone cua.getApp call before editing.';
          if (browser && !documentMode) {
            msg.params.arguments.code = guardedCode(originalCode, target, reason,
              inputLease && leaseCalls.get(msg.id)?.key ? inputLease.grant(leaseCalls.get(msg.id).key) : undefined,
              { timing: guardTiming, fileOnly: changeReview, browserCandidate: true,
                skipAppWrap: browserHandles.has('app') || browser.handles.includes('app'),
                nativeDenied: nativeDenied ?? (!target
                  ? 'Native access stopped: send a standalone native app read before acting. No confirmed native window.' : undefined) });
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
            msg.params.arguments.code = readCode(code);
          }
          else if (documentMode || inputLease || (changeReview && target)) msg.params.arguments.code = guardedCode(originalCode, target, reason,
            inputLease ? inputLease.grant(leaseCalls.get(msg.id)?.key) : undefined,
            { timing: guardTiming, fileOnly: changeReview && !documentMode, cancelOnly: changeReview && !documentMode && safe,
              adoptUrl: !documentMode && !changeReview, skipAppWrap: browserHandles.has('app') });
          if (clipboard) msg.params.arguments.code = clipboardCode(msg.params.arguments.code, clipboardAction);
        }
      }
      if (browser) browserCalls.set(msg.id, browser);
      msg.params._meta = { ...msg.params._meta, [META_KEY]: turnMeta() };
      turnUsed = true;
      clearTimeout(idleTimer);
      if (msg.id !== undefined) running.add(msg.id);
      if (flowPlan) { flowRules.forward(flowPlan); flowCalls.set(msg.id, flowPlan); }
    }
    if (clipboardAction) {
      let response;
      clipboard.run(clipboardAction, () => new Promise((resolve, reject) => {
        if (closing) { reject(new Error('Clipboard guard: session closed before input.')); return; }
        clipboardReplies.set(msg.id, { reject, receive: reply => {
          response = reply;
          if (reply.error || reply.result?.isError) reject(new Error('Clipboard guard: engine action failed; Copy/Cut ownership cannot be attributed.'));
          else resolve(reply);
        } });
        toServer(msg);
      })).then(({ notices }) => { clipboardNotices(response, notices); observeServerMessage(response); }, error => {
        const result = response ?? { jsonrpc: '2.0', id: msg.id, result: { content: [] } };
        result.result = { ...(result.result ?? {}), isError: true, content: [...(result.result?.content ?? []), { type: 'text', text: error.message }] };
        clipboardNotices(result, error.clipboardNotices);
        observeServerMessage(result);
      });
    } else toServer(msg);
  }

  lines(serverOut, line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      clientOut.write(line + '\n');
      return;
    }
    // Only the id: with to-server and to-client it splits engine time from the relay's own.
    trace('from-server', { id: msg.id, method: msg.method });
    if (msg.method === undefined && clipboardReplies.has(msg.id)) {
      const pending = clipboardReplies.get(msg.id); clipboardReplies.delete(msg.id); pending.receive(msg); return;
    }
    observeServerMessage(msg);
  });
  function observeServerMessage(msg) {
    if (msg.method === undefined && Array.isArray(msg.result?.content)) {
      msg.result.content = stripGuardTiming(msg.result.content, metric => trace('guard-read', { id: msg.id, ...metric }));
    }
    let windowNote;
    const confirmedBrowser = msg.method === undefined && browserCalls.has(msg.id) && browserReply(msg);
    if (msg.method === undefined && clipboardResets.delete(msg.id) && !msg.error && !msg.result?.isError) {
      clipboard.reset().then(() => observeServerMessage(msg), error => {
        msg.result = { ...(msg.result ?? {}), isError: true };
        clipboardNotices(msg, ['Clipboard: reset cleanup failed: ' + error.message]);
        observeServerMessage(msg);
      });
      return;
    }
    if (msg.method === undefined && nativeCopies.delete(msg.id) && !msg.error && !msg.result?.isError) {
      clipboardNotices(msg, ['Copy/Cut used the native clipboard. Its contents were not restored by sleight; a successful copy remains available to menu Paste, pbpaste and browser pastes.']);
    }
    if (msg.method === undefined && msg.id !== undefined && internalRequests.has(msg.id)) {
      internalRequests.get(msg.id)(msg);
      internalRequests.delete(msg.id);
      return;
    }
    if (msg.method === undefined && browserCalls.has(msg.id)) {
      const browser = browserCalls.get(msg.id); browserCalls.delete(msg.id);
      for (const handle of browser.handles) {
        if (confirmedBrowser) browserHandles.add(handle);
        else browserHandles.delete(handle);
      }
    }
    if (msg.method === undefined && lateHelperReplies.delete(msg.id)) return;
    const jsCode = msg.method === undefined ? jsCalls.get(msg.id) : undefined;
    // Reading after ⌘W closed the last window fails with noWindowsAvailable, but the
    // close worked (7 of 437 calls, 2026-10-07). Say so instead of reporting an error.
    if (jsCode !== undefined && msg.result?.isError && /\bsuper\+w\b|cmd\+w\b|command\+w\b/i.test(jsCode) &&
        (msg.result.content ?? []).some(c => c.type === 'text' && /noWindowsAvailable/.test(c.text ?? ''))) {
      msg.result = { ...msg.result, isError: false, content: [{ type: 'text', text: 'sleight: the app has no windows left, so the window this call closed was its last. Nothing more to read.' }] };
    }
    if (msg.method === undefined && jsCalls.delete(msg.id) && Array.isArray(msg.result?.content)) {
      const docs = msg.result.content.some(c => c.type === 'text' && /(^|\n)## Computer Use\n/.test(c.text ?? ''));
      if (docs && docsShown) {
        // An un-awaited action that fails can end the engine's session (reproduced 2026-10-07).
        forgetHandles(); helperHandles.clear(); helperActive = undefined;
        trace('engine-session-restarted', { id: msg.id });
        msg.result.content.push({ type: 'text', text: "sleight: the engine's JavaScript session restarted before this call, so handles from earlier calls (such as `app`) are gone. An action that fails without `await` can end the session. Acquire the app again with `let app = await cua.getApp(…)`, and await every action." });
      }
      // The engine's first call returns its docs and nothing else Claude can act on, so sleight's
      // own rules ride along here instead of costing Claude a skill turn (one per benchmark run).
      if (docs && firstCallRules && !rulesShown) {
        rulesShown = true;
        msg.result.content.push({ type: 'text', text: firstCallRules });
      }
      if (docs) docsShown = true;
    }
    const healthPlan = msg.method === undefined ? helperReads.get(msg.id) : undefined;
    if (healthPlan) { helperReads.delete(msg.id); updateHelperRead(healthPlan, msg); }
    const helperStuck = helperStates.get(healthPlan?.key)?.stuck;
    const automatic = helperProbes.has(msg.id);
    if (msg.method === undefined && flowCalls.has(msg.id)) {
      flowRules.observe(msg.result, flowCalls.get(msg.id));
      flowCalls.delete(msg.id);
    }
    if (documentMode && isAppApproval(msg)) { documentEngineApproval(msg); return; }
    if (msg.method === undefined && changeCalls.has(msg.id)) {
      const call = changeCalls.get(msg.id);
      changeCalls.delete(msg.id);
      const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (call.observe && !automatic && !confirmedBrowser) { lastWindowText = text; lastWindow = windowFromText(text); }
      if (!confirmedBrowser && selectedWindow && !call.read && call.target && msg.result &&
          (!lastWindow || ['title', 'app', 'url'].some(key => lastWindow[key] !== call.target[key]))) {
        windowNote = `Sleight: outcome unconfirmed. Intended ${documentLabel(call.target)}. ` +
          (lastWindow ? `Observed ${documentLabel(lastWindow)}.` : 'Result missing full window header.');
      }
      // Keep the initial acquisition check, but release a verified selection
      // when a successful full observation confirms a different window.
      if (!confirmedBrowser && selectedWindow && selectionVerified && !automatic && call.observe && !msg.error && !msg.result?.isError &&
          lastWindow && !sameWindow(lastWindow, selectedWindow)) clearSelection();
      // The Open click and its standalone reread can overlap. Judge safety at
      // the read's completion, after earlier action results have been recorded.
      const actionPending = [...changeCalls.values()].some(pending => !pending.safe);
      if (!confirmedBrowser && changeReview && !automatic && call.read && call.observe && actionPending && !msg.error && !msg.result?.isError) {
        msg.result.content.push({ type: 'text', text: 'Change review: an action is still pending, so this read cannot take a later copy. Wait for its result, then take another standalone cua.getApp read before editing.' });
      }
      if (!confirmedBrowser && changeReview && !automatic && call.read && call.observe && !actionPending && !msg.error && !msg.result?.isError) {
        try {
          const entry = changes.read(lastWindow);
          if (entry) trace('snapshot-after-read', { id: msg.id, path: entry.path, directory: changes.directory, snapshot: entry.snapshot });
        } catch (err) {
          trace('snapshot-read-failed', { id: msg.id, error: err.message });
          msg.result.content.push({ type: 'text', text: `Change review could not take a later copy: ${err.message}. Reads remain available.` });
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
            'Document scope stopped: Window or URL changed, or a full header is missing. That call may already have acted. Stop and read the intended window, then ask the user with document_scope.' }] };
          if (!call.read) observedDocument = undefined;
        }
      }
    }
    if (inputLease && !automatic && !confirmedBrowser && msg.method === undefined && leaseCalls.get(msg.id)?.observe) {
      const call = leaseCalls.get(msg.id);
      const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      // A guard stop happens before its action and carries the header it just read.
      const guardStop = msg.result?.isError && /^sleight stopped before /m.test(text);
      const window = !msg.error && (!msg.result?.isError || guardStop) && windowFromText(text);
      const appId = msg.result?._meta?.['codex/toolSurface']?.app?.appId;
      const cached = call.acquisition ? selectorWindows.get(call.selector)
        : call.handle ? handleBundles.get(call.handle) : leaseWindow;
      const matches = window && cached && (call.acquisition
        ? documentKey(cached.window) === documentKey(window) : cached.app === window.app);
      const known = window && (typeof appId === 'string' && appId ? appId : matches ? cached.appId : undefined);
      leaseWindow = window ? { ...window, ...(known ? { appId: known } : {}) } : undefined;
      if (call.handle) {
        if (known) handleBundles.set(call.handle, leaseWindow);
        else if (call.acquisition) handleBundles.delete(call.handle);
      }
      if (known) {
        recoveryTarget = `cua.getApp(${JSON.stringify(known)})`;
        if (call.selector) selectorWindows.set(call.selector, { window, appId: known });
        selectorWindows.set(JSON.stringify(known), { window, appId: known });
      } else if (window) {
        // A failed acquisition (an invalid app name) never becomes the advice.
        const selector = call.selector ?? handleSelectors.get(call.handle);
        recoveryTarget = selector ? `cua.getApp(${selector})` : `cua.getApp(${JSON.stringify(window.app)})`;
      }
      if (selectedWindow && call.acquisition) {
        if (known && known !== selectedWindow.appId) {
          // A deliberate acquisition of another app ends this selection.
          selectedWindow = undefined; selectionVerified = false;
        } else {
          selectionVerified = !msg.result?.isError && sameWindow(window, selectedWindow) && known === selectedWindow.appId;
          if (!selectionVerified) windowNote = `Sleight: selected window not observed. ${selectionRecovery()}`;
        }
      }
    }
    if (windowNote && msg.result) msg.result.content = [...(msg.result.content ?? []), { type: 'text', text: windowNote }];
    // The engine refuses Terminal, iTerm2 and OpenAI's own apps before any
    // approval, so a user consent can never enable the engine on them. Say so,
    // and offer sleight's own Accessibility path: the prompt is the opt-in.
    // The helper quits after about 20 s idle and relaunches on the next call;
    // a call during that restart can fail before reaching any app (2026-10-05).
    if (msg.method === undefined && msg.result?.isError && Array.isArray(msg.result.content) &&
      msg.result.content.some(c => c.type === 'text' && /Sky Computer Use (?:native pipe|service) startup (?:request )?failed/.test(c.text ?? ''))) {
      msg.result.content.push({ type: 'text', text: "sleight: the engine couldn't reach its helper (SkyComputerUseService), so this call never reached an app. The helper quits after about 20 seconds idle and restarts on the next call, which can race. Retry the same call once. If it fails again, call js_reset and retry. If that fails too, tell the user; `sleight-mcp --doctor` prints a fix when macOS won't relaunch the helper." });
    }
    if (localNames.has('blocked_app') && msg.method === undefined && msg.result) {
      const text = (msg.result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const refused = refusedApp(text);
      if (refused) {
        trace('blocked-app-refusal', { app: refused });
        msg.result = { ...msg.result, content: [...(msg.result.content ?? []), { type: 'text', text:
          `The engine's helper refuses ${refused} before any approval, so the js tool cannot drive it. ` +
          "sleight's blocked_app tool drives the app through macOS Accessibility instead: the user approves " +
          'the app once per session, and each command send to a terminal is shown to them first. ' +
          'Ask the user, then use blocked_app; its settings windows are refused.' }] };
      }
    }
    if (msg.method === undefined) { reportPreapprovals(msg); finishedCall(msg.id); }
    if (engineForbiddenTargets && isAppApproval(msg)) {
      const warning = forbiddenTargetWarning(msg.params?._meta?.tool_params?.app);
      if (warning && msg.params) msg.params.message = `${msg.params.message ?? 'Allow Computer Use?'} ${warning}`;
    }
    if (isAppApproval(msg)) {
      let granted;
      try {
        granted = userListGrant(msg.params?._meta?.tool_params?.app,
          msg.params?._meta?.riskLevel, 'engine', [...running].filter(id => !localRunning.has(id)));
      } catch {
        // An audit failure must reach a person, even with a remembered approval.
        if (ask) askUser(msg, true);
        else {
          const key = approvalScope === 'session' ? approvalKey(msg) : undefined;
          if (key !== undefined) approvalRequests.set(msg.id, key);
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
    if (ask && (isAppApproval(msg) || (msg.method === 'elicitation/create' && msg.params?._meta?.connector_id === 'browser-use'))) {
      askUser(msg);
      return;
    }
    const key = approvalScope === 'session' ? approvalKey(msg) : undefined;
    if (key !== undefined) {
      if (approved.has(key)) {
        trace('answered-for-session', msg);
        toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept', content: {}, _meta: { persist: 'session' } } });
        return;
      }
      approvalRequests.set(msg.id, key);
    }
    if (msg.method === undefined && listRequests.delete(msg.id) && Array.isArray(msg.result?.tools)) {
      msg.result.tools = msg.result.tools
        .filter(t => !HIDDEN_TOOLS.has(t.name))
        .filter(t => !documentMode || t.name === 'js' || t.name === TURN_END_TOOL)
        .map(t => (t.name === TURN_END_TOOL ? internalTurnEnd(t) : t))
        .concat(documentMode ? [DOCUMENT_TOOL, ...(localTools?.tools ?? []).filter(t => t.name === 'select_window')] : (localTools?.tools ?? []), changeReview ? [REVIEW_TOOL] : [], flowRules ? [FLOW_TOOL] : []);
    }
    // Last, after every check above has read the full tree.
    if (msg.method === undefined && Array.isArray(msg.result?.content)) {
      msg.result.content = compactor.process(dropRepeatedImages(msg.result.content));
    }
    toClient(msg);
  }

  // Ends the open turn, if any call used it. Resolves once the server answers
  // or after a short grace period.
  async function endOpenTurn() {
    if (inputLease && running.size) await new Promise(resolve => drained.add(resolve));
    if (!turnUsed) return Promise.resolve();
    const id = `sleight-${nextInternalId++}`;
    const done = new Promise(resolve => {
      internalRequests.set(id, resolve);
      setTimeout(resolve, SHUTDOWN_GRACE_MS).unref();
    });
    toServer({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: TURN_END_TOOL, arguments: endTurnArgs() },
    });
    rotateTurn();
    return done;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(idleTimer);
    for (const resolve of elicitations.values()) resolve({ result: { action: 'cancel' } });
    elicitations.clear();
    flowRules?.dispose();
    flowCalls.clear(); flowPending = undefined; flowPermit = undefined;
    preapprovalNotes.clear();
    helperReads.clear();
    for (const state of helperStates.values()) clearTimeout(state.timer);
    for (const probe of helperProbes.values()) clearTimeout(probe.timer);
    helperStates.clear(); helperHandles.clear(); helperAliases.clear(); helperProbes.clear(); helperFullReads.clear();
    changes.dispose();
    trace('change-snapshots-deleted', { directory: changes.directory });
  }
  function close() {
    closing = true;
    for (const pending of clipboardReplies.values()) pending.reject(new Error('Clipboard guard: engine connection closed.'));
    clipboardReplies.clear();
    clearTimeout(idleTimer);
    try { dispose(); } finally { releaseLeases(); }
    return clipboard?.close() ?? Promise.resolve();
  }
  async function shutdown() {
    closing = true;
    await endOpenTurn();
    await close();
  }
  return { endOpenTurn, shutdown, close, dispose: close, get snapshotDirectory() { return changes.directory; }, get sessionId() { return sessionId; }, get turnId() { return turnId; } };
}
