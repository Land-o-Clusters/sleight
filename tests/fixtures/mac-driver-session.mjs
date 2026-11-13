// Offline stdio fixture. No native builder, desktop APIs or real windows.
import { createInterface } from 'node:readline';
import { writeFileSync, readdirSync } from 'node:fs';
import { DRIVER_CORE_METHODS } from '../../plugins/sleight/lib/mac-driver/protocol.mjs';

if (['--exit-runtime', '--signal-runtime'].includes(process.argv[2])) {
  const { spawn, fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { join } = await import('node:path');
  const { runOwnRuntime } = await import('../../plugins/sleight/lib/runtime-select.mjs');
  const { InputLease } = await import('../../plugins/sleight/lib/input-lease.mjs');
  const directory = process.argv[3], killed = [], signalMode = process.argv[2] === '--signal-runtime';
  const leases = join(directory, 'leases'), lease = new InputLease({ directory: leases, holder: 'exit-session' });
  let aborted = false;
  const track = (child, name) => {
    const kill = child.kill.bind(child);
    child.kill = (...args) => { killed.push(name); return kill(...args); };
    return child;
  };
  const input = new PassThrough(), output = new PassThrough();
  const runtime = await runOwnRuntime({ input, output,
    lease,
    driverOptions: { platform: 'darwin', prepare: signalMode ? ({ signal }) => {
      signal.addEventListener('abort', () => { aborted = true; process.stderr.write('ABORTED\n'); }, { once: true });
      process.stderr.write('PREPARING\n');
      return new Promise(() => {});
    } : async () => ({ status: 'ready', spawn: ({ nonce }) =>
      track(spawn(process.execPath, [new URL(import.meta.url).pathname, '0', join(directory, 'helper-signalled')],
        { env: { SLEIGHT_DRIVER_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe'] }), 'helper') }) },
    replOptions: { environment: () => ({}), spawn: (...args) => {
      const worker = track(fork(...args), 'worker');
      if (signalMode) worker.once('close', () => writeFileSync(join(directory, 'worker-closed'), 'closed'));
      return worker;
    } },
    policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false },
    approvalStorage: { load: () => ({}), live: () => ({ list: () => [], allows: () => false }) },
    ask: () => 'accept', allowForbidden: () => false, ownHostPid: () => false,
    grantAudit() {}, relayOptions: { idleTurnEndMs: 0 },
  });
  if (signalMode) {
    // Seed a record so a non-abortable prepare exercises synchronous release.
    lease.acquire({ appId: 'com.example.Editor', title: 'stalled-startup', url: null }, 'window');
    process.on('exit', () => writeFileSync(join(directory, 'exit.json'), JSON.stringify({
      leases: readdirSync(leases).filter(name => name.endsWith('.json')).length, aborted,
    })));
  }
  runtime.runtime.serverIn.write(JSON.stringify({ id: 1, method: 'tools/call',
    params: { name: 'js', arguments: { code: 'await cua.getApp("Editor")' } } }) + '\n');
  if (!signalMode) {
    const [bytes] = await once(runtime.runtime.serverOut, 'data');
    if (JSON.parse(bytes).result.isError) throw Error(bytes.toString());
    process.on('exit', () => writeFileSync(join(directory, 'signalled.json'), JSON.stringify(killed)));
    process.exit(0);
  }
} else {
  const index = Number(process.argv[2]), owner = `session-${index}`, nonce = process.env.SLEIGHT_DRIVER_NONCE;
  if (process.argv[3]) process.on('SIGTERM', () => { writeFileSync(process.argv[3], 'SIGTERM'); process.exit(0); });
  let previous = 0, readId = 0;
  const windowFor = id => ({ windowId: String(id), pid: 120, processStart: '134059077770000001',
    bundleId: 'com.example.Editor', app: 'Editor', title: `Draft ${id}`, identityVerified: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 }, onScreen: true, minimized: false });
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.nonce !== nonce || request.id <= previous) process.exit(65);
    previous = request.id;
    const window = windowFor(request.params.windowId ?? request.params.selector?.windowId ?? 101 + index);
    let result;
    if (request.method === 'ping') {
      if (process.argv[2] === 'hold-ping') { process.stderr.write('HOLD_PING\n'); continue; }
      result = { protocol: 'sleight.driver/1', platform: 'darwin', apiVersion: 2,
        build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, 'rendererRestore'], healthy: true };
    } else if (request.method === 'resolveApp') result = {
      app: { id: window.bundleId, name: window.app, path: '/Applications/Editor.app', pid: window.pid,
        processStart: window.processStart, running: true }, windows: [window],
    };
    else if (request.method === 'rendererRestore') result = { restored: true, token: request.params.args[0].lease.token };
    else if (request.method === 'getAXState') {
      if (request.params.budgetMs === 123) { process.stderr.write('HOLD_READ\n'); continue; }
      result = { window, readId: ++readId, truncated: false, elapsedMs: 0,
        text: `Window: "${window.title}", App: Editor.\n0 standard window ${window.title}\n\t1 text ${owner}/read-${readId}` };
    } else result = { window };
    process.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin',
      nonce, id: request.id, ok: true, result }) + '\n');
  }
}
