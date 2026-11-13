// Guest MCP client. Importing this file never starts a process or reads the desktop.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, ROOT } from './kit.mjs';
import { verifyKit } from './guest-integrity.mjs';

export const RESULT_SCHEMA = 'sleight.windows-real-tasks/1';
export const TASK_IDS = Object.freeze(['notepad', 'explorer', 'edge', 'blocked-app', 'approval', 'escape']);
const textOf = reply => (reply?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const fail = code => { throw Error(code); };
const MAX_REPLY = 8 * 1024 * 1024;

export function createMcpSession({ spawnChild = spawn, allowFixtureApprovals = false, timeoutMs = 55000,
  closeMs = 5000, env = process.env } = {}) {
  // A disposable test guest gets product defaults. Never turn off a safety guard.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('SLEIGHT_')));
  childEnv.SLEIGHT_HAND = '0';
  const child = spawnChild(process.execPath, [fileURLToPath(new URL('../../plugins/sleight/lib/launch.mjs', import.meta.url))],
    { cwd: ROOT, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let seq = 0, task, buffer = Buffer.alloc(0), ended = false, poisoned, closing;
  const pending = new Map(), approvals = [];
  let stderr = '';
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const rejectAll = error => {
    poisoned ??= error;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  child.on('error', () => rejectAll(Error('MCP_SPAWN_FAILED')));
  child.stdin.on('error', () => rejectAll(Error('MCP_STDIN_FAILED')));
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-2048); });
  const closed = new Promise(resolve => child.once('close', code => {
    ended = true; rejectAll(Error('MCP_EXIT_' + code)); resolve(code);
  }));
  const receive = message => {
    if (message.method === 'elicitation/create' && message.id !== undefined) {
      const meta = message.params?._meta, app = meta?.tool_params?.app;
      const expected = task === 'notepad' ? 'notepad.exe' : task === 'explorer' ? 'explorer.exe' : undefined;
      const accept = !poisoned && pending.size > 0 && allowFixtureApprovals && expected && typeof app === 'string' && app.toLowerCase() === expected &&
        message.params.mode === 'form' && meta.connector_id === 'computer-use' &&
        Array.isArray(meta.persist) && meta.persist.length === 1 && meta.persist[0] === 'session';
      const action = accept ? 'accept' : 'decline';
      approvals.push({ task, app: typeof app === 'string' ? app : 'unknown', action });
      send({ id: message.id, result: { action, content: {} } });
    } else if (message.method && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
    } else if (message.method === undefined && pending.has(message.id)) {
      const p = pending.get(message.id); clearTimeout(p.timer); pending.delete(message.id);
      message.error ? p.reject(Error('MCP_RPC_ERROR_' + message.error.code)) : p.resolve(message.result);
    }
  };
  child.stdout.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    if (buffer.length > MAX_REPLY) return rejectAll(Error('MCP_OUTPUT_LIMIT'));
    let end;
    while ((end = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      try { receive(JSON.parse(line.toString('utf8'))); }
      catch { rejectAll(Error('MCP_PROTOCOL')); }
    }
  });
  return {
    approvals,
    setTask(id) { task = id; },
    notify(method, params = {}) { if (poisoned) throw poisoned; send({ method, params }); },
    request(method, params = {}, waitMs = timeoutMs) {
      if (poisoned) return Promise.reject(poisoned);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'Real task deadline' } });
          rejectAll(Error('MCP_TIMEOUT'));
        }, Math.min(timeoutMs, waitMs));
        pending.set(id, { resolve, reject, timer }); send({ id, method, params });
      });
    },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        // EOF is the MCP shutdown path. Restore owns remaining guest processes.
        child.stdin.end();
        let timer;
        try {
          const code = await Promise.race([closed, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('MCP_CLOSE_TIMEOUT')), closeMs);
          })]);
          if (code !== 0) throw Error('MCP_CLOSE_FAILED');
        } finally { clearTimeout(timer); }
      })();
      return closing;
    },
    get stderrBytes() { return Buffer.byteLength(stderr); },
    get stderrTail() { return stderr; },
    get ended() { return ended; },
  };
}

