import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { InputLease, isLeaseRead, leaseKey } from '../plugins/sleight/lib/input-lease.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';

const window = { app: 'TextEdit', appId: 'com.apple.TextEdit', title: 'a.txt', url: 'file:///tmp/a.txt' };
for (const code of [
  'app = await cua.getApp("Chess")',
  'let app2 = await cua.getApp("TextEdit")',
  'let te = await cua.getApp("com.apple.TextEdit")',
  'const te = await cua.getApp("TextEdit")',
  'var chess = await cua.getApp("Chess")',
  'await cua.getApp("Chess")',
  'JSON.stringify((await cua.listApps()).filter(a => a.name === "TextEdit"))',
  'JSON.stringify((await cua.listApps()).filter(a=>/calc/i.test(a.id+a.displayName)))',
  'await cua.listWindows()',
  'await cua.getState()',
  'await te.getAXState({disableDiffing:true})',
]) test('standalone read passes: ' + code, () => assert.equal(isLeaseRead(code), true));

for (const code of [
  'app = await cua.getApp("Chess"); await app.click(1)',
  'let te = await cua.getApp(await app.typeText("oops"))',
  '(await cua.listApps()).filter(a => app.typeText("oops"))',
  'JSON.stringify((await cua.listApps()).filter(a => (a.name = "oops")))',
  '(await cua.listApps()).filter(a => { app.click(1); return true })',
  'cua.listApps = () => []',
  'await cua.listApps(); await app.click(1)',
  '(await cua.listApps()).forEach(a => app.click(1))',
]) test('read/action mixture stays an action: ' + code, () => assert.equal(isLeaseRead(code), false));
function bank(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-lease-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('second holder is refused with its name and remaining time; reads have a narrow grammar', t => {
  const directory = bank(t);
  const a = new InputLease({ directory, holder: 'session A', now: () => 1000 });
  const b = new InputLease({ directory, holder: 'session B', now: () => 2000 });
  a.acquire(window);
  assert.throws(() => b.acquire(window), /session A.*29 s/);
  assert.ok(isLeaseRead('let app = await cua.getApp("TextEdit")'));
  assert.ok(isLeaseRead('await app.getAXState({ disableDiffing: true })'));
  assert.ok(isLeaseRead('await nodeRepl.emitImage(await app.getScreenshot())'));
  assert.ok(isLeaseRead('nodeRepl.write(await app.getAXState({ emit: false }))'));
  assert.ok(isLeaseRead('await app.getAXStateAndScreenshot({ disableDiffing: true })'));
  assert.ok(isLeaseRead('await app.getScreenshot({ emit: false })'));
  assert.equal(isLeaseRead('await app.getAXState({ emit: (await app.typeText("oops")) })'), false);
  assert.equal(isLeaseRead('await app.getAXState(); await app.typeText("oops")'), false);
  assert.equal(isLeaseRead('await app.typeText("hello")'), false);
});
test('renewal, expiry at 30 s, and stale owner release never erase a successor', t => {
  const directory = bank(t);
  let time = 1000;
  const a = new InputLease({ directory, holder: 'A', now: () => time });
  const b = new InputLease({ directory, holder: 'B', now: () => time });
  a.acquire(window);
  time += 20000; a.renew();
  time += 20000; assert.throws(() => b.acquire(window), /A.*10 s/);
  time += 10000; b.acquire(window);
  assert.throws(() => a.renew(), /lost/);
  a.close();
  assert.throws(() => a.acquire(window), /B.*30 s/);
  b.close(); a.acquire(window); a.close();
  assert.equal(readdirSync(directory).filter(f => f.endsWith('.json')).length, 0);
});
test('bundle identity and URL stay stable on title changes; distinct windows are independent', t => {
  assert.equal(leaseKey(window), leaseKey({ ...window, app: 'Different display name', title: 'renamed' }));
  const directory = bank(t);
  const a = new InputLease({ directory, holder: 'A' }), b = new InputLease({ directory, holder: 'B' });
  a.acquire(window);
  b.acquire({ ...window, url: 'file:///tmp/b.txt' });
  a.close(); b.close();
});
test('corrupt lease fails closed and a busy coordinator refuses without waiting', t => {
  const directory = bank(t);
  const a = new InputLease({ directory, holder: 'A' }), b = new InputLease({ directory, holder: 'B' });
  a.acquire(window);
  const json = join(directory, leaseKey(window) + '.json');
  const original = readFileSync(json);
  writeFileSync(json, '{}');
  assert.throws(() => b.acquire(window), /invalid/);
  writeFileSync(json, original);
  const db = new DatabaseSync(join(directory, '.coordinator.sqlite'));
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => b.acquire(window), /A.*s remaining/);
  db.exec('ROLLBACK'); db.close(); a.close();
});
test('independent processes racing one file admit exactly one action owner', async t => {
  const directory = bank(t);
  const module = new URL('../plugins/sleight/lib/input-lease.mjs', import.meta.url).href;
  const children = Array.from({ length: 8 }, (_, i) => spawn(process.execPath, ['--input-type=module', '-e',
    `import {InputLease} from ${JSON.stringify(module)};
     const lease = new InputLease({directory:${JSON.stringify(directory)},holder:'child-${i}'});
     process.stdin.once('data',()=>{try {lease.acquire(${JSON.stringify(window)}); console.log('won');}
     catch(e){console.log(e.message)} });`], { stdio: ['pipe', 'pipe', 'pipe'] }));
  const results = children.map(c => new Promise((resolve, reject) => {
    let out = ''; c.stdout.on('data', d => out += d); c.on('error', reject);
    c.once('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${code}`)));
  }));
  for (const c of children) c.stdin.end('go');
  const outputs = await Promise.all(results);
  assert.equal(outputs.filter(o => o === 'won').length, 1, outputs.join('\n'));
  assert.ok(outputs.filter(o => o !== 'won').every(o => /Input lease/.test(o)));
});

test('app and desktop leases conflict with window leases in both acquisition orders', t => {
  for (const scope of ['app', 'desktop']) for (const broadFirst of [true, false]) {
    const directory = bank(t);
    const a = new InputLease({ directory, holder: 'window holder' }), b = new InputLease({ directory, holder: 'broad holder' });
    const broad = scope === 'desktop' ? { ...window, appId: 'desktop' } : window;
    if (broadFirst) { b.acquire(broad, scope); assert.throws(() => a.acquire(window), /broad holder/); }
    else { a.acquire(window); assert.throws(() => b.acquire(broad, scope), /window holder/); }
    a.close(); b.close();
  }
});

test('engine guard checks the token again before the next action after takeover', async t => {
  const directory = bank(t);
  const a = new InputLease({ directory, holder: 'A' }), b = new InputLease({ directory, holder: 'B' });
  const key = a.acquire(window);
  const writes = [];
  const app = {
    getAXState: async () => 'Window: "a.txt", App: TextEdit\nURL: file:///tmp/a.txt',
    typeText: async value => { writes.push(value); a.close(); b.acquire(window); },
  };
  const { appId, ...identity } = window;
  const code = guardedCode('await app.typeText("first"); await app.typeText("second")', identity, undefined, a.grant(key));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(app, { getApp: async () => app }, { write() {} }), /ownership lost/);
    assert.deepEqual(writes, ['first']);
  } finally { delete globalThis.__sleightDocumentGuard; a.close(); b.close(); }
});
