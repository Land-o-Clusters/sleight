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
  localTools,
  idleTurnEndMs,
  trace = () => {},
}) {
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
  let idleTimer;
  const documentMode = approvalScope === 'document';
  const documentGrants = new Set();
  const documentRisks = new Set();
  const documentCalls = new Map();
  let observedDocument;
  let observedEngines = new Set();
  let observedRisks = new Set();
  let documentAsking = false;

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
    if (!idleTurnEndMs || running.size || !turnUsed) return;
    idleTimer = setTimeout(() => {
      trace('idle-turn-end', { turnId });
      endOpenTurn();
    }, idleTurnEndMs);
    idleTimer.unref?.();
  }
  let nextElicitId = 0;

  const toServer = msg => {
    trace('to-server', msg);
    serverIn.write(JSON.stringify(msg) + '\n');
  };
  const toClient = msg => {
    trace('to-client', msg);
    clientOut.write(JSON.stringify(msg) + '\n');
  };

  function turnMeta() {
    return JSON.stringify({ session_id: sessionId, turn_id: turnId });
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
  function askUser(msg) {
    const key = approvalScope === 'session' ? approvalKey(msg) : undefined;
    asking = asking.then(async () => {
      if (key !== undefined && approved.has(key)) {
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

  // Approval for a local tool: once per key and session, like app approvals.
  function approve(keyParts, message) {
    const key = JSON.stringify(['sleight', ...keyParts]);
    const scoped = approvalScope === 'session';
    const decided = asking.then(async () => {
      if (scoped && approved.has(key)) return true;
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

  async function callLocal(msg) {
    let result;
    try {
      result = await localTools.call(msg.params.name, msg.params.arguments ?? {}, approve);
    } catch (err) {
      result = { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true };
    }
    toClient({ jsonrpc: '2.0', id: msg.id, result });
  }

  function rotateTurn() {
    turnId = randomUUID();
    turnUsed = false;
  }

  lines(clientIn, line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (documentMode) return;
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
        documentCalls.set(msg.id, { read, expected: read ? undefined : documentKey(observedDocument), engines: new Set(), risks: new Set() });
        msg.params.arguments = { ...msg.params.arguments, code: read ? readCode(code) : guardedCode(code, observedDocument) };
      }
    }
    if (msg.method === 'tools/call' && localNames.has(msg.params?.name)) {
      trace('from-client', msg);
      callLocal(msg);
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
      msg.params._meta = { ...msg.params._meta, [META_KEY]: turnMeta() };
      turnUsed = true;
      clearTimeout(idleTimer);
      if (msg.id !== undefined) running.add(msg.id);
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
    if (documentMode && isAppApproval(msg)) { documentEngineApproval(msg); return; }
    if (documentMode && msg.method === undefined && documentCalls.has(msg.id)) {
      const call = documentCalls.get(msg.id);
      documentCalls.delete(msg.id);
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
    if (msg.method === undefined && running.delete(msg.id)) scheduleIdleEnd();
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
        .concat(documentMode ? [DOCUMENT_TOOL] : (localTools?.tools ?? []));
    }
    toClient(msg);
  });

  // Ends the open turn, if any call used it. Resolves once the server answers
  // or after a short grace period.
  function endOpenTurn() {
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

  return { endOpenTurn, get sessionId() { return sessionId; }, get turnId() { return turnId; } };
}
