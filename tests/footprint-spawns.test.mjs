import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectSurfaces } from '../plugins/sleight/lib/launch.mjs';
import { createAppHealthHelper } from '../plugins/sleight/lib/read-failure.mjs';
import { snapshotCode } from '../plugins/sleight/hooks/snapshot.ts';
import { pane, loadCodec } from '../bench/footprint-spawns.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAEklEQVR4AWP4z8Dwn4GB4f9/ABH4A/1gtGwYAAAAAElFTkSuQmCC', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

test('automatic launch without a cached extension stays computer-only without a preflight engine', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-no-discovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const requests = join(directory, 'requests');
  const server = { command: process.execPath, args: [new URL('fixtures/browser-discovery-engine.mjs', import.meta.url).pathname],
    env: { SLEIGHT_TEST_REQUESTS: requests, SLEIGHT_TEST_BROWSERS: '[]' } };
  await selectSurfaces(server, {}, { file: join(directory, 'cache.json') });
  assert.equal(existsSync(requests), false, 'native startup must not run a separate JS session');
  assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.equal(server.env.BROWSER_USE_AVAILABLE_BACKENDS, 'chrome');
});

test('health, targets and taps reuse three session helpers and retain reply identity', async () => {
  let spawned = 0;
  const script = `require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const r=JSON.parse(line); const reply=r.op==='keyboard-taps'?{ok:true,taps:[{pid:42,app:'Calculator'}]}:
      r.op==='lease-target'?{ok:true,target:{appId:'com.apple.calculator',pid:42}}:{status:'responding'};
    process.stdout.write(JSON.stringify({id:r.id,...reply})+'\\n'); });`;
  const helper = createAppHealthHelper({ timeoutMs: 2000, spawnHelper: () => {
    spawned++; return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
  } });
  try {
    assert.equal((await helper.probe('Calculator')).status, 'responding');
    assert.deepEqual(await helper.keyboardTaps(), [{ pid: 42, app: 'Calculator' }]);
    assert.deepEqual(await helper.target({ app: 'Calculator' }), { ok: true, target: { appId: 'com.apple.calculator', pid: 42 } });
    assert.equal(spawned, 3);
  } finally { await helper.close(); }
  assert.deepEqual(await helper.keyboardTaps(), []);
  assert.equal((await helper.target({ app: 'Calculator' })).ok, false, 'closed helpers cannot grant a target');
});

test('a stalled target refuses and a new helper can answer the next request', async () => {
  let spawned = 0;
  const script = `require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const r=JSON.parse(line); if(r.app==='stuck')return;
    process.stdout.write(JSON.stringify({id:r.id,ok:true,target:{appId:'com.apple.calculator',pid:42}})+'\\n'); });`;
  const helper = createAppHealthHelper({ operationTimeoutMs: 300, spawnHelper: () => {
    spawned++; return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
  } });
  try {
    const failure = await helper.target({ app: 'stuck' });
    assert.equal(failure.ok, false);
    assert.match(failure.error, /lease.target resolution/i);
    assert.match(failure.error, /reading.*won.t help/i);
    assert.deepEqual(await helper.target({ app: 'Calculator' }), { ok: true, target: { appId: 'com.apple.calculator', pid: 42 } });
    assert.equal(spawned, 2);
  } finally { await helper.close(); }
});

function fakeHelpers() {
  const lanes = { probe: [], target: [], taps: [] };
  return { lanes, spawnHelper(kind) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.requests = [];
    child.stdin = new PassThrough();
    child.stdin.on('data', line => child.requests.push(JSON.parse(line)));
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close')); };
    child.reply = value => child.stdout.write(JSON.stringify({ id: child.requests.at(-1).id, ...value }) + '\n');
    lanes[kind].push(child);
    return child;
  } };
}

test('a probe deadline cannot interrupt a slow target with its own 30 second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeHelpers();
  const helper = createAppHealthHelper({ spawnHelper: kind => fake.spawnHelper(kind) });
  let targetFinished = false;
  const target = helper.target({ app: 'Calculator' }).then(value => { targetFinished = true; return value; });
  const probe = helper.probe('TextEdit');
  t.mock.timers.tick(2000);
  assert.deepEqual(await probe, { status: 'unknown' });
  assert.equal(fake.lanes.probe[0].killed, true);
  assert.equal(fake.lanes.target[0].killed, undefined);
  t.mock.timers.tick(27999); await Promise.resolve();
  assert.equal(targetFinished, false);
  fake.lanes.target[0].reply({ ok: true, target: { appId: 'com.apple.calculator', pid: 42 } });
  assert.equal((await target).ok, true);
  await helper.close();
});

