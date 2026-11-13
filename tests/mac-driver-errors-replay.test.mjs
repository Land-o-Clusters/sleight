// Offline format replay only. No recorded code is evaluated and no app is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createMacDriverClient, DRIVER_PROTOCOL } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { DRIVER_CODES, DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { MAC_DRIVER_ERRORS, formatMacDriverError, normalizeMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';

// Manual behavior labels for PF6's eight B-side failures. Source text is neither
// copied here nor used for routing. These are fake-driver equivalents, not a
// translator between turbo and the native driver.
const chromeCases = [
  ['toolu_01DWQ7WKCensPD7Z1Jt3WEPn', 'WINDOW_NOT_FOUND'],
  ['toolu_01NJ4fvGkdng8Qi44uFU39AR', 'INVALID_PARAMS'],
  ['toolu_01EQpHY4GmfRzKsoU7rYQDsG', 'WINDOW_NOT_FOUND'],
  ['toolu_01WQsjKVf2WnwBPsNJqigHix', 'WINDOW_NOT_FOUND'],
  ['toolu_01GUo6e9mxVv98PtuzZn1Khg', 'WINDOW_NOT_FOUND'],
  ['toolu_01Wm4jeT9MuiMhbwD6kVZBBi', 'INVALID_PARAMS'],
  ['toolu_01PfW8Y2CjbLRd1BqNS3Csxs', 'INVALID_PARAMS'],
  ['toolu_01WJneKM7RZUNjVrNW3sygeM', 'WINDOW_NOT_FOUND'],
];

function fakeDriver(t, faults) {
  let index = 0;
  const client = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const request = JSON.parse(bytes.toString());
      done();
      if (request.method === 'ping') {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: DRIVER_PROTOCOL, platform: 'darwin',
          nonce: request.nonce, id: request.id, ok: true, result: { protocol: DRIVER_PROTOCOL, apiVersion: 2,
            build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS] } }) + '\n'));
        return;
      }
      const fault = faults[index++];
      const error = { ...fault, next: DRIVER_CODES[fault.code].next };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: DRIVER_PROTOCOL, platform: 'darwin',
        nonce: request.nonce, id: request.id, ok: false, error }) + '\n'));
    } });
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
    return child;
  } }) });
  t.after(() => client.close());
  return { client, get calls() { return index; } };
}

async function replayFaults(t, faults) {
  const fake = fakeDriver(t, faults), lines = [];
  for (const fault of faults) {
    await assert.rejects(fake.client.request('click', { args: [0], readId: 1, windowId: '1', processStart: 'fixture' }), error => {
      const line = formatMacDriverError(error, { action: true });
      assert.ok(line.startsWith(`sleight: ${fault.code}: `));
      assert.equal(line.split('\n').length, 1);
      assert.match(line, / next=(?:read-again|retry-safe|stop-tell-user|ask-user|restart-helper|none): .+\.$/);
      assert.ok(line.includes(`delivery=${fault.delivery};`));
      if (line.includes('next=none:') && fault.retry === 'safe') assert.doesNotMatch(line, /retry=safe/);
      else assert.ok(line.includes(`retry=${fault.retry};`));
      assert.equal(error.code, fault.code, 'the real closed-table envelope must reach the formatter');
      lines.push(line);
      return true;
    });
  }
  assert.equal(fake.calls, faults.length, 'formatting must never replay a request');
  return lines;
}

test('eight PF6 behavior cases render directives through the fake driver client', async t => {
  const faults = chromeCases.map(([, code]) => ({ code, message: 'fixture diagnostic', unhealthy: false,
    delivery: code === 'INVALID_PARAMS' ? 'not-sent' : 'unknown', retry: code === 'INVALID_PARAMS' ? 'safe' : 'read-first' }));
  assert.equal((await replayFaults(t, faults)).length, 8);
});

