import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DRIVER_CODES } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { ROLE_CASES, SUBROLE_CASES } from './fixtures/mac-driver-recorded-tree.mjs';
import { clipboardClientReply } from './fixtures/mac-driver-clipboard-client.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createWindowsDriverClient } from '../plugins/sleight/lib/driver-client.mjs';

const root = new URL('../plugins/sleight/lib/mac-driver/', import.meta.url);
const swift = name => readFileSync(new URL('native/' + name, root), 'utf8');

test('clipboard change rewrites remove the typed pointer refusal', async () => {
  const reply = await clipboardClientReply({ ok: false, error: {
    code: 'ACTION_UNSUPPORTED', message: 'diagnostic', unhealthy: false, next: 'none',
    delivery: 'not-sent', retry: 'safe', pointerRefusal: 'incomplete-ancestry',
    clipboard: 'untouched', clipboardChanged: true,
  } });
  assert.equal(reply.error.code, 'CLIPBOARD_CHANGED');
  assert.equal(reply.error.next, 'stop-tell-user');
  assert.equal(reply.error.retry, 'read-first');
  for (const key of ['pointerRefusal', 'clipboard', 'textInput']) assert.equal(Object.hasOwn(reply.error, key), false, key);
});

test('Windows rejects Mac-only typed refusals and still accepts an ordinary error', async () => {
  for (const fields of [{}, ...['incomplete-ancestry', null, false].map(pointerRefusal => ({ pointerRefusal })),
    ...['busy', null, false].map(pasteRefusal => ({ pasteRefusal }))]) {
    const client = createWindowsDriverClient({ platform: 'win32', prepare: async () => ({ status: 'ready', spawn() {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('close')); return true; };
      child.stdin = new Writable({ write(bytes, encoding, done) {
        const request = JSON.parse(bytes); done();
        queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: request.protocol, nonce: request.nonce,
          id: request.id, ok: false, error: { code: 'ACTION_UNSUPPORTED', message: 'diagnostic', unhealthy: false,
            ...fields } }) + '\n'));
      } });
      return child;
    } }) });
    try { await assert.rejects(client.request('getState'), error => {
      assert.equal(error.code, Object.keys(fields).length ? 'DRIVER_PROTOCOL' : 'ACTION_UNSUPPORTED');
      assert.equal(Object.hasOwn(error, 'pointerRefusal'), false);
      assert.equal(Object.hasOwn(error, 'pasteRefusal'), false); return true;
    }); } finally { await client.close(); }
  }
});

