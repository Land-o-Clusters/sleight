import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { rendererObserverSource, rendererObserverClient } from '../bench/hand/stage-renderer-rss.mjs';
import { privateStageHome } from '../bench/hand/private-stage-home.mjs';
import { HOST_SOURCE, ROOT, compileArgs } from '../bench/hand/vc7-live.mjs';

test('private production build answers cache snapshots through its real observer with no NSApplication or windows',
  { skip: process.platform !== 'darwin' }, async t => {
    const work = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-renderer-rss-native-')));
    const main = join(work, 'main.swift'), binary = join(work, 'consent-host');
    writeFileSync(main, privateStageHome(rendererObserverSource(readFileSync(HOST_SOURCE, 'utf8')), work));
    const args = compileArgs(HOST_SOURCE, binary, join(work, 'modules')).map(a => a === HOST_SOURCE ? main : a);
    let observer = join(ROOT, 'bench/hand/stage-renderer-rss-observer.swift');
    if (process.env.CHV4G_NATIVE_BROKEN === 'negative-cache') {
      const source = readFileSync(observer, 'utf8'), before = '"cacheBytes": cache?["cacheBytes"] ?? 0';
      assert.ok(source.includes(before), 'native cache mutation site');
      observer = join(work, 'observer.swift'); writeFileSync(observer, source.replace(before, '"cacheBytes": -1'));
    }
    args.splice(args.indexOf('-o'), 0, observer);
    const build = spawnSync('/usr/bin/xcrun', args, { encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL' });
    assertChildStatus(build, 0, build.stderr);
    const child = spawn(binary, ['--renderer-rss-selftest'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
    const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const snapshot = rendererObserverClient(child);
      const row = await snapshot();
      assert.equal(row.pid, child.pid); assert.equal(row.loaded, false);
      assert.equal(row.cacheBytes, 0); assert.equal(row.pending, 0); assert.equal(row.shown, false);
      assert.equal((await snapshot()).cacheBytes, 0);
    } finally { child.stdio[3].end(); const exit = await ended; clearTimeout(deadline); assert.equal(exit.code, 0, stderr); }
  });
