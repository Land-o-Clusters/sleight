import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createV3Bridge } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { prepareInstalledStartup } from '../plugins/sleight/lib/launch.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

const config = { profileRoot: '/fixture/chrome-profile', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' };
const base = { readConfig: () => config, acceptPackage: () => ({ current: () => true }), shareConsent: async () => {}, tracePhase: () => {} };
const waitFor = async predicate => {
  const until = Date.now() + 6000;
  while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'bounded fixture wait');
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

for (const boundary of ['endTurn', 'close', 'disconnect', 'worker-exit']) test(`pending compiler is collected on ${boundary}`, { skip: process.platform !== 'darwin', timeout: 15000 }, async t => {
  const root = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-turbo-cancel-')))));
  mkdirSync(join(root, 'sources'), { mode: 0o700 });
  for (const name of ['peer-host.c', 'consent-host.swift']) writeFileSync(join(root, 'sources', name), 'offline compiler input', { mode: 0o600 });
  let child, exited, compiler;
  const dependencies = { ...base, forkWorker() {
    child = fork(fileURLToPath(new URL('fixtures/turbo-cancel-worker.mjs', import.meta.url)), [root],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    child.stderr.resume();
    exited = new Promise(resolve => child.once('exit', resolve));
    return child;
  } };
  const prepared = await prepareInstalledStartup(options => createV3Bridge(options, dependencies), () => {},
    { defer: true, deferredDependencies: base, log: () => {}, trace: () => {} });
  const bridge = prepared.directHost;
  t.after(async () => {
    await bridge.close();
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM');
    await exited;
    if (compiler) await waitFor(() => !alive(compiler));
  });
  await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'one', text: 'Read the fixture.' });
  assert.match((await bridge.call({ name: 'browser_tabs', arguments: { do: 'list' } })).text, /Preparing turbo/);
  await waitFor(() => existsSync(join(root, 'compiler.pid')));
  compiler = Number(readFileSync(join(root, 'compiler.pid'), 'utf8'));
  assert.equal(alive(compiler), true);
  if (boundary === 'disconnect') child.disconnect();
  else if (boundary === 'worker-exit') child.kill('SIGTERM');
  else {
    const receipt = await bridge[boundary]();
    assert.deepEqual(receipt, { revoked: true, cleanup: [] });
    assert.equal(alive(compiler), false, 'receipt follows compiler collection');
  }
  await exited;
  await waitFor(() => !alive(compiler));
  if (boundary !== 'worker-exit') {
    assert.equal(existsSync(join(root, 'cache', 'build.lock')), false);
    assert.ok(!readdirSync(join(root, 'cache')).some(name => name.startsWith('.build-')));
    assert.equal(JSON.parse(readFileSync(join(root, 'worker-result.json'))).code, 'PARENT_GONE');
  }
});
