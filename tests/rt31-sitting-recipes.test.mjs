import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVMBackend, runVMSitting, mapGuestPoints } from '../bench/windows/rt31-sitting.mjs';

function fakeVM(stop) {
  const posts = [], inspections = [], ops = [];
  let text = '0123456789', caret = 0, released = false, guardClosed = false;
  const points = { text: [20, 90], toolbar: [30, 80], after5: [60, 90], after2: [40, 90] };
  const guest = () => ({ fixture: true, driverRead: true, windowId: '42', processStart: 'start', text, caret, selectionLength: 0, layout: '00000409' });
  const dependencies = {
    platform: 'darwin', env: { CLAUDE_CONFIG_DIR: '/fixture/config' },
    metadata: async () => ({ fake: true }),
    acquireLiveLock: async () => async () => { released = true; },
    startGuard: () => ({ records: [], async start() { if (stop) throw Error(stop); }, async check() {}, async close() { guardClosed = true; },
      async call() { return { vmPID: 321, vmWindow: 654 }; } }),
    guestTransport: async () => ({ cleanupConfirmed: true, async call(op) {
      ops.push(op); if (op === 'restore') { text = '0123456789'; caret = 0; } return { ...guest(), confirmed: ['restore', 'close'].includes(op), closed: op === 'close' };
    } }),
    startTool: (_path, request, o) => {
      assert.equal(request.mode, 'background'); assert.equal(request.pid, 321); assert.equal(request.window, 654);
      if (o?.inspect) inspections.push(request);
      else {
        posts.push(request);
        if (request.row === 'click') caret = request.point[0] === 60 ? 6 : 3;
        if (request.row.endsWith('keys')) { text = text.slice(0, caret) + '\nq' + text.slice(caret); caret++; }
      }
      return { interrupt() { throw Error('UNEXPECTED_CANCEL'); }, done: Promise.resolve({ code: 0, records: [{
        record: o?.inspect ? 'inspection' : 'summary', ok: true, pending: 0, beliefCleared: true, maxCriticalSectionMs: 50,
        toolbarHeight: 48, titleBarHeight: 32,
      }] }) };
    },
  };
  return { points, dependencies, posts, inspections, ops, get released() { return released; }, get guardClosed() { return guardClosed; } };
}
test('real VM recipe runs six background rows with exact point inspections and guest readback', async () => {
  const f = fakeVM();
  const backend = await createVMBackend({ tools: '/fixture/tools', points: f.points }, f.dependencies);
  const r = await runVMSitting({ backend });
  assert.equal(r.completed, true, JSON.stringify(r));
  assert.equal(f.posts.length, 6); assert.equal(f.inspections.length, 7);
  assert.deepEqual(f.posts.map(r => r.row), ['move', 'move', 'click', 'click', 'mapped-keys', 'belief-keys']);
  assert.deepEqual(f.posts[2].point, f.points.after5); assert.deepEqual(f.posts[3].point, f.points.after2);
  assert.equal(f.ops.filter(op => op === 'read').length, 12); assert.deepEqual(f.ops.slice(-2), ['restore', 'close']);
  assert.equal(r.restore.text, '0123456789'); assert.equal(r.restore.caret, 0);
  assert.equal(r.rows.filter(r => r.effect.matchesExpected === true).length, 4);
  assert.equal(f.released, true);
  assert.equal(r.collection.fixtureClosed, true);
});
test('guest UIA pixels map to inspected host content in bottom-left points and refuse unknown scaling', () => {
  const guest = { guestDesktop: [1000, 500], guestPoints: { text: [100, 100], toolbar: [200, 50], after5: [300, 100], after2: [250, 100] } };
  const inspection = { windowFrame: [100, 200, 1000, 600], axContentFrame: [100, 300, 1000, 500] };
  assert.deepEqual(mapGuestPoints(guest, inspection).after5, [300, 400]);
  assert.throws(() => mapGuestPoints(guest, { ...inspection, axContentFrame: [100, 300, 900, 500] }), /DISPLAY_MAPPING_UNCONFIRMED/);
  assert.throws(() => mapGuestPoints({ ...guest, guestDesktop: [0, 500] }, inspection), /DISPLAY_MAPPING_UNCONFIRMED/);
  assert.throws(() => mapGuestPoints({ ...guest, guestPoints: { ...guest.guestPoints, text: [-1, 100] } }, inspection), /GUEST_POINT_GEOMETRY_REQUIRED/);
});
test('fixture-only preflight checks scheduled-task setup and closes without posting or restoring', async () => {
  const f = fakeVM();
  const r = await runVMSitting({ backend: await createVMBackend({ tools: '/fixture/tools', points: f.points }, f.dependencies), fixtureCheckOnly: true });
  assert.equal(r.completed, true); assert.equal(f.posts.length, 0); assert.equal(f.inspections.length, 1);
  assert.deepEqual(f.ops, ['setup', 'close']); assert.equal(f.released, true);
});
test('an inspection failure still closes the bound guest fixture without posting', async () => {
  const f = fakeVM();
  f.dependencies.startTool = () => ({ interrupt() {}, done: Promise.resolve({ code: 1, reason: 'WINDOW_UNAVAILABLE', records: [] }) });
  const backend = await createVMBackend({ tools: '/fixture/tools', points: f.points }, f.dependencies);
  const r = await runVMSitting({ backend });
  assert.equal(r.stop, 'WINDOW_UNAVAILABLE'); assert.equal(r.rows.length, 0);
  assert.equal(r.cleanupConfirmed, true); assert.equal(f.released, true); assert.equal(f.ops.at(-1), 'close');
});
for (const reason of ['GUEST_CLOSE_UNCONFIRMED', 'GUEST_NOTEPAD_STATE_BACKUP_FAILED', 'NOTEPAD_ALREADY_RUNNING']) {
test(`guest close refusal ${reason} retains the lock`, async () => {
  const f = fakeVM(), base = f.dependencies.guestTransport;
  f.dependencies.guestTransport = async () => {
    const transport = await base();
    return { ...transport, async call(op) { if (op === 'close') throw Error(reason); return transport.call(op); } };
  };
  const r = await runVMSitting({ backend: await createVMBackend({ tools: '/fixture/tools', points: f.points }, f.dependencies) });
  assert.equal(r.completed, false); assert.equal(r.cleanupConfirmed, false); assert.equal(f.released, false);
  assert.equal(r.collection.closeReason, reason);
  assert.equal(r.collection.fixtureClosed, false);
});
}
test('uncertain key releases prevent guest writes and retain the lock', async () => {
  const f = fakeVM(), base = f.dependencies.startTool;
  f.dependencies.startTool = (path, request, options) => options?.inspect ? base(path, request, options) : {
    interrupt() {}, done: Promise.resolve({ code: 1, records: [{ pending: 1, beliefCleared: false }] }),
  };
  const r = await runVMSitting({ backend: await createVMBackend({ tools: '/fixture/tools', points: f.points }, f.dependencies) });
  assert.equal(r.stop, 'CLEANUP_UNCONFIRMED'); assert.equal(r.cleanupConfirmed, false); assert.equal(f.released, false);
  assert.ok(!f.ops.includes('close')); assert.ok(!f.ops.includes('restore'));
});
test('task-launched Notepad foreground refusal still schedules its bound close', async () => {
  const f = fakeVM(), base = f.dependencies.guestTransport;
  f.dependencies.guestTransport = async () => {
    const transport = await base();
    return { ...transport, async call(op) { if (op === 'setup') throw Error('GUEST_NOTEPAD_NOT_FRONTMOST'); return transport.call(op); } };
  };
  const r = await runVMSitting({ backend: await createVMBackend({ tools: '/fixture/tools', points: f.points }, f.dependencies) });
  assert.equal(r.stop, 'GUEST_NOTEPAD_NOT_FRONTMOST'); assert.equal(f.posts.length, 0);
  assert.equal(r.collection.fixtureClosed, true); assert.equal(f.released, true);
});
test('a lost posting reply still collects the guard and keeps the lock without guest writes', async () => {
  const f = fakeVM(), base = f.dependencies.startTool;
  f.dependencies.startTool = (path, request, options) => options?.inspect ? base(path, request, options) : {
    interrupt() {}, done: Promise.reject(Error('CHILD_REPLY_LOST')),
  };
  const r = await runVMSitting({ backend: await createVMBackend({ tools: '/fixture/tools', points: f.points }, f.dependencies) });
  assert.equal(r.stop, 'CHILD_REPLY_LOST'); assert.equal(r.cleanupConfirmed, false); assert.equal(f.released, false);
  assert.equal(f.guardClosed, true); assert.ok(!f.ops.includes('close')); assert.ok(!f.ops.includes('restore'));
});
for (const reason of ['UTM_NOT_OPEN', 'UTM_NOT_UNCOVERED', 'CAPTURE_ON', 'CAPTURE_STATE_UNKNOWN', 'WINDOW_BLOCKED']) {
  test(`native preflight ${reason} prevents guest setup and all tool invocations`, async () => {
    const f = fakeVM(reason), backend = await createVMBackend({ tools: '/fixture/tools', points: f.points }, f.dependencies);
    const r = await runVMSitting({ backend });
    assert.equal(r.stop, reason); assert.equal(f.ops.length, 0); assert.equal(f.posts.length, 0); assert.equal(f.inspections.length, 0);
  });
}
test('a banner onscreen stops the RT31 input loop before any post', async () => {
  async function prove(create, run) {
    const posts = [];
    let inspections = 0, banner = false;
    const points = { text: [20, 90], toolbar: [30, 80], after5: [60, 90], after2: [40, 90] };
    const guest = () => ({ fixture: true, driverRead: true, windowId: '42', processStart: 'start', text: '0123456789', caret: 0, selectionLength: 0, layout: '00000409' });
    const dependencies = {
      platform: 'darwin', env: { CLAUDE_CONFIG_DIR: '/fixture/config' },
      metadata: async () => ({ fake: true }),
      acquireLiveLock: async () => async () => {},
      startGuard: (_path, settings) => ({
        records: [],
        async start() {},
        async check() {
          if (banner && settings.exemptSystemOverlay !== true) { settings.onStop('FOREIGN_WINDOW'); throw Error('FOREIGN_WINDOW'); }
        },
        async close() {},
        async call() { return { vmPID: 321, vmWindow: 654 }; },
      }),
      guestTransport: async () => ({ cleanupConfirmed: true, async call(op) {
        return { ...guest(), confirmed: op === 'restore' || op === 'close', closed: op === 'close' };
      } }),
      startTool: (_path, request, o) => {
        if (o?.inspect) {
          inspections += 1;
          if (inspections > 1) banner = true;
          return { interrupt() {}, done: Promise.resolve({ code: 0, records: [{ record: 'inspection', ok: true, pending: 0, beliefCleared: true, maxCriticalSectionMs: 1, toolbarHeight: 48, titleBarHeight: 32 }] }) };
        }
        posts.push(request);
        return { interrupt() {}, done: Promise.resolve({ code: 0, records: [{ record: 'summary', ok: true, pending: 0, beliefCleared: true, maxCriticalSectionMs: 1 }] }) };
      },
    };
    const report = await run({ backend: await create({ tools: '/fixture/tools', points }, dependencies) });
    assert.equal(posts.length, 0);
    assert.equal(report.stop, 'FOREIGN_WINDOW');
    assert.ok(inspections >= 2);
  }
  await prove(createVMBackend, runVMSitting);
  const url = new URL('../bench/windows/rt31-sitting.mjs', import.meta.url);
  const rewrite = source => source.replace(/from '(\.\.?\/[^']+)'/g, (_all, spec) => `from '${new URL(spec, url).href}'`).replaceAll('import.meta.url', JSON.stringify(url.href));
  const load = source => import('data:text/javascript;base64,' + Buffer.from(rewrite(source)).toString('base64'));
  const original = readFileSync(url, 'utf8');
  const opted = await load(original.replace("kind: 'vm', onStop: stop", "kind: 'vm', exemptSystemOverlay: true, onStop: stop"));
  await assert.rejects(prove(opted.createVMBackend, opted.runVMSitting), assert.AssertionError);
  const skipped = await load(original.replace(
    `if (inspected.code !== 0) throw Error(inspected.reason ?? 'INSPECTION_FAILED');
      await check();
      runMayPost = true;`,
    `if (inspected.code !== 0) throw Error(inspected.reason ?? 'INSPECTION_FAILED');
      runMayPost = true;`));
  await assert.rejects(prove(skipped.createVMBackend, skipped.runVMSitting), assert.AssertionError);
});
