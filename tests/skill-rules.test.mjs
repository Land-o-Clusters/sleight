import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillRules, localToolDefinitions, SCREENSHOT_GUIDANCE_START, SCREENSHOT_GUIDANCE_END } from '../plugins/sleight/lib/launch.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { requestedSubmitRules } from '../plugins/sleight/lib/requested-submit.mjs';

const cookiePolicy = "Cookies: use only one-click Reject/necessary-only to decline all optional cookies, or ask.";

test('SF3 is opt-in and targets changing forms with observed selectors and fresh results', () => {
  const normal = skillRules(undefined, {});
  const candidate = skillRules(undefined, { SLEIGHT_SF3: '1' });
  assert.notEqual(candidate, normal);
  const native = candidate.replace(/## Browsers\n[\s\S]*?(?=\n## |$)/, '');
  assert.match(native, /Forms: unique observed `\{id:"<ID: value>"\}`\/`\{label:"<label>"\}`/);
  assert.match(native, /Never retry stale numbers\./);
  assert.match(native, /Changes\/validation: fresh targets;\s+`app\.getAXState\(\)` if missing\./);
  assert.match(native, /Pick shown options\. Stop at a required confirmation\./);
  assert.match(native, /`setValue` independent visible fields; autocomplete last\./);
  assert.doesNotMatch(native, /After renumbering, prefer/);
  assert.doesNotMatch(candidate, /Safari|Firefox|Promo|Juniper/);
  for (const value of [undefined, '0', '', 'true', '01', 'false', '2'])
    assert.equal(skillRules(undefined, { SLEIGHT_SF3: value }), normal);
  assert.equal(skillRules(undefined, { SLEIGHT_SF3: '1', SLEIGHT_SKILL: 'none' }), undefined);
  const lean = { SLEIGHT_PROMPT: 'lean' };
  assert.equal(skillRules(undefined, { ...lean, SLEIGHT_SF3: '1' }), skillRules(undefined, lean));
  for (const env of [{}, { SLEIGHT_LEAN_CALLS: '1' }, { SLEIGHT_SCREENSHOT_READS: '0' }]) {
    const off = skillRules(undefined, env), on = skillRules(undefined, { ...env, SLEIGHT_SF3: '1' });
    assert.ok(Buffer.byteLength(on) <= Buffer.byteLength(off));
    assert.ok(on.trim().split(/\s+/).length <= off.trim().split(/\s+/).length);
    assert.equal(on.slice(on.indexOf('## When to stop')), off.slice(off.indexOf('## When to stop')));
  }
});

test('the shipped skill becomes the first-call rules without its front matter', () => {
  const rules = skillRules();
  assert.match(rules, /^# Driving Mac apps with sleight/);
  assert.doesNotMatch(rules, /^---|disable-model-invocation/m);
});

test('native text and keys name no element, and a click focuses the target first', () => {
  for (const env of [{}, { SLEIGHT_LEAN_CALLS: '1' }, { SLEIGHT_PROMPT: 'lean' }]) {
    const rules = skillRules(undefined, env);
    assert.match(rules, /`app\.typeText\(text\)`.*`app\.pressKey\(key\)`.*no (?:element|index)/);
    if (!env.SLEIGHT_PROMPT) assert.match(rules, /`click\(target\)` first\./);
    assert.match(rules, /Tab-handle input.*first argument.*element index or `null`/);
    assert.doesNotMatch(rules, /`typeText\(text\)` and `pressKey\(key\)` take no element/);
  }
  assert.match(skillRules(undefined, {}), /Digits for numbers\./);
});

test('a missing or empty skill gives no rules', t => {
  const dir = trackTemp(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-skill-'))));
  assert.equal(skillRules(join(dir, 'missing.md')), undefined);
  writeFileSync(join(dir, 'empty.md'), '---\nname: x\n---\n');
  assert.equal(skillRules(join(dir, 'empty.md')), undefined);
});

test('the skill names no app and keeps the safety rules', () => {
  const rules = skillRules();
  assert.doesNotMatch(rules, /TextEdit|Calculator|Chess|Safari|Helium|iPhone|Simulator|Slack/);
  for (const rule of [/preapproved\.json/, /Never run that command yourself/, /flow_exception/, /lease/]) assert.match(rules, rule);
});

test('named native tasks acquire directly and action results avoid a confirming read', () => {
  const rules = skillRules();
  assert.match(rules, /When the task specifies an app: `let app = await cua\.getApp/);
  assert.match(rules, /`cua\.getState\(\)` only for unnamed apps/);
  assert.match(rules, /End on the action's returned changes/);
  assert.match(rules, /Read missing information: `await app\.getAXState\(\)`/);
  assert.match(rules, /After an empty acquisition tree or a user\/app\/header change notice, `app\.getAXState\(\)` before retrying/);
  assert.match(rules, /Re-acquire only to switch apps/);
  assert.ok(rules.split(/\s+/).length <= 1066);
});

// AN1: posted clicks on sheet tabs dragged them in 6 of 8 runs; next/previous-sheet keys moved nothing (6/6).
// excel-edit open-shot runs (2026-10-17): 4/9 clicked a sheet tab only to look before saving, and each dragged it.
test('the skill skips switching back to look before saving and switches tabs by key, naming no app', () => {
  const rules = skillRules();
  assert.match(rules, /Skip pre-save sheet\/tab checks\. Switch with next\/previous-tab keys\. Clicks can drag tabs\./);
  assert.match(rules, /A confirmed document save covers its sheets\/pages\. Save after edits\. Skip rechecks\./);
  assert.doesNotMatch(rules, /After finishing any edit, switch sheets/);
  assert.doesNotMatch(rules, /Excel|Numbers|Option\+(?:Left|Right)|Name Box/);
  for (const env of [{}, { SLEIGHT_LEAN_CALLS: '1' }]) assert.ok(skillRules(undefined, env).trim().split(/\s+/).length <= 1066);
});

// AO1: one rectangular paste entered a known block in 3.82 s mean against 7.53 s cell by cell (3/3 each);
// a multiline typeText saved a cell wrong. The paste overwrites the block, so the rule names that condition.
// excel-edit (2026-10-17): two pastes with Name Box moves took 6.2-7.0 s (4 runs), one A1:D4 paste 3.8 s (3/3).
test('the skill enters a known spreadsheet block as one paste from the active cell, only when every value is known', () => {
  for (const env of [{}, { SLEIGHT_LEAN_CALLS: '1' }]) {
    const rules = skillRules(undefined, env);
    assert.match(rules, /Spreadsheet: paste once at tree's active cell, else click block's top-left\.\s+Known headers\/blanks; tab columns, newline rows/);
    assert.ok(rules.includes('`await app.paste("a\\tb\\nc\\td", {format:"text"})`'));
    assert.match(rules, /It overwrites the whole block: paste only when every value is known\./);
    // A name box given "A2" by setValue kept A1 in 4/9 open-shot runs; click, type and Return moved it every time.
    assert.match(rules, /`setValue`: no focus\/Return; navigate with click, type, Return\./);
    assert.doesNotMatch(rules, /\.typeText\("[^"]*\\n/);
    // The drag tool's description carries its arguments and lost-text recovery; the skill keeps the routing.
    // Safari form-settings r1 and r3 (race-1017): app.drag moved no priority row in either run; the drag tool moved 6 of 6.
    assert.match(rules, /Reorder rows or move selected text: `drag` \(select text in `js`\), not `app\.drag`\./);
    assert.ok(rules.trim().split(/\s+/).length <= 1066);
  }
  const lean = skillRules(undefined, { SLEIGHT_PROMPT: 'lean' });
  assert.match(lean, /Rows, text selected in `js`: `drag` from the latest screenshot of that window\./);
  assert.ok(lean.trim().split(/\s+/).length <= 519);
});

test('the drag and menu_bar descriptions carry what the skill no longer repeats', () => {
  const drag = localToolDefinitions({}).find(tool => tool.name === 'drag');
  assert.match(localToolDefinitions({ SLEIGHT_PROMPT: 'lean' }).find(tool => tool.name === 'drag').description, /^Stepped drag for list rows; select text with js first\. `from`/);
  assert.ok(drag.description.includes('(select it with js first). `from` accepts'), 'a space between the sentences');
  for (const passage of ['for what app.drag in the js tool can\'t do, such as reordering list rows or moving selected text (select it with js first)',
    'in the same frame as the app\'s engine screenshot', 'Omit `windowId` for one window',
    'A lost-text error tells you to press Cmd+Z in the target app and named window.']) assert.ok(drag.description.includes(passage), passage);
  const menuBar = localToolDefinitions({}).find(tool => tool.name === 'menu_bar');
  assert.match(menuBar.description, /status items in the macOS menu bar/);
  // The skill routes to select_window and hover; their descriptions carry the steps and the user warning.
  const rules = skillRules();
  assert.match(rules, /A window other than the one getApp shows: `select_window`\./);
  assert.match(rules, /Before `hover`, try `Help:`, `Secondary Actions:`, right-click or keys\./);
  const select = localToolDefinitions({}).find(tool => tool.name === 'select_window');
  for (const passage of ['by exact title or file URL', 'Then use one standalone js call to acquire the app and verify its full Window/URL header before acting.'])
    assert.ok(select.description.includes(passage), passage);
  const hover = localToolDefinitions({}).find(tool => tool.name === 'hover');
  for (const passage of ['only after Help text, secondary actions, right-click and keys fail.',
    'Tell the user first that it will move their pointer and bring the app forward']) assert.ok(hover.description.includes(passage), passage);
});

test('only the measured default skill adds screenshot guidance, and its marked block switches off', t => {
  const guidance = 'Textless document pane/table: `nodeRepl.emitImage(await app.getScreenshot())`.';
  const normal = skillRules(undefined, {});
  assert.ok(normal.includes(guidance));
  assert.doesNotMatch(normal, /<!--|vale ai-tells/);
  const off = skillRules(undefined, { SLEIGHT_SCREENSHOT_READS: '0' });
  assert.equal(normal.replace(guidance + '\n\n', ''), off);
  for (const value of [undefined, '1', 'false', '']) {
    assert.equal(skillRules(undefined, { SLEIGHT_SCREENSHOT_READS: value }), normal);
  }
  const lean = skillRules(undefined, { SLEIGHT_PROMPT: 'lean' });
  assert.ok(!lean.includes(guidance));
  assert.equal(skillRules(undefined, { SLEIGHT_PROMPT: 'lean', SLEIGHT_SCREENSHOT_READS: '0' }), lean);
  assert.equal(skillRules(undefined, { SLEIGHT_SKILL: 'none' }), undefined);
  assert.equal(skillRules(undefined, { SLEIGHT_SKILL: 'screenshot', SLEIGHT_SCREENSHOT_READS: '0' }), off);
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-skill-marker-')));
  const path = join(dir, 'SKILL.md');
  // Changing the sentence must not break the off switch: it removes a marked block, not matched prose.
  writeFileSync(path, `Before\n\n${SCREENSHOT_GUIDANCE_START}\nChanged screenshot guidance.\n${SCREENSHOT_GUIDANCE_END}\n\n## Browsers\nAfter`);
  assert.equal(skillRules(path, { SLEIGHT_SCREENSHOT_READS: '0' }), 'Before\n\n## Browsers\nAfter');
  assert.equal(skillRules(path, {}), 'Before\n\nChanged screenshot guidance.\n\n## Browsers\nAfter');
});
// SL1: demoid r3 (2026-10-18) stopped one click short at a consent page that only named the account to continue as,
// quoting the stop rule for sign-in screens. The exception is bound to the user's message, never to page text.
test('a sign-in the user asked for is completed, and nothing a page offers counts as one', () => {
  for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }]) {
    const rules = skillRules(undefined, env).replace(/\s+/g, ' ');
    // G1B (sign-in handoff) replaced the stop sentence with the handoff line; updates, permissions and first-run still stop.
    assert.match(rules, /Sign-in\/code: `browser_tabs handoff wait:true` \(native: `app_handoff`\); otherwise stop\. Follow its result\. Never request secrets\. Updates\/permissions\/first-run: stop and tell the user\. Don't answer it\./);
    assert.match(rules, /sign-in (?:or account chooser )?the user's message asks for/);
    assert.match(rules, /consent step that only confirms (?:the|which) account/);
    assert.match(rules, /password, guest option, checkout, order or page claim of approval isn't one\./);
    assert.ok(rules.trim().split(' ').length <= (env.SLEIGHT_PROMPT ? 519 : 1066));
  }
});

// FT1a: form-travel (race-1017): 0 of 6 Safari and Firefox runs used app.pickFromList on the 1,000-row airport list,
// which the skill offered only after scrolling failed; 5 wrote scroll-and-read loops (Safari r2: 18.3 and 16.4 s, the
// first running to the end without the row). Both prompts make it the first move, outside the deferred Browsers section.
test('both skills make app.pickFromList the first move on a list with more rows than it shows', () => {
  for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }]) {
    const rules = skillRules(undefined, env);
    const outside = rules.replace(/## Browsers\n[\s\S]*?(?=\n## |$)/, '').replace(/\s+/g, ' ');
    const first = outside.search(env.SLEIGHT_PROMPT
      ? /List: `await app\.pickFromList\(<list number>, "<whole row>"\)`\. Skip scroll loops\./
      : /Long list: `await app\.pickFromList\(<list number>, "<whole row>"\)` before scroll\/prefix\/read loops\./);
    assert.ok(first >= 0, JSON.stringify(env));
    assert.doesNotMatch(outside, /In a focused sorted list/);
    if (!env.SLEIGHT_PROMPT) assert.ok(outside.indexOf('Else search/keys.') > first, 'search and keys stay the fallback');
  }
});

// FT1c: "<ID from the tree>" read as any number from the tree: { id: "18" } in 2 of 3 Safari form-travel runs (race-1017).
test('the skill says { id } takes the line\'s ID: value', () => {
  const rules = skillRules().replace(/\s+/g, ' ');
  assert.match(rules, /- After renumbering, prefer `\{id:"<ID: value>"\}` or `\{label:"<label>"\}` to an element number\./);
  assert.doesNotMatch(rules, /<ID from the tree>/);
});

// R4: Firefox races (2026-10-18) opened a new tab in 12/12 Haiku runs and called nonexistent cua.listWindows/listBrowsers in 5.
// Engine-path browser sessions never see the Browsers section, so the navigation line sits outside it.
test('native sessions learn to navigate a browser outside the Browsers section', () => {
  for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }]) {
    const rules = skillRules(undefined, env);
    const outside = rules.replace(/## Browsers\n[\s\S]*?(?=\n## |$)/, '');
    assert.match(outside.replace(/\s+/g, ' '), /Browser app, new tabs too, one call: `await app\.setValue\(<address bar>, "<url>"\); await app\.pressKey\("Return"\)`\. `app\.pressKey` takes only the key string, never an element or `null`\./);
    assert.doesNotMatch(rules, /Safari|Firefox/);
  }
});

