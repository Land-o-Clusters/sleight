import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { collectOwnedGroup } from '../plugins/sleight/lib/owned-group.mjs';
import { relayServer, replay } from '../plugins/sleight/lib/replay.mjs';

test('macOS zombie-only owned group is collected despite EPERM', {
  skip: process.platform !== 'darwin' ? 'macOS zombie process-group signaling required'
    : !existsSync('/usr/bin/python3') ? 'system Python required for unreaped zombie fixture' : false,
  timeout: 10000,
}, async t => {
  const child = spawn('/usr/bin/python3', [new URL('./fixtures/owned-group-zombie.py', import.meta.url).pathname],
    { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const closed = once(child, 'close');
  t.after(async () => { child.stdin.end('\n'); await closed; });
  const [data] = await once(child.stdout, 'data');
  const pid = Number(data.toString().trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  let status = '';
  const deadline = Date.now() + 3000;
  while (!status.startsWith('Z') && Date.now() < deadline) {
    status = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (!status.startsWith('Z')) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(status, /^Z/, 'fixture child exited and remains unreaped');
  for (const signal of [0, 'SIGTERM', 'SIGKILL']) {
    assert.throws(() => process.kill(-pid, signal), { code: 'EPERM' });
    t.diagnostic(`zombie group signal ${signal}: EPERM`);
  }
  await collectOwnedGroup(pid, { graceMs: 20 });
  child.stdin.end('\n');
  const [code] = await closed;
  assert.equal(code, 0, 'fixture parent reaped its zombie before exiting');
  await collectOwnedGroup(pid, {
    alive: () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); },
  });
});

test('collection keeps waiting after leader close and escalates only the owned group', async () => {
  let alive = true, now = 0;
  const sent = [];
  await collectOwnedGroup(123, { alive: () => alive, signal: name => {
    sent.push(name); if (name === 'SIGKILL') alive = false;
  }, graceMs: 5, now: () => now, sleep: async ms => { now += ms; } });
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
});

for (const stage of ['probe', 'signal']) {
  for (const states of [[], ['Z'], ['Z+', 'ZN']]) {
    test(`EPERM at ${stage} accepts only gone or zombie-only group: ${JSON.stringify(states)}`, async () => {
      const denied = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
      await collectOwnedGroup(123, { alive: stage === 'probe' ? denied : () => true,
        signal: denied, members: async pid => { assert.equal(pid, 123); return states; } });
    });
  }
  for (const states of [['S'], ['Z', 'R'], [''], ['unknown'], null]) {
    test(`EPERM at ${stage} keeps inaccessible live or unknown group unconfirmed: ${JSON.stringify(states)}`, async () => {
      const denied = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
      await assert.rejects(collectOwnedGroup(123, { alive: stage === 'probe' ? denied : () => true,
        signal: denied, members: async () => states }), error => error.cleanupUnconfirmed === true);
    });
  }
}

test('EPERM with unavailable inspection still reports unconfirmed collection', async () => {
  await assert.rejects(collectOwnedGroup(123, {
    alive: () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); },
    members: async () => { throw new Error('inspection unavailable'); },
  }), error => error.cleanupUnconfirmed === true && /kill EPERM/.test(error.message));
});

test('other collection errors do not consult member inspection', async () => {
  await assert.rejects(collectOwnedGroup(123, {
    alive: () => { throw Object.assign(new Error('invalid signal'), { code: 'EINVAL' }); },
    members: async () => { assert.fail('inspection is only for EPERM'); },
  }), error => error.cleanupUnconfirmed === true && /invalid signal/.test(error.message));
});

test('unconfirmed or inaccessible groups fail closed', async () => {
  for (const alive of [() => true, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }]) {
    let now = 0;
    await assert.rejects(collectOwnedGroup(123, { alive, signal: () => {}, members: async () => ['S'], graceMs: 1,
      now: () => now, sleep: async ms => { now += ms; } }), error => error.cleanupUnconfirmed === true);
  }
});

test('relay close waits for both the child close and owned group collection', async () => {
  const child = new EventEmitter();
  child.pid = 123; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let finish, done = false;
  const server = relayServer('/fixture/relay', { spawn: (_bin, _args, options) => {
    assert.equal(options.detached, true); return child;
  }, collect: () => new Promise(resolve => { finish = resolve; }) });
  const pending = server.close().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  child.emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  finish(); await pending;
  assert.equal(done, true);
});

test('relay exit settles pending initialization and tool requests without hanging a routine', async () => {
  for (const stage of ['initialize', 'tools/call']) {
    const child = new EventEmitter();
    child.pid = 123; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('data', data => {
      const message = JSON.parse(data);
      if (message.method === stage) child.emit('close', 1);
      else if (message.id !== undefined) child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
    });
    const server = relayServer('/fixture/relay', { spawn: () => child, collect: async () => {} });
    let failure;
    const pending = replay({ sleightReplay: 1, steps: [{ tool: 'js', args: { code: 'await app.getAXState();' }, positions: [] }] }, { server })
      .catch(error => { failure = error; });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(failure?.message ?? '', /relay exited/, stage);
    await pending;
  }
});

test('leader exit begins collection before descendants release inherited pipes', async () => {
  const child = new EventEmitter(), signals = new EventEmitter();
  child.pid = 123; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let collected = false;
  const server = relayServer('/fixture', { spawn: () => child, signals, collect: async () => {
    collected = true; child.emit('close', 1);
  } });
  child.emit('exit', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(collected, true);
  await assert.rejects(server.close(), /relay exited/);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('ownership receipt failure collects the detached relay before reporting failure', async () => {
  const child = new EventEmitter(), signals = new EventEmitter();
  child.pid = 123; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let collected = false;
  const server = relayServer('/fixture', { spawn: () => child, signals,
    onSpawn: () => { throw new Error('owner receipt write failed'); },
    collect: async () => { collected = true; child.emit('close', 0); } });
  assert.equal(child.stdin.readableLength, 0);
  await assert.rejects(server.close(), /owner receipt write failed/);
  assert.equal(collected, true);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('ownership failure with unconfirmed collection reports cleanup uncertainty without awaiting pipes', async () => {
  const child = new EventEmitter(), signals = new EventEmitter();
  child.pid = 123; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const server = relayServer('/fixture', { spawn: () => child, signals,
    onSpawn: () => { throw new Error('receipt failed'); },
    collect: async () => { throw Object.assign(new Error('collection failed'), { cleanupUnconfirmed: true }); } });
  await assert.rejects(server.close(), error => error.cleanupUnconfirmed === true);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});