test('native post-input faults keep dispositions across the client and formatter', async t => {
  const codes = ['ACTION_UNCONFIRMED', 'CLIPBOARD_CHANGED', 'CLIPBOARD_RESTORE_FAILED',
    'PASTE_UNCONFIRMED_CLIPBOARD_HELD', 'PERSON_TOOK_OVER', 'IDENTITY_CHANGED', 'AX_UNAVAILABLE', 'DEADLINE_EXCEEDED'];
  const faults = codes.map(code => ({ code, message: 'fixture diagnostic', unhealthy: code === 'DEADLINE_EXCEEDED',
    delivery: 'sent-unverified', retry: 'read-first', personTookOver: code === 'PERSON_TOOK_OVER' }));
  assert.equal((await replayFaults(t, faults)).length, 8);
});

function errorCalls(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) if (item.type === 'tool_result' && item.is_error === true) rows.push(item);
  }
  return rows;
}

const chromeBank = process.env.RT20_CHROME_BANK ?? fileURLToPath(new URL('../../race-1017/validation-150b-rerun-chrome-ho5b/', import.meta.url));
test('retained PF6 Chrome bank has a directive for every one of its eight B-side error calls', {
  skip: !existsSync(chromeBank) && 'set RT20_CHROME_BANK to the retained PF6 bank',
}, async t => {
  const calls = [];
  for (const folder of readdirSync(chromeBank).filter(name => /^rerun-chrome-haiku-B-r[1-5]$/.test(name)).sort()) {
    for (const task of readdirSync(join(chromeBank, folder)).sort()) {
      const file = join(chromeBank, folder, task, 'events.jsonl');
      if (existsSync(file)) calls.push(...errorCalls(file));
    }
  }
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map(call => call.tool_use_id).sort(), chromeCases.map(([id]) => id).sort());
  const mapping = new Map(chromeCases);
  const faults = calls.map(call => {
    const code = mapping.get(call.tool_use_id);
    return { code, message: typeof call.content === 'string' ? call.content : JSON.stringify(call.content), unhealthy: false,
      delivery: code === 'INVALID_PARAMS' ? 'not-sent' : 'unknown', retry: code === 'INVALID_PARAMS' ? 'safe' : 'read-first' };
  });
  const lines = await replayFaults(t, faults);
  for (const [index, line] of lines.entries()) assert.ok(!line.includes(faults[index].message));
  t.diagnostic(`PF6 B-side flagged calls=${calls.length}; directive lines=${lines.length}; input dispatches=0`);
});

// Optional manually labelled engine-origin subset. Labels are keyed by call ID
// in rt20-labels.json beside retained transcripts; no source text selects a code.
const nativeBank = process.env.RT20_NATIVE_BANK;
test('labelled native engine-origin errors receive directive lines (format coverage only)', {
  skip: !nativeBank && 'set RT20_NATIVE_BANK to a labelled engine-origin subset; summaries are insufficient',
}, async t => {
  const calls = [];
  function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && ['events.jsonl', 'transcript.jsonl'].includes(entry.name)) calls.push(...errorCalls(path));
    }
  }
  walk(nativeBank);
  assert.ok(calls.length > 0, 'native bank must contain actual error calls');
  const labels = JSON.parse(readFileSync(join(nativeBank, 'rt20-labels.json'), 'utf8'));
  assert.deepEqual(Object.keys(labels).sort(), calls.map(call => call.tool_use_id).sort());
  const faults = [];
  for (const call of calls) {
    const label = labels[call.tool_use_id];
    assert.equal(label.origin, 'engine');
    assert.ok(Object.hasOwn(DRIVER_CODES, label.code), 'manual equivalent must be a helper code');
    assert.ok(typeof label.reason === 'string' && label.reason.length > 0);
    assert.equal(createHash('sha256').update(JSON.stringify(call.content)).digest('hex'), label.contentSHA256);
    const failure = { code: label.code, message: call.content, unhealthy: DRIVER_CODES[label.code].unhealthy,
      delivery: 'unknown', retry: 'read-first' };
    faults.push(failure);
    const normalized = normalizeMacDriverError(failure, { action: true });
    assert.ok(Object.hasOwn(MAC_DRIVER_ERRORS, normalized.code));
    assert.match(formatMacDriverError(failure, { action: true }), /^sleight: [A-Z_]+: .+ next=[a-z-]+: .+\.$/);
  }
  assert.equal((await replayFaults(t, faults)).length, calls.length);
  t.diagnostic(`native flagged calls=${calls.length}; directive lines=${calls.length}; input dispatches=0`);
});
