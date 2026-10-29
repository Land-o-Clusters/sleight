import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { skillRules, localToolDefinitions } from '../plugins/sleight/lib/launch.mjs';
import { batchingDescription, createRelay, promptNotice } from '../plugins/sleight/lib/relay.mjs';
import { compactJsDescription } from '../plugins/sleight/lib/tool-description.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { SCROLL_LOOP_NOTE, TEXTLESS_NOTE } from '../plugins/sleight/lib/compact-reads.mjs';
import { browserTools, closedTabOutcome, popupObservationHeader } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { handoffMessages } from '../plugins/sleight/lib/direct-browser/handoff.mjs';
import { closedSubmitWarning, shortStepOutcomes } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { guardUnavailableReason, guardPathReason } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { turboFirstRules } from '../plugins/sleight/lib/turbo-first-rules.mjs';
import { pendingTabNote } from '../plugins/sleight/lib/browser-turn-input.mjs';
// The budget script parses relay.mjs with the typescript dev dependency, which CI doesn't install.
const budget = await import('../bench/prompt-budget.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
const skip = !budget && 'needs the typescript dev dependency (npm install)';
const { noticeInventory, sharedNoticeInventory, taggedNoticeInventory } = budget ?? {};
const ts = budget && (await import('typescript')).default;

const firstRule = 'execute exactly one of the API calls shown below, optionally assigning its result to a variable. Do not add other API calls, waits, or snapshots to that invocation.';
const hash = text => createHash('sha256').update(text).digest('hex');
const baseline = JSON.parse(readFileSync(new URL('fixtures/prompt-default.json', import.meta.url)));
const skillPath = new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url);
// G11B shortens the eager cookie rule and counts conditional guard notices.
// p143 plus the cookie rule: default 1062 words, lean 517 words.
// HT1R counts the two conditional hook refusals in both variants (+151 characters).
// SM1R counts the new conditional managed-PATH refusal label (+54 characters).
// HO1 pins the shortened default and lean handoff descriptions.
// KT1 adds one fixed 40-character pending-tab notice (+43 inventoried characters).
// INT5 measures the combined AS2R2 and RS1AR inventory.
// SB3 inventories both conditional field-write notices and their risk prefixes.
const wrongFieldNoticeBudget = 304;
const leanRatio = 33488 / 46546;
const leanSkill = () => skillRules(skillPath, { SLEIGHT_PROMPT: 'lean' });

test('SB3 field-write notices have a pinned conditional budget', { skip }, () => {
  const entries = taggedNoticeInventory().filter(entry => entry.path.startsWith('write-effect.mjs:'));
  assert.deepEqual(entries.map(e => e.text), [
    'Payment field received the text. ', 'Credential field received the text. ',
    'clear it before continuing. Requested write not done: <value> kept its value.',
    'check <value> and <value> before continuing.',
    'Other actions in this call ran; ',
    'sleight: <value>The text is now in <value>; <value> <value>sleight made no repair.',
  ]);
  assert.equal(entries.reduce((sum, entry) => sum + entry.text.length, 0), wrongFieldNoticeBudget);
});

test('hook guard refusals join the pinned notice inventory', { skip }, () => {
  const texts = taggedNoticeInventory().map(entry => entry.text);
  assert.ok(texts.includes(guardUnavailableReason));
  assert.ok(texts.includes(guardPathReason));
  assert.ok(texts.includes(pendingTabNote));
});

test('make-character description stays below 60 tokens even at one token per UTF-8 byte', t => {
  const source = readFileSync(new URL('../plugins/sleight/skills/make-character/SKILL.md', import.meta.url), 'utf8');
  const description = source.match(/^description: (.+)$/m)?.[1];
  assert.ok(description);
  assert.equal(hash(source), baseline.makeCharacterBody);
  const bytes = Buffer.byteLength(description);
  assert.ok(bytes < 60, `${bytes} bytes is the conservative token upper bound`);
  assert.equal(hash(description), baseline.makeCharacterDescription);
  const bodyBytes = Buffer.byteLength(source), words = source.trim().split(/\s+/).length;
  assert.match(source, /^disable-model-invocation: true$/m);
  // Codex 0.164.0 ignores disable-model-invocation. The reviewer observed that this manifest path
  // omits make-character from its model-visible skills; the path form is not documented upstream.
  const codex = JSON.parse(readFileSync(new URL('../plugins/sleight/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(codex.skills, './skills/drive-mac-apps/');
  t.diagnostic(`make-character description: ${bytes} UTF-8 bytes, at most ${bytes} byte-level tokens; on-demand body: ${bodyBytes} UTF-8 bytes, ${words} words`);
});

test('outcome reporting guidance costs no default skill tokens', () => {
  for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }, { SLEIGHT_LEAN_CALLS: '1' }])
    assert.doesNotMatch(skillRules(skillPath, env), /Report read completeness and unverified actions/);
});