export function taskCode(id, fixture) {
  const q = JSON.stringify;
  if (id === 'notepad') return `let note = await cua.getApp("Notepad");
let noteTree = await note.getAXState();
if (!noteTree.split('\\n')[0].includes(${q(fixture.notepad)})) throw Error('NOTE_WINDOW_MISMATCH');
let editors = noteTree.split('\\n').filter(line => /^\\s*\\d+ (?:text entry area|text field)\\b/i.test(line));
if (editors.length !== 1) throw Error('NOTE_EDITOR_AMBIGUOUS');
if (!/\\(focused\\)/.test(editors[0])) throw Error('NOTE_EDITOR_NOT_FOCUSED');
await note.typeText(${q(fixture.line)});
await note.performSecondaryAction({ id: "File" }, "Expand");
let menuTree = await note.getAXState();
let save = menuTree.split('\\n').find(line => /^\\s*\\d+ menu item Save(?!\\s*as)\\b/i.test(line));
if (!save) throw Error('NOTE_SAVE_MISSING');
await note.performSecondaryAction(Number(/^\\s*(\\d+)/.exec(save)[1]), "Invoke");
await note.getAXState();`;
  // Titles stay private until the app is approved, so a title lookup can't find the folder first (WINDOW_NOT_FOUND
  // live, 2026-11-06). Acquire Explorer by executable, then check the read is the fixture folder.
  if (id === 'explorer') return `let folder = await cua.getApp("explorer.exe");
let folderTree = await folder.getAXState();
if (!folderTree.split('\\n')[0].includes(${q(fixture.folder)})) throw Error('FOLDER_WINDOW_MISMATCH');`;
  if (id === 'edge') return `let edge = await cua.getApp("msedge.exe");
await edge.getAXState();`;
  if (id === 'blocked-app') return `let forbiddenWindows = (await cua.getState()).windows.filter(w => w.refused === "FORBIDDEN_TARGET");
if (forbiddenWindows.length !== 1) throw Error('FORBIDDEN_FIXTURE_AMBIGUOUS');
await cua.getApp({ windowId: forbiddenWindows[0].windowId });`;
  // Calculator is a packaged app whose frame host refuses before any card, so the card fixture is Character Map.
  if (id === 'approval') return 'await cua.getApp("charmap.exe");';
  return fail('UNKNOWN_TASK');
}

// Notepad runs as four js calls (read, click, type, save), as a model would, so a hang names its step.
// Bindings persist between calls in the REPL.
export function taskCells(id, fixture) {
  const code = taskCode(id, fixture);
  if (id !== 'notepad') return [code];
  const lines = code.split('\n');
  return [lines.slice(0, 6), lines.slice(6, 7), lines.slice(7, 8), lines.slice(8)].map(group => group.join('\n'));
}

