import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browserTools, createToolDispatcher, unknownTabOutcome } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { NATIVE_HANDOFF_TOOL } from '../plugins/sleight/lib/native-handoff.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('one shared sign-in rule delegates presence decisions to the handoff result', () => {
  for (const file of ['SKILL.md', 'SKILL.lean.md']) {
    const skill = read('plugins/sleight/skills/drive-mac-apps/' + file);
    assert.match(skill, /Sign-in\/code: `browser_tabs handoff wait:true` \(native: `app_handoff`\); otherwise stop\./);
    assert.match(skill, /Follow its result\. Never request secrets\./);
    assert.match(skill, /Updates\/permissions\/first-run: stop and tell the user\. Don't answer it\./);
  }
  const browser = read('plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md');
  assert.doesNotMatch(browser, /For passwords|when the user is present|Away, end/);
  for (const mode of [undefined, '0']) {
    const before = process.env.SLEIGHT_MT;
    try {
      if (mode === undefined) delete process.env.SLEIGHT_MT; else process.env.SLEIGHT_MT = mode;
      const tabs = browserTools('bfixture').find(tool => tool.name === 'browser_tabs');
      assert.match(tabs.description, /await Continue, reread/);
      assert.match(tabs.description, /away end turn, ask user to sign in and reply/);
      assert.match(tabs.description, /Never request secrets\./);
      if (mode !== '0') assert.match(tabs.description, /keep past turn/);
      assert.match(tabs.description, /Hand off unasked payments/);
    } finally {
      if (before === undefined) delete process.env.SLEIGHT_MT; else process.env.SLEIGHT_MT = before;
    }
  }
  assert.match(NATIVE_HANDOFF_TOOL.description, /Present:.*Continue/);
  assert.match(NATIVE_HANDOFF_TOOL.description, /Away: end turn, ask user to sign in and reply/);
  assert.match(NATIVE_HANDOFF_TOOL.description, /Never request passwords\/codes\./);
});

test('the browser catalog directs literal handles, snapshot use and one-call forms', () => {
  const tools = Object.fromEntries(browserTools('bfixture').map(tool => [tool.name, tool]));
  assert.match(tools.browser_open.description, /Copy returned tab exactly; t is included/);
  assert.doesNotMatch(tools.browser_act.description, /navigate[^.]*\burl\b/);
  assert.match(tools.browser_act.description, /wait until:text\/gone:text\/url:substring/);
  for (const mode of [undefined, '0']) {
    const before = process.env.SLEIGHT_MT;
    try {
      if (mode === undefined) delete process.env.SLEIGHT_MT; else process.env.SLEIGHT_MT = mode;
      for (const tool of browserTools('bfixture').filter(tool => ['browser_read', 'browser_act'].includes(tool.name))) {
        assert.match(tool.description, /screenshot.*user asks or state cannot answer/);
        assert.doesNotMatch(tool.description, /image to user/);
      }
    } finally {
      if (before === undefined) delete process.env.SLEIGHT_MT; else process.env.SLEIGHT_MT = before;
    }
  }
  assert.match(tools.browser_act.description, /use only one-click Reject\/necessary-only to decline all optional cookies, or ask\./);
  assert.match(tools.browser_fill.description, /autocomplete in the same fill, last/);
  const browser = read('plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md');
  assert.match(browser, /autocomplete in the same fill, last/);
  assert.match(browser, /whole matching option/);
  assert.match(browser, /the amount/);
  assert.match(browser, /confirmation refusal, stop and ask/);
});

test('an unknown or closed handle stays refused and returns an exact-copy instruction', async () => {
  let actions = 0;
  const dispatcher = createToolDispatcher({
    pages: { enqueue: async () => { throw Error('unknown or releasing owned tab'); } },
    snapshot: async () => '', fillFields: async () => { actions++; },
    runSteps: async () => { actions++; },
  });
  const result = await dispatcher.call({ name: 'browser_act', arguments: { tab: 'tt1', steps: [{ do: 'click', ref: 'e1' }] } });
  assert.deepEqual(result, { isError: true, text: unknownTabOutcome });
  assert.match(unknownTabOutcome, /Unknown or closed tab; copy tab exactly\./);
  assert.ok(unknownTabOutcome.length <= 40);
  assert.equal(actions, 0);
});

test('every edited skill stays within its p170 source byte count', () => {
  for (const [file, ceiling] of [['SKILL.md', 7653], ['SKILL.lean.md', 3534], ['BROWSERS.turbo-v3.md', 1854]]) {
    assert.ok(Buffer.byteLength(read('plugins/sleight/skills/drive-mac-apps/' + file)) <= ceiling, file);
  }
});
