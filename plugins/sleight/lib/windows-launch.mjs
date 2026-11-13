// Windows bootstrap. Driver access is admitted in the relay process, outside the worker.
import { win32 } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay.mjs';
import { createWindowsReplClient } from './windows-repl/client.mjs';
import { createWindowsDriverClient } from './windows-driver/client.mjs';
import { windowsDriverResult } from './windows-driver/guard.mjs';
import { WINDOWS_REPL_DOCS } from './windows-repl/docs.mjs';
import { createWindowsSafety } from './windows-driver/safety.mjs';
import { windowsTurnEndFailure } from './driver-safety.mjs';
import { WindowsInputLease } from './windows-driver/leases.mjs';
import { windowsReplTools } from './windows-repl/docs.mjs';
import { skillRules } from './skill-rules.mjs';
import { getPlatform } from './platform/index.mjs';
import { createCursorEvents } from './hand/events.mjs';
import { cursorDrawing } from './hand/settings.mjs';
import { handWireFrame } from './hand/client.mjs';
import { browserTools } from './direct-browser/tools.mjs';
import { createWindowsTurboDiscovery } from './direct-browser/windows-platform.mjs';
import { createWindowsHandSettingReader } from './windows-hand-settings.mjs';
import { doctorVersionLine, readPluginVersion } from './version.mjs';

export const windowsNativeUnavailable = /* notice */ 'Native app tools are not available on Windows yet.';
export const windowsBrowserUnavailable = /* notice */ 'Windows browser driving needs native peer verification and trusted consent controls, which are not available yet.';
// Private VM telemetry. Each sample matches G3's per-reply timing intake. Never
// put this record in MCP content or infer a sample from a quantile.
export function windowsTurnTelemetry(result) {
  if (!result?.hookCallbacks) return;
  return { event: 'windows-turn-end', ...result };
}
const hostModule = () => import('./direct-browser/windows-host.mjs');
const failed = text => ({ isError: true, content: [{ type: 'text', text }] });
function dependencies(options) {
  const adapter = getPlatform('win32');
  return { adapter, paths: options.paths ?? adapter.paths(),
    discovery: options.discovery ?? createWindowsTurboDiscovery({ platform: 'win32' }),
    setting: options.setting ?? createWindowsHandSettingReader() };
}

export async function windowsCommand(args, { start = runWindows, diagnose = windowsDoctor,
  error = text => process.stderr.write(text + '\n'), settings, register, ...options } = {}) {
  if (!args.length) { await start(); return 0; }
  if (args.length === 1 && args[0] === '--doctor') return diagnose();
  if (args.length === 1 && args[0] === 'register') return (register ?? (await import('./windows-register.mjs')).registerWindowsPlugin)({ ...options, platform: 'win32' });
  if (args[0] === 'replay') {
    const { readFileSync } = await import('node:fs');
    const { replay, replayOptions } = await import('./replay.mjs');
    if (!args[1]) { error('Usage: sleight-mcp replay <script.json>'); return 1; }
    const result = await replay(JSON.parse(readFileSync(args[1], 'utf8')), {
      ...replayOptions(args.slice(2)), server: options.replayServer ?? windowsReplayServer, log: error,
    });
    if (!result.ok) error(result.error);
    return result.ok ? 0 : 1;
  }
  if (['hand', 'cursor', 'turbo', 'permissions'].includes(args[0]))
    return (settings ?? (await import('./windows-settings.mjs')).windowsSettingsCommand)(args, { ...options, platform: 'win32', error });
  error(args[0].startsWith('-') ? `Unsupported Windows option: ${args.join(' ')}` : windowsNativeUnavailable); return 1;
}

