#!/usr/bin/env node
// Read-only acquisition comparison. The runner owns its child, admission and metadata-only receipt.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, openSync, closeSync, writeSync, fsyncSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openClient } from './compat/client.mjs';
import { acquireAdmission } from './shell-card-probe.mjs';
import { collectOwnedGroup } from '../plugins/sleight/lib/owned-group.mjs';
import { resolveServer, shellExecWrapper } from '../plugins/sleight/lib/launch.mjs';
import { sessionEnvironment } from '../plugins/sleight/lib/socket-bridge.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = data => createHash('sha256').update(data).digest('hex');
export function engineIdentity(server, read = readFileSync) {
  if (server.error) throw Error('ACQUISITION_ENGINE_UNAVAILABLE');
  const args = server.args ?? [];
  // ChatGPT 26.1117 execs node_repl through a `/bin/sh -c` wrapper; that program's bytes belong in the identity too.
  const wrapper = shellExecWrapper(server.command, args);
  const paths = [server.command, ...wrapper ? [wrapper.program] : [], ...args.filter(arg => isAbsolute(arg) && /\.(?:mjs|cjs|js)$/.test(arg))];
  const files = Object.fromEntries(paths.map(path => [path, sha256(read(path))]));
  const argsSha256 = sha256(JSON.stringify(args));
  const identity = { version: server.version, command: server.command, files, argsSha256,
    args: args.map(arg => paths.includes(arg) ? arg : { redactedSha256: sha256(arg) }) };
  return { ...identity, fingerprint: sha256(JSON.stringify(identity)) };
}
export function acquisitionEnvironment(env, serverEnv) {
  const result = { ...env, ...serverEnv, SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_SURFACES: 'computer',
    SLEIGHT_HAND: '0', SLEIGHT_TURBO: '0', CUA_REPL_ENABLED_SURFACES: 'computer' };
  delete result.SLEIGHT_TRACE;
  return result;
}
export function acquisitionClientOptions(mode, server, env = process.env) {
  if (mode === 'shell') return { command: process.execPath,
    args: [resolve(ROOT, 'plugins/sleight/lib/launch.mjs'), '--socket-relay'],
    env: acquisitionEnvironment(sessionEnvironment(env), {}), name: 'Grok Bot', capabilities: {}, turnMeta: false };
  const diagnosticEnv = acquisitionEnvironment(env, server.env);
  return mode === 'raw'
    ? { command: server.command, args: server.args, env: diagnosticEnv, name: 'sleight-acquisition-raw' }
    : { command: resolve(ROOT, 'plugins/sleight/bin/sleight-mcp'), env: diagnosticEnv, name: 'sleight-acquisition-relay' };
}
const READS = [
  { stage: 'inventory', code: 'await cua.getState();', appId: null },
  { stage: 'calculator-first', code: 'var acquisitionCalculator = await cua.getApp("Calculator");', appId: 'com.apple.calculator' },
  { stage: 'textedit-first', code: 'var acquisitionTextEdit = await cua.getApp("TextEdit");', appId: 'com.apple.TextEdit' },
];
const safeError = text => {
  const native = /(?:Computer Use server error )?(-\d{4,})(?::)?\s+([A-Za-z][A-Za-z0-9_]*)/.exec(String(text));
  if (native) return `Computer Use server error ${native[1]}: ${native[2]}`;
  const errno = /\b(EPERM|EACCES|ENOENT|ECONNREFUSED|EPIPE)\b/.exec(String(text));
  if (errno) return `host-${errno[1]}`;
  if (/operation not permitted/i.test(String(text))) return 'host-operation-not-permitted';
  if (/permission denied/i.test(String(text))) return 'host-permission-denied';
  if (/sandbox/i.test(String(text))) return 'sandbox-error';
  if (/kernel/i.test(String(text))) return 'kernel-error';
  if (/timed out|timeout/i.test(String(text))) return 'timeout';
  return 'unclassified-error';
};

