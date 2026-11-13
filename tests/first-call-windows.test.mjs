// SLEIGHT_TS3 (turn-study class preliminary-inventory): the js description says before the first call that
// getState lists no windows, so a task that names a window starts with getApp. Shapes come from the 2026-10-18
// race traces (race-1017/safari-sleight-r2/wikipedia, firefox-sleight-b3-r2/mdn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { batchingDescription, createRelay } from '../plugins/sleight/lib/relay.mjs';
import { compactJsDescription } from '../plugins/sleight/lib/tool-description.mjs';
import { FIRST_CALL_WINDOWS, WINDOWS_LINE } from '../plugins/sleight/lib/engine-app-docs.mjs';
import { traceEnv } from '../bench/fowl/real-gate-setup.mjs';

const firstRule = 'execute exactly one of the API calls shown below, optionally assigning its result to a variable. Do not add other API calls, waits, or snapshots to that invocation.';
const ENGINE = 'Control native apps or browsers on the user’s computer by reading or operating UI.\n\nOn the first invocation of `cua_repl`, or after resetting it, ' +
  firstRule + '\n\nWhen you need an inventory of available apps, browsers, and tabs, get a snapshot of all enabled surfaces:\n\n```javascript\nawait cua.getState();\n```';
const count = (text, part) => text.split(part).length - 1;
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const replies = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, firstCallBatch: true, ...options });
  t.after(() => { relay.dispose(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); });
  return {
    async jsDescription(description = ENGINE) {
      clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }) + '\n');
      await tick();
      serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js', description }] } }) + '\n');
      await tick();
      return replies.find(row => row.id === 'list').result.tools.find(tool => tool.name === 'js').description;
    },
    call(id, code) { clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'); },
    async reply(id, text) {
      await tick();
      serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }) + '\n');
      await tick();
      return replies.find(row => row.id === id).result.content.map(item => item.text ?? '');
    },
  };
}

test('the windows sentence says getState lists no windows and where a window title is', () => {
  assert.equal(FIRST_CALL_WINDOWS, "cua.getState() lists no windows: to find a window by its title, start with getApp and read the result's `Window:` header.");
});

test('every first-call wording gains the windows sentence once, and only with the flag', () => {
  for (const prompt of [undefined, 'lean']) for (const variant of [true, 'merge', 'nosavestop']) {
    const plain = batchingDescription(firstRule, variant, prompt);
    const flagged = batchingDescription(firstRule, variant, prompt, true);
    assert.equal(count(plain, FIRST_CALL_WINDOWS), 0, `${prompt} ${variant}`);
    assert.equal(count(flagged, FIRST_CALL_WINDOWS), 1, `${prompt} ${variant}`);
    assert.equal(flagged.replace(FIRST_CALL_WINDOWS + ' ', ''), plain, `only the sentence is added: ${prompt} ${variant}`);
  }
  // The default wording keeps its getState sentence, and the new one follows it.
  assert.match(batchingDescription(firstRule, true, undefined, true),
    /Use cua\.getState\(\) only to find an app or browser you can't name\. cua\.getState\(\) lists no windows: /);
  assert.equal(batchingDescription('different engine wording', true, undefined, true), 'different engine wording');
});

test('the compact js description gains the sentence under the flag and stays within Claude Code\'s budget', () => {
  const engine = readFileSync(new URL('fixtures/engine-js-description.txt', import.meta.url), 'utf8').trimEnd();
  for (const batch of [true, 'merge', false]) {
    const plain = compactJsDescription(engine, batch, false);
    const flagged = compactJsDescription(engine, batch, false, true);
    assert.equal(count(plain, FIRST_CALL_WINDOWS), 0);
    assert.equal(count(flagged, FIRST_CALL_WINDOWS), 1);
    assert.equal(flagged.replace(FIRST_CALL_WINDOWS + ' ', ''), plain);
    assert.ok(flagged.length <= 2048, String(flagged.length));
  }
});

test('the relay delivers the sentence in tools/list only with SLEIGHT_TS3=1', async t => {
  assert.equal(count(await harness(t).jsDescription(), FIRST_CALL_WINDOWS), 0);
  assert.equal(count(await harness(t, { firstCallWindows: true }).jsDescription(), FIRST_CALL_WINDOWS), 1);
  const saved = process.env.SLEIGHT_TS3;
  try {
    process.env.SLEIGHT_TS3 = '1';
    assert.equal(count(await harness(t).jsDescription(), FIRST_CALL_WINDOWS), 1);
    process.env.SLEIGHT_TS3 = 'true';
    assert.equal(count(await harness(t).jsDescription(), FIRST_CALL_WINDOWS), 0);
  } finally { if (saved === undefined) delete process.env.SLEIGHT_TS3; else process.env.SLEIGHT_TS3 = saved; }
});

// safari-sleight-r2/wikipedia: getState (2.35 s turn), then getApp with a sliced read, then the action.
const STATE = '{"apps":[{"displayName":"Safari","id":"com.apple.Safari","isRunning":true,"lastUsedDate":813974400,"useCount":40}],"browsers":[]}';
const TREE = '<app_specific_instructions>\n## Browser Computer Use\n\nWhen navigating to a new website or starting a separate web task, prefer opening a new tab instead of reusing the current tab.\n</app_specific_instructions>\n' +
  'Window: "sleight benchmark — Sleight Gate fixture", App: Safari.\n0 standard window sleight benchmark — Sleight Gate fixture, Secondary Actions: Raise';

test('results are the same with the flag: a recorded getState still ends with the windows line, getApp is unchanged', async t => {
  const results = [];
  for (const firstCallWindows of [false, true]) {
    const h = harness(t, { firstCallWindows });
    h.call(1, 'const state = await cua.getState(); state');
    const state = await h.reply(1, STATE);
    assert.equal(state.at(-1), WINDOWS_LINE);
    h.call(2, 'let safari = await cua.getApp("Safari"); const st = await safari.getAXState(); nodeRepl.write(st.slice(0, 3000));');
    results.push([state, await h.reply(2, TREE)]);
  }
  assert.deepEqual(results[1], results[0]);
});

test('the race passes SLEIGHT_TS3=1 to the sleight arm, and nothing else new', () => {
  assert.deepEqual(traceEnv({ SLEIGHT_TS3: '1', HOME: '/h' }), { SLEIGHT_TS3: '1' });
  assert.deepEqual(traceEnv({ SLEIGHT_TS3: '0', SLEIGHT_TRACE: '/t' }), { SLEIGHT_TRACE: '/t' });
  assert.deepEqual(traceEnv({ SLEIGHT_TS4: '1', SLEIGHT_PROMPT: 'lean' }), {});
  const script = readFileSync(new URL('../bench/fowl/rounds.sh', import.meta.url), 'utf8');
  const branch = script.slice(script.indexOf('if [ -n "$REAL" ]; then'), script.indexOf('fi\n', script.indexOf('if [ -n "$REAL" ]; then')));
  assert.match(branch, /env -i[\s\S]*\$\{SLEIGHT_TS3:\+SLEIGHT_TS3="\$SLEIGHT_TS3"\}[\s\S]*node tools\/rounds\.mjs/);
});
