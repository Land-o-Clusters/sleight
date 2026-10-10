// Background-only select-all diagnosis. Owns one engine at a time and one temporary document.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), execute = promisify(execFile);
const repetitions = process.argv.includes('--quick') ? 1 : 3;
const bank = await mkdtemp('/private/tmp/sleight-exact-'), path = join(bank, 'exact.txt');
const report = { started: new Date().toISOString(), repetitions, bank, trials: [], records: [] };
report.source = Object.fromEntries(await Promise.all(['plugins/sleight/lib/relay.mjs', 'bench/small-fixes-textedit.js', 'bench/small-fixes-textedit.mjs'].map(async name =>
  [name, createHash('sha256').update(await readFile(join(root, name))).digest('hex')])));
const outputPath = join(root, 'docs/benchmarks', `${report.started.slice(0, 10)}-exact-text-${Date.now()}.json`);
const text = r => (r?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const ensureFree = async () => { try { await access('/tmp/sleight-hold'); } catch (e) { if (e.code === 'ENOENT') return; throw e; } throw new Error('Live hold exists; app driving stopped'); };
let release, fixture, client, opened = false, attached = false, cancelled = false;
process.once('SIGINT', () => { cancelled = true; });

function startFixture() {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/small-fixes-textedit.js'), path], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let id = 0, ended = false, stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  const collected = new Promise(resolve => child.once('close', (code, signal) => {
    ended = true; report.fixtureExit = { code, signal };
    for (const p of pending.values()) p.reject(new Error(stderr || 'Fixture helper closed'));
    pending.clear(); resolve();
  }));
  child.on('error', error => { for (const p of pending.values()) p.reject(error); });
  const input = createInterface({ input: child.stdout });
  input.on('line', line => {
    let r; try { r = JSON.parse(line); } catch { return; }
    const p = pending.get(r.id) ?? [...pending.values()][0];
    if (!p) return;
    pending.delete(p.id); r.ok ? p.resolve(r) : p.reject(new Error(r.error));
  });
  return {
    request: op => new Promise((resolve, reject) => {
      const key = id++, timer = setTimeout(() => reject(new Error('Fixture helper timeout')), 10000);
      pending.set(key, { id: key, resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ id: key, op }) + '\n');
    }),
    close: async () => {
      child.stdin.end();
      const timer = setTimeout(() => { if (!ended) child.kill('SIGTERM'); }, 10000);
      try { await collected; } finally { clearTimeout(timer); input.close(); }
    },
  };
}
const checked = async code => {
  if (cancelled) throw new Error('Cancelled');
  await ensureFree(); await fixture.request('read');
  const start = performance.now(), reply = await client.call('js', { code });
  const window = windowFromText(text(reply));
  report.records.push({ code, ms: performance.now() - start, isError: reply?.isError ?? false,
    reportedOwnedWindow: window ? window.url === pathToFileURL(path).href : null, responseBodyOmitted: true });
  assert.ok(!reply?.isError, 'Engine returned an error; response body omitted to protect unrelated document contents');
  await fixture.request('read'); return reply;
};
const acquire = async () => {
  const reply = await checked('var app = await cua.getApp("TextEdit")');
  assert.equal(windowFromText(text(reply))?.url, pathToFileURL(path).href, 'Engine did not select the owned document; no input sent');
};
try {
  await ensureFree(); release = await acquireLiveLock(); await ensureFree();
  fixture = startFixture();
  const preflight = await fixture.request('preflight'); report.preflight = preflight;
  assert.ok(preflight.running && !preflight.foregroundTextEdit, 'Requires already-running TextEdit in the background; no activation attempted');
  await writeFile(path, '');
  await execute('/usr/bin/open', ['-g', '-b', 'com.apple.TextEdit', path]); opened = true;
  await fixture.request('attach'); attached = true;
  const server = resolveServer(); assert.ok(!server.error, server.error); report.engineVersion = server.version;
  for (const mode of ['direct', 'default', 'careful']) {
    client = await probeClient(server, { relay: mode !== 'direct', label: mode, record: entry => {
      if (entry.event) report.records.push({ client: mode, event: entry.event, code: entry.code, signal: entry.signal, error: entry.error });
    }, relayOptions: { guardMode: mode === 'careful' ? 'careful' : undefined } });
    await acquire();
    for (const condition of ['pasted-seed-batch-type', 'pasted-seed-observed-type', 'typed-seed-batch-type', 'typed-seed-observed-type', 'typed-seed-observed-paste', 'typed-seed-escape-type']) {
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        const entry = { mode, condition, repetition, expected: 'engine01' }; report.trials.push(entry);
        await checked('await app.pressKey("super+a"); await app.paste("")');
        if (condition.startsWith('pasted')) await checked('await app.paste("Engine01")');
        else await checked([...`engine01`].map(key => `await app.pressKey(${JSON.stringify(key)})`).join('; '));
        await checked('await app.pressKey("super+s")');
        entry.seed = await fixture.request('read');
        if (condition.includes('escape')) await checked('await app.pressKey("Escape")');
        if (condition.includes('observed')) {
          await checked('await app.pressKey("super+a")');
          entry.afterSelect = await fixture.request('read');
          await checked(condition.endsWith('paste') ? 'await app.paste("engine01")' : 'await app.typeText("engine01")');
          entry.beforeSave = await fixture.request('read');
          await checked('await app.pressKey("super+s")');
        } else await checked('await app.pressKey("super+a"); await app.typeText("engine01"); await app.pressKey("super+s")');
        entry.after = await fixture.request('read'); entry.saved = await readFile(path, 'utf8');
        entry.exact = entry.after.text === entry.expected && entry.saved === entry.expected;
        if (!entry.exact) process.exitCode = 1;
        console.log(JSON.stringify(entry));
        if (entry.after.text !== entry.saved) throw new Error('Saved file differs from document buffer');
      }
    }
    await client.close(); client = undefined;
  }
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (client) { try { await client.close(); report.engineCollected = true; } catch (error) { report.engineCleanupError = error.message; process.exitCode = 1; } }
  if (fixture && opened) {
    try { await ensureFree(); await fixture.request('close'); report.documentClosed = true; }
    catch (error) { report.documentCleanupError = error.message; process.exitCode = 1; }
  }
  if (fixture) {
    try { await fixture.close(); report.fixtureCollected = true; }
    catch (error) { report.fixtureCleanupError = error.message; process.exitCode = 1; }
  }
  if (release && (!opened || report.documentClosed) && !report.engineCleanupError && !report.fixtureCleanupError) {
    try { await release(); report.lockReleased = true; }
    catch (error) { report.lockCleanupError = error.message; process.exitCode = 1; }
  } else if (release) report.lockRetained = 'Owned document or process cleanup is unconfirmed; operator inspection required';
  report.attached = attached; report.finished = new Date().toISOString();
  report.exactCount = report.trials.filter(t => t.exact).length;
  report.completedCount = report.trials.filter(t => typeof t.exact === 'boolean').length;
  const published = JSON.stringify(report, null, 2).replaceAll(homedir(), '~').replaceAll(userInfo().username, '[owner]');
  await writeFile(join(bank, 'results.json'), published + '\n');
  console.log(`Private evidence: ${join(bank, 'results.json')}`);
  await writeFile(outputPath, published + '\n');
  console.log(`Published ${outputPath.replaceAll(homedir(), '~')}`);
}