test('opened-handle and engine-exit notices retain recovery details in lean wording', () => {
  const handle = 'handle src belongs to "file:///fixture/Source.txt"; window unconfirmed. Call select_window with {"app":"Editor","url":"file:///fixture/Source.txt"}.';
  const ended = 'Engine exited (0). Input outcome is unconfirmed; read the app again.';
  assert.equal(promptNotice(handle), handle);
  assert.equal(promptNotice(ended), ended);
  assert.equal(promptNotice(handle, 'lean'), 'handle src: "file:///fixture/Source.txt" unconfirmed. Call select_window with {"app":"Editor","url":"file:///fixture/Source.txt"}.');
  assert.equal(promptNotice(ended, 'lean'), 'Engine exited (0). Input unconfirmed; read again.');
});

test('the self-closed popup outcome has a reviewed prompt budget', () => {
  assert.equal(hash(closedTabOutcome), baseline.browserClosedOutcome);
  assert.ok(closedTabOutcome.length <= 80);
});

test('handoff status lines have a measured prompt budget', () => {
  assert.equal(hash(JSON.stringify(handoffMessages)), baseline.browserHandoffOutcomes);
  assert.equal(Object.values(handoffMessages).reduce((size, text) => size + text.length, 0), 647);
});

test('the turbo skill reopens the page after an away handoff within its reviewed section byte budget', () => {
  const skill = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md', import.meta.url), 'utf8');
  assert.match(skill, /Reopen the page on their reply\./);
  assert.doesNotMatch(skill, /Read fresh on their next message/);
  assert.ok(Buffer.byteLength(skill) <= 2459);
  // PF3 + HO3: the section cap rises from 1,854 to 2,459 bytes while deferring 3,389 native
  // characters from the first request. Its catalog + first rules fall to 11,020 bytes.
  // Pin the section separately from HO1P's unchanged engine skill and catalogs.
  assert.equal(hash(skill), baseline.browserSkill);
});

test('wait and closed-submit review outcomes have a reviewed prompt budget', () => {
  const outcomes = [...Object.values(shortStepOutcomes), closedSubmitWarning, popupObservationHeader];
  assert.equal(hash(JSON.stringify(outcomes)), baseline.browserReviewOutcomes);
  assert.ok(outcomes.reduce((sum, text) => sum + text.length, 0) <= 241);
});

function placement(t, env = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const replies = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    firstCallRules: skillRules(skillPath, env), leanFirst: env.SLEIGHT_LEAN_FIRST === '1' });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  return {
    call(id, code, name = 'js') { clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n'); },
    reply(id, text, browser = false, isError = false) {
      serverOut.write(JSON.stringify({ id, result: { isError, content: [{ type: 'text', text }],
        ...(browser ? { _meta: { 'codex/toolSurface': { kind: 'browserUse' } } } : {}) } }) + '\n');
      return replies.find(row => row.id === id).result.content.map(item => item.text ?? '').join('\n');
    },
  };
}

