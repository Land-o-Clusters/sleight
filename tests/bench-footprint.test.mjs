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
    ['100 100 0:01.00 /usr/local/bin/claude', '300 300 0:10.00 /Apps/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService', '400 400 5:00.00 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit', '500 500 9:00.00 /usr/bin/other'],
    ['100 100 0:03.00 /usr/local/bin/claude', '101 100 0:00.40 /usr/bin/osascript', '300 300 0:11.50 /Apps/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService', '400 400 5:00.25 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit', '600 600 0:02.00 /System/Applications/Calculator.app/Contents/MacOS/Calculator', '500 500 9:30.00 /usr/bin/other'],
  ];
  let call = 0;
  const stop = startFootprint({ pgid: 100, apps: ['TextEdit', 'Calculator'], intervalMs: 1e6, ps: async () => frames[Math.min(call++, frames.length - 1)].join('\n') });
  const result = await stop();
  assert.deepEqual(result.group, { claude: 3, osascript: 0.4 });
  assert.deepEqual(result.outside, { 'engine helper': 1.5, TextEdit: 0.25, Calculator: 2 }, 'Calculator launched during the run counts whole');
  assert.equal(result.cpuSeconds, 7.15);
});
