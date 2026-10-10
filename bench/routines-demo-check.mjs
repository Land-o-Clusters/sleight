// Own the native observer build and cleanup. No app is launched or driven by this check.
import { createDemoHelper } from '../plugins/sleight/lib/demonstration.mjs';
import { RoutineStore } from '../plugins/sleight/lib/routines.mjs';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
if (existsSync('/tmp/sleight-hold')) throw new Error('sleight-hold exists; native check stopped');
if (process.argv[2] === '--installer') {
  const temporaryHome = mkdtempSync('/private/tmp/sleight-routine-preview-');
  try {
    const calls = [];
    let confirmed = false;
    const store = new RoutineStore({ home: temporaryHome, confirm: async () => confirmed,
      preapproved: () => ({ allows: app => app === 'com.apple.calculator' }),
      launchctl: async args => { calls.push(args); } });
    const print = text => console.log(text.replaceAll(temporaryHome, '<temporary HOME>'));
    const script = { sleightReplay: 1, steps: [
      { tool: 'js', args: { code: 'let app = await cua.getApp("com.apple.calculator");' }, positions: [] },
      { tool: 'js', args: { code: 'await app.click({"id":"Seven"});' }, positions: [] },
    ] };
    const plan = await store.add(script, '15m', { print });
    assert.equal(existsSync(plan.directory), false);
    assert.equal(calls.length, 0);
    confirmed = true;
    await store.add(script, '15m');
    assert.equal(store.list().length, 1);
    await store.remove(plan.id, { print });
    assert.equal(store.list().length, 0);
    assert.equal(existsSync(plan.plistPath), false);
    print(JSON.stringify({ simulatedLaunchctl: calls, realLaunchctlCalled: false, previewWrites: false, installedThenRemoved: true }));
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
} else if (!process.argv[2] || process.argv[2] === '--live-preflight') {
  const live = process.argv[2] === '--live-preflight';
  let ownsLock = false, helper;
  try {
    if (live) {
      try { mkdirSync('/tmp/sleight-live.lock'); ownsLock = true; }
      catch (error) { if (error.code === 'EEXIST') throw new Error('shared live lock is occupied; stopped without app input'); throw error; }
      if (existsSync('/tmp/sleight-hold')) throw new Error('sleight-hold exists; stopped');
    }
    helper = await createDemoHelper();
    const trust = await helper.check(), state = await helper.state();
    console.log(JSON.stringify({ observerCompiled: true, permissionRequested: false, ...trust,
      idleProbeValid: Number.isFinite(state.idleSeconds), runningAppCount: state.apps.length }));
    if (live && (!trust.trusted || !trust.listening)) throw new Error('macOS permission missing; live recording and replay stopped without a permission request');
  } finally { try { helper?.close(); } finally { if (ownsLock) rmSync('/tmp/sleight-live.lock', { recursive: true }); } }
} else throw new Error('usage: node bench/routines-demo-check.mjs [--installer|--live-preflight]');