for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }, { SLEIGHT_LEAN_CALLS: '1' }, { SLEIGHT_LEAN_FIRST: '1' }]) {
  const variant = JSON.stringify(env);
  test(`native acquisition keeps every pinned safety passage and defers browser rules: ${variant}`, t => {
    const h = placement(t, env);
    h.call(1, 'let app = await cua.getApp("Editor")');
    const first = h.reply(1, '## Computer Use\nNative reference.\nWindow: "Draft", App: Editor');
    for (const passage of baseline.skillSafety) assert.ok(first.includes(passage), passage);
    assert.match(first, /`app\.typeText\(text\)`.*`app\.pressKey\(key\)`.*no (?:element|index)/);
    assert.match(first, /Top-level `await`, no `return`/);
    assert.match(first, /Write text with `nodeRepl\.write\(\.\.\.\)`/);
    assert.doesNotMatch(first, /sleight\.fillForm|sleight\.dragTo|downloadMedia|tab\.getJsDialog/);
    // Engine-path browser sessions (Firefox, Safari) never see the Browsers section, so the form batching rule is outside it.
    assert.match(first, /In a form, fill every independent (?:visible )?field(?: you already see)? in one call\./);
    assert.match(first, /Observe again after\s+autocomplete, a (?:field-adding|selection that adds fields)/);
    assert.match(first, /async validation/);
    assert.match(first, /Stop at a required confirmation\./);
    // A native-first session can act in a browser before its first browser result: the submit rule and
    // tab-handle routing ride in the first rules, not with the deferred browser how-to.
    assert.match(first, /[Ss]top before the final click/);
    assert.match(first, /tab handle, never `getApp`/);
    h.call(2, 'nodeRepl.write(2 + 2)');
    assert.doesNotMatch(h.reply(2, '4'), /sleight\.fillForm/);
    h.call(3, 'let tab = await cua.getTab("1")');
    const browser = h.reply(3, 'Browser result', true);
    assert.match(browser, /sleight\.fillForm/);
    assert.match(browser, /stop if the user declines a browser approval/);
    assert.match(browser, /downloadMedia/);
    assert.match(browser, /tab\.getJsDialog/);
    assert.doesNotMatch(browser, /Never create or edit/);
    h.call(4, 'await tab.getAXState()');
    assert.doesNotMatch(h.reply(4, 'Browser state', true), /sleight\.fillForm/);
  });

  for (const reset of [false, true]) test(`deferred rules survive ${reset ? 'js_reset' : 'engine restart'} and reach a failed browser result: ${variant}`, t => {
    const h = placement(t, env);
    h.call(1, 'let app = await cua.getApp("Editor")');
    h.reply(1, '## Computer Use\nNative reference.');
    h.call(2, reset ? '' : 'await cua.listApps()', reset ? 'js_reset' : 'js');
    assert.doesNotMatch(h.reply(2, reset ? 'reset' : '## Computer Use\nNative reference.'), /sleight\.fillForm/);
    h.call(3, 'let b = await cua.getBrowser({})');
    assert.match(h.reply(3, 'Browser approval declined', false, true), /sleight\.fillForm/);
    h.call(4, 'await cua.listBrowsers()');
    assert.doesNotMatch(h.reply(4, '[]', true), /sleight\.fillForm/);
  });

  for (const docs of ['## Computer Use\nNative reference.', '# Other Browser APIs\nBrowser reference.']) {
    test(`browser-first receives common and browser safety with ${docs.split('\n')[0]}: ${variant}`, t => {
      const h = placement(t, env);
      h.call(1, 'let b = await cua.getBrowser({})');
      const first = h.reply(1, docs, true);
      for (const passage of baseline.skillSafety) assert.ok(first.includes(passage), passage);
      assert.match(first, /sleight\.fillForm/);
      h.call(2, 'await cua.listTabs()');
      assert.doesNotMatch(h.reply(2, '[]', true), /sleight\.fillForm|Never create or edit/);
    });
  }
}

test('lean calls teach persistent handles and action endings only under the experiment flag', () => {
  for (const prompt of [undefined, 'lean']) {
    const normal = skillRules(skillPath, { SLEIGHT_PROMPT: prompt });
    const selected = skillRules(skillPath, { SLEIGHT_PROMPT: prompt, SLEIGHT_LEAN_CALLS: '1' });
    if (prompt !== 'lean') {
      assert.match(selected, /Keep the app handle across calls/);
      assert.match(selected, /End on the action/);
    } else assert.equal(selected, normal, 'the lean skill has no native call guidance to replace');
    assert.ok(selected.split(/\s+/).length <= (prompt === 'lean' ? 519 : 1066));
    assert.equal(skillRules(skillPath, { SLEIGHT_PROMPT: prompt, SLEIGHT_LEAN_CALLS: '0' }), normal);
  }
});

test('lean calls change only the js description in both prompt variants', t => {
  function tools(leanCalls, prompt) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    let result;
    clientOut.on('data', data => { result = JSON.parse(data.toString()); });
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, leanCalls, prompt });
    t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
    clientIn.write(JSON.stringify({ id: 1, method: 'tools/list' }) + '\n');
    serverOut.write(JSON.stringify({ id: 1, result: { tools: [{ name: 'js', description: firstRule }, { name: 'js_reset', description: 'Reset' }] } }) + '\n');
    return result.result.tools;
  }
  for (const prompt of [undefined, 'lean']) {
    const normal = tools(false, prompt), selected = tools(true, prompt);
    assert.match(selected[0].description, /keep the app handle across calls/);
    assert.match(selected[0].description, /End on the action/);
    assert.ok(selected[0].description.startsWith(normal[0].description));
    assert.deepEqual(selected[1], normal[1]);
  }
});

