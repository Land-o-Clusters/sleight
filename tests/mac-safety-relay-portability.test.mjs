import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('relay safety cases finish without a permission-limited worker or developer packages', () => {
  // Exercise the actual relay suite with Node 24's missing network permission.
  // This changes only the test process, without launching a native helper.
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    import { registerHooks } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'allowedNodeEnvironmentFlags', {
      value: new Set([...process.allowedNodeEnvironmentFlags].filter(flag => flag !== '--allow-net')),
    });
    registerHooks({ resolve(name, context, next) {
      if (name === 'typescript') throw Object.assign(Error('missing test parser'), { code: 'MODULE_NOT_FOUND' });
      return next(name, context);
    } });
  `);
  const child = spawnSync(process.execPath, ['--import', preload, '--test', '--test-concurrency=4',
    '--test-reporter=tap', '--test-timeout=5000',
    fileURLToPath(new URL('./mac-safety-relay.test.mjs', import.meta.url)),
    fileURLToPath(new URL('./glide-preapproved-mutations.test.mjs', import.meta.url)),
  ], { env: { ...process.env, NODE_TEST_CONTEXT: undefined }, encoding: 'utf8',
    timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  const output = child.stdout + child.stderr;
  assert.equal(child.status, 0, output);
  assert.match(output, /^# fail 0$/m);
  assert.match(output, /^# cancelled 0$/m);
  assert.match(output, /# SKIP real REPL worker needs Node 25 or later with --permission and --allow-net/);
  assert.match(output, /ok \d+ - closing own cancels its pending shell panel before any content read\n/);
  assert.match(output, /ok \d+ - own and engine relays refuse the same blocked turbo browser and engine browser site\n/);
  assert.match(output, /ok \d+ - GL3 detects broken variant: shared ceiling removed\n/);
});
