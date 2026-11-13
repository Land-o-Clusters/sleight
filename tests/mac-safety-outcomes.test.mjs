import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMacSafety } from '../plugins/sleight/lib/mac-safety.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';

const window = { windowId: '42', pid: 321, processStart: '1.25', bundleId: 'org.test.App', app: 'Fixture',
  title: 'Draft', identityVerified: true, onScreen: true, minimized: false,
  bounds: { x: 0, y: 0, width: 400, height: 300 } };
const binding = { windowId: '42', processStart: '1.25' };
async function fixture(factory = createMacSafety) {
  const calls = []; let readId = 0, helperGeneration = 1, outcome = { delivery: 'sent-unverified' };
  const driver = { get helperGeneration() { return helperGeneration; }, ping: async () => ({ build: 'a'.repeat(64) }), async request(method, params) {
    calls.push([method, structuredClone(params)]);
    const observed = { ...window, windowId: params.windowId ?? params.selector?.windowId ?? '42' };
    if (method === 'inputGateState') return { enabled: true };
    if (method === 'resolveApp') return { app: { id: window.bundleId, pid: window.pid, processStart: window.processStart }, windows: [observed] };
    if (method === 'verifyWindowIdentity') return { window: observed };
    if (method === 'personState') return { token: 'fixture', personTookOver: false };
    if (method === 'getAXState') return { window: observed, text: `Window: "Draft", App: Fixture.\n0 standard window Draft\n\t1 button Press`, readId: ++readId, truncated: false };
    if (outcome instanceof Error) throw outcome;
    return { window: observed, ...outcome };
  } };
  const inputRegistrar = await prepareMacInputRegistrar(driver, 'a'.repeat(64));
  const safety = factory({ driver, inputRegistrar, lease: { acquire: () => 'lease', renew() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 999, path: '/usr/bin/node' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false } });
  safety.setPolicy({ checkPause() {}, beforeAction: ({ args }) => ({ args }) });
  await safety.request('getApp', { selector: 'Fixture' });
  return { safety, calls, restart: () => { helperGeneration++; readId = 0; }, outcome: value => { outcome = value; },
    input: (params = {}) => safety.request('click', { ...binding, readId: 1, args: [1], ...params }),
    read: () => safety.request('getAXState', binding) };
}
const blocked = { code: 'READ_FIRST_REQUIRED', delivery: 'not-sent' };
const fault = delivery => Object.assign(Error('lost reply'), { code: 'ACTION_UNCONFIRMED', delivery, retry: 'read-first' });

async function unknownThenRetry(factory, delivery = 'unknown', error = false) {
  const f = await fixture(factory);
  f.outcome(error ? fault(delivery) : { delivery });
  if (error) await assert.rejects(f.input()); else await f.input();
  const sent = f.calls.length;
  await assert.rejects(f.input(), blocked);
  assert.equal(f.calls.length, sent, 'no driver call before the latch refusal');
  return f;
}
for (const delivery of ['unknown', undefined]) for (const error of [false, true])
  test(`UC2D ${error ? 'error' : 'result'} delivery=${delivery} blocks the next input`, () => unknownThenRetry(createMacSafety, delivery, error));

test('UC2D hidden, forged and pre-input reads do not clear the latch', async () => {
  const f = await fixture(), earlier = await f.read(); f.outcome({ delivery: 'unknown' });
  await f.input();
  f.safety.recordReadDelivery(earlier);
  await assert.rejects(f.input(), blocked);
  const hidden = await f.read();
  await assert.rejects(f.input(), blocked);
  f.safety.recordReadDelivery(structuredClone(hidden));
  await assert.rejects(f.input(), blocked);
  f.safety.recordReadDelivery(hidden);
  assert.equal((await f.input()).delivery, 'unknown');
});

test('UC2D a delivered read of another window grants no recovery', async () => {
  const f = await unknownThenRetry(createMacSafety);
  const other = await f.safety.request('getApp', { selector: { windowId: '43' } });
  f.safety.recordReadDelivery(other);
  await assert.rejects(f.input(), blocked);
  assert.equal((await f.input({ windowId: '43' })).delivery, 'unknown');
});

