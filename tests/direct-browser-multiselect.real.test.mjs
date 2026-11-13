import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';
import { createActionRunner, inspectTarget } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { snapshot, acknowledgeSnapshot, snapshotRefBinding } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';

async function setup(t, html, observeTabs = false) {
  const f = await fixture(t, html, {}, { observeTabs }), { page } = f.entry;
  await page.waitForLoadState('load');
  const runSteps = createActionRunner({ check: () => 'allow', snapshot, backgroundClick });
  const fill = createFillFields({ check: () => 'allow', runSteps, inspectElement: inspectTarget });
  const ref = async selector => {
    // Deliver public refs as the worker does. A private locator snapshot neither
    // acknowledges delivery nor preserves the full page's latest ref listing.
    const read = await snapshot(page);
    assert.equal(acknowledgeSnapshot(page, read.number), true);
    for (const [, ref] of read.text.matchAll(/\[ref=(e\d+)\]/g)) {
      if (await snapshotRefBinding(page, ref).evaluate((el, selector) => el.matches(selector), selector)) return ref;
    }
    assert.fail('No observed ref for ' + selector + ':\n' + read.text);
  };
  return { ...f, page, ref, runSteps, fill: async (selector, value) => fill(f.entry, [{ ref: await ref(selector), value }], {}, {}) };
}

const settings = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/test/forms/site/settings.html');
test('real settings Languages multi-select replaces prior choices, emits page events and clears', {
  skip: skip || (!existsSync(settings) && 'read-only settings fixture is unavailable'), timeout: 30000,
}, async t => {
  const source = readFileSync(settings, 'utf8'), control = source.match(/<select id="languages" multiple>[\s\S]*?<\/select>/)?.[0];
  assert.ok(control, 'settings Languages control');
  const f = await setup(t, '<label for="languages">Languages</label>' + control + `<script>
    window.events=[];
    for(const type of ['input','change']) languages.addEventListener(type,e=>events.push([e.type,[...languages.selectedOptions].map(o=>o.value)]));
    languages.options[0].selected=true;
  </script>`);
  const result = await f.fill('#languages', ['Portuguese (Brazil)', 'Japanese']);
  assert.equal(result.rows[0].status, 'set', JSON.stringify(result));
  assert.deepEqual(await f.page.locator('#languages').evaluate(el => [...el.selectedOptions].map(o => o.value)), ['pt-BR', 'ja']);
  assert.deepEqual(await f.page.evaluate(() => events), [['input', ['pt-BR', 'ja']], ['change', ['pt-BR', 'ja']]]);
  assert.equal((await f.fill('#languages', [])).rows[0].status, 'set');
  assert.deepEqual(await f.page.locator('#languages').evaluate(el => [...el.selectedOptions]), []);
  assert.deepEqual((await f.page.evaluate(() => events)).slice(-2), [['input', []], ['change', []]]);
});

const aria = `<div role="listbox" aria-label="Languages" aria-multiselectable="true" id="languages">
  <div role="option" aria-selected="true">English</div>
  <div role="option" aria-selected="true">Portuguese (Brazil)</div>
  <div role="option" aria-selected="false">Japanese</div>
</div><script>
window.selections=[]; window.clicks=[]; window.retainedClicks=[]; window.contextClicks=0;
languages.addEventListener('contextmenu',()=>contextClicks++);
languages.addEventListener('click',event=>{
  const row=event.target.closest('[role="option"]'); if(!row)return;
  retainedClicks.push(event);
  clicks.push({button:event.button,ctrlKey:event.ctrlKey,metaKey:event.metaKey,trusted:event.isTrusted,
    controlState:event.getModifierState('Control'),metaState:event.getModifierState('Meta')});
  if(!event.metaKey&&!event.ctrlKey) for(const other of languages.children)other.setAttribute('aria-selected','false');
  row.setAttribute('aria-selected',String(row.getAttribute('aria-selected')!=='true'));
  selections.push([...languages.children].filter(o=>o.getAttribute('aria-selected')==='true').map(o=>o.textContent));
});
</script>`;
const selected = page => page.locator('#languages').evaluate(el => [...el.children].filter(o => o.getAttribute('aria-selected') === 'true').map(o => o.textContent));

test('real ARIA multi-select updates page-owned selection and clears through modifier clicks', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, aria);
  const result = await f.fill('#languages', ['Portuguese (Brazil)', 'Japanese']);
  assert.equal(result.rows[0].status, 'set', JSON.stringify(result));
  assert.deepEqual(await selected(f.page), ['Portuguese (Brazil)', 'Japanese']);
  assert.equal((await f.fill('#languages', [])).rows[0].status, 'set');
  assert.deepEqual(await selected(f.page), []);
  assert.equal((await f.page.evaluate(() => selections)).length, 4);
});

test('real browser_act exposes its requested command modifier through the background hook', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, aria);
  const result = await f.runSteps(f.entry, [{ do: 'click', ref: await f.ref('[role="option"]:last-child'), modifier: 'cmd' }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.deepEqual(await selected(f.page), ['English', 'Portuguese (Brazil)', 'Japanese']);
});

