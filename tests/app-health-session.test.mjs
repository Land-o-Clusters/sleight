import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = readFileSync(new URL('../plugins/sleight/lib/app-health.js', import.meta.url), 'utf8');

// Run the real session loop. Every native boundary is fake, including stdin,
// parent identity, poll and AX trust. No osascript or application is launched.
function session({ parent = 42, waits = [1], chunks = ['{"id":1,"app":"Fixture"}\n', ''],
  onWait = () => {}, onRead = () => {}, onReply = () => {}, bindFails = false } = {}) {
  const replies = [], polls = [], bindings = [];
  let reads = 0, pid = parent;
  const $ = value => ({ dataUsingEncoding: () => value });
  Object.assign($, {
    getppid: () => pid,
    poll: (bytes, count, ms) => {
      assert.deepEqual([...bytes], [0, 0, 0, 0, 1, 0, 0, 0]);
      assert.equal(count, 1); assert.equal(ms, 100);
      polls.push(ms); onWait({ number: polls.length, reparent: value => { pid = value; } });
      if (!waits.length) throw Error('unbounded poll in fixture');
      return waits.shift();
    },
    NSData: { alloc: { initWithBase64EncodedStringOptions: (text, options) => {
      assert.equal(options, 0);
      return { mutableCopy: { mutableBytes: Buffer.from(text, 'base64') } };
    } } },
    NSFileHandle: {
      fileHandleWithStandardInput: { get availableData() {
        reads++; onRead({ number: reads, reparent: value => { pid = value; } });
        const text = chunks.shift();
        if (text === undefined) throw Error('unbounded read in fixture');
        return { length: text.length, text };
      } },
      fileHandleWithStandardOutput: { writeData: text => {
        replies.push(JSON.parse(text)); onReply({ number: replies.length, reparent: value => { pid = value; } });
      } },
    },
    NSString: { alloc: { initWithDataEncoding: data => data.text } }, NSUTF8StringEncoding: 4,
    NSRunLoop: { currentRunLoop: { runUntilDate() {} } }, NSDate: { dateWithTimeIntervalSinceNow: () => 0 },
    AXIsProcessTrusted: () => false,
  });
  const context = vm.createContext({ $, ObjC: { import() {}, unwrap: value => value, bindFunction(name, signature) {
    bindings.push([name, signature]); if (bindFails) throw Error('unavailable');
  } } });
  vm.runInContext(source, context);
  const result = context.run(['--session', '/fixture']);
  return { result, replies, polls, reads, bindings };
}

test('a session already adopted by launchd exits before reading or dispatching', () => {
  const f = session({ parent: 1 });
  assert.equal(f.result, ''); assert.equal(f.reads, 0); assert.deepEqual(f.replies, []);
});

for (const parent of [1, 77]) test(`idle session exits when its parent changes to ${parent}, even with stdin open`, () => {
  const f = session({ waits: [0, 0], onWait: ({ number, reparent }) => { if (number === 2) reparent(parent); } });
  assert.equal(f.reads, 0); assert.deepEqual(f.replies, []); assert.deepEqual(f.polls, [100, 100]);
});

test('parent death as input becomes ready discards the request', () => {
  const f = session({ onWait: ({ reparent }) => reparent(1) });
  assert.equal(f.reads, 0); assert.deepEqual(f.replies, []);
});

test('parent death during a read discards every buffered request', () => {
  const f = session({ onRead: ({ reparent }) => reparent(1) });
  assert.equal(f.reads, 1); assert.deepEqual(f.replies, []);
});

test('parent death after one reply prevents dispatch of the next buffered request', () => {
  const f = session({ chunks: ['{"id":1,"app":"Fixture"}\n{"id":2,"app":"Fixture"}\n', ''],
    onReply: ({ reparent }) => reparent(1) });
  assert.deepEqual(f.replies, [{ id: 1, status: 'denied' }]); assert.equal(f.reads, 1);
});

test('healthy sessions wait without reading, dispatch once, then exit on EOF', () => {
  const f = session({ waits: [0, 1, 1] });
  assert.deepEqual(f.replies, [{ id: 1, status: 'denied' }]);
  assert.deepEqual(f.polls, [100, 100, 100]); assert.equal(f.reads, 2);
});

test('a poll error and an unavailable parent watcher exit without reading', () => {
  for (const options of [{ waits: [-1] }, { bindFails: true }]) {
    const f = session(options);
    assert.equal(f.result, ''); assert.equal(f.reads, 0); assert.deepEqual(f.replies, []);
  }
});

test('one-shot probes do not bind or poll a session watcher', () => {
  const context = vm.createContext({ $: { AXIsProcessTrusted: () => false }, ObjC: { import() {} } });
  vm.runInContext(source, context);
  assert.equal(context.run(['"Fixture"']), '{"status":"denied"}');
});

test('Darwin poll bridge handles stdin and EOF without an app target', { skip: process.platform !== 'darwin' }, () => {
  // null is rejected before an app lookup; AXIsProcessTrusted never prompts.
  const output = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript',
    fileURLToPath(new URL('../plugins/sleight/lib/app-health.js', import.meta.url)), '--session', '/unused'], {
    input: '{"id":7,"app":null}\n', encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
  }).trim();
  assert.ok(['{"id":7,"status":"unknown"}', '{"id":7,"status":"denied"}'].includes(output), output);
});