// Windows has no POSIX process groups. Own just this launcher child, close stdin,
// then collect its exit. The launcher closes its REPL and driver before exiting.
export function windowsReplayServer({ spawnChild = spawn } = {}) {
  const child = spawnChild(process.execPath, [fileURLToPath(new URL('./launch.mjs', import.meta.url))],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env } });
  let failure, settled = false;
  const listeners = new Set();
  const ended = error => { failure = error; for (const listener of listeners) listener(error); };
  const closed = new Promise((resolve, reject) => {
    child.once('error', error => { settled = true; ended(error); reject(error); });
    child.once('close', code => {
      settled = true;
      const ok = code === 0 && !failure;
      const error = failure ?? Error(`Windows replay relay exited ${code}.`); ended(error);
      ok ? resolve() : reject(error);
    });
  });
  closed.catch(() => {});
  child.stdin.on('error', error => ended(error)); child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  return {
    send(message) { if (failure) throw failure; child.stdin.write(JSON.stringify(message) + '\n'); },
    onMessage(handler) { lines.on('line', line => { try { handler(JSON.parse(line)); } catch {} }); },
    onClose(handler) { listeners.add(handler); if (failure) handler(failure); },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => { if (!settled) child.kill(); }, 5000); timer.unref();
      try { await closed; } finally { clearTimeout(timer); lines.close(); }
    },
  };
}

export async function windowsDoctor({ log = console.log, ...options } = {}) {
  const { discovery, paths, setting } = dependencies(options);
  const node = options.nodeVersion ?? process.version, nodeOK = Number(/^v?(\d+)\./.exec(node)?.[1]) >= 24;
  log(doctorVersionLine(options.versionOptions)); log('platform  win32');
  log(`Node      ${node}${nodeOK ? '' : ' (requires Node 24 or newer)'}`);
  let host, compiler, built = false, browsers = [], hand = false, checkFailed = false;
  const reason = error => { checkFailed = true; return `check failed: ${error.message}`; };
  await setting.ready?.();
  try { hand = setting().enabled === true; log(`hand      ${hand ? 'on' : 'off (SLEIGHT_HAND=1 builds the ring host)'}`); }
  catch (error) { log(`hand      ${reason(error)}`); }
  try { host = options.host ?? await (options.loadHost ?? hostModule)(); }
  catch (error) { const detail = reason(error); log(`csc       ${detail}`); log(`host      ${detail}`); }
  if (host) {
    try { compiler = host.findWindowsCompiler({ platform: 'win32' }); log(`csc       ${compiler ? 'found' : 'not found'}`); }
    catch (error) { log(`csc       ${reason(error)}`); }
    try {
      built = await (options.hostBuilt ?? host.windowsHandHostBuilt)({ platform: 'win32', cacheRoot: getPlatform('win32').join(paths.cache, 'cursor-host') }) === true;
      log(`host      ${built ? 'built' : 'not built'}`);
    } catch (error) { log(`host      ${reason(error)}`); }
  }
  try { browsers = (await discovery.browsers()).filter(browser => browser.installed); log(`browser   ${browsers.map(browser => browser.name).join(', ') || 'not found'}`); }
  catch (error) { log(`browser   ${reason(error)}`); }
  log(windowsNativeUnavailable); log(windowsBrowserUnavailable);
  log('Cursor geometry, Windows consent, capture exclusion and app driving still need a Windows session.');
  await setting.close?.();
  return nodeOK && !checkFailed && (!hand || compiler && built) && browsers.length ? 0 : 1;
}

// Host prompt text is display-only. Identity and approval memory keep the full native path.
function windowsApprovalDisplay(card) {
  const clean = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '');
  const tail = (value, size) => value.length > size ? '…' + value.slice(-(size - 1)) : value;
  const image = clean(card.image || card.app);
  const file = tail(win32.basename(image), 100), folder = tail(win32.dirname(image), 200);
  return { file, message: `Allow Computer Use to use "${file}" in folder "${folder}"?` + (card.warning ? ` ${card.warning}` : '') };
}
export function windowsApprovalMessage(card) {
  return windowsApprovalDisplay(card).message;
}

/** Driver admission and observation live in this process, outside the worker.
 * The stream and native-host dependencies are injectable for headless tests. */
