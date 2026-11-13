import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareMacDriver } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('real compiler cache validates both fixed artifacts without starting the driver',
  { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
    const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-driver-real-build-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cacheRoot = join(root, 'mac-driver');
    const host = await prepareMacDriver({ cacheRoot });
    assert.match(host.binary, /\/mac-driver\/[a-f0-9]{64}\/glide-engine$/);
    assert.equal(host.status, 'ready', host.code); assert.match(host.build, /^[a-f0-9]{64}$/);
    const bank = host.binary.slice(0, host.binary.lastIndexOf('/'));
    const record = JSON.parse(await readFile(join(bank, 'build.json'), 'utf8'));
    assert.deepEqual(Object.keys(record.sources), ['peer-host.c', 'glide-engine.swift']);
    assert.deepEqual(Object.keys(record.binaries).sort(), ['glide-engine', 'peer-host']);
    const again = await prepareMacDriver({ cacheRoot, tools: async () => { throw Error('tools probe on hit'); } });
    assert.equal(again.status, 'ready'); assert.equal(again.binary, host.binary);
    assert.throws(() => again.spawn({ nonce: 'bad' }), /INVALID_NONCE/);
    // Both invocations refuse before constructing a core, sampling a session,
    // taking power, inspecting inventory or registering any handler.
    for (const args of [['--fixture', 'not-a-fixture'], ['--unknown']]) {
      await assert.rejects(promisify(execFile)(host.binary, args, { env: {}, timeout: 5000 }), { code: 64 });
    }
    t.diagnostic(`production driver ${(await stat(host.binary)).size} bytes; 2 cached artifacts verified`);
  });