test('UC2D turn end resets the latch, a worker reset does not', async () => {
  const f = await unknownThenRetry(createMacSafety);
  await f.safety.reset();
  await f.safety.request('getApp', { selector: 'Fixture' });
  await assert.rejects(f.input(), blocked);
  await f.safety.endTurn();
  await f.safety.request('getApp', { selector: 'Fixture' });
  assert.equal((await f.input()).delivery, 'unknown');
});

for (const delivery of ['not-sent', 'sent-verified', 'sent-unverified']) test(`UC2D ${delivery} permits the next input`, async () => {
  const f = await fixture(); f.outcome({ delivery });
  await f.input(); await f.input();
  assert.equal(f.calls.filter(([method]) => method === 'click').length, 2);
});

test('UC2D a post-input validation failure still latches', async () => {
  const f = await fixture(); f.outcome({ delivery: 'unknown', window: { ...window, pid: 999 } });
  await assert.rejects(f.input());
  await assert.rejects(f.input(), blocked);
});

test('UC2D local input shares the latch in both directions', async () => {
  const f = await fixture(); f.outcome({ delivery: 'unknown' });
  await f.safety.inputForWindows([window], async () => ({ delivery: 'unknown' }));
  await assert.rejects(f.input(), blocked);
  await assert.rejects(f.safety.inputForWindows([window], async () => assert.fail('must not dispatch')), blocked);
  const read = await f.read(); f.safety.recordReadDelivery(read);
  await f.input();
  await assert.rejects(f.safety.inputForWindows([window], async () => assert.fail('must not dispatch')), blocked);
});

test('UC2D every unknown-outcome retry test detects the disabled latch mutation', async () => {
  const url = new URL('../plugins/sleight/lib/mac-safety.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8').replaceAll(/from '(\.\.?\/[^']+)'/g,
    (_, path) => `from '${new URL(path, url).href}'`);
  const needle = 'if (outcomes.has(windowKey(window)))';
  assert.ok(source.includes(needle));
  const broken = await import('data:text/javascript;base64,' + Buffer.from(source.replace(needle, 'if (false)')).toString('base64'));
  for (const delivery of ['unknown', undefined]) for (const error of [false, true])
    await assert.rejects(unknownThenRetry(broken.createMacSafety, delivery, error), { code: 'ERR_ASSERTION' });
});

test('UC2D recovery tests detect premature, forged and old-read delivery mutations', async () => {
  const url = new URL('../plugins/sleight/lib/mac-safety.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8').replaceAll(/from '(\.\.?\/[^']+)'/g,
    (_, path) => `from '${new URL(path, url).href}'`);
  const variants = [
    ['old callback', 'pending <= receipt.sequence', 'true', async f => {
      const read = await f.read(); await f.input(); f.safety.recordReadDelivery(read);
      await assert.rejects(f.input(), blocked);
    }],
    ['hidden read', 'return rememberRead(result, readSequence);',
      'outcomes.delete(windowKey(result.window)); return rememberRead(result, readSequence);', async f => {
        await f.input(); await f.read(); await assert.rejects(f.input(), blocked);
      }],
    ['forged receipt', 'const receipt = readReceipts.get(result);',
      'const receipt = readReceipts.get(result) ?? { epoch, helperEpoch, generation: driver.helperGeneration, key: windowKey(result.window), sequence: outcomeSequence };', async f => {
        await f.input(); const read = await f.read(); f.safety.recordReadDelivery(structuredClone(read));
        await assert.rejects(f.input(), blocked);
      }],
    ['worker reset', 'reset() { epoch++; driver.cancelPending?.(); runtimePolicy?.reset?.(); inspections.clear(); deliveredCoordinates.clear();',
      'reset() { epoch++; driver.cancelPending?.(); runtimePolicy?.reset?.(); inspections.clear(); clearEvidence();', async f => {
        await f.input(); await f.safety.reset(); await f.safety.request('getApp', { selector: 'Fixture' });
        await assert.rejects(f.input(), blocked);
      }],
  ];
  for (const [name, from, to, scenario] of variants) {
    const good = await fixture(); good.outcome({ delivery: 'unknown' }); await scenario(good);
    assert.equal(source.split(from).length, 2, name);
    const broken = await import('data:text/javascript;base64,' + Buffer.from(source.replace(from, to)).toString('base64'));
    const bad = await fixture(broken.createMacSafety); bad.outcome({ delivery: 'unknown' });
    await assert.rejects(scenario(bad), { code: 'ERR_ASSERTION' }, name);
  }
});