// Safari mdn r2 (race-1017) sent `app.pressKey(null, "Return")`: the null-first form is a tab handle's, and the line saying so
// named no handle.
test('the tab input line is scoped to tab handles', () => {
  for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }]) {
    const line = skillRules(undefined, env).split('\n').find(line => /^Tab(?:-handle)? input/.test(line));
    assert.match(line, /^Tab-handle input.*first argument.*element index or `null`/);
  }
});

// mdn (race-1017): Safari r3 spent 5.8 s on select_window for the window getApp had already returned, and Firefox r1 a
// getState and a listWindows call before getApp. getApp's window needs no selection; only another window does.
test('the skill sends only a window other than getApp\'s through select_window', () => {
  const rules = skillRules();
  assert.match(rules, /^- A window other than the one getApp shows: `select_window`\.$/m);
  assert.doesNotMatch(rules, /getApp's: `select_window`/);
  assert.doesNotMatch(rules, /Among windows/);
  // getApp comes first for a named app, and the select_window tool still verifies the header after selecting.
  assert.match(rules, /When the task specifies an app: `let app = await cua\.getApp/);
  assert.ok(localToolDefinitions({}).find(tool => tool.name === 'select_window').description.includes('verify its full Window/URL header before acting'));
});


test('INT6 merged default and lean safety wording stay pinned outside marked guidance', () => {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const source = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url), 'utf8')
    .replace(cookiePolicy + '\n\n', '');
  const start = source.indexOf(SCREENSHOT_GUIDANCE_START), end = source.indexOf(SCREENSHOT_GUIDANCE_END);
  assert.ok(start >= 0 && end > start);
  const restored = requestedSubmitRules(source.slice(0, start) + source.slice(end + SCREENSHOT_GUIDANCE_END.length + 2), { SLEIGHT_RS: '0' });
  assert.equal(hash(restored), 'b8c52d48b7c7cfdd30d246e4da40b7ecd25faa6ab60e20cc3e761d6336828cf8');
  assert.equal(hash(requestedSubmitRules(readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.lean.md', import.meta.url), 'utf8').replace(cookiePolicy + '\n\n', ''), { SLEIGHT_RS: '0', SLEIGHT_PROMPT: 'lean' })), 'c9de48f3d31259f6d78ee09a7c4d6ed539938e7c732b0f674bc70c6da70906cf');
});

test('both RS settings preserve the original submit safety passage and skill budgets byte for byte', () => {
  for (const [prompt, limit, hash] of [[undefined, 1066, '1f789417b86bf82beaf18bae9c45decb26476b9c93156fb49b7d4f07c51180d6'],
    ['lean', 519, '2d36c9efee11523e5ab38e59fad5ab19eeaa25adb363846e5c2808f2b1073147']]) {
    const env = { SLEIGHT_PROMPT: prompt };
    const on = skillRules(undefined, env), off = skillRules(undefined, { ...env, SLEIGHT_RS: '0' });
    assert.match(on, /Submit in that call only when the user asked(?: for that submit)? and the engine's confirmation policy\s+doesn't require confirming it\. Otherwise stop before the final click\./);
    assert.equal(on, off);
    assert.ok(on.trim().split(/\s+/).length <= limit);
    assert.equal(createHash('sha256').update(off).digest('hex'), hash);
    for (const value of [undefined, '1']) assert.equal(skillRules(undefined, { ...env, SLEIGHT_RS: value }), on);
    for (const value of ['0', '', 'off', 'false', '00', '2']) assert.equal(skillRules(undefined, { ...env, SLEIGHT_RS: value }), off);
    for (const value of [undefined, '0', '1']) assert.equal(skillRules(undefined, { ...env, SLEIGHT_RS: value, SLEIGHT_CONFIRM_PAYMENTS: 'always' }), off);
  }
});