export function gradeTask(id, reply, context) {
  const text = textOf(reply), error = reply?.isError === true;
  let pass = false, reason, evidence = { replyError: error };
  if (id === 'notepad') {
    pass = !error && context.saved === context.line;
    evidence.fileMatches = context.saved === context.line;
    reason = pass ? 'saved file equals the known line' : 'saved file does not prove the requested edit';
  } else if (id === 'explorer') {
    // Explorer hides known extensions by default, so the row may show the name without ".txt".
    const shown = [context.filename, context.filename.replace(/\.[^.]+$/, '')];
    pass = !error && text.split(/\r?\n/).some(line => {
      if (!/^\s*\d+ (?:list item|tree item|text)\b/i.test(line)) return false;
      const label = line.replace(/^\s*\d+ (?:list item|tree item|text)\s*/i, '');
      return shown.some(name => label === name || label.startsWith(name + ',') || label.startsWith(name + ' '));
    });
    evidence.treeHasName = pass;
    reason = pass ? 'known filename is in a numbered tree row' : 'known filename is absent from the tree';
  } else if (id === 'edge') {
    // LAWS: browsers are refused through the native driver in 1.6.0, and the API text says by name or HWND.
    pass = error && /^(?:sleight: )?BROWSER_TARGET_REFUSED:/m.test(text);
    evidence.browserRefused = pass;
    reason = pass ? 'browser acquisition refused by name' : 'browser refusal by name was not proved';
  } else if (id === 'blocked-app') {
    pass = error && /^(?:sleight: )?FORBIDDEN_TARGET:/m.test(text);
    // This cell contains inventory and acquisition only. No input operation is attempted.
    evidence.acquisitionOnly = true; evidence.refusal = pass;
    reason = pass ? 'forbidden acquisition refused; cell sends no input' : 'forbidden acquisition refusal was not proved';
  } else if (id === 'approval') {
    const decisions = (context.approvals ?? []).filter(a => a.task === id);
    pass = error && /^(?:sleight: )?APP_DECLINED:/m.test(text) && decisions.length === 1 && decisions[0].action === 'decline' &&
      /^charmap\.exe$/i.test(decisions[0].app);
    evidence.declined = pass; evidence.acquisitionOnly = true;
    reason = pass ? 'session approval requested and explicitly declined by unattended client' : 'unattended approval refusal was not proved';
  }
  const code = /(?:sleight: )?([A-Z][A-Z0-9_]{2,}):/.exec(text)?.[1];
  if (!pass && code) reason += ': ' + code;
  // Retain the actual product refusal, but exclude trees and private window content.
  if (error) evidence.refusalText = text.split(/\r?\n/).filter(line => /^(?:sleight: )?[A-Z][A-Z0-9_]+:/.test(line)).join('\n').slice(0, 2048);
  return { id, status: pass ? 'pass' : 'fail', reason, evidence };
}

export async function runGuestTasks(request, { session = createMcpSession(request), now = Date.now,
  readSaved = () => readFileSync(request.fixture.notePath, 'utf8'), trace = () => {} } = {}) {
  const start = now(), tasks = [];
  let error, shutdownError;
  try {
    await session.request('initialize', { protocolVersion: '2024-11-05', capabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'sleight-windows-real-tasks', version: '1' } });
    session.notify?.('notifications/initialized');
    const tools = await session.request('tools/list');
    if (tools?.tools && !tools.tools.some(t => t.name === 'js')) fail('MCP_JS_MISSING');
    // Diagnostics only: the window inventory the tasks start from. It isn't graded.
    trace('inventory', await session.request('tools/call', { name: 'js', arguments: { title: 'Windows real tasks: inventory', timeout_ms: 45000,
      code: 'nodeRepl.write(JSON.stringify((await cua.getState()).windows.map(w => [w.windowId, w.app, w.className, w.title, w.refused, w.image, w.cloaked])));' } }));
    // Diagnostics only: the full refusal each already-refused window gives by HWND. These refuse before any card or input.
    trace('refusals', await session.request('tools/call', { name: 'js', arguments: { title: 'Windows real tasks: refusals', timeout_ms: 45000,
      code: 'let refusals = [];\nfor (const w of (await cua.getState()).windows.filter(w => w.refused)) {\n  try { await cua.getApp({ windowId: w.windowId }); refusals.push([w.windowId, w.refused, "acquired"]); }\n  catch (e) { refusals.push([w.windowId, w.refused, String(e?.message ?? e).slice(0, 400)]); }\n}\nnodeRepl.write(JSON.stringify(refusals));' } }));
    for (const id of TASK_IDS.slice(0, -1)) {
      const started = now(); session.setTask(id);
      try {
        let reply;
        for (const [step, code] of taskCells(id, request.fixture).entries()) {
          reply = await session.request('tools/call', { name: 'js', arguments: {
            code, title: 'Windows real task: ' + id + (step ? ' step ' + (step + 1) : ''), timeout_ms: 45000 } });
          trace(id + '#' + (step + 1), reply);
          // The API text says to read again after an identity refusal; a model would repeat the step once.
          if (reply?.isError && /^(?:sleight: )?IDENTITY_CHANGED:/m.test(textOf(reply))) {
            reply = await session.request('tools/call', { name: 'js', arguments: {
              code, title: 'Windows real task: ' + id + ' step ' + (step + 1) + ' again', timeout_ms: 45000 } });
            trace(id + '#' + (step + 1) + '-again', reply);
          }
          if (reply?.isError) break;
        }
        let saved;
        if (id === 'notepad') { try { saved = readSaved(); } catch { saved = null; } }
        tasks.push({ ...gradeTask(id, reply, { ...request.fixture, saved, approvals: session.approvals }), durationMs: now() - started });
      } catch (failure) {
        tasks.push({ id, status: 'fail', reason: failure.message, durationMs: now() - started });
      }
      // A new model turn clears physical Escape state without resetting session approvals.
      await session.request('tools/call', { name: 'turn_ended', arguments: { sleight_windows_turn_end: true } });
    }
  } catch (failure) { error = failure.message; }
  finally {
    try { await session.close(); } catch (failure) { shutdownError = failure.message; }
  }
  for (const id of TASK_IDS) if (!tasks.some(t => t.id === id)) tasks.push({ id, status: 'fail', durationMs: 0,
    reason: id === 'escape' ? 'OWNER_PRESENT_REQUIRED: physical Escape ignores injected input' : (error ?? 'TASK_NOT_RUN'),
    ...id === 'escape' ? { evidence: { ownerPresentRequired: true } } : {} });
  return { schema: RESULT_SCHEMA, token: request.token, commit: request.commit, manifestSha256: request.manifestSha256,
    wallMs: now() - start, tasks, approvals: session.approvals, cleanup: 'restore-required',
    ...error ? { error } : {}, ...shutdownError ? { shutdownError } : {} };
}