test('the default skill explains masked field reads without claiming a fill succeeded', () => {
  const skill = skillRules(skillPath, {});
  assert.match(skill, /engine masks protected field reads as `<redacted>`/);
  assert.match(skill, /does not mean input was replaced/);
  assert.match(skill, /Use validation or submission results\. Never try to unmask it/);
});

test('both skill variants explain browser routing and script input within their word budgets', () => {
  for (const [env, limit] of [[{}, 1066], [{ SLEIGHT_PROMPT: 'lean' }, 519]]) {
    const skill = skillRules(skillPath, env);
    assert.match(skill, /[Ww]eb pages.*tab handle, never `getApp`/);
    assert.match(skill, /[Tt]op-level `await`, no `return`/);
    assert.match(skill, /[Ww]rite text with `nodeRepl\.write\(\.\.\.\)`/);
    assert.doesNotMatch(skill, /last expression is the result/);
    assert.match(skill, /Tab-handle input.*first argument.*element index or `null`/);
    assert.match(skill, /[Ff]ill every (?:independent )?(?:field you already see|visible field) in one call/);
    assert.match(skill, /nodeRepl\.write\(await sleight\.fillForm\(tab,/);
    assert.match(skill, /by label or locator \(an index needs a stable ID in the tree\)/);
    if (!env.SLEIGHT_PROMPT) assert.match(skill, /nodeRepl\.write\(await sleight\.pickFromList\(tab, list, "Portland"\)\)/);
    else assert.doesNotMatch(skill, /sleight\.pickFromList/);
    assert.match(skill, /[Rr]ead once at the end/);
    assert.match(skill, /Submit in that call only when the user asked(?: for that submit)? and the engine's confirmation policy\s+doesn't require confirming it\./);
    assert.match(skill, /Otherwise stop before the final click\./);
    assert.doesNotMatch(skill, /submit in (?:that|the same) call when nothing is uncertain/i);
    assert.match(skill, /Use locators when validation(?: or |\/)autocomplete (?:can add or move|moves) fields, indices on static forms\./);
    assert.match(skill, /nodeRepl\.write\(await sleight\.dragTo\(tab, from, to\)\)/);
    assert.match(skill, /selectors, locators or page coordinates.*reads back/s);
    if (env.SLEIGHT_PROMPT === 'lean') assert.doesNotMatch(skill, /sleight\.reorder/);
    else assert.match(skill, /nodeRepl\.write\(await sleight\.reorder\(tab,list,order\)\)/);
    assert.match(skill, /Downloads: `locator\.downloadMedia\(\{\}\)`, never `tab\.click` \(stalls later downloads\)\./);
    assert.match(skill, /`tab\.click\(index\)`, not a locator, then answer it: `\(await tab\.getJsDialog\(\)\)\.accept\(\)`/);
    assert.ok(skill.trim().split(/\s+/).length <= limit, 'skill word budget');
  }
});

test('the default skill retains extension selection and lean retains precise safety instructions', () => {
  const normal = skillRules(skillPath, {}), lean = leanSkill();
  assert.match(normal, /With a connected ChatGPT extension/);
  assert.match(normal, /Several Chromium browsers report as Chrome/);
  assert.match(normal, /metadata\.extensionInstanceId.*await cua\.listBrowsers\(\)/s);
  assert.match(normal, /nodeRepl\.write\(await sleight\.pickFromList\(tab, list, "Portland"\)\)/);
  assert.doesNotMatch(lean, /sleight\.pickFromList/);
  assert.match(normal, /cua\.getBrowser\(\{ extensionInstanceId \}\).*in a call of its own/s);
  assert.match(lean, /tell the user first that it moves their pointer/i);
  assert.match(lean, /ask the user to run `bin\/sleight-mcp --doctor` from the plugin folder/);
  assert.match(lean, /the latest screenshot of that window/);
  assert.match(lean, /press Cmd\+Z in that window/);
  assert.match(lean, /Use only documented methods/);
  assert.match(lean, /leave tabs in the background/i);
  assert.match(lean, /stop if the user declines a browser approval/i);
  assert.match(lean, /brings the app forward for about two seconds/);
  assert.match(lean, /Submit in that call only when the user asked and the engine's confirmation policy doesn't require confirming it\. Otherwise stop before the final click\./);
  assert.match(lean, /Before `hover`, try `Help:`/);
});

test('nosavestop changes only the final stop clause and keeps the default prompt hashes', () => {
  assert.equal(hash(batchingDescription(firstRule, true)), baseline.batch);
  assert.equal(hash(batchingDescription(firstRule, 'merge')), baseline.merge);
  const clause = ', but end the call after a shortcut that opens or names a window (Cmd+N, Cmd+O, or Cmd+S on an untitled document): sleight stops the rest of a call when its window changes.';
  for (const prompt of [undefined, 'lean']) {
    const normal = batchingDescription(firstRule, true, prompt);
    assert.ok(normal.endsWith(clause));
    const expected = normal.slice(0, -clause.length) + '. sleight waits for the sheet a shortcut opens.';
    assert.equal(batchingDescription(firstRule, 'nosavestop', prompt), expected);
    assert.equal(batchingDescription('different engine wording', 'nosavestop', prompt), 'different engine wording');
  }
});

test('the launcher selects nosavestop without changing default, disabled or merge settings', async () => {
  const { firstCallBatchSetting } = await import('../plugins/sleight/lib/relay.mjs');
  for (const [value, expected] of [['nosavestop', 'nosavestop'], ['merge', 'merge'], ['0', false],
    [undefined, true], ['1', true], ['NOSAVESTOP', true]]) {
    assert.equal(firstCallBatchSetting?.(value), expected);
  }
});

test('only lean selects shorter text and RS off keeps the original skill hash', { skip }, () => {
  assert.ok(leanSkill().length < skillRules(skillPath, {}).length);
  // HO1 changes descriptions only; the verified notices hash stays unchanged.
  assert.equal(hash(JSON.stringify([...noticeInventory(), ...sharedNoticeInventory(), ...taggedNoticeInventory()].map(e => e.text))), baseline.notices);
  for (const env of [{}, { SLEIGHT_PROMPT: 'default' }, { SLEIGHT_PROMPT: 'LEAN' }]) {
    assert.equal(hash(skillRules(skillPath, { ...env, SLEIGHT_RS: '0' })), baseline.skill);
    assert.equal(hash(JSON.stringify(localToolDefinitions(env))), baseline.tools);
    assert.equal(hash(batchingDescription(firstRule, true, env.SLEIGHT_PROMPT)), baseline.batch);
    assert.equal(hash(batchingDescription(firstRule, 'merge', env.SLEIGHT_PROMPT)), baseline.merge);
  }
  const stripDescriptions = value => Array.isArray(value) ? value.map(stripDescriptions) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, item]) => [key, stripDescriptions(item)])) : value;
  assert.deepEqual(stripDescriptions(localToolDefinitions({ SLEIGHT_PROMPT: 'lean' })), stripDescriptions(localToolDefinitions({})));
});