test('a timed-out target leaves the next queued target its full deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeHelpers();
  const helper = createAppHealthHelper({ spawnHelper: kind => fake.spawnHelper(kind) });
  const target = helper.target({ app: 'Calculator' });
  let nextFinished = false;
  const next = helper.target({ app: 'TextEdit' }).then(value => { nextFinished = true; return value; });
  assert.equal(fake.lanes.target[0].requests.length, 1);
  t.mock.timers.tick(30000);
  assert.equal((await target).ok, false);
  // Collection of the timed-out process precedes dispatch on its replacement.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(fake.lanes.target.length, 2);
  assert.equal(fake.lanes.target[1].requests[0].op, 'lease-target');
  t.mock.timers.tick(29999); await Promise.resolve();
  assert.equal(nextFinished, false);
  fake.lanes.target[1].reply({ ok: true, target: { appId: 'com.apple.TextEdit', pid: 43 } });
  assert.equal((await next).target.appId, 'com.apple.TextEdit');
  await helper.close();
});

test('a stuck tap scan cannot delay target resolution or lose its own deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeHelpers();
  const helper = createAppHealthHelper({ spawnHelper: kind => fake.spawnHelper(kind) });
  let tapsFinished = false;
  const taps = helper.keyboardTaps().then(value => { tapsFinished = true; return value; });
  const target = helper.target({ app: 'Calculator' });
  assert.equal(fake.lanes.taps[0].requests[0].op, 'keyboard-taps');
  assert.equal(fake.lanes.target[0].requests[0].op, 'lease-target');
  fake.lanes.target[0].reply({ ok: true, target: { appId: 'com.apple.calculator', pid: 42 } });
  assert.equal((await target).ok, true);
  t.mock.timers.tick(29999); await Promise.resolve();
  assert.equal(tapsFinished, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await taps, []);
  await helper.close();
});