for (const delivery of ['sent-unverified', 'sent-verified']) test(`UC2D2 local ${delivery} reply permits chained input`, async () => {
  const f = await fixture();
  await f.safety.inputForWindows([window], async () => ({ delivery }));
  await f.input(); await f.input();
  assert.equal(f.calls.filter(([method]) => method === 'click').length, 2);
});

test('UC2D2 a timeout remains latched until a fresh complete delivered read', async () => {
  const f = await fixture(), earlier = await f.read();
  f.outcome(Object.assign(Error('timeout'), {code: 'DEADLINE_EXCEEDED'}));
  await assert.rejects(f.input(), {code: 'DEADLINE_EXCEEDED'});
  f.outcome({delivery: 'sent-unverified'});
  f.safety.recordReadDelivery(earlier); await assert.rejects(f.input(), blocked);
  const read = await f.read(); await assert.rejects(f.input(), blocked);
  f.safety.recordReadDelivery(read); await f.input(); await f.input();
});

test('UC2D2 a malformed acknowledged reply keeps the latch', async () => {
  const f = await fixture(); f.outcome({delivery: 'sent-unverified', window: {...window, pid: 999}});
  await assert.rejects(f.input()); await assert.rejects(f.input(), blocked);
});

async function generationScenario(factory = createMacSafety) {
  const f = await fixture(factory);
  const capture = async id => {
    f.outcome({screenshot:{data:'fixture',mimeType:'image/png'},coordinateReadId:id});
    return f.safety.request('getScreenshot',binding);
  };
  const old = await capture(100); f.safety.recordReadDelivery(old,{screenshotDelivered:true});
  f.restart();
  // Hidden capture collides with the old ID in the replacement helper.
  await capture(100); f.outcome({delivery:'sent-unverified'});
  await assert.rejects(f.input({args:[[40,30]]}), {code:'TARGET_CHANGED'});
  f.safety.recordReadDelivery(old,{screenshotDelivered:true});
  await assert.rejects(f.input({args:[[40,30]]}), {code:'TARGET_CHANGED'});
  const fresh=await capture(1); f.safety.recordReadDelivery(fresh,{screenshotDelivered:true});
  f.outcome({delivery:'sent-unverified'}); await f.input({args:[[40,30]]});
  assert.equal(f.calls.at(-1)[1].coordinateReadId,1);
}
test('UC2D2 screenshot receipts bind helper generation and replace old larger IDs', () => generationScenario());

test('UC2D2 truncated reads cannot recover a lost reply', async () => {
  const f=await unknownThenRetry(createMacSafety);
  f.outcome({text:'partial',readId:20,truncated:true});
  const read=await f.safety.request('getScreenshot',binding); f.safety.recordReadDelivery(read);
  await assert.rejects(f.input(),blocked);
});

test('UC2D2 generation test detects independent request and receipt mutations', async () => {
  const url = new URL('../plugins/sleight/lib/mac-safety.mjs', import.meta.url);
  const source = readFileSync(url,'utf8').replaceAll(/from '(\.\.?\/[^']+)'/g,(_,path)=>`from '${new URL(path,url).href}'`);
  for (const [from,to,scenario] of [
    ['!capture || capture.generation !== driver.helperGeneration','!capture',generationScenario],
    ['receipt.generation !== driver.helperGeneration || closed','closed',receiptGenerationScenario],
  ]) {
    assert.equal(source.split(from).length,2);
    const broken=await import('data:text/javascript;base64,'+Buffer.from(source.replace(from,to)).toString('base64'));
    await assert.rejects(scenario(broken.createMacSafety),{code:'ERR_ASSERTION'});
  }
});

async function receiptGenerationScenario(factory=createMacSafety) {
  const f=await unknownThenRetry(factory), old=await f.read(); f.restart();
  f.safety.recordReadDelivery(old); await assert.rejects(f.input(),blocked);
}
test('UC2D2 an old helper read cannot unlatch a lost input',()=>receiptGenerationScenario());
