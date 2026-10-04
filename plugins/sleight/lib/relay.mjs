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
// message)` asks the user once per key and session, through `ask` when given,
// else through an elicitation sent to Claude Code. launch.mjs uses this for the
// menu bar and notifications, which the engine can't reach.
//
// `idleTurnEndMs`, when given, ends a used turn once no engine call has been
// running for that long. Hosts without the mod (the desktop app's Claude Code)
// never end the engine's turn, and the engine keeps holding the app (its badge
// on the window) until the session closes.
//
// `trace`, when given, receives every message as it passes, for debugging.

import { randomUUID } from 'node:crypto';
import { DOCUMENT_TOOL, documentKey, documentLabel, windowFromText, isDocumentRead, readCode, guardedCode } from './document-scope.mjs';
import { ChangeReview, REVIEW_TOOL } from './change-review.mjs';
import { FLOW_TOOL } from './flow-rules.mjs';
import { isLeaseRead } from './input-lease.mjs';
import { isInventoryRead } from './inventory-read.mjs';

const META_KEY = 'x-codex-turn-metadata';
const HIDDEN_TOOLS = new Set(['js_add_node_module_dir']);
const TURN_END_TOOL = 'turn_ended';
const TURN_END_DESCRIPTION = 'Internal to sleight: its hooks call this when a Claude turn ends. Never call it yourself.';
const SHUTDOWN_GRACE_MS = 3000;