test('lean retains the skill safety passages verbatim and removes named examples', { skip }, () => {
  const lean = leanSkill();
  assert.ok(lean.length < skillRules(skillPath, {}).length);
  for (const passage of baseline.skillSafety) assert.ok(lean.includes(passage), passage);
  const withoutSafety = baseline.skillSafety.reduce((text, passage) => text.replace(passage, ''), lean);
  const texts = [withoutSafety, batchingDescription(firstRule, true, 'lean'), batchingDescription(firstRule, 'merge', 'lean')];
  for (const variant of [true, 'merge']) assert.ok(batchingDescription(firstRule, variant, 'lean').includes('sleight acquires the app and checks its window before they run.'));
  assert.ok(batchingDescription(firstRule, true, 'lean').includes('but end the call after a shortcut that opens or names a window (Cmd+N, Cmd+O, or Cmd+S on an untitled document): sleight stops the rest of a call when its window changes.'));
  for (const tool of localToolDefinitions({ SLEIGHT_PROMPT: 'lean' })) {
    const safety = baseline.toolSafety[tool.name] ?? [];
    for (const passage of safety) assert.ok(tool.description.includes(passage), `${tool.name}: ${passage}`);
    texts.push(safety.reduce((text, passage) => text.replace(passage, ''), JSON.stringify(tool)));
  }
  assert.doesNotMatch(texts.join('\n'), /Calculator|TextEdit|Chess|Safari|Helium|iPhone|Simulator|Slack|Chrome|ChatGPT|Codex|Atlas|Terminal|iTerm2/);
  const [normalHover] = localToolDefinitions({}).filter(t => t.name === 'hover');
  const [leanHover] = localToolDefinitions({ SLEIGHT_PROMPT: 'lean' }).filter(t => t.name === 'hover');
  assert.equal(leanHover.inputSchema.properties.windowTitle.description, normalHover.inputSchema.properties.windowTitle.description);
  const sharedLean = sharedNoticeInventory('lean').map(e => e.text).join('\n');
  for (const entry of sharedNoticeInventory()) {
    for (const sentence of entry.text.split(/(?<=[.!?])\s+/)) {
      if (/^(?:Stop|Ask|Tell|Read|Before|Restarting|Never|Use|The user|Its settings|A yes)\b/.test(sentence)) assert.ok(sharedLean.includes(sentence), sentence);
    }
  }
});