for (const modifier of ['cmd', 'ctrl']) test(`real browser_act ${modifier} toggles an ARIA option without opening or activating a tab`, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, aria, true), before = await f.tabState(), pages = f.context.pages().length;
  const result = await f.runSteps(f.entry, [{ do: 'click', ref: await f.ref('[role="option"]:last-child'), modifier }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.deepEqual(await selected(f.page), ['English', 'Portuguese (Brazil)', 'Japanese']);
  const expected = [{ button: 0, ctrlKey: modifier === 'ctrl', metaKey: modifier === 'cmd', trusted: true,
    controlState: modifier === 'ctrl', metaState: modifier === 'cmd' }];
  assert.deepEqual(await f.page.evaluate(() => clicks), expected);
  assert.deepEqual(await f.page.evaluate(() => retainedClicks.map(event => ({button:event.button,ctrlKey:event.ctrlKey,
    metaKey:event.metaKey,trusted:event.isTrusted,controlState:event.getModifierState('Control'),metaState:event.getModifierState('Meta')}))), expected);
  assert.equal(await f.page.evaluate(() => contextClicks), 0);
  assert.equal(f.context.pages().length, pages);
  assert.deepEqual((await f.tabState()).filter(tab => tab.active).map(tab => tab.id), before.filter(tab => tab.active).map(tab => tab.id));
});

const refusedTargets = [
  ['submit', '<form><button id="target">Submit</button></form>', 'cmd'],
  ['submit label', '<form><button id="submit">Submit</button><label id="target" for="submit">Forward</label></form>', 'ctrl'],
  ['Shift submit', '<form><button id="target">Submit</button></form>', 'shift'],
  ['Shift window.open', '<div id="target" onclick="window.open(\'/landed\')">Open</div>', 'shift'],
  ['window.open', '<div id="target" onclick="window.open(\'/landed\')">Open</div>', 'cmd'],
  ['registered window.open', '<div id="target">Open</div><script>target.addEventListener("click",()=>window.open("/landed"))</script>', 'ctrl'],
  ['descendant link', '<div id="target"><a href="/landed">Link</a></div>', 'cmd'],
  ['ancestor link', '<a href="/landed"><span id="target">Link</span></a>', 'ctrl'],
  ['descendant control', '<div id="target"><button>Button</button></div>', 'cmd'],
  ['ancestor control', '<button><span id="target">Button</span></button>', 'ctrl'],
];
for (const [name, html, modifier] of refusedTargets) test('real modified click refuses ' + name + ' without a popup or tab activation', { skip, timeout: 30000 }, async t => {
  // Custom targets need an accessible role and name to survive the AI snapshot's
  // generic-node folding. Keep the native label/link/control ancestry under test.
  const observed = html.replace(/<(div|span|label) id="target"/, '<$1 role="option" aria-label="Target" id="target"');
  const f = await setup(t, observed, true), before = await f.tabState(), pages = f.context.pages().length;
  let popups = 0; f.page.on('popup', () => popups++);
  const steps = [{ do: 'click', ref: await f.ref('#target'), modifier }];
  if (modifier === 'shift') await assert.rejects(f.runSteps(f.entry, steps, {}), /modifier/);
  else assert.match((await f.runSteps(f.entry, steps, {})).lines[0], /not run: modified clicks require Command or Control/);
  assert.equal(popups, 0); assert.equal(f.context.pages().length, pages);
  assert.deepEqual((await f.tabState()).filter(tab => tab.active).map(tab => tab.id), before.filter(tab => tab.active).map(tab => tab.id));
});

for (const child of ['<a href="/landed">Japanese</a>', '<button>Japanese</button>'])
  test('real ARIA fill refuses an option containing ' + child, { skip, timeout: 30000 }, async t => {
    const f = await setup(t, aria.replace('aria-selected="false">Japanese', 'aria-selected="false">' + child), true);
    const before = await f.tabState(), pages = f.context.pages().length;
    const result = await f.fill('#languages', ['English', 'Portuguese (Brazil)', 'Japanese']);
    assert.equal(result.rows[0].status, 'failed');
    assert.deepEqual(await selected(f.page), ['English', 'Portuguese (Brazil)']);
    assert.equal(f.context.pages().length, pages);
    assert.deepEqual((await f.tabState()).filter(tab => tab.active).map(tab => tab.id), before.filter(tab => tab.active).map(tab => tab.id));
  });

for (const modifier of ['cmd', 'ctrl', 'fill']) test('real modified option refuses persistent card-frame focus: ' + modifier, { skip, timeout: 30000 }, async t => {
  const f = await setup(t, '<iframe id="card" srcdoc="<input>"></iframe>' + aria, true);
  const ref = await f.ref('[role="option"]:last-child'), before = await f.tabState();
  await f.page.evaluate(() => {
    window.inputs = 0;
    for (const event of ['keydown', 'pointerdown', 'click']) window.addEventListener(event, () => inputs++);
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document.getElementById('card') });
  });
  if (modifier === 'fill') assert.equal((await f.fill('#languages', ['English', 'Portuguese (Brazil)', 'Japanese'])).rows[0].status, 'failed');
  else assert.match((await f.runSteps(f.entry, [{ do: 'click', ref, modifier }], {})).lines[0], /focus is held inside a frame/);
  assert.equal(await f.page.evaluate(() => inputs), 0);
  assert.deepEqual(await selected(f.page), ['English', 'Portuguese (Brazil)']);
  assert.deepEqual((await f.tabState()).filter(tab => tab.active).map(tab => tab.id), before.filter(tab => tab.active).map(tab => tab.id));
});