export async function runWindows({ input = process.stdin, output = process.stdout, signals = process,
  warn = text => process.stderr.write(`sleight: ${text}\n`),
  turnTelemetry, ...options } = {}) {
  const { adapter, paths, setting } = dependencies(options);
  const release = readPluginVersion();
  const controller = new AbortController();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  let closed = false, closing, child, childClosed, buffer = Buffer.alloc(0), target, seq = 0, hostStatus = 'off', pendingJs;
  const appApprovals = new Map(), completedApprovals = new Set(), cellViews = new Map();
  const guardedMessages = new WeakSet();
  const driver = options.driver ?? createWindowsDriverClient({ platform: 'win32' });
  const safety = options.repl ? undefined : createWindowsSafety({ driver, lease: options.lease ?? new WindowsInputLease(),
    approve: card => new Promise(resolve => {
      const id = 'windows-app-' + randomBytes(16).toString('hex');
      const finish = accepted => {
        clearTimeout(timer); appApprovals.delete(id); completedApprovals.add(id);
        if (completedApprovals.size > 64) completedApprovals.delete(completedApprovals.values().next().value);
        resolve(accepted);
      };
      const timer = setTimeout(() => finish(false), 120000);
      appApprovals.set(id, finish);
      const display = windowsApprovalDisplay(card);
      send({ id, method: 'elicitation/create', params: {
        message: display.message,
        mode: 'form', requestedSchema: { type: 'object', properties: {} },
        _meta: { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: display.file } },
      } });
    }), ...options.safetyOptions });
  if (safety) {
    safety.guardResult = message => {
      if (guardedMessages.has(message)) return;
      const view = cellViews.get(message.id);
      // initialize, tools/list, reset and parent-generated refusals are not worker results.
      if (!view) return;
      guardedMessages.add(message);
      message.result = structuredClone(view.trusted);
    };
    safety.displayResult = (id, result) => {
      const view = cellViews.get(id); cellViews.delete(id);
      if (!view || !Array.isArray(result?.content)) return result;
      const known = new Set(result.content.filter(c => c.type === 'text').map(c => c.text));
      return { ...result, content: [...result.content, ...view.display.filter(c => c.type !== 'text' || !known.has(c.text))] };
    };
  }
  function cancelAppApprovals() {
    for (const [id, finish] of appApprovals) {
      send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'Windows JavaScript session ended.' } });
      finish(false);
    }
  }
  const repl = options.repl ?? createWindowsReplClient({ platform: 'win32', ...options.replOptions, driver,
    dispatch: (method, params, context) => safety.request(method, params, context),
    async finalize(result, facts, { id, docs, cell }) {
      const escaped = await safety.finishCell(cell);
      if (escaped) facts.results.set(escaped.window.windowId, escaped);
      const observations = [...facts.results.values()];
      const last = observations.findLast(row => row.window);
      const content = [
        ...docs ? [{ type: 'text', text: WINDOWS_REPL_DOCS }] : [],
        ...observations.flatMap(row => typeof row.text === 'string' ? [{ type: 'text', text: row.text }]
          : row.windows ? [{ type: 'text', text: JSON.stringify(row) }] : []),
        ...observations.flatMap(row => (row.notices ?? []).map(text => ({ type: 'text', text }))),
        ...facts.errors.map(error => ({ type: 'text', text: error.code + ': ' + error.message })),
      ];
      cellViews.set(id, { trusted: { ...windowsDriverResult(last), content,
        isError: facts.errors.length > 0 || result?.isError === true },
        display: (result?.content ?? []).filter(item => item && (item.type === 'text' && typeof item.text === 'string' || item.type === 'image')) });
      // The parent projection supplies all guard-visible content and metadata.
      return { content: [], isError: facts.errors.length > 0 || result?.isError === true };
    },
    onReset() { cancelAppApprovals(); return safety.reset(); } });
  async function resetNativeCell() {
    cancelAppApprovals();
    // Start cancellation before worker retirement, and collect both failures.
    const operations = [() => safety ? safety.reset() : driver.cancel?.(), () => repl.reset()];
    const calls = operations.map(operation => {
      try { return Promise.resolve(operation()); }
      catch (error) { return Promise.reject(error); }
    });
    const results = await Promise.allSettled(calls);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors);
    return results[1].value;
  }
  const nonce = randomBytes(32).toString('hex');
  const cursor = createCursorEvents({ platform: 'win32', setting, sink: options.sink });
  const frame = value => {
    if (!child || closed || child.stdin.destroyed || child.stdin.writableLength > 65536) return;
    try { child.stdin.write(JSON.stringify({ ...value, nonce }) + '\n'); } catch {}
  };
  const hostClient = { get enabled() { return hostStatus === 'ready'; }, cursor(event) {
    if (event.type === 'session' && event.state === 'end' || event.type === 'status' && event.state === 'idle') { frame({ hand: 'hide' }); target = undefined; return; }
    if (event.type === 'action') {
      // WIN4 cannot bind a CDP rectangle to an HWND or prove DPI/exposure yet. Never invent geometry.
      if (!event.point || !event.window?.pid || !event.window?.id || event.window.exposure !== 'exposed') return;
      if (!['aim', 'act'].includes(event.phase)) return;
      const wire = handWireFrame({ hand: event.phase === 'aim' ? 'aim' : 'act', kind: ['select', 'navigate'].includes(event.kind) ? 'click' : event.kind,
        pid: event.window.pid, windowId: event.window.id, at: event.point, path: event.path, rect: event.rect, label: event.label });
      if (typeof wire === 'string') return;
      target = { pid: wire.pid, windowId: wire.windowId, at: wire.at };
      frame({ hand: 'act', ...wire, seq: ++seq });
    } else if (event.type === 'status' && target && ['thinking', 'waiting', 'error', 'done', 'handback'].includes(event.state)) {
      frame({ hand: 'status', state: event.state, ...target, seq: ++seq });
    }
  } };
  cursor.connectHost(hostClient);
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      const errors = [];
      cancelAppApprovals(); cellViews.clear();
      // Send control frames before worker retirement or lease cleanup can wait.
      let cancelled;
      try { cancelled = safety ? safety.close() : driver.cancel?.(); }
      catch (error) { errors.push(error); }
      try { cursor.close(); } catch (error) { errors.push(error); }
      closed = true; controller.abort();
      try { relay.dispose(); } catch (error) { errors.push(error); }
      serverIn.off('data', onData); input.off('end', onEnd); input.off('error', onEnd); output.off('error', onEnd);
      input.pause();
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.off(signal, onEnd);
      const collected = await Promise.allSettled([cancelled, Promise.resolve().then(() => setting.close?.()), Promise.resolve().then(() => repl.close())]);
      for (const result of collected) if (result.status === 'rejected') errors.push(result.reason);
      serverIn.destroy(); serverOut.destroy();
      await hostReady;
      if (child && child.exitCode == null) {
        child.stdin.end();
        const timer = setTimeout(() => child.kill(), 2000); timer.unref?.();
        const hard = setTimeout(() => child.kill('SIGKILL'), 5000); hard.unref?.();
        try { await childClosed; } finally { clearTimeout(timer); clearTimeout(hard); }
      }
      if (errors.length) throw new AggregateError(errors, 'Windows session cleanup failed. Remaining leases expire without renewal.');
    })();
    return closing;
  }
  const onEnd = () => { close().catch(() => { process.exitCode = 1; }); };
  const send = reply => {
    if (closed) return;
    if (output.writableLength > 1048576) return onEnd();
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...reply }) + '\n');
  };
  async function endSafetyTurn(id, args) {
    try {
      const ended = await safety?.endTurn({ clipboardTurnEnded: args?.sleight_clipboard_turn_end === true,
        windowsTurnEnded: args?.sleight_windows_turn_end === true });
      const telemetry = turnTelemetry && windowsTurnTelemetry(ended);
      if (telemetry) { try { turnTelemetry(telemetry); } catch { /* Telemetry cannot change cleanup or input admission. */ } }
      send({ id, result: { content: [] } });
    } catch (error) {
      send({ id, result: failed(windowsTurnEndFailure(error?.reason)) });
    }
  }
  function request(message) {
    if (message?.method === undefined && appApprovals.has(message?.id)) {
      appApprovals.get(message.id)(message.result?.action === 'accept'); return;
    }
    if (message?.method === undefined && completedApprovals.has(message?.id)) return;
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        !['string', 'number', 'undefined'].includes(typeof message.id)) return send({ id: null, error: { code: -32600, message: 'Invalid Request' } });
    if (message.id === undefined) {
      if (message.method === 'notifications/cancelled' && pendingJs && message.params?.requestId === pendingJs.id) {
        pendingJs = undefined;
        resetNativeCell().catch(() => {});
      }
      return;
    }
    const { id, method, params } = message;
    if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'sleight', version: release } } });
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: [...windowsReplTools(), ...browserTools()] } });
    if (method === 'tools/call') {
      if (typeof params?.name !== 'string') return send({ id, error: { code: -32602, message: 'Invalid params' } });
      if (params.name === 'js' || params.name === 'js_reset') {
        cursor.status('thinking');
        const cell = params.name === 'js' && !pendingJs ? { id } : undefined;
        if (cell) pendingJs = cell;
        const finish = () => { if (pendingJs === cell) pendingJs = undefined; };
        return Promise.resolve(params.name === 'js' ? repl.execute(params.arguments, { id }) : resetNativeCell()).then(result => {
          // A client can start its next cell as soon as it receives this reply.
          finish(); cursor.status(result.isError ? 'error' : 'done'); send({ id, result });
        }, () => { finish(); send({ id, result: failed('Windows JavaScript worker failed.') }); }).finally(finish);
      }
      if (params.name === 'turn_ended') return endSafetyTurn(id, params.arguments);
      const native = ['js', 'js_reset', 'open_file', 'select_window', 'drag', 'hover', 'menu_bar', 'notifications'].includes(params.name);
      if (!native && !browserTools().some(tool => tool.name === params.name))
        return send({ id, error: { code: -32602, message: `Unknown tool: ${params.name}` } });
      cursor.status('thinking');
      const result = failed(native ? windowsNativeUnavailable : windowsBrowserUnavailable);
      cursor.status('error'); return send({ id, result });
    }
    send({ id, error: { code: -32601, message: 'Method not found' } });
  }
  function onData(chunk) {
    if (closed) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > 1048576) return onEnd();
    let end;
    while ((end = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      try { request(JSON.parse(line.toString('utf8'))); }
      catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    }
  }
  // A cold C# build runs beside MCP, with cancellation owned by this session.
  const hostReady = Promise.resolve().then(async () => {
    await setting.ready?.();
    if (!cursorDrawing(setting()) || closed) return;
    hostStatus = 'building';
    try {
      const host = options.host ?? await hostModule();
      const result = await host.prepareWindowsHandHost({ platform: 'win32', cacheRoot: adapter.join(paths.cache, 'cursor-host'), signal: controller.signal });
      if (closed) return;
      if (result.status !== 'ready') { hostStatus = result.code ?? 'unavailable'; warn(`Windows cursor host unavailable (${hostStatus}).`); return; }
      const value = setting();
      child = result.spawn({ capture: value.capture === 'visible' ? 'visible' : 'hidden', cursorStyle: value.style === 'seam' ? 'seam' : 'ring', consent: false });
      childClosed = new Promise(resolve => child.once('close', resolve));
      child.on('error', () => { hostStatus = 'unavailable'; });
      child.on('close', () => { hostStatus = 'unavailable'; });
      child.stdin.on('error', () => { hostStatus = 'unavailable'; });
      // Host stdout is private, never forwarded into MCP. Phase 1 has no control replies.
      child.stdout?.resume(); hostStatus = 'ready';
      frame({ hand: 'menu', enabled: true, capture: value.capture === 'visible' ? 'visible' : 'hidden', version: release });
    } catch { hostStatus = 'unavailable'; if (!closed) warn('Windows cursor host unavailable.'); }
  });
  serverIn.on('data', onData);
  const relay = createRelay({ ...options.relayOptions, clientIn: input, clientOut: output, serverIn, serverOut,
    firstCallRules: skillRules(undefined, process.env, 'win32'),
    changeReview: false, warmRepl: false, warmEngine: false, simFocusNote: false, nativeWindows: true, cursor,
    // Safety owns Windows session memory. A late answer to a cancelled worker's
    // card must not populate a second cache in the relay after reset.
    approvalScope: 'once', nativeSession: safety });
  input.once('end', onEnd); input.once('error', onEnd); output.once('error', onEnd);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.once(signal, onEnd);
  cursor.status('idle');
  return { close, hostReady, cursor, relay, get hostStatus() { return hostStatus; } };
}
