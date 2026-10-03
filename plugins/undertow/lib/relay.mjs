// A stdio relay between Claude Code and the computer-use server.
//
// The server scopes app approvals and cleanup to a Codex session and turn,
// read from `_meta["x-codex-turn-metadata"]` on each tool call. Claude Code
// sends no such field, so the relay supplies it:
//
// - session_id: one per relay process. Claude Code starts one server process
//   per session, so approvals last for the session, as in Codex.
// - turn_id: rotates each time the turn ends. A `turn_ended` call (sent by the
//   undertow mod at the end of each Claude turn) gets the current ids filled
//   in, then the next call starts a new turn.
//
// It also keeps the server's host-only tools out of the model's tool list,
// and ends the open turn when Claude Code closes the connection.

import { randomUUID } from 'node:crypto';

const META_KEY = 'x-codex-turn-metadata';
const HIDDEN_TOOLS = new Set(['turn_ended', 'js_add_node_module_dir']);
const TURN_END_TOOL = 'turn_ended';
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

export function createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId = randomUUID() }) {
  let turnId = randomUUID();
  let turnUsed = false;
  let nextInternalId = 0;
  const listRequests = new Set();
  const internalRequests = new Map();

  const toServer = msg => serverIn.write(JSON.stringify(msg) + '\n');
  const toClient = msg => clientOut.write(JSON.stringify(msg) + '\n');

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

  function rotateTurn() {
    turnId = randomUUID();
    turnUsed = false;
  }

  lines(clientIn, line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      serverIn.write(line + '\n');
      return;
    }
    if (msg.method === 'tools/list' && msg.id !== undefined) listRequests.add(msg.id);
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
    if (msg.id !== undefined && internalRequests.has(msg.id)) {
      internalRequests.get(msg.id)(msg);
      internalRequests.delete(msg.id);
      return;
    }
    if (msg.id !== undefined && listRequests.has(msg.id)) {
      listRequests.delete(msg.id);
      if (Array.isArray(msg.result?.tools)) {
        msg.result.tools = msg.result.tools.filter(t => !HIDDEN_TOOLS.has(t.name));
      }
    }
    toClient(msg);
  });

  // Ends the open turn, if any call used it. Resolves once the server answers
  // or after a short grace period.
  function endOpenTurn() {
    if (!turnUsed) return Promise.resolve();
    const id = `undertow-${nextInternalId++}`;
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
