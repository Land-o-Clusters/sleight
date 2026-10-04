// Small clipboard benchmark, not bench/run.mjs. Owns the engine and one temporary document.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { createNativeClipboardIO } from '../plugins/sleight/lib/clipboard.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const bank = process.argv[2] || await mkdtemp('/private/tmp/sleight-clipboard-');
const extra = process.argv.includes('--extra');
const fixed = process.argv.includes('--fixed');
const diagnose = process.argv.includes('--diagnose');
const recover = process.argv.includes('--recover');
const filesOnly = process.argv.includes('--files-only');
const round2 = process.argv.includes('--round2');
let clipboardIOMs = 0;
const equalItems = (a, b) => JSON.stringify(a.map(reps => [...reps].sort((x, y) => x.type.localeCompare(y.type)))) === JSON.stringify(b.map(reps => [...reps].sort((x, y) => x.type.localeCompare(y.type))));
const native = (...args) => execute(join(bank, 'clipboard-fixture'), args).then(r => JSON.parse(r.stdout));
const path = join(bank, 'clipboard-benchmark.txt');
const fixture = op => execute('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/input-lease-fixture.js'), op, path]);
const records = [], trials = [];
let child, relay, closed, ownedCount, opened = false;
const original = join(bank, 'original.json');
let saved = false;
const pending = new Map(); let id = 0;
const send = msg => input.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const input = new PassThrough(), output = new PassThrough();
const request = (method, params) => new Promise((resolve, reject) => {
  const key = id++;
  const timer = setTimeout(() => { pending.delete(key); reject(new Error('MCP request timed out')); }, 45000);
  pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: e => { clearTimeout(timer); reject(e); } });
  send({ id: key, method, params });
});
const call = (code) => request('tools/call', { name: 'js', arguments: { code } });
const text = r => (r?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const approve = async message => {
  const hook = spawn(process.execPath, [join(root, 'bench/approve.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  let result = ''; hook.stdout.on('data', b => { result += b; });
  const done = new Promise((resolve, reject) => { hook.on('error', reject); hook.on('close', resolve); });
  hook.stdin.end(JSON.stringify({ mcp_server_name: 'plugin:sleight:computer', message }));
  await done;
  return result ? JSON.parse(result).hookSpecificOutput.action : 'decline';
};
process.once('SIGINT', () => { for (const p of pending.values()) p.reject(new Error('cancelled')); pending.clear(); });
try {
  if (recover) {
    const current = await native('inspect');
    const receipt = JSON.parse(await readFile(join(root, 'docs/benchmarks/2026-10-04-clipboard-attempt-16.json'), 'utf8'));
    const image = receipt.trials.find(t => t.kind === 'image').before;
    if (!equalItems(current.items, image.items)) throw new Error('Cancelled-run recovery refused: current clipboard is not the owned synthetic image.');
    await native('restore', join(bank, 'original-before-cancellation.json'), String(current.count));
    trials.push({ cancelledRunClipboardRecovered: true });
  } else {
  await native('save', original); saved = true;
  await writeFile(path, 'alpha beta gamma\n');
  await fixture('open'); opened = true;
  const s = resolveServer(); if (s.error) throw new Error(s.error);
  child = spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...s.env } });
  closed = new Promise(resolve => child.once('close', resolve));
  const clipboardIO = fixed ? createNativeClipboardIO(join(root, 'plugins/sleight/lib/clipboard.js')) : undefined;
  relay = createRelay({ clientIn: input, clientOut: output, serverIn: child.stdin, serverOut: child.stdout,
    inputLease: new InputLease({ holder: 'clipboard benchmark' }),
    clipboardHelper: fixed ? join(root, 'plugins/sleight/lib/clipboard.js') : undefined,
    clipboardMode: fixed ? 'preserve' : undefined,
    clipboardIO: clipboardIO ? async request => {
      const start = performance.now();
      const result = await clipboardIO(request);
      clipboardIOMs += performance.now() - start;
      records.push({ direction: 'clipboard-host', op: request.op, count: result?.count, itemCount: result?.items?.length, writeItems: request.items?.length });
      return result;
    } : undefined,
    localTools: {
      tools: [{ name: 'drag' }],
      target: async () => ({ appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'clipboard benchmark', url: null }),
      call: async (name, args, allow) => {
        if (!await allow(['drag', args.app], `Allow Claude to drag in ${args.app}? It moves your pointer for a few seconds.`)) return { isError: true, content: [{ type: 'text', text: 'Not approved' }] };
        const r = JSON.parse((await execute('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'plugins/sleight/lib/drag.js'), JSON.stringify(args)])).stdout);
        return { isError: !r.ok, content: [{ type: 'text', text: JSON.stringify(r) }] };
      },
    },
    ask: approve, trace: (direction, msg) => records.push({ direction, msg }) });
  createInterface({ input: output }).on('line', line => {
    const msg = JSON.parse(line), p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  });
  child.on('exit', code => { for (const p of pending.values()) p.reject(new Error(`engine exited ${code}`)); pending.clear(); void relay.close(); });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-clipboard-benchmark', version: '1' } });
  send({ method: 'notifications/initialized' });
  const read = await call('let app = await cua.getApp("TextEdit")');
  if (read.isError) throw new Error(text(read));
  const element = /^\s*(\d+) text (?:entry|area)/m.exec(text(read))?.[1];
  trials.push({ phase: 'discovery', element, text: text(read).split('## Computer Use')[0] });
  if (round2) {
    for (let repetition = 1; repetition <= 3; repetition++) {
      const before = await native('seed', 'rich', path, original); ownedCount = before.count;
      await call('app = await cua.getApp("TextEdit")');
      await call('await app.pressKey("super+a")');
      for (const [method, key] of [['copy', 'c'], ['cut', 'x'], ['paste', 'v']]) {
        const ioBefore = clipboardIOMs, start = performance.now();
        const result = await call(`await app.pressKey("super+${key}")`);
        const elapsedMs = performance.now() - start, addedClipboardIOMs = clipboardIOMs - ioBefore;
        const after = await native('inspect'); ownedCount = after.count;
        const document = JSON.parse((await fixture('read')).stdout).text;
        const copiedText = method === 'copy' ? (await execute('/usr/bin/pbpaste', [])).stdout : undefined;
        const restoredBytes = equalItems(before.items, after.items);
        const pass = !result.isError && (fixed ? restoredBytes : after.items[0]?.some(r => r.type === 'public.utf8-plain-text')) &&
          (method === 'cut' ? document === '' : document === 'alpha beta gamma\n') &&
          (method !== 'copy' || (fixed ? copiedText === 'SLEIGHT RICH TEXT' : copiedText === 'alpha beta gamma\n'));
        trials.push({ mode: fixed ? 'preserve' : 'native', repetition, method, elapsedMs, addedClipboardIOMs, before, after, restoredBytes, copiedText, document, result: text(result), isError: result.isError ?? false, pass });
        console.log(JSON.stringify({ repetition, method, elapsedMs, addedClipboardIOMs, pass }));
        if (!pass) { process.exitCode = 1; break; }
      }
    }
    if (fixed) {
      await native('seed', 'promise', path, original);
      await call('app = await cua.getApp("TextEdit")'); await call('await app.pressKey("super+a")');
      const result = await call('await app.pressKey("super+c")');
      const after = await native('inspect'); ownedCount = after.count;
      const copiedText = (await execute('/usr/bin/pbpaste', [])).stdout;
      const pass = !result.isError && /Clipboard not preserved/.test(text(result)) && copiedText === 'alpha beta gamma\n';
      trials.push({ mode: 'preserve', method: 'promise-fallback', after, copiedText, result: text(result), isError: result.isError ?? false, pass });
      if (!pass) process.exitCode = 1;
      console.log(JSON.stringify({ method: 'promise-fallback', pass }));
    }
  }
  if (diagnose) {
    const hostNative = await new Promise(resolve => {
      const helper = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'plugins/sleight/lib/clipboard.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
      let data = ''; helper.stdout.on('data', b => { data += b; });
      helper.on('close', () => { try { const r = JSON.parse(data); resolve({ ok: r.ok, count: r.count, error: r.error }); } catch { resolve({ error: 'no output' }); } });
      helper.stdin.end(JSON.stringify({ op: 'read' }));
    });
    console.log(JSON.stringify({ hostNative })); trials.push({ hostNative });
    const probe = join(bank, 'bridge-probe.json');
    await writeFile(probe, 'host readable');
    const filesystem = await call(`{ const fs = await import('node:fs/promises'); nodeRepl.write(await fs.readFile(${JSON.stringify(probe)}, 'utf8')); await fs.writeFile(${JSON.stringify(probe)}, 'engine writable'); }`);
    trials.push({ filesystem: text(filesystem), hostObserved: await readFile(probe, 'utf8'), isError: filesystem.isError ?? false });
    console.log(JSON.stringify(trials.at(-1)));
    await call('app = await cua.getApp("TextEdit")');
    const bridge = createServer((_request, response) => response.end('relay reached'));
    await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
    try {
      const connectivity = await call(`nodeRepl.write(await (await fetch(${JSON.stringify('http://127.0.0.1:' )} + ${bridge.address().port})).text())`);
      trials.push({ connectivity: text(connectivity), isError: connectivity.isError ?? false });
      console.log(text(connectivity));
    } finally { await new Promise(resolve => bridge.close(resolve)); }
    await call('app = await cua.getApp("TextEdit")');
    const diagnostic = await call(`{
      const os = await import('node:os'); const fs = await import('node:fs/promises');
      const { DatabaseSync } = await import('node:sqlite');
      const path = ${JSON.stringify(join(bank, 'diagnostic.sqlite'))};
      let sqlite; try { const db = new DatabaseSync(path); db.exec('BEGIN IMMEDIATE; ROLLBACK'); db.close(); sqlite = 'ok'; } catch (e) { sqlite = e.message; }
      const { execFile } = await import('node:child_process');
      const native = await new Promise(resolve => {
        const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', ${JSON.stringify(join(root, 'plugins/sleight/lib/clipboard.js'))}], { timeout: 10000 }, (e, stdout) => {
          try { const r = JSON.parse(stdout); resolve({ ok: r.ok, count: r.count, error: r.error }); } catch { resolve({ error: e?.message || 'no output' }); }
        }); child.stdin.end(JSON.stringify({ op: 'read' }));
      });
      nodeRepl.write({ home: os.homedir(), temporary: os.tmpdir(), sqlitePath: path, sqlite, native });
    }`);
    trials.push({ diagnostic: text(diagnostic), isError: diagnostic.isError ?? false });
    console.log(text(diagnostic));
  }
  for (const kind of diagnose || round2 ? [] : filesOnly ? ['files'] : extra ? ['rich', 'files'] : ['text', 'image', 'files', 'rich']) {
    for (const [method, code] of fixed ? [
      ['copy', 'await app.pressKey("super+a"); await app.pressKey("super+c")'],
      ['cut-paste', ['await app.pressKey("super+a"); await app.pressKey("super+x")', 'await app.pressKey("super+v")']],
    ] : extra ? [
      ['local-drag', null],
      ['copy', 'await app.pressKey("super+a"); await app.pressKey("super+c")'],
      ['paste-with-new-copy', 'await app.paste("SLEIGHT PASTE\\n")'],
    ] : [
      ['paste', 'await app.paste("SLEIGHT PASTE\\n")'],
      ['typeText', 'await app.typeText("SLEIGHT TYPE\\n")'],
      ['pressKey', 'await app.pressKey("Right")'],
      ['drag', 'await app.drag([50, 80], [150, 80])'],
    ]) {
      const before = await native('seed', kind, path, original); ownedCount = before.count;
      if (fixed && kind === 'files') {
        const helper = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'plugins/sleight/lib/clipboard.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
        let output = ''; helper.stdout.on('data', b => { output += b; });
        const readDone = new Promise(resolve => helper.once('close', resolve));
        helper.stdin.end(JSON.stringify({ op: 'read' })); await readDone;
        const read = JSON.parse(output);
        trials.push({ hostFileSnapshot: { ok: read.ok, count: read.count, itemCount: read.items?.length, representations: read.items?.map(i => i.map(r => r.type)), error: read.error } });
      }
      if (extra || fixed) await call('app = await cua.getApp("TextEdit")');
      if (method === 'local-drag') {
        await call(`await app.selectText(${element}, "alpha")`);
      }
      const watcher = spawn(join(bank, 'clipboard-fixture'), method === 'paste-with-new-copy' ? ['watch', 'replace'] : ['watch'], { stdio: ['pipe', 'pipe', 'inherit'] });
      let events; let readyResolve; const ready = new Promise(r => { readyResolve = r; });
      const collected = new Promise(resolve => watcher.once('close', resolve));
      createInterface({ input: watcher.stdout }).on('line', line => { const m = JSON.parse(line); if (m.ready) readyResolve(); if (m.events) events = m.events; });
      await ready;
      let result;
      try {
        if (Array.isArray(code)) {
          for (const step of code) { result = await call(step); if (result.isError) break; }
        } else result = method === 'local-drag' ? await request('tools/call', { name: 'drag', arguments: { app: 'TextEdit', from: [30, 80], to: [130, 80] } }) : await call(code);
      } finally { watcher.stdin.end(); await collected; }
      const after = await native('inspect'); ownedCount = after.count;
      const trial = { kind, method, before, after, events, restoredBytes: equalItems(before.items, after.items), isError: result.isError ?? false, result: text(result), document: JSON.parse((await fixture('read')).stdout).text };
      if (trial.isError) process.exitCode = 1;
      if (fixed && (!trial.restoredBytes || trial.document !== 'alpha beta gamma\n')) process.exitCode = 1;
      trials.push(trial); console.log(JSON.stringify({ kind, method, restoredBytes: trial.restoredBytes, countDelta: after.count - before.count, isError: trial.isError }));
    }
  }
  }
} catch (err) { trials.push({ error: err.message }); process.exitCode = 1; console.error(err.message); }
finally {
  if (child) {
    await relay.shutdown(); child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
    await closed; clearTimeout(timer); relay.close();
  }
  if (opened) { try { await fixture('close'); } catch (err) { trials.push({ cleanupError: err.message }); process.exitCode = 1; } }
  if (saved && ownedCount !== undefined) {
    try { await native('restore', original, String(ownedCount)); trials.push({ originalRestored: true }); }
    catch (err) { trials.push({ originalRestored: false, error: err.message, privateSnapshot: original }); process.exitCode = 1; }
  }
  const sanitize = value => JSON.stringify(value, null, 2).replaceAll(process.env.HOME, '~');
  await writeFile(join(bank, 'results.json'), sanitize({ trials, records }) + '\n');
  console.log(`Evidence: ${join(bank, 'results.json')}`);
}