test('lean changes relay additions without changing engine text or safety refusals', t => {
  function reply(prompt) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const output = [];
    clientOut.on('data', bytes => output.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, prompt, changeReview: false, firstCallBatch: true });
    t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'js', description: `ENGINE BEFORE ${firstRule} ENGINE AFTER` }] } }) + '\n');
    const description = output.at(-1).result.tools[0].description;
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [
      { type: 'text', text: 'ENGINE TEXT, including Calculator, stays unchanged.' },
      { type: 'image', data: 'same', mimeType: 'image/png' }, { type: 'image', data: 'same', mimeType: 'image/png' },
    ] } }) + '\n');
    const content = output.at(-1).result.content;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: 'app.click(1); app.typeText("x")' } } }) + '\n');
    return { description, content, refusal: output.at(-1).result };
  }
  const normal = reply(), lean = reply('lean');
  assert.ok(lean.description.length < normal.description.length);
  assert.match(lean.description, /^ENGINE BEFORE .* ENGINE AFTER$/);
  assert.deepEqual(lean.content.slice(0, 2), normal.content.slice(0, 2));
  assert.ok(lean.content.at(-1).text.length < normal.content.at(-1).text.length);
  assert.equal(lean.refusal.isError, true);
  assert.equal(normal.refusal.isError, true);
  assert.match(lean.refusal.content[0].text, /stopped this call before it ran:.*Add await at line \d+ and send it again\./);
});

// Lean was 30% under the default until both gained the same browser lines (29.7%, 2026-10-12).
test('shared notices count the browser lease advice and its lean variant', { skip }, () => {
  assert.ok(sharedNoticeInventory().some(entry => entry.text === 'For browser work, use cua.getBrowser(...) and its tab handle, or cua.listTabs() for inventory. cua.getApp(...) acquires a native app.'));
  assert.ok(sharedNoticeInventory('lean').some(entry => entry.text === 'Browser work: use cua.getBrowser(...) and its tab, or cua.listTabs() for inventory.'));
});