export function summarizeRead(result) {
  const texts = (result?.content ?? []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text);
  const surface = result?._meta?.['codex/toolSurface'];
  const app = surface?.app?.appId ?? surface?.appId;
  const execution = result?._meta?.['codex/nodeReplExecutionDurationMs'];
  return { isError: !result || result.isError === true,
    ...(!result || result.isError ? { error: safeError(texts.join('\n')) } : {}),
    textItems: texts.length, textCharacters: texts.reduce((n, text) => n + text.length, 0),
    appId: ['com.apple.TextEdit', 'com.apple.calculator'].includes(app) ? app : app ? 'other' : null,
    executionMs: Number.isFinite(execution) ? execution : null };
}

export async function runAcquisitionProbe({ mode, repeatOnce = false, open = openClient, clientOptions = {},
  admission, collect = collectOwnedGroup, record = () => {}, signals = process, now = Date.now } = {}) {
  const result = { mode, passed: false, approvals: 0, reads: [], children: [], cleanup: { confirmed: false, lockReleased: false } };
  let client, closePromise, transportError = false;
  const lifecycle = new Map();
  const write = value => record({ at: new Date(now()).toISOString(), ...value });
  const close = () => closePromise ??= client ? client.close() : Promise.resolve(false);
  const cancel = () => { result.interrupted = true; if (client) void close().catch(() => {}); };
  signals.on('SIGINT', cancel); signals.on('SIGTERM', cancel);
  const check = async () => {
    if (result.interrupted) throw Error('interrupted');
    if (result.approvals) throw Error('approval-stop');
    await admission.check();
  };
  const read = async ({ stage, code, appId }) => {
    await check();
    const start = now();
    write({ event: 'read-start', stage });
    let summary;
    try { summary = summarizeRead(await client.call('js', { code, timeout_ms: 30000 }, 45000)); }
    catch (error) { transportError = true; summary = { isError: true, error: safeError(error.message) }; }
    if (!summary.isError && appId && summary.appId !== appId) {
      summary.isError = true; summary.error = 'target-metadata-mismatch';
    }
    const row = { stage, elapsedMs: now() - start, result: summary, ...(transportError ? { transportError: true } : {}) };
    result.reads.push(row); write({ event: 'read-result', ...row });
    if (summary.isError) result.failedStage ??= stage;
    return row;
  };
  try {
    await check();
    client = await open({ ...clientOptions, timeoutMs: 45000, turnMeta: mode !== 'shell',
      ...(mode === 'shell' ? { name: 'Grok Bot', capabilities: {}, onNotification: message => {
        if (message.method !== 'notifications/sleight/approval') return;
        result.approvals++;
        const state = message.params?.state;
        write({ event: 'approval-notification', state: ['waiting', 'answered', 'unanswered', 'unavailable'].includes(state) ? state : 'unknown' });
        return 'close';
      } } : {}),
      onLifecycle: event => {
        if (Number.isSafeInteger(event.pid) && event.pid > 0) lifecycle.set(event.pid, { ...lifecycle.get(event.pid), ...event });
        write({ event: 'child', lifecycle: event });
      },
      approve: () => { result.approvals++; write({ event: 'approval-declined' }); return { action: 'decline' }; },
    });
    if (Number.isSafeInteger(client.pid) && !lifecycle.has(client.pid)) lifecycle.set(client.pid, { event: 'spawn', pid: client.pid });
    for (const step of READS) {
      const row = await read(step);
      if (row.result.isError || result.approvals) {
        result.failedStage ??= step.stage;
        // This optional, separately recorded read investigates the already preserved native failure.
        // A transport timeout or declined permission cannot trigger it.
        if (repeatOnce && step.stage === 'textedit-first' && row.result.isError && !transportError && !result.approvals && !result.interrupted) {
          await read({ ...step, stage: 'textedit-diagnostic-repeat' });
        }
        break;
      }
    }
  } catch (error) { result.error = result.interrupted ? 'interrupted' : result.approvals ? 'approval-stop' : safeError(error.message); }
  finally {
    if (mode === 'shell') result.shutdown = 'eof';
    else if (client && !transportError && !result.interrupted) {
      try { const end = await client.endTurn(); result.turnEnded = !end?.isError; }
      catch { result.turnEnded = false; }
    }
    let closed = false, groupsCollected = true;
    try { closed = client ? await close() : [...lifecycle.values()].every(item => item.event === 'close'); }
    catch { closed = false; }
    for (const pid of lifecycle.keys()) {
      try { await collect(pid); }
      catch { groupsCollected = false; }
    }
    result.children = [...lifecycle.values()];
    result.childExitAccepted = result.children.length > 0 && result.children.every(item =>
      item.event === 'close' && item.code === 0 && item.signal == null);
    result.cleanup.confirmed = closed === true && groupsCollected;
    if (result.cleanup.confirmed) {
      try { await admission.release(); result.cleanup.lockReleased = true; }
      catch { result.cleanup.lockReleased = false; }
    }
    signals.removeListener('SIGINT', cancel); signals.removeListener('SIGTERM', cancel);
  }
  result.passed = !result.error && !result.failedStage && !result.approvals && !result.interrupted &&
    result.reads.length === READS.length && result.turnEnded !== false && result.childExitAccepted && result.cleanup.confirmed && result.cleanup.lockReleased;
  write({ event: 'summary', ...result });
  return result;
}

