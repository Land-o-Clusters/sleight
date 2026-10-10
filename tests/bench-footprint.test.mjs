import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuSeconds, label, startFootprint } from '../bench/footprint.mjs';

test('ps times and process labels', () => {
  assert.equal(cpuSeconds('0:01.50'), 1.5);
  assert.equal(cpuSeconds('1:02:03.00'), 3723);
  assert.equal(cpuSeconds('2-00:00:01.00'), 172801);
  assert.equal(label('/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node'), 'engine node');
  assert.equal(label('~/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService'), 'engine helper');
  assert.equal(label('/usr/bin/osascript'), 'osascript');
  assert.equal(label('/opt/homebrew/bin/node'), 'node');
});

test('the driver group counts all its time; outside processes count what they used during the run', async () => {
  const frames = [
    // pid pgid time comm
    // pid ppid pgid time comm
    ['100 1 100 0:01.00 /usr/local/bin/claude', '300 1 300 0:10.00 /Apps/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService', '400 1 400 5:00.00 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit', '500 1 500 9:00.00 /usr/bin/other'],
    ['100 1 100 0:03.00 /usr/local/bin/claude', '101 100 100 0:00.40 /usr/bin/osascript', '300 1 300 0:11.50 /Apps/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService', '400 1 400 5:00.25 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit', '600 1 600 0:02.00 /System/Applications/Calculator.app/Contents/MacOS/Calculator', '500 1 500 9:30.00 /usr/bin/other',
      '700 100 700 0:01.10 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node', '701 700 701 0:00.20 /x/node_repl'],
  ];
  let call = 0;
  const stop = startFootprint({ pgid: 100, apps: ['TextEdit', 'Calculator'], intervalMs: 1e6, ps: async () => frames[Math.min(call++, frames.length - 1)].join('\n') });
  const result = await stop();
  assert.deepEqual(result.group, { claude: 3, osascript: 0.4, 'engine node': 1.1, node_repl: 0.2 }, 'descendants in groups of their own count');
  assert.deepEqual(result.outside, { 'engine helper': 1.5, TextEdit: 0.25, Calculator: 2 }, 'Calculator launched during the run counts whole');
  assert.equal(result.cpuSeconds, 8.45);
});

test('snapshots track only the owned root and descendants without stopping sampling', async () => {
  let call = 0;
  const frames = [
    '100 1 5 0:01.00 /usr/bin/codex\n200 1 5 0:09.00 /usr/bin/unrelated',
    '100 1 5 0:01.20 /usr/bin/codex\n101 100 8 0:00.30 /cua_node/bin/node',
    '100 1 5 0:01.25 /usr/bin/codex\n101 100 8 0:00.80 /cua_node/bin/node',
  ];
  const stop = startFootprint({ rootPid: 100, intervalMs: 1e6,
    ps: async () => frames[Math.min(call++, frames.length - 1)] });
  try {
    const first = await stop.snapshot();
    const second = await stop.snapshot();
    assert.deepEqual(first.group, { codex: 1.2, 'engine node': 0.3 });
    assert.deepEqual(second.group, { codex: 1.25, 'engine node': 0.8 });
  } finally { await stop(); }
});

test('a warm phase excludes existing process CPU and counts new descendants', async () => {
  const frames = [
    ['100 1 100 0:10.00 /usr/local/bin/node', '101 100 101 0:03.00 /x/node',
      '300 1 300 0:50.00 /Apps/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService',
      '400 1 400 1:40.00 /System/Applications/Calculator.app/Contents/MacOS/Calculator'],
    ['100 1 100 0:12.00 /usr/local/bin/node', '101 100 101 0:04.00 /x/node',
      '102 101 102 0:02.00 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node',
      '300 1 300 0:52.00 /Apps/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService',
      '400 1 400 1:43.00 /System/Applications/Calculator.app/Contents/MacOS/Calculator'],
  ];
  let call = 0;
  const stop = startFootprint({ pgid: 100, apps: ['Calculator'], baselineGroup: true, intervalMs: 1e6,
    ps: async () => frames[Math.min(call++, frames.length - 1)].join('\n') });
  await stop.ready;
  const result = await stop();
  assert.deepEqual(result.group, { node: 3, 'engine node': 2 });
  assert.deepEqual(result.outside, { 'engine helper': 2, Calculator: 3 });
  assert.equal(result.cpuSeconds, 10);
});

test('an unavailable warm baseline refuses instead of counting existing lifetime CPU', async () => {
  let call = 0;
  const stop = startFootprint({ pgid: 100, apps: ['Calculator'], baselineGroup: true, intervalMs: 1e6,
    ps: async () => call++ ? '100 1 100 10:00.00 /x/node\n400 1 400 20:00.00 /x/Calculator' : '' });
  try { await assert.rejects(stop.ready, /baseline/); }
  finally { assert.equal((await stop()).cpuSeconds, 0, 'the later snapshot cannot count lifetime CPU'); }
});

test('a failed final warm sample cannot publish a zero CPU result', async () => {
  let call = 0;
  const stop = startFootprint({ pgid: 100, baselineGroup: true, intervalMs: 1e6,
    ps: async () => call++ ? '' : '100 1 100 10:00.00 /x/node' });
  await stop.ready;
  await assert.rejects(stop(), /final sample/);
});