test('the offline budget command measures all sources and stays about 30 percent under', { skip }, () => {
  const result = spawnSync(process.execPath, ['bench/prompt-budget.mjs', '--json'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.rows.some(row => row.source === 'skill'));
  assert.ok(report.rows.some(row => row.source === 'js rewrite'));
  assert.ok(report.rows.some(row => row.source === 'relay notices'));
  assert.ok(report.rows.some(row => row.source === 'tool descriptions'));
  assert.ok(report.rows.some(row => row.source === 'shared notices'));
  assert.ok(report.total.default.characters <= 46546, JSON.stringify(report.total));
  assert.ok(report.total.lean.characters <= 33488, JSON.stringify(report.total));
  assert.ok(report.total.lean.characters <= report.total.default.characters * leanRatio, JSON.stringify(report.total));
});

test('the delivered default js prompt stays pinned within Claude Code’s description budget', () => {
  const engine = readFileSync(new URL('fixtures/engine-js-description.txt', import.meta.url), 'utf8').trimEnd();
  const description = compactJsDescription(engine, true, false);
  assert.equal(hash(description), baseline.js);
  assert.ok(description.length <= 2048);
});

// PB1 (2026-10-17): the compactor's notes, the document guard's stops and the stop notes were outside the count.
test('the budget counts compactor, guard and stop notes marked as notices', { skip }, () => {
  const texts = taggedNoticeInventory().map(entry => entry.text).join('\n');
  for (const text of [SCROLL_LOOP_NOTE, TEXTLESS_NOTE, 'UI changed (window)', 'sleight: <value> earlier reads of the same window in this call left out',
    'sleight: the click on <value> moved it from position', 'sleight: clicking also swapped', 'sleight: typed text landed in',
    'sleight: lines changed since the last full tree', 'sleight: this call ran <value>', 'Native access stopped: use the handle',
    'that object names no element', 'Input lease stopped this action: app changed.', 'Copy/Cut used the native clipboard.',
    'sleight sent one Escape to <value> to close a stuck menu']) assert.ok(texts.includes(text), text);
  const others = [...noticeInventory(), ...sharedNoticeInventory()].map(entry => entry.text);
  for (const entry of taggedNoticeInventory()) assert.ok(!others.includes(entry.text), `counted twice: ${entry.path}`);
});

// Log lines (ending in a newline, written to stderr) and internal [sleight:…] marks are not model-visible.
test('every sleight-prefixed literal in the relay, compactor, guard and stop notes is counted', { skip }, () => {
  const counted = [...noticeInventory(), ...sharedNoticeInventory(), ...taggedNoticeInventory()].map(entry => entry.text).join('\n');
  for (const file of ['relay.mjs', 'compact-reads.mjs', 'document-scope.mjs', 'menu-continuation.mjs']) {
    const source = readFileSync(new URL(`../plugins/sleight/lib/${file}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    (function visit(node) {
      const text = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => '\0' + span.literal.text).join('') : undefined;
      if (text !== undefined && /^sleight(?::| stopped)/.test(text) && !text.endsWith('\n')) {
        const pieces = text.split('\0').filter(piece => piece.trim().length > 3);
        assert.ok(pieces.every(piece => counted.includes(piece)), `${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${text}`);
      }
      ts.forEachChild(node, visit);
    })(ast);
  }
});

test('lean keeps the safety sentences of marked notices verbatim', { skip }, () => {
  const lean = taggedNoticeInventory('lean').map(entry => entry.text).join('\n');
  for (const entry of taggedNoticeInventory()) {
    for (const sentence of entry.text.split(/(?<=[.!?])\s+/)) {
      if (/^(?:Stop|Ask|Tell|Never|Before|The user|Only the user)\b/.test(sentence)) assert.ok(lean.includes(sentence), sentence);
    }
  }
});

test('the guard carries lean stop wording only under SLEIGHT_PROMPT=lean, and both forms compile', () => {
  const AsyncFunction = (async () => {}).constructor;
  const window = { app: 'Editor', title: 'Draft', url: undefined };
  const normal = guardedCode('await app.click(1);', window), lean = guardedCode('await app.click(1);', window, undefined, undefined, { prompt: 'lean' });
  assert.match(normal, /One call acts in one app: to switch apps/);
  assert.doesNotMatch(lean, /One call acts in one app: to switch apps/);
  assert.match(lean, /Send the rest in a new call/);
  assert.ok(lean.length < normal.length);
  for (const code of [normal, lean]) assert.doesNotThrow(() => new AsyncFunction(code));
});


test('AO prompt inventory counts browser_open and first-call guidance only under the flag, within the same ratio', { skip }, () => {
  const off = budget.budget({}), on = budget.budget({ SLEIGHT_BROWSER_CORE: '1' });
  for (const variant of ['default', 'lean']) {
    assert.ok(!off.details[variant].tools.some(e => e.source === 'browser_open'));
    assert.ok(on.details[variant].tools.some(e => e.source === 'browser_open'));
    assert.ok(on.total[variant].characters > off.total[variant].characters);
    const js = r => r.rows.find(row => row.source === 'js rewrite')[variant].characters;
    assert.equal(js(on) - js(off), 83);
  }
  assert.ok(on.total.lean.characters <= on.total.default.characters * leanRatio, JSON.stringify(on.total));
});

import { withMT } from './fixtures/mt-env.mjs';
test('PF7 batch wording is default-off with its own catalog hash and unchanged schemas and notices', { skip }, async t => {
  const saved = process.env.SLEIGHT_FORM_BATCH;
  t.after(() => { if (saved === undefined) delete process.env.SLEIGHT_FORM_BATCH; else process.env.SLEIGHT_FORM_BATCH = saved; });
  await withMT(undefined, async () => {
    delete process.env.SLEIGHT_FORM_BATCH;
    const before = browserTools('bfixture');
    for (const value of ['0', 'true', 'yes']) {
      process.env.SLEIGHT_FORM_BATCH = value;
      assert.deepEqual(browserTools('bfixture'), before);
    }
    process.env.SLEIGHT_FORM_BATCH = '1';
    const after = browserTools('bfixture');
    assert.deepEqual(after.map(t => t.inputSchema), before.map(t => t.inputSchema));
    assert.deepEqual(after.filter(t => t.name !== 'browser_fill'), before.filter(t => t.name !== 'browser_fill'));
    assert.equal(hash(JSON.stringify(after)), baseline.browserToolsFormBatch);
    assert.equal(JSON.stringify(after).length - JSON.stringify(before).length, 50);
    assert.match(after.find(t => t.name === 'browser_fill').description, /same call as the last field/);
    assert.match(after.find(t => t.name === 'browser_fill').description, /select\/listbox\/combobox/);
    assert.match(after.find(t => t.name === 'browser_fill').description, /only when user asked/);
    assert.equal(hash(JSON.stringify([...noticeInventory(), ...sharedNoticeInventory(), ...taggedNoticeInventory()].map(e => e.text))), baseline.notices);
  });
  await withMT('0', async () => assert.equal(hash(JSON.stringify(browserTools('bfixture'))), baseline.browserToolsLegacy));
});
for (const mode of [undefined, '0']) test(`MT browser descriptions stay pinned inside existing budgets, switch=${mode}`, async () => withMT(mode, async () => {
  const tools = browserTools('bfixture');
  // HO1 pins both catalogs after the handoff wording trim.
  assert.equal(hash(JSON.stringify(tools)), mode === '0' ? baseline.browserToolsLegacy : baseline.browserToolsMT);
  // p143 integration (fd1b screenshots/motion, fd3b waits, fd5b links/viewport, g2b download, g1b handoff, g4b PDF):
  // +363 characters for g3g export (path, format, bom, completeness receipt).
  // G12F paste adds 119 catalog characters in each mode (111 description, 8 enum).
  // Point input is opt-in and adds no catalog characters by default.
  // each lane measured its own increment; G10B adds 68 characters for touch schema and guidance.
  // G13E opt-in discovery adds 64 catalog characters (62 description characters).
  // Release trim: the 65536 string limit is validate()'s default, so the catalog drops it (-252 in each mode).
  // G11F's cookie sentence adds 94 catalog characters in each mode.
  // TL1's max_steps schema adds 57 catalog characters; descriptions stay unchanged.
  assert.equal(tools.find(tool => tool.name === 'browser_act').description.length, mode === '0' ? 1034 : 1059);
  // HO1 saves 2 catalog bytes by default and 3 in the legacy variant versus 1.5.0.
  assert.equal(JSON.stringify(tools).length, mode === '0' ? 6162 : 6083);
  const descriptions = tools.map(tool => tool.description).join('\n');
  for (const prompt of [undefined, 'lean']) {
    const combined = skillRules(skillPath, { SLEIGHT_PROMPT: prompt }).length + descriptions.length;
    // HO1 pins the combined skill and description sizes in both MT variants.
    assert.equal(combined, mode === '0' ? (prompt === 'lean' ? 6000 : 9621)
      : (prompt === 'lean' ? 5921 : 9542));
  }
  assert.ok(JSON.stringify(tools).length < 8000);
  for (const tool of tools) assert.ok(tool.description.length <= 2048, tool.name);
}));

test('PF3 keeps every 1.5.0 input schema and pins both first and full turbo guidance', { skip }, () => {
  const schemas = browserTools('bbench').map(({ name, inputSchema }) => ({ name, inputSchema }));
  assert.equal(hash(JSON.stringify(schemas)), baseline.browserSchemas150);
  const browser = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md', import.meta.url), 'utf8')
    .trimEnd().replace('{browser}', 'bbench').replace('{application}', ' (Google Chrome)');
  const full = skillRules(skillPath, {}).replace(/## Browsers\n[\s\S]*?(?=\n## |$)/, browser + '\n');
  assert.equal(hash(full), baseline.browserFullRules);
  assert.equal(hash(turboFirstRules(full)), baseline.browserFirstRules);
  const measured = budget.budget({}).conditional.turboFirst.default;
  assert.equal(measured.catalog.characters, 6081);
  assert.equal(measured.rules.characters, 4937);
  assert.equal(measured.deferredCharacters, 3285);
  assert.equal(measured.combined.characters, 11019);
  assert.equal(Buffer.byteLength(JSON.stringify(browserTools('bbench')) + '\n' + turboFirstRules(full)), 11019);
  // This counts the browser catalog + skill, not host framing, native tools or Haiku tokens.
  assert.ok(measured.combined.characters <= 11736, 'below the same df27db01 surface');
  assert.ok(measured.combined.characters < 14166, 'below p160 a3706679');
});

// Remote context is absent on the ordinary path and inventoried as a conditional per-turn addition.
test('remote approval context has its own measured conditional budget', { skip }, () => {
  const report = budget.budget({});
  assert.equal(report.conditional.remoteApprovals.ordinary.characters, 0);
  assert.equal(report.conditional.remoteApprovals.upfront.text, 'sleight: Ask the user to reply: allow Mail, Word');
  assert.equal(report.conditional.remoteApprovals.upfront.characters, 48);
  assert.equal(report.conditional.remoteApprovals.upfront.lines, 1);
  assert.ok(report.conditional.remoteApprovals.refusal.characters < 100);
  assert.match(report.conditional.remoteApprovals.physical.text, /needs the user at the Mac/);
  assert.ok(report.conditional.remoteApprovals.physical.characters < 100);
});
