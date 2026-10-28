import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as compat from '../bench/compat.mjs';

// Representative lines from the bundled Node's --help, including aliases and optional values.
const HELP = `Usage: node [options] [ script.js ] [arguments]
Options:
  --                          indicate the end of node options
  --no-warnings               silence all process warnings
  -C, --conditions=...        additional user conditions
  --import=...                ES module to preload
  --loader, --experimental-loader=...
                              use the specified module as a custom loader
  --env-file-if-exists=...    set environment variables from supplied file
  -r, --require=...           CommonJS module to preload
  --title=...                 process title
  --build-snapshot-config=... Generate a snapshot blob
  --test-coverage-exclude=... exclude files from coverage report
  --experimental-default-config-file, --experimental-config-file=...
                              set config file path
  -p, --print [...]           evaluate script and print result
  --inspect[=[host:]port]     activate inspector
Environment variables:
NODE_OPTIONS                 options for Node.js
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sleight-launch-shape-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'plugins/cache/openai-bundled/unified-computer-use/26.1023.50603');
  mkdirSync(configDir, { recursive: true });
  const script = join(root, 'cua-repl.mjs'), hook = join(root, 'require-browser-access.mjs');
  // Starting either file is a test failure. Only Node's --help may run.
  writeFileSync(script, 'throw new Error("engine must not start");');
  writeFileSync(hook, 'throw new Error("helper must not start");');
  const env = { CODEX_HOME: root, SLEIGHT_CHATGPT_APP: join(root, 'no-app') };
  const setArgs = args => writeFileSync(join(configDir, '.mcp.json'), JSON.stringify({ mcpServers: {
    cua_repl: { command: process.execPath, args, env: { PRIVATE_SENTINEL: 'never record env' } },
  } }));
  const check = async args => {
    setArgs(args);
    assert.equal(typeof compat.launchShapeCheck, 'function', 'launch-shape check is missing');
    return compat.launchShapeCheck({ env, nodeHelp: HELP });
  };
  return { root, script, hook, env, setArgs, check };
}

test('launch shape resolves the old one-script .mcp.json without starting it', async t => {
  const f = fixture(t), result = await f.check([f.script]);
  assert.equal(result.version, '26.1023.50603');
  assert.equal(result.result.id, 'launch-shape');
  assert.equal(result.result.status, 'pass');
  assert.deepEqual(result.result.shape, [f.script]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
  assert.ok(!JSON.stringify(result).includes('engine must not start'));
});

test('launch shape accepts --import and preserves option order and file URLs', async t => {
  const f = fixture(t), args = ['--no-warnings', '--import', pathToFileURL(f.hook).href, '--title=private title', f.script];
  const { result } = await f.check(args);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.shape, ['--no-warnings', '--import', pathToFileURL(f.hook).href, '--title=<value>', f.script]);
  assert.ok(result.nodeValueOptions.includes('--experimental-loader'));
  assert.ok(result.nodeValueOptions.includes('--loader'));
  assert.ok(result.nodeValueOptions.includes('-C'));
  assert.ok(!result.nodeValueOptions.includes('--inspect'));
  assert.ok(result.nodeValueOptions.includes('--build-snapshot-config'));
  assert.ok(result.nodeValueOptions.includes('--test-coverage-exclude'));
  assert.ok(result.nodeValueOptions.includes('--print'));
  assert.ok(!result.nodeValueOptions.includes('--experimental-default-config-file'));
});

for (const which of ['script', 'hook']) test(`launch shape fails when the ${which} file is missing`, async t => {
  const f = fixture(t);
  rmSync(f[which]);
  const { result } = await f.check(['--import', pathToFileURL(f.hook).href, f.script]);
  assert.equal(result.status, 'fail');
  assert.match(result.reason, which === 'script' ? /server script/ : /option file/);
});

test('launch shape fails on absent script, directories and malformed file URLs', async t => {
  const f = fixture(t);
  for (const args of [[], ['--import', f.hook], [f.root], ['--import', f.root, f.script], ['--import=file://host/bad.mjs', f.script]]) {
    assert.equal((await f.check(args)).result.status, 'fail', JSON.stringify(args));
  }
});

test('launch shape fails on an unknown option even with an inline value', async t => {
  const f = fixture(t);
  for (const args of [['--future-option', f.script], ['--future-option=value', f.script]]) {
    const { result } = await f.check(args);
    assert.equal(result.status, 'fail');
    assert.match(result.reason, /unknown option arity.*--future-option/);
  }
});

test('launch shape compares used value-taking options with EC1, including aliases', async t => {
  const f = fixture(t);
  for (const option of ['--env-file-if-exists', '--env-file-if-exists=']) {
    const args = option.endsWith('=') ? [option + f.hook, f.script] : [option, f.hook, f.script];
    const { result } = await f.check(args);
    assert.equal(result.status, 'fail');
    assert.match(result.reason, /parser does not consume.*--env-file-if-exists/);
  }
  assert.equal((await f.check(['--loader', f.hook, f.script])).result.status, 'pass');
  assert.equal((await f.check(['-r', f.hook, f.script])).result.status, 'pass');
});

test('launch shape rejects a missing option value and malformed args', async t => {
  const f = fixture(t);
  for (const args of [['--import'], [f.script, 7], '--import', ['--import', '--no-warnings', f.script]]) {
    assert.equal((await f.check(args)).result.status, 'fail', JSON.stringify(args));
  }
});

test('launch shape scrubs home paths and does not log arbitrary option values', async t => {
  const f = fixture(t);
  const { result } = await f.check([`--import=file://${homedir()}/missing-hook.mjs`, '--title', 'private title', f.script]);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.shape, ['--import=file://~/missing-hook.mjs', '--title', '<value>', f.script]);
  assert.ok(!JSON.stringify(result).includes(homedir()));
  assert.ok(!JSON.stringify(result).includes('private title'));
});