if (isMain(import.meta.url)) {
  const bank = process.argv[2];
  try {
    if (process.platform !== 'win32' || !/^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$/.test(bank ?? '')) fail('TEST_GUEST_REQUIRED');
    const request = JSON.parse(readFileSync(join(bank, 'request.json'), 'utf8'));
    if (request.token !== win32.basename(bank).slice(5) || Number(process.versions.node.split('.')[0]) < 25) fail('GUEST_REQUEST_INVALID');
    verifyKit(ROOT, { expectedCommit: request.commit, expectedManifestSha256: request.manifestSha256 });
    request.fixture = JSON.parse(readFileSync(join(bank, 'fixtures.json'), 'utf8'));
    // Diagnostics for the host: each task's raw reply and the MCP child's stderr tail, kept in the bank.
    const session = createMcpSession(request), lines = [];
    const trace = (id, reply) => {
      const text = JSON.stringify({ id, reply });
      lines.push(text.length > 12000 ? text.slice(0, 2000) + ' ... ' + text.slice(-10000) : text);
    };
    const result = await runGuestTasks(request, { session, trace });
    try { writeFileSync(join(bank, 'diagnostics.txt'), lines.join('\n') + '\n--- mcp stderr\n' + session.stderrTail + '\n', { flag: 'wx' }); } catch {}
    const path = join(bank, 'result.json');
    writeFileSync(path + '.tmp', JSON.stringify(result) + '\n', { flag: 'wx' }); renameSync(path + '.tmp', path);
    // The host disposes the VM, including any uncollected guest children. No process signaling.
    process.exit(result.tasks.every(t => t.status === 'pass') && !result.error && !result.shutdownError ? 0 : 1);
  } catch (error) {
    // The task's own stderr isn't collected, so the reason goes in the bank for the host's diagnostics.
    const reason = String(error?.message ?? error).replace(/[^\x20-\x7e]/g, '?').slice(0, 300);
    try { writeFileSync(join(bank, 'guest-error.txt'), reason + '\n', { flag: 'wx' }); } catch {}
    process.stderr.write('REAL_TASKS_GUEST_FAILED ' + reason + '\n'); process.exit(1);
  }
}
