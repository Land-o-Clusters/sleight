import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, realpath, stat, mkdir, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const nonce = 'a'.repeat(64), binding = { windowId: '7', processStart: 'start' };
const frame = { x: 0, y: 0, width: 100, height: 100 };
const envelope = (id, method, params = {}) => ({ protocol: 'sleight.driver/1', platform: 'darwin', nonce,
  id, method, params, deadline: Date.now() + 10000 });
const fixture = semantic => ({ semantic,
  apps: [{ id: 'test.fake', name: 'Fixture', pid: 42, processStart: 'start' }],
  windows: [{ ...binding, pid: 42, app: 'Fixture', title: 'Fixture', bounds: frame,
    onScreen: true, layer: 0, hidden: false }],
  trees: { 7: { AXRole: 'AXWindow', AXTitle: 'Fixture', AXMinimized: false, AXFullScreen: false, frame, children: [
    { AXRole: 'AXTextField', AXValue: 'old', AXEnabled: true, AXSelectedTextRange: [0, 3], frame },
  ] } },
});

test('strict semantic startup and EOF use the actual stdin lifecycle with fake providers', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await realpath(await mkdtemp(join(tmpdir(), 'sleight-semantic-lifecycle-'))));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'driver.swift'), binary = join(root, 'driver');
  const hooks = await readFile(new URL('./fixtures/mac-driver-semantic-lifecycle.swift', import.meta.url), 'utf8');
  const installed = macDriverSource();
  const checked = process.env.GL1_NATIVE_MUTANT === 'disabled'
    ? installed.replace('let driverInputGateEnabled = true', 'let driverInputGateEnabled = false') : installed;
  const composed = checked.replaceAll('NSPasteboard.general', 'forbiddenGeneral()').replace('runtime.install(driverRegistrars)', 'runtime.install(driverRegistrars)\nfixtureSemanticRegister(runtime)');
  const entry = composed.lastIndexOf('\ndriverMain()');
  assert.ok(entry > 0);
  await writeFile(source, composed.slice(0, entry) + '\nfunc forbiddenGeneral() -> NSPasteboard { fatalError("general pasteboard factory accessed") }\n' + hooks + composed.slice(entry));
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES', '-module-cache-path', join(root, 'modules'), source, '-o', binary],
    { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000, maxBuffer: 65536 });
  assert.equal(compile.status, 0, JSON.stringify({ stderr: compile.stderr, signal: compile.signal, error: compile.error?.code }));
  t.diagnostic(`lifecycleBinaryBytes=${(await stat(binary)).size}`);
  const run = async (config = {}, requests = [{ method: 'ping' }], bank) => {
    const directory = bank ?? await mkdtemp(join(root, 'case-'));
    const path = join(directory, 'fixture.json');
    const data = fixture({ root: directory, ...config });
    if (config.offSpace) data.windows[0].onScreen = false;
    await writeFile(path, JSON.stringify(data));
    const started = performance.now();
    const child = spawnSync(binary, ['--fixture', path], { env: { ...process.env, HOME: directory, SLEIGHT_DRIVER_NONCE: nonce },
      input: requests.map((request, index) => JSON.stringify(envelope(index + 1, request.method, request.params))).join('\n') + '\n',
      killSignal: 'SIGKILL', encoding: 'utf8', timeout: 15000 });
    assert.equal(child.stderr, ''); assert.equal(child.signal, null); assert.equal(child.error, undefined);
    const rows = child.stdout.trim() ? child.stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
    return { directory, rows, status: child.status, elapsed: performance.now() - started, board: JSON.parse(await readFile(join(directory, 'board.json'), 'utf8')) };
  };
  const paste = () => [{ method: 'getAXState', params: binding },
    { method: 'paste', params: { ...binding, readId: 1, args: ['agent'] } }];
  const text = board => Buffer.from(board.items[0]['public.utf8-plain-text'], 'base64').toString();

  await t.test('the real semantic registrar refuses off-Space paste before any clipboard write', async () => {
    const row = await run({ registerSemantic: true, offSpace: true }, paste());
    assert.equal(row.status, 0); assert.equal(row.rows[0].ok, true);
    assert.equal(row.rows[1].error.code, 'NO_WINDOWS_AVAILABLE');
    assert.equal(row.rows[1].error.delivery, 'not-sent'); assert.equal(row.rows[1].error.retry, 'safe');
    assert.match(row.rows[1].error.message, /another Space or off screen/);
    assert.equal(row.board.writes, 0); assert.equal(text(row.board), 'owner');
  });

  await t.test('installed startup advertises semantic input and retains no clipboard capability', async () => {
    const row = await run({}, [{ method: 'ping' }, { method: 'paste', params: { ...binding, readId: 1, args: ['agent'] } }]); assert.equal(row.status, 0); assert.equal(row.rows[0].ok, true);
    for (const method of ['setValue', 'selectText', 'performSecondaryAction', 'paste']) assert.equal(row.rows[0].result.methods.includes(method), true);
    assert.equal(row.rows[1].error.code, 'ACTION_UNSUPPORTED');
    for (const key of ['writes', 'reads', 'clears', 'providers', 'factory']) assert.equal(row.board[key], 0);
    assert.equal(text(row.board), 'owner');
  });
  await t.test('EOF after unknown delivery and crash restart never replay input or access a board', async () => {
    const row = await run({ registerSemantic: true }, paste());
    assert.equal(row.status, 0); assert.equal(row.rows[1].error.code, 'ACTION_UNCONFIRMED');
    assert.equal(row.rows[1].error.delivery, 'unknown'); assert.equal(row.rows[1].error.retry, 'read-first');
    for (const key of ['writes', 'reads', 'clears', 'providers', 'factory']) assert.equal(row.board[key], 0);
    const crashed = await run({ registerSemantic: true, crashAfterSend: true }, paste());
    assert.equal(crashed.status, 70);
    const next = await run({}, [{ method: 'ping' }], crashed.directory);
    assert.equal(next.rows.length, 1); assert.equal(next.status, 0); assert.equal(text(next.board), 'owner');
    for (const key of ['writes', 'reads', 'clears', 'providers', 'factory']) assert.equal(next.board[key], 0);
  });
  await t.test('old native and browser journals are inventoried and retained byte for byte across startup and EOF', async () => {
    const bank = await mkdtemp(join(root, 'old-records-')), catalog = join(bank, 'clipboard');
    await mkdir(catalog, { mode: 0o700 });
    // Every interrupted file phase is opaque to strict startup. Truncation,
    // unknown schemas, duplicate ids, over-budget declarations and invalid bytes
    // cannot grant mutation or deletion authority.
    const payloads = [Buffer.alloc(0), Buffer.from([0, 0, 0, 255]), Buffer.from('{"version":999}'),
      Buffer.from('{"id":"same","id":"same"}'), Buffer.from('{"size":999999999999}'), Buffer.from([255, 254, 0]),
      Buffer.from('before-fsync'), Buffer.from('after-fsync'), Buffer.from('before-rename'), Buffer.from('after-rename'),
      Buffer.from('before-receipt-append'), Buffer.from('after-receipt-append'),
      Buffer.from('before-terminal-append'), Buffer.from('after-terminal-append'), Buffer.from('before-reclaim'), Buffer.from('after-reclaim')];
    const paths = payloads.map((_, i) => join(catalog, `${i % 2 ? 'snapshot-' : 'runtime-snapshot-'}${i}.bin`));
    await Promise.all(paths.map((path, i) => writeFile(path, payloads[i], { mode: 0o600 })));
    const row = await run({}, [{ method: 'ping' }], bank);
    assert.equal(row.status, 0); assert.equal(row.board.retained, 16);
    for (const [i, path] of paths.entries()) assert.deepEqual(await readFile(path), payloads[i]);
    assert.equal((await readdir(catalog)).length, 16);
    for (const key of ['writes', 'reads', 'clears', 'providers', 'factory']) assert.equal(row.board[key], 0);
  });

  await t.test('two same-text sessions share an opaque catalog and never adopt old staged bytes', async () => {
    const bank = await mkdtemp(join(root, 'two-sessions-')), catalog = join(bank, 'clipboard');
    await mkdir(catalog, { mode: 0o700 });
    const old = join(catalog, 'runtime-snapshot-same-text.bin');
    await writeFile(old, 'old unresolved original with staged agent', { mode: 0o600 });
    for (let session = 0; session < 2; session++) {
      const row = await run({ registerSemantic: true }, paste(), bank);
      assert.equal(row.board.retained, 1); assert.equal(row.rows[1].error.delivery, 'unknown');
      assert.equal(row.rows[1].error.retry, 'read-first'); assert.equal(text(row.board), 'owner');
      assert.equal(row.board.factory, 0); assert.equal(row.board.writes, 0);
    }
    assert.equal(await readFile(old, 'utf8'), 'old unresolved original with staged agent');
  });
  await t.test('symlinked entries and replaced files stay opaque and a symlinked catalog is refused without repair', async () => {
    const bank = await mkdtemp(join(root, 'unsafe-records-')), catalog = join(bank, 'clipboard'), outside = join(bank, 'outside');
    await mkdir(catalog, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
    const original = join(outside, 'original.bin'); await writeFile(original, 'retained bytes', { mode: 0o600 });
    const link = join(catalog, 'snapshot-symlink.bin'); await symlink(original, link);
    let row = await run({}, [{ method: 'ping' }], bank);
    assert.equal(row.board.retained, 1); assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readFile(original, 'utf8'), 'retained bytes');
    await rm(link); await writeFile(link, 'replacement inode', { mode: 0o600 });
    row = await run({}, [{ method: 'ping' }], bank);
    assert.equal(row.board.retained, 1); assert.equal(await readFile(link, 'utf8'), 'replacement inode');
    const aliasBank = await mkdtemp(join(root, 'catalog-alias-')); await symlink(catalog, join(aliasBank, 'clipboard'));
    const alias = await run({}, [{ method: 'ping' }], aliasBank);
    assert.equal(alias.board.retained, -1); assert.equal((await lstat(join(aliasBank, 'clipboard'))).isSymbolicLink(), true);
    for (const result of [row, alias]) for (const key of ['writes', 'reads', 'clears', 'providers', 'factory']) assert.equal(result.board[key], 0);
  });

  const action = (windowId = '7', read = 'full') => [{ method: 'setValue', params: { ...binding, windowId, readId: 1, args: [1, 'value'], read } }];
  await t.test('a closed target during settle keeps successful delivery and discards stale observation data', async () => {
    for (const code of ['WINDOW_NOT_FOUND', 'NO_WINDOWS_AVAILABLE', 'STALE_ELEMENT', 'IDENTITY_UNVERIFIED', 'IDENTITY_CHANGED']) {
      for (const delivery of ['sent-verified', 'sent-unverified']) {
        const row = await run({ wrapper: true, settleFault: code, delivery }, action());
        assert.equal(row.status, 0); const reply = row.rows[0]; assert.equal(reply.ok, true, code);
        assert.equal(reply.result.delivery, 'sent-unverified'); assert.equal(reply.result.retry, 'read-first');
        assert.equal(reply.result.observation, 'unavailable'); assert.equal(reply.result.observationError, code);
        assert.equal(reply.result.settled, false); assert.equal(Object.hasOwn(reply.result, 'text'), false);
        assert.equal(Object.hasOwn(reply.result, 'readId'), false);
      }
    }
  });
  await t.test('a lost target during readTree is an unavailable observation after successful delivery', async () => {
    const row = await run({ wrapper: true }, action('8'));
    assert.equal(row.status, 0); assert.equal(row.rows[0].ok, true);
    assert.equal(row.rows[0].result.delivery, 'sent-unverified'); assert.equal(row.rows[0].result.observationError, 'WINDOW_NOT_FOUND');
  });
  await t.test('read none keeps cap and match metadata without attempting observation or leaking tree text', async () => {
    const row = await run({ wrapper: true, overLimit: true, settleFault: 'WINDOW_NOT_FOUND' }, action('7', 'none'));
    assert.equal(row.status, 0); assert.equal(row.rows[0].ok, true);
    const result = row.rows[0].result;
    assert.equal(result.valueVerified, false); assert.equal(result.valueReadback, 'over-limit'); assert.equal(result.valueReadbackLimit, 1_048_576);
    assert.deepEqual(result.selectedRange, [0, 1]); assert.equal(result.matchCount, 1);
    assert.equal(Object.hasOwn(result, 'text'), false); assert.equal(Object.hasOwn(result, 'observation'), false);
  });
  await t.test('an unhealthy observation fault retires the helper instead of becoming a successful reply', async () => {
    const row = await run({ wrapper: true, settleFault: 'WINDOW_NOT_FOUND', settleUnhealthy: true }, action());
    assert.equal(row.status, 70); assert.equal(row.rows[0].ok, false);
    assert.equal(row.rows[0].error.code, 'WINDOW_NOT_FOUND'); assert.equal(row.rows[0].error.unhealthy, true);
    assert.equal(row.rows[0].error.delivery, 'unknown');
  });
  await t.test('refused writes and policy or verification faults still fail', async () => {
    for (const [config, code, delivery] of [
      [{ refusedWrite: true }, 'VALUE_NOT_SETTABLE', 'not-sent'],
      [{ failedWrite: true }, 'ACTION_UNCONFIRMED', 'unknown'],
      [{ settleFault: 'PERSON_TOOK_OVER' }, 'PERSON_TOOK_OVER', 'unknown'],
      [{ settleFault: 'SECURE_FIELD' }, 'SECURE_FIELD', 'unknown'],
      [{ afterObservationFails: true }, 'ACTION_UNCONFIRMED', 'unknown'],
    ]) {
      const row = await run({ wrapper: true, ...config }, action());
      assert.equal(row.status, 0); assert.equal(row.rows[0].ok, false); assert.equal(row.rows[0].error.code, code);
      assert.equal(row.rows[0].error.delivery, delivery);
    }
    const noDelivery = await run({ wrapper: true, settleFault: 'WINDOW_NOT_FOUND', delivery: 'not-sent' }, action());
    assert.equal(noDelivery.rows[0].ok, false); assert.equal(noDelivery.rows[0].error.code, 'WINDOW_NOT_FOUND');
  });
});