test('launch shape runs only the resolved runtime --help with no preload environment', async t => {
  const f = fixture(t);
  f.setArgs(['--import', pathToFileURL(f.hook).href, f.script]);
  assert.equal(typeof compat.launchShapeCheck, 'function');
  const result = await compat.launchShapeCheck({ env: { ...f.env, NODE_OPTIONS: '--import=do-not-load' }, run: async (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['--help']);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.PRIVATE_SENTINEL, undefined);
    return { stdout: HELP };
  } });
  assert.equal(result.result.status, 'pass');
});

test('launch shape fails closed on unavailable help and resolver errors', async t => {
  const f = fixture(t);
  f.setArgs([f.script]);
  assert.equal(typeof compat.launchShapeCheck, 'function');
  for (const options of [{ nodeHelp: 'not node help' }, { run: async () => { throw new Error('secret error'); } },
    { resolve: () => ({ error: 'secret engine contents' }) }]) {
    const checked = await compat.launchShapeCheck({ env: f.env, ...options });
    assert.equal(checked.result.status, 'fail');
    assert.ok(!JSON.stringify(checked).includes('secret'));
  }
});

test('--launch-shape CLI is read-only and reports the fixture config without starting it', t => {
  const f = fixture(t);
  f.setArgs(['--import', pathToFileURL(f.hook).href, f.script]);
  const report = join(f.root, 'report.json');
  const output = execFileSync(process.execPath, ['bench/compat.mjs', '--launch-shape', '--report', report], {
    env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 10000,
  });
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(parsed.verdict, 'pass');
  assert.deepEqual(parsed.steps.map(s => s.id), ['launch-shape']);
  assert.match(output, /launch-shape/);
  assert.ok(!existsSync(join(f.root, 'Library')));
});

test('watch logs launch shape next to the docs result on a changed version, then skips it', async t => {
  const f = fixture(t), logs = join(f.root, 'logs');
  f.setArgs(['--future-option', f.script]);
  assert.equal(typeof compat.launchShapeCheck, 'function');
  let helps = 0;
  const deps = { holdPath: join(f.root, 'hold'), lockPath: join(f.root, 'live-lock'), notify: async () => {},
    run: async () => ({ stdout: 'Codex computer-use 26.1023.50603\n' }),
    nodeHelp: HELP, open: async () => assert.fail('incompatible engine must not start'),
  };
  // Count resolution to prove unchanged runs leave the launch check alone.
  const { resolveServer } = await import('../plugins/sleight/lib/launch.mjs');
  deps.resolve = env => { helps++; return resolveServer(env); };
  assert.equal(await compat.runWatch({ env: f.env, logs, deps }), 1);
  assert.equal(helps, 1);
  assert.equal(compat.lastRecord(logs, '26.1023.50603').steps.find(s => s.id === 'launch-shape').status, 'fail');
  assert.match(readFileSync(join(logs, 'watch.log'), 'utf8'), /launch-shape: fail/);
  assert.equal(await compat.runWatch({ env: f.env, logs, deps }), 0);
  assert.equal(helps, 1);
});

test('watch still records launch shape when doctor fails before engine checks', async t => {
  const f = fixture(t), logs = join(f.root, 'logs');
  f.setArgs(['--import', pathToFileURL(f.hook).href, f.script]);
  rmSync(f.hook);
  const deps = { holdPath: join(f.root, 'hold'), lockPath: join(f.root, 'live-lock'), notify: async () => {}, nodeHelp: HELP,
    run: async () => { throw Object.assign(new Error('doctor failed'), { stdout: 'Codex computer-use 26.1023.50603\nMISSING server file\n', code: 1 }); } };
  assert.equal(await compat.runWatch({ env: f.env, logs, deps }), 1);
  const result = compat.lastRecord(logs, '26.1023.50603').steps.find(s => s.id === 'launch-shape');
  assert.equal(result?.status, 'fail');
  assert.match(result.reason, /option file/);
});