// Splits a stream into newline-delimited JSON-RPC messages.
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
  flowRules,
  // Off by default: its window guard stops Open dialogs and late-found documents (0/2 TextEdit
  // benchmark tasks, 2026-10-04). SLEIGHT_CHANGE_REVIEW=1 turns it on.
  changeReview = false,
  idleTurnEndMs,
  inputLease,
  onLeaseFault = () => {},
  trace: writeTrace = () => {},
}) {
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
  let reviewing = false;
  let disposed = false;
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
          : elicitReview(`Review ${entry.title}\n${detail}\nChoose Keep, Undo or Later. Undo restores the session's original saved file. Reopen it in the app afterward.`));
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
  let constApp = false;
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

  function prepareLease(msg) {
    if (!inputLease || msg.method !== 'tools/call') return true;
    const name = msg.params?.name;
    if (name === TURN_END_TOOL) {
      if (running.size) { leaseStop(msg, 'an action or read is still running; end the turn after it finishes.'); return false; }
      return true;
    }
    if (name === DOCUMENT_TOOL.name) return true;
    if (name === 'js_reset') { leaseWindow = undefined; handleBundles.clear(); handleSelectors.clear(); constApp = false; return true; }
    if (name !== 'js' && !localNames.has(name)) return true;
    const args = msg.params.arguments ?? {};
    const code = args.code;
    if (name === 'js' && typeof code !== 'string') { leaseStop(msg, 'js needs code.'); return false; }
    const read = name === 'js' ? typeof code === 'string' && isLeaseRead(code)
      : (name === 'menu_bar' && args.op === 'apps') || (name === 'notifications' && args.op === 'list');
    const acquisition = read && code?.trim().match(/^(?:(?:(let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*)?await\s+cua\.getApp\(\s*(.*?)\s*\)\s*;?$/s);
    const handle = acquisition ? acquisition[2] ?? (constApp ? undefined : 'app')
      : read && code?.match(/([A-Za-z_$][\w$]*)\.(?:getAXState|getAXStateAndScreenshot|getScreenshot)\(/)?.[1];
    const selector = acquisition?.[3];
    if (selector) recoveryTarget = `cua.getApp(${selector})`;
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
      if (!leaseWindow?.appId) {
        const recovery = recoveryTarget ? `${constApp ? '' : 'app = '}await ${recoveryTarget}` : 'await cua.getState()';
        leaseStop(msg, `a bundle ID and full window header are required. Send exactly \u0060${recovery}\u0060 in js, then read the intended window before acting.`);
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
  function approve(keyParts, message, callId) {
    const key = JSON.stringify(['sleight', ...keyParts]);
    const scoped = approvalScope === 'session';
    const decided = asking.then(async () => {
      let auditFailed = false;
      try {
        if (keyParts.length === 2 && ['drag', 'menu_bar'].includes(keyParts[0]) &&
            userListGrant(keyParts[1], 'high', keyParts[0], [callId])) return true;
      } catch { auditFailed = true; }
      if (!auditFailed && scoped && approved.has(key)) return true;
      let action;
      try {
        action = ask ? await ask(message, scoped) : await elicit(message);
      } catch {
        action = 'cancel';
      }
      trace('local-approval', { key, action });
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
    try {
      if (leaseCalls.get(msg.id)?.localAction) {
        const name = msg.params.name;
        const args = msg.params.arguments ?? {};
        const appTool = ['drag', 'hover'].includes(name);
        const target = appTool ? await (localTools.target?.(args) ?? Promise.resolve(
          [leaseWindow?.app, leaseWindow?.appId].includes(args.app) ? leaseWindow : undefined))
          : { appId: 'desktop', app: 'macOS', title: 'local desktop controls', url: null };
        if (closing) throw new Error('Input lease: this session is closing.');
        const key = inputLease.acquire(target, appTool ? 'app' : 'desktop');
        leaseCalls.set(msg.id, { key }); refreshHeartbeat();
      }
      result = await localTools.call(msg.params.name, msg.params.arguments ?? {}, async (parts, message) => {
        const allowed = await approve(parts, message, msg.id);
        if (closing || disposed) throw new Error('Input lease: this session is closing.');
        if (allowed) {
          const key = leaseCalls.get(msg.id)?.key;
          if (key) inputLease.renew([key]);
        }
        return allowed;
      });
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
      if (flowRules && !['js', 'drag', 'menu_bar'].includes(msg.params?.name)) { flowPermit = undefined; flowPending = undefined; }
      if (changeReview && msg.params?.name === REVIEW_TOOL.name) { reviewChanges(msg); return; }
      if (reviewing) { changeStop(msg, 'the user is reviewing changes, wait for their decision'); return; }
    }
    const originalCode = msg.params?.arguments?.code;
    let flowPlan;
    if (flowRules && msg.method === 'tools/call' && ['js', 'drag', 'menu_bar'].includes(msg.params?.name)) {
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
      if (name !== 'js' && name !== TURN_END_TOOL) {
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
      } else if (!prepareLease(msg)) return;
    } else if (!prepareLease(msg)) return;
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
      if (name === TURN_END_TOOL) {
        msg.params.arguments = endTurnArgs(msg.params.arguments);
        toServer(msg);
        rotateTurn();
        return;
      }
      if (name === 'js') {
        const read = typeof originalCode === 'string' && isLeaseRead(originalCode);
        let entry;
        try {
          if (changeReview && !read && lastWindow?.url?.startsWith('file://') && changeCalls.size) throw new Error('another engine call is pending, wait for its result');
          if (changeReview && !read && lastWindow?.url?.startsWith('file://')) {
            entry = changes.before(lastWindow);
            trace('snapshot-before-call', { id: msg.id, path: entry.path, directory: changes.directory, snapshot: entry.snapshot });
          }
        } catch (err) { documentCalls.delete(msg.id); finishedCall(msg.id); changeStop(msg, `cannot snapshot before acting: ${err.message}`); return; }
        changeCalls.set(msg.id, { read, entry, expected: documentKey(lastWindow),
          observe: !read || (!isInventoryRead(originalCode) && /cua\.getApp\(|\.(?:getAXState|getAXStateAndScreenshot)\(/.test(originalCode)) });
        if (typeof originalCode === 'string') {
          const target = documentMode ? observedDocument : inputLease ? leaseWindow : lastWindow;
          const reason = documentMode ? undefined : inputLease
            ? 'Input lease stopped this action: window or URL changed. Read the intended window again before acting.'
            : 'Change review stopped this action: window or URL changed. Read the intended window with one standalone cua.getApp call before editing.';
          if (read) msg.params.arguments.code = readCode(originalCode);
          else if (documentMode || inputLease || entry) msg.params.arguments.code = guardedCode(originalCode, target, reason,
            inputLease?.grant(leaseCalls.get(msg.id)?.key));
        }
      }
      msg.params._meta = { ...msg.params._meta, [META_KEY]: turnMeta() };
      turnUsed = true;
      clearTimeout(idleTimer);
      if (msg.id !== undefined) running.add(msg.id);
      if (flowPlan) { flowRules.forward(flowPlan); flowCalls.set(msg.id, flowPlan); }
    }
    toServer(msg);
  });

  lines(serverOut, line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      clientOut.write(line + '\n');
      return;
    }
    if (msg.method === undefined && msg.id !== undefined && internalRequests.has(msg.id)) {
      internalRequests.get(msg.id)(msg);
      internalRequests.delete(msg.id);
      return;
    }
    if (msg.method === undefined && flowCalls.has(msg.id)) {
      flowRules.observe(msg.result, flowCalls.get(msg.id));
      flowCalls.delete(msg.id);
    }
    if (documentMode && isAppApproval(msg)) { documentEngineApproval(msg); return; }
    if (msg.method === undefined && changeCalls.has(msg.id)) {
      const call = changeCalls.get(msg.id);
      changeCalls.delete(msg.id);
      const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (call.observe) lastWindow = windowFromText(text);
      if (changeReview && !call.read) {
        changes.after(call.entry, !msg.error && !msg.result?.isError && documentKey(lastWindow) === call.expected);
        // A window first identified after an action has no trustworthy before copy.
        for (const window of windowsInText(text)) {
          if (documentKey(window) !== call.expected) changes.uncaptured(window);
        }
      }
    }
    if (documentMode && msg.method === undefined && documentCalls.has(msg.id)) {
      const call = documentCalls.get(msg.id);
      documentCalls.delete(msg.id);
      if (call.observe) {
        const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        observedDocument = windowFromText(text);
        if (call.read) {
          observedEngines = call.engines;
          observedRisks = call.risks;
          const appId = msg.result?._meta?.['codex/toolSurface']?.app?.appId;
          if (typeof appId === 'string') observedEngines.add(appId);
        }
        if (!msg.error && (!observedDocument || (call.expected && call.expected !== documentKey(observedDocument)))) {
          msg.result = { ...(msg.result ?? {}), isError: true, content: [...(msg.result?.content ?? []), { type: 'text', text:
            'Document scope stopped: Window or URL changed, or a full header is missing. That call may already have acted. Stop and read the intended window, then ask the user with document_scope.' }] };
          if (!call.read) observedDocument = undefined;
        }
      }
    }
    if (inputLease && msg.method === undefined && leaseCalls.get(msg.id)?.observe) {
      const call = leaseCalls.get(msg.id);
      const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const window = !msg.error && !msg.result?.isError && windowFromText(text);
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
      } else {
        const selector = call.selector ?? handleSelectors.get(call.handle);
        if (selector) recoveryTarget = `cua.getApp(${selector})`;
        else if (window) recoveryTarget = `cua.getApp(${JSON.stringify(window.app)})`;
      }
    }
    if (msg.method === undefined) { reportPreapprovals(msg); finishedCall(msg.id); }
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
    if (ask && isAppApproval(msg)) {
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
        .concat(documentMode ? [DOCUMENT_TOOL] : (localTools?.tools ?? []), changeReview ? [REVIEW_TOOL] : [], flowRules ? [FLOW_TOOL] : []);
    }
    toClient(msg);
  });

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
    changes.dispose();
    trace('change-snapshots-deleted', { directory: changes.directory });
  }
  function close() {
    closing = true;
    clearTimeout(idleTimer);
    try { dispose(); } finally { releaseLeases(); }
  }
  async function shutdown() {
    closing = true;
    await endOpenTurn();
    close();
  }
  return { endOpenTurn, shutdown, close, dispose: close, get snapshotDirectory() { return changes.directory; }, get sessionId() { return sessionId; }, get turnId() { return turnId; } };
}
