import { assertChildStatus } from './fixtures/child-status.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { windowsSharedPlans } from '../scripts/windows-plan-compat.mjs';
import { prepareWindowsHandHost, windowsHostExecutable } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { ringCases, invalidFrames } from './fixtures/windows-ring-cases.mjs';
import { characterFrame, fixturePng, spriteCases } from './fixtures/windows-character-fixture.mjs';
import { registerTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { webpCases, fixtureWebP } from './fixtures/windows-webp-fixture.mjs';

const windows = { skip: process.platform !== 'win32' ? 'requires in-box Windows csc.exe; no GUI is launched' : false };
let binary, buildRoot;
after(() => { if (buildRoot) removeTemp(buildRoot); });
async function host() {
  if (binary) return binary;
  buildRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-win-compiled-')));
  const built = await prepareWindowsHandHost({ cacheRoot: join(buildRoot, 'host') });
  assert.equal(built.status, 'ready', JSON.stringify(built));
  return (binary = windowsHostExecutable(built.receipt));
}
const input = frames => frames.map(frame => typeof frame === 'string' ? frame : JSON.stringify(frame)).join('\n') + '\n';
function near(actual, expected, path = '$') {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', path);
    assert.ok(Math.abs(actual - expected) <= 1e-7 * Math.max(1, Math.abs(expected)), `${path}: ${actual} != ${expected}`);
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path);
    for (const key of Object.keys(expected)) near(actual[key], expected[key], path + '.' + key);
  } else assert.equal(actual, expected, path);
}
test('Windows shared ring plan matches every Swift reference fixture', windows, async () => {
  const reference = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/windows-ring-reference.json.gz', import.meta.url))));
  for (const fixture of ringCases) {
    const result = spawnSync(await host(), ['--plan-dump', ...fixture.flags], { input: input(fixture.frames), encoding: 'utf8', timeout: 20000, maxBuffer: 64 << 20, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, fixture.name + ': ' + result.stderr);
    near(windowsSharedPlans(result.stdout.trim().split('\n').map(JSON.parse)), windowsSharedPlans(reference.cases[fixture.name]), fixture.name);
  }
});
test('Windows frame validator refuses malformed, replayed and card frames with exit 65', windows, async () => {
  for (const [name, frames] of Object.entries(invalidFrames)) {
    const result = spawnSync(await host(), ['--validate'], { input: input(frames), encoding: 'utf8', timeout: 10000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(result, 65, name + ': ' + result.stderr); assert.equal(result.stdout, '', name);
  }
});
test('Windows validation accepts every act and status without creating an application', windows, async () => {
  for (const fixture of ringCases) {
    const frames = fixture.frames.filter(frame => !('dumpClock' in frame));
    const result = spawnSync(await host(), ['--validate'], { input: input(frames), encoding: 'utf8', timeout: 10000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, fixture.name + ': ' + result.stderr); assert.equal(result.stdout, '');
  }
});

function characterBank(t) {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-win-sprite-'))));
  mkdirSync(join(root, 'fixture')); const frame = characterFrame(root);
  writeFileSync(frame.sheet, fixturePng()); return { root, frame };
}
test('Windows PNG character plans match the Swift sprite reference without a window', windows, async t => {
  const { root } = characterBank(t);
  const reference = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/windows-ring-reference.json.gz', import.meta.url))));
  for (const fixture of spriteCases(root)) {
    const result = spawnSync(await host(), ['--plan-dump', ...fixture.flags, '--test-character-root=' + root], {
      input: input(fixture.frames), encoding: 'utf8', timeout: 20000, maxBuffer: 64 << 20, windowsHide: true,
     killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, result.stderr);
    const effects = result.stdout.trim().split('\n').map(JSON.parse).map(({ selfMaxRss, handleMs, ...record }) => record);
    assert.equal(effects.find(e => e.effect === 'character')?.loaded, true);
    near(windowsSharedPlans(effects), windowsSharedPlans(reference.cases[fixture.name]), fixture.name);
  }
});
test('Windows character check bounds PNG decode, refuses bad ink and reparse paths, and decodes lossless WebP', windows, async t => {
  const { root, frame } = characterBank(t);
  const check = async value => {
    const result = spawnSync(await host(), ['--check-character', '--test-character-root=' + root], {
      input: input([value]), encoding: 'utf8', timeout: 10000, windowsHide: true,
     killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, result.stderr); return JSON.parse(result.stdout);
  };
  assert.equal((await check(frame)).loaded, true);
  writeFileSync(frame.sheet, fixturePng({ opaque: true }));
  assert.equal((await check(frame)).reason, 'pixels');
  writeFileSync(frame.sheet, fixturePng({ width: 2000 }));
  assert.equal((await check(frame)).reason, 'size');
  const webp = join(root, 'fixture', 'sheet.webp'); writeFileSync(webp, Buffer.from('RIFF0000WEBP' + 'x'.repeat(30)));
  assert.equal((await check({ ...frame, sheet: webp })).reason, 'type');
  writeFileSync(webp, fixtureWebP());
  assert.equal((await check({ ...frame, sheet: webp })).loaded, true);
  const link = join(root, 'linked'); symlinkSync(join(root, 'fixture'), link, 'junction');
  assert.equal((await check({ ...frame, sheet: join(link, 'sheet.png') })).loaded, false);
});
test('Windows native protocol checks characters, all optional fields and byte framing before UI initialization', windows, async () => {
  const frame = characterFrame('C:\\unused');
  const run = async bytes => spawnSync(await host(), ['--validate'], { input: bytes, encoding: 'utf8', timeout: 10000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(await run(input([frame])), 0);
  for (const bad of [
    { ...frame, cell: [193, 208] }, { ...frame, sheet: '\\\\remote\\share\\sheet.png' },
    { ...frame, table: { idle: { ...frame.table.idle, loop: 1 } } },
    { ...frame, table: { idle: { ...frame.table.idle, ms: [1, 1] } } },
  ]) assertChildStatus(await run(input([bad])), 65);
  assertChildStatus(await run(JSON.stringify(frame)), 65, 'unterminated final line');
  assertChildStatus(await run(Buffer.from([0xff, 0x0a])), 65, 'invalid UTF-8');
});
test('Windows build cache and character checks refuse a private child under a replaceable parent', windows, async t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-win-acl-'))));
  const parent = join(root, 'parent'), bank = join(parent, 'characters');
  mkdirSync(bank, { recursive: true }); mkdirSync(join(bank, 'fixture'));
  const frame = characterFrame(bank); writeFileSync(frame.sheet, fixturePng());
  // Compile before making the test parent unsafe, so refusal cannot be a missing compiler.
  const executable = await host();
  const changed = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./fixtures/windows-acl-fixture.ps1', import.meta.url)), parent],
    { encoding: 'utf8', timeout: 10000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(changed, 0, changed.stderr);
  assert.equal((await prepareWindowsHandHost({ cacheRoot: join(parent, 'host') })).code, 'HOST_CACHE_UNSAFE');
  const checked = spawnSync(executable, ['--check-character', '--test-character-root=' + bank], {
    input: input([frame]), encoding: 'utf8', timeout: 10000, windowsHide: true,
   killSignal: 'SIGKILL' });
  assertChildStatus(checked, 0, checked.stderr); assert.equal(JSON.parse(checked.stdout).loaded, false);
});

test('Windows headless interop selftest checks the Unicode OSVERSIONINFO layout', windows, async () => {
  const result = spawnSync(await host(), ['--interop-selftest'], {encoding:'utf8',timeout:10000,windowsHide:true, killSignal: 'SIGKILL' });
  assertChildStatus(result,0,result.stderr);
  assert.equal(result.stdout, '{"osVersionSize":276}\n');
});
test('Windows secure-input worker fails closed on exceptions, a timeout and a busy provider', windows, async () => {
  const result = spawnSync(await host(), ['--security-selftest'], {encoding:'utf8',timeout:10000,windowsHide:true, killSignal: 'SIGKILL' });
  assertChildStatus(result,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {password:true,plain:false,failure:true,timeout:true,busy:true});
});
test('Windows labels emit UTF-8 and LF, with bounded StringInfo truncation', windows, async () => {
  const labels = ['Café 漢字 e\u0301','x'.repeat(41),('e'+'\u0301'.repeat(3)).repeat(30),'🇺🇸','กำ'];
  const frames = labels.map((label,i)=>({hand:'aim',nonce:'a'.repeat(64),seq:i+1,kind:'click',pid:1,windowId:1,at:[0,0],label}));
  const result = spawnSync(await host(), ['--label-dump'], {input:input(frames),encoding:'utf8',timeout:10000,windowsHide:true, killSignal: 'SIGKILL' });
  assertChildStatus(result,0,result.stderr); assert.ok(!result.stdout.includes('\r'));
  const rows=result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].label,labels[0]); assert.equal(rows[1].label.length,40);
  assert.equal([...rows[2].label].length,80);
  // .NET Framework StringInfo separates regional indicators and Thai SARA AM.
  // These are explicit divergence fixtures, outside the Swift equality matrix.
  assert.deepEqual(rows.slice(3), [{label:'🇺🇸',elements:2},{label:'กำ',elements:2}]);
});
for (const fixture of webpCases()) test('Windows managed VP8L pixels: '+fixture.name, windows, async () => {
  const result = spawnSync(await host(), ['--decode-webp'], {input:fixture.bytes,timeout:10000,windowsHide:true,maxBuffer:16<<20, killSignal: 'SIGKILL' });
  assertChildStatus(result,0,result.stderr?.toString());
  assert.deepEqual(result.stdout,fixture.expected);
});
test('Windows managed VP8L refuses truncation, bad version, oversize, animation and lossy input', windows, async () => {
  const bytes = webpCases()[0].bytes;
  const version=Buffer.from(bytes); version[24]|=0x80;
  const oversize=Buffer.from(bytes); oversize[21]=255;oversize[22]|=63;
  const lossy=Buffer.from(bytes);lossy.write('VP8 ',12);
  const animated=Buffer.from(bytes);animated.write('ANIM',12);
  const hugeChunk=Buffer.from(bytes);hugeChunk.writeUInt32LE(0xffffffff,16);
  for (const value of [bytes.subarray(0,24),bytes.subarray(0,-2),version,oversize,lossy,animated,hugeChunk]) {
    const result=spawnSync(await host(),['--decode-webp'],{input:value,timeout:10000,windowsHide:true, killSignal: 'SIGKILL' });
    assertChildStatus(result,65,result.stderr?.toString());assert.equal(result.stdout.length,0);
  }
});
test('Windows system-tool trust refuses a user-owned compiler before executing it', windows, async t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-win-tool-'))));
  const compiler = join(root,'csc.exe');writeFileSync(compiler,'this must never execute');
  let compiled=false;
  const built=await prepareWindowsHandHost({cacheRoot:join(root,'host'),compiler,compile(){compiled=true;}});
  assert.equal(built.code,'HOST_CACHE_UNSAFE');assert.equal(compiled,false);
});