export function parseAcquisitionArgs(argv) {
  const parsed = { repeatOnce: false, live: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live' && !parsed.live) parsed.live = true;
    else if (arg === '--repeat-once' && !parsed.repeatOnce) parsed.repeatOnce = true;
    else if (arg === '--mode' && !parsed.mode) parsed.mode = argv[++i];
    else if (arg === '--receipt' && !parsed.receipt) parsed.receipt = argv[++i];
    else throw Error('ACQUISITION_ARGUMENT');
  }
  if (!parsed.live || !['raw', 'relay', 'shell'].includes(parsed.mode) || !parsed.receipt || !isAbsolute(parsed.receipt) ||
      resolve(parsed.receipt) !== parsed.receipt || !parsed.receipt.endsWith('.jsonl')) throw Error('ACQUISITION_ARGUMENT');
  return parsed;
}

async function main(argv) {
  const options = parseAcquisitionArgs(argv);
  const parent = realpathSync(dirname(options.receipt));
  if (parent !== dirname(options.receipt) || !['/private/tmp', realpathSync(tmpdir())].some(root => {
    const rel = relative(root, parent); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  })) throw Error('ACQUISITION_RECEIPT_ROOT');
  const fd = openSync(options.receipt, 'wx', 0o600);
  const record = value => { const line = JSON.stringify(value) + '\n'; writeSync(fd, line); fsyncSync(fd); console.log(line.trimEnd()); };
  try {
    const sourceEnv = options.mode === 'shell' ? sessionEnvironment() : process.env;
    const server = resolveServer(sourceEnv);
    if (server.error) throw Error('ACQUISITION_ENGINE_UNAVAILABLE');
    const identity = engineIdentity(server);
    const hashes = Object.fromEntries(['plugins/sleight/lib/relay.mjs', 'plugins/sleight/lib/document-scope.mjs',
      'plugins/sleight/lib/launch.mjs', 'plugins/sleight/lib/socket-bridge.mjs', 'bench/acquisition-probe.mjs', 'bench/compat/client.mjs'].map(path =>
      [path, createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex')]));
    record({ event: 'start', run: randomUUID(), mode: options.mode, repeatOnce: options.repeatOnce,
      at: new Date().toISOString(), source: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      hashes, engine: identity });
    const admission = await acquireAdmission();
    record({ event: 'admitted', at: new Date().toISOString() });
    const clientOptions = acquisitionClientOptions(options.mode, server);
    const result = await runAcquisitionProbe({ ...options, admission, clientOptions, record });
    const after = engineIdentity(resolveServer(sourceEnv));
    const unchanged = identity.fingerprint === after.fingerprint;
    record({ event: 'engine-identity-after', engine: after, unchanged });
    if (!result.passed || !unchanged) process.exitCode = 1;
  } catch (error) { record({ event: 'runner-error', error: safeError(error.message) }); process.exitCode = 1; }
  finally { closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('ACQUISITION_PROBE_FAILED'); process.exitCode = 1; });
}