test('the typed pointer refusal has one wire value and preserves its stricter model recovery', async () => {
  const doc = readFileSync(new URL('../docs/design/mac-driver.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('`pointerRefusal: "incomplete-ancestry"`'));
  const error = { code: 'ACTION_UNSUPPORTED', message: 'provider diagnostic', unhealthy: false,
    next: 'none', delivery: 'not-sent', retry: 'safe', pointerRefusal: 'incomplete-ancestry' };
  const reply = await clipboardClientReply({ ok: false, error });
  assert.equal(reply.error.code, 'ACTION_UNSUPPORTED');
  assert.equal(reply.error.pointerRefusal, 'incomplete-ancestry');
  assert.equal(reply.error.delivery, 'not-sent');
  assert.equal(reply.error.retry, 'read-first');
  assert.equal(reply.error.next, 'none');
  const forged = await clipboardClientReply({ ok: false, error: { ...error, pointerRefusal: undefined,
    message: "The target's accessibility tree is incomplete. Try another element from a read or a keyboard route." } });
  assert.equal(forged.error.code, 'ACTION_UNSUPPORTED');
  assert.equal(forged.error.retry, 'safe');
  assert.equal(Object.hasOwn(forged.error, 'pointerRefusal'), false);
  for (const patch of [
    { pointerRefusal: null }, { pointerRefusal: true }, { pointerRefusal: 1 },
    { pointerRefusal: ['incomplete-ancestry'] }, { pointerRefusal: {} },
    { pointerRefusal: 'unknown' }, { pointerRefusal: 'incomplete-ancestry\ninjected' },
    { code: 'AX_UNAVAILABLE', next: 'retry-safe' }, { code: 'INVALID_PARAMS' },
    { delivery: 'unknown', retry: 'read-first' }, { delivery: 'sent-unverified', retry: 'read-first' },
    { delivery: 'sent-verified', retry: 'read-first' }, { retry: 'read-first' },
    { delivery: undefined, retry: undefined },
  ]) {
    const refused = await clipboardClientReply({ ok: false, error: { ...error, ...patch } });
    assert.equal(refused.error.code, 'DRIVER_PROTOCOL', JSON.stringify(patch));
    assert.equal(refused.error.unhealthy, true);
    assert.equal(refused.error.retry, 'read-first');
    assert.equal(Object.hasOwn(refused.error, 'pointerRefusal'), false);
  }
});

test('every native fault belongs to the single closed code table and the protocol doc lists the same rows', () => {
  const found = new Set();
  for (const file of readdirSync(new URL('native/', root)).filter(name => /^Driver.*\.swift$/.test(name))) {
    for (const [, code] of swift(file).matchAll(/DriverFault\("([A-Z_]+)"/g)) {
      found.add(code); assert.ok(Object.hasOwn(DRIVER_CODES, code), `${file}: ${code}`);
    }
  }
  assert.ok(found.size >= 25);
  const doc = readFileSync(new URL('../docs/design/mac-driver.md', import.meta.url), 'utf8');
  const documented = [...doc.matchAll(/^\| `([A-Z_]+)`(?: \(engine-path only\))? \| `([^`]+)` \| (yes|no) \| (on-action|required) \|$/gm)]
    .map(([, code, next, unhealthy, disposition]) => [code, { next, unhealthy: unhealthy === 'yes', disposition }]);
  const rows = Object.fromEntries(documented);
  // The legacy engine row has different recovery from the runtime watcher.
  const engineOnly = [...doc.matchAll(/^\| `([A-Z_]+)` \(engine-path only\) \|/gm)].map(([, code]) => code);
  assert.deepEqual(engineOnly, ['CLIPBOARD_CHANGED', 'CLIPBOARD_RESTORE_FAILED', 'PASTE_UNCONFIRMED_CLIPBOARD_HELD']);
  assert.match(doc, /count-only watcher also emits `CLIPBOARD_CHANGED`, with `next: stop-tell-user` and\s+`retry: read-first`/);
  assert.deepEqual(rows.CLIPBOARD_CHANGED, { next: 'read-again', unhealthy: false, disposition: 'required' });
  rows.CLIPBOARD_CHANGED = { ...rows.CLIPBOARD_CHANGED, next: 'stop-tell-user' };
  assert.deepEqual(rows, DRIVER_CODES);
  assert.equal(DRIVER_CODES.CLIPBOARD_CHANGED.next, 'stop-tell-user');
  assert.equal(DRIVER_CODES.USER_STOPPED.next, 'stop-tell-user');
});

test('role table tests enumerate every mapping with no untested entry', () => {
  const source = swift('DriverTree.swift');
  const roles = [...source.slice(source.indexOf('let driverRoles ='), source.indexOf('let driverSubroles =')).matchAll(/"(AX[^"]+)": "([^"]+)"/g)]
    .map(([, ax, text]) => [ax, text]);
  const subroles = [...source.slice(source.indexOf('let driverSubroles ='), source.indexOf('func driverRoleName')).matchAll(/"(AX[^"]+)": "([^"]+)"/g)]
    .map(([, ax, text]) => [ax, text]);
  assert.deepEqual(roles, ROLE_CASES); assert.deepEqual(subroles, SUBROLE_CASES);
});

test('full walks bind once per route; menu post reads rebind and reuse verifies after its digest', () => {
  const tree = swift('DriverTree.swift');
  const read = tree.slice(tree.indexOf('    func readTree('), tree.indexOf('    func resolveSecondaryAction('));
  const reuse = read.slice(read.indexOf('        if reuseEnabled,'), read.indexOf('        // Establish the proof'));
  assert.equal((reuse.match(/boundWindow\(/g) ?? []).length, 1);
  const menu = read.slice(read.indexOf('        if let before = menuAfter {'), read.indexOf('        } else { bound = try known ?? boundWindow'));
  assert.equal((menu.match(/boundWindow\(/g) ?? []).length, 1);
  assert.match(menu, /retained.root.same\(bound.root\)/);
  assert.match(menu, /AXWindowNumber/);
  assert.equal((read.replace(reuse, '').replace(menu, '').match(/boundWindow\(/g) ?? []).length, 1);
  assert.equal((read.replace(menu, '').match(/inventory\.recheck\(/g) ?? []).length, 1);
  assert.doesNotMatch(read, /inventory\.state\(|inventory\.bound\(/);
  assert.doesNotMatch(tree, /AXUIElementGetAttributeValueCount|AXUIElementCopyAttributeValues/);
});

test('registrars and the capture extension are wired explicitly with no static desktop call', () => {
  assert.match(swift('DriverMain.swift'), /let driverRegistrars:.*registerCapture\(\)/);
  assert.match(swift('DriverMain.swift'), /runtime.install\(driverRegistrars\)/);
  assert.match(swift('DriverProtocol.swift'), /core.session.withRequestPower/);
  assert.match(swift('DriverCore.swift'), /result.merge\(session.sample\(\).health\)/);
  assert.match(swift('DriverMain.swift'), /#if SLEIGHT_DRIVER_FIXTURES/);
  assert.doesNotMatch(swift('DriverMain.swift'), /DriverPointer|DriverKeyboard|registerPointer|registerKeyboard/);
});

test('walk reserve pins the quarter fraction, 5 ms floor and 650 ms cap for both providers', () => {
  const tree = swift('DriverTree.swift');
  assert.match(tree, /let available = min\(request\.remaining, Double\(budget\) \/ 1000\)/);
  assert.match(tree, /let margin = min\(0\.65, max\(0\.005, available \/ 4\)\)/);
  assert.match(tree, /let stop = min\(request\.deadline - margin, began \+ Double\(budget\) \/ 1000\)/);
  assert.equal((tree.match(/let margin =/g) ?? []).length, 1, 'fixture and live AX share one reserve');
});