test('closing the session collects its helper before reporting completion', async () => {
  let collected = false;
  const helper = createAppHealthHelper({ spawnHelper: () => {
    const child = spawn(process.execPath, ['-e', `require('readline').createInterface({input:process.stdin}).on('line',l=>{
      process.stdout.write(JSON.stringify({id:JSON.parse(l).id,status:'responding'})+'\\n'); });`], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.once('close', () => { collected = true; });
    return child;
  } });
  await helper.probe('Calculator');
  await helper.close();
  assert.equal(collected, true, 'helper exit is part of session cleanup');
});

test('forced helper collection keeps a standalone caller alive until close', async () => {
  const url = new URL('../plugins/sleight/lib/read-failure.mjs', import.meta.url).href;
  const code = `import {spawn} from 'node:child_process'; import {createAppHealthHelper} from ${JSON.stringify(url)};
    const helper=createAppHealthHelper({spawnHelper:()=>spawn(process.execPath,['-e',
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);require('readline').createInterface({input:process.stdin}).on('line',l=>process.stdout.write(JSON.stringify({id:JSON.parse(l).id,status:'responding'})+'\\\\n'));"
    ],{stdio:['pipe','pipe','ignore']})}); await helper.probe('Calculator'); await helper.close(); console.log('collected');`;
  const result = await new Promise(resolve => execFile(process.execPath, ['--input-type=module', '-e', code], { timeout: 10000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  assert.equal(result.error, null, result.stderr);
  assert.equal(result.stdout.trim(), 'collected');
});

test('the actual JXA session loader dispatches health, target and tap requests with their IDs', () => {
  const lib = new URL('../plugins/sleight/lib/', import.meta.url);
  const requests = [{ id: 1, app: 'Calculator' }, { id: 2, op: 'lease-target', app: 'Calculator' },
    { id: 3, op: 'keyboard-taps' }, { id: 4, op: 'keyboard-taps' }];
  const chunks = [Buffer.from(requests.map(JSON.stringify).join('\n') + '\n'), Buffer.alloc(0)];
  const output = [];
  const $ = value => ({ dataUsingEncoding: () => Buffer.from(value) });
  const app = { bundleIdentifier: 'com.apple.calculator', localizedName: 'Calculator',
    bundleURL: { path: '/System/Applications/Calculator.app', isNil: () => false }, processIdentifier: 42 };
  Object.assign($, {
    NSUTF8StringEncoding: 4,
    NSString: { stringWithContentsOfFileEncodingError: path => readFileSync(new URL(path.split('/').at(-1), lib), 'utf8'),
      alloc: { initWithDataEncoding: data => data.toString() } },
    NSFileHandle: { fileHandleWithStandardInput: { get availableData() { return chunks.shift(); } },
      fileHandleWithStandardOutput: { writeData: data => output.push(JSON.parse(data.toString())) } },
    NSRunLoop: { currentRunLoop: { runUntilDate() {} } }, NSDate: { dateWithTimeIntervalSinceNow: () => 0 },
    AXIsProcessTrusted: () => false,
    NSWorkspace: { sharedWorkspace: { runningApplications: { count: 1, objectAtIndex: () => app } } },
    NSData: { dataWithBytesLength: (ptr, n) => ({ base64EncodedStringWithOptions: () => ptr.subarray(0, n).toString('base64') }) },
    malloc: n => Buffer.alloc(n), free() {}, CGGetEventTapList: (_max, _list, count) => { count.writeUInt32LE(0); return 0; },
  });
  const context = vm.createContext({ $, ObjC: { import() {}, unwrap: value => value, bindFunction() {} }, Ref: () => [] });
  vm.runInContext(readFileSync(new URL('app-health.js', lib), 'utf8'), context);
  context.run(['--session', '/fixture']);
  assert.deepEqual(output, [{ id: 1, status: 'denied' },
    { id: 2, ok: true, target: { appId: 'com.apple.calculator', app: 'Calculator', pid: 42, title: null, url: null } },
    { id: 3, ok: true, taps: [] }, { id: 4, ok: true, taps: [] }]);
});

test('explicit surfaces preserve the requested backends without a discovery process', () => {
  const server = { env: { BROWSER_USE_AVAILABLE_BACKENDS: 'iab' } };
  selectSurfaces(server, { SLEIGHT_SURFACES: 'computer' });
  assert.deepEqual(server.env, { CUA_REPL_ENABLED_SURFACES: 'computer', BROWSER_USE_AVAILABLE_BACKENDS: 'iab' });
});

test('a desktop PNG that already fits is forwarded without loading a pixel decoder', async () => {
  const shot = png;
  const frame = await pane(snapshotCode('Calculator', 46, 13, false), shot, () => { throw new Error('unneeded decoder'); });
  assert.equal(frame.width, 1); assert.equal(frame.height, 2);
  assert.equal(frame.columns, 13); assert.equal(frame.rows, 13, 'desktop log layout keeps the same frame reservation');
  assert.equal(frame.cells, undefined);
  assert.deepEqual(frame.image, { mime: 'image/png', base64: shot.toString('base64') });
});

test('a desktop JPEG with metadata segments is forwarded without decoding its pixels', async () => {
  const shot = jpeg;
  const frame = await pane(snapshotCode('Calculator', 46, 13, false), shot, () => { throw new Error('unneeded decoder'); });
  assert.equal(frame.width, 1); assert.equal(frame.height, 1);
  assert.deepEqual(frame.image, { mime: 'image/jpeg', base64: shot.toString('base64') });
});

test('terminal snapshots retain their pixel colors and half-block cells', async () => {
  // The codec boundary returns the two pixels in the fixture. Check the pane's cell packing.
  const load = async () => ({ PNG: { sync: { read: () => ({ width: 1, height: 2, data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]) }) } } });
  const frame = await pane(snapshotCode('Calculator', 1, 1, true), png, load);
  assert.equal(frame.image, undefined);
  assert.equal(frame.columns, 1); assert.equal(frame.rows, 1);
  const cells = Buffer.from(frame.cells, 'base64');
  assert.deepEqual([cells.readUInt32LE(0), cells.readUInt32LE(4), cells.readUInt32LE(8)], [0x2580, 0xff0000, 0x0000ff]);
});

test('invalid dimensions fall back to the decoder instead of producing an invalid desktop frame', async () => {
  const shot = Buffer.from(png);
  shot.writeUInt32BE(0, 16);
  await assert.rejects(pane(snapshotCode('Calculator', 46, 13, false), shot, () => { throw new Error('decoder fallback'); }), /decoder fallback/);
});

test('oversized desktop images still resize to fit the MCP frame budget', { skip: !existsSync('/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/pngjs') }, async () => {
  const { default: { PNG } } = await loadCodec('pngjs');
  const data = Buffer.alloc(128 * 128 * 4);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; data[i] = seed & 255; }
  const shot = PNG.sync.write({ width: 128, height: 128, data });
  assert.ok(shot.length > 12000, 'fixture must exceed the unchanged base64 budget');
  const frame = await pane(snapshotCode('Calculator', 46, 13, false), shot);
  assert.equal(frame.width, 128); assert.equal(frame.height, 128);
  assert.equal(frame.image.mime, 'image/jpeg');
  assert.ok(frame.image.base64.length <= 16000);
});
