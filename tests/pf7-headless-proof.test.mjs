// Explicitly opted-in Chromium headless shell only. No installed browser, model,
// native host, screenshot, visible window or benchmark runner is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { snapshot, acknowledgeSnapshot, snapshotRefBinding } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';

const enabled = process.env.SLEIGHT_PF7_HEADLESS_TEST === '1';
const spec = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(b => b.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = enabled ? false : 'set SLEIGHT_PF7_HEADLESS_TEST=1 for the isolated offline proof';
const origin = 'http://127.0.0.1:1'; // Every request is fulfilled in memory, before network dispatch.

async function fixture(t, html) {
  assert.ok(existsSync(executablePath), 'pinned headless shell is required; no installed-browser fallback');
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); assert.equal(browser.isConnected(), false); t.diagnostic('PF7 cleanup: owned headless browser closed'); });
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto(origin + '/fixture');
  return { page, context };
}

function flags(t, values) {
  const prior = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

function delivered(state, capture) {
  if (!acknowledgeSnapshot(capture.page, capture.number)) return false;
  state.snapshotNo = capture.number;
  return true;
}

test('PF7 real full-observation replay removes exactly one capture and retains current refs', { skip }, async t => {
  flags(t, { SLEIGHT_FULL_OBSERVE_ONCE: '0' });
  const { page } = await fixture(t, '<main><label>Project<input></label><button type="button">Preview</button></main>');
  const records = [];
  for (const flag of ['0', '1']) {
    process.env.SLEIGHT_FULL_OBSERVE_ONCE = flag;
    await page.goto(origin + '/fixture?variant=' + flag);
    const first = await snapshot(page); acknowledgeSnapshot(page, first.number);
    const ref = /textbox "Project" \[ref=([^\]]+)\]/.exec(first.text)[1];
    const tab = { page, state: { snapshotNo: first.number }, tab: 'tfixture' };
    let captures = 0;
    const capture = async (...args) => { captures++; return snapshot(...args); };
    const runSteps = createActionRunner({ check: () => ({ verdict: 'allow' }), snapshot: capture });
    const d = createToolDispatcher({ pages: { enqueue: async (id, run) => run(tab), tab: () => tab, closedOpener: () => undefined },
      snapshot: capture, runSteps, fillFields: () => assert.fail('no fill'), siteMemory: null, deliverSnapshot: delivered });
    const start = performance.now();
    const result = await d.call({ name: 'browser_act', arguments: { tab: 'tfixture', steps: [{ do: 'type', ref, text: 'Proof' }], observe: 'full' } });
    const elapsed = performance.now() - start;
    assert.equal(result.isError, false); assert.match(result.text, /"Proof"/); assert.match(result.text, /Preview/);
    assert.equal(d.delivered(result), true);
    assert.doesNotThrow(() => snapshotRefBinding(page, ref));
    assert.equal(await page.locator('input').inputValue(), 'Proof');
    assert.equal(captures, flag === '1' ? 1 : 2);
    records.push({ flag, captures, ms: +elapsed.toFixed(3), bytes: Buffer.byteLength(result.text) });
  }
  t.diagnostic('PF7 full observation ' + JSON.stringify(records));
});

test('PF7 popup result includes a protected child snapshot and keeps its refs scoped', { skip }, async t => {
  flags(t, { SLEIGHT_POPUP_OBSERVE: '1' });
  const { page, context } = await fixture(t, '<main><button type="button">Open details</button></main>');
  const childPage = await context.newPage();
  await childPage.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
    '<main><h1>Delivery choices</h1><p>Economy: 4 days. Express: 1 day.</p><label>Password<input type="password" value="offline-child-secret"></label><button type="button">Done</button></main>' }));
  await childPage.goto(origin + '/details');
  const first = await snapshot(page); acknowledgeSnapshot(page, first.number);
  const parent = { page, state: { snapshotNo: first.number, submitUnconfirmed: { snapshotNo: first.number } }, popups: [], tab: 'tparent' };
  const child = { page: childPage, state: { snapshotNo: 0 }, opener: 'tparent', tab: 'tchild' };
  const entries = new Map([['tparent', parent], ['tchild', child]]);
  // Replay the trusted registry boundary from a recorded click. Ownership admission
  // and background window creation are outside this test; neither is imitated by page text.
  const d = createToolDispatcher({ pages: { tab: id => entries.get(id), enqueue: async (id, run) => run(entries.get(id)), closedOpener: () => undefined },
    snapshot, fillFields: () => assert.fail('no fill'), siteMemory: null, deliverSnapshot: delivered,
    runSteps: async () => { parent.popups.push({ tab: 'tchild' }); const observed = await snapshot(page, { since: first.number });
      return { lines: ['1 click: opened background tab tchild; opener below', '2 wait: not reached'], stoppedAt: 1,
        observe: { ...observed, capturedAt: Date.now() } }; },
  });
  const result = await d.call({ name: 'browser_act', arguments: { tab: 'tparent', steps: [{ do: 'click', ref: 'e1' }, { do: 'wait', ms: 1000 }] } });
  assert.match(result.text, /New tab tchild/); assert.match(result.text, /Express: 1 day/); assert.match(result.text, /\[redacted\]/);
  assert.doesNotMatch(result.text, /offline-child-secret/);
  const done = /button "Done" \[ref=([^\]]+)\]/.exec(result.text)[1];
  assert.throws(() => snapshotRefBinding(childPage, done), /not delivered|stale/);
  assert.equal(d.delivered(result), true);
  assert.doesNotThrow(() => snapshotRefBinding(childPage, done));
  assert.ok(parent.state.submitUnconfirmed);
  t.diagnostic('PF7 popup proof ' + JSON.stringify({ callsWithSeparateRead: 2, callsWithObservation: 1, bytes: Buffer.byteLength(result.text), childSnapshot: child.state.snapshotNo }));
});

test('PF7 one fill handles independent fields and a delayed autocomplete last', { skip }, async t => {
  const { page } = await fixture(t, `<main><label>Project<input id="project"></label><label>Owner<input id="owner"></label>
    <label>Destination<input id="destination" role="combobox" aria-controls="choices" aria-expanded="false"></label><ul id="choices" role="listbox"></ul>
    <script>destination.addEventListener('input', () => { choices.replaceChildren(); destination.setAttribute('aria-expanded','true');
      setTimeout(() => { const item = document.createElement('li'); item.role='option'; item.textContent='Cedar Point, Zone 7';
        item.onclick=()=>{destination.value=item.textContent; choices.replaceChildren(); destination.setAttribute('aria-expanded','false');}; choices.append(item); }, 80); });</script></main>`);
  const first = await snapshot(page); acknowledgeSnapshot(page, first.number);
  const names = ['Project', 'Owner', 'Destination'];
  const refs = names.map(name => new RegExp('(?:textbox|combobox) "'+name+'" \\[ref=([^\\]]+)\\]').exec(first.text)[1]);
  const tab = { page, state: { snapshotNo: first.number } };
  const fill = createFillFields({ check: () => 'allow', runSteps: () => assert.fail('ordinary fields need no action replay') });
  const result = await fill(tab, refs.map((ref, i) => ({ ref, value: ['Cedar', 'Fixture Owner', 'Cedar Point, Zone 7'][i] })), {}, {});
  assert.deepEqual(result.rows.map(row => row.status), ['set', 'set', 'set'], JSON.stringify(result));
  assert.deepEqual(await page.locator('input').evaluateAll(nodes => nodes.map(n => n.value)), ['Cedar', 'Fixture Owner', 'Cedar Point, Zone 7']);
  t.diagnostic('PF7 form proof ' + JSON.stringify({ fillCalls: 1, fieldsSet: 3, autocompleteDelayMs: 80, modelBehaviorTested: false }));
});

test('PF7 observed listbox fill replaces a model scroll/read loop on a held-out virtual list', { skip }, async t => {
  const { page } = await fixture(t, `<main><div role="listbox" aria-label="Delivery depot" id="depots" style="height:100px;overflow:auto">
    <div id="items" style="height:10000px;position:relative"></div></div><output id="chosen"></output>
    <script>function paint() { items.replaceChildren(); const start=Math.floor(depots.scrollTop/25);
      for(let i=start;i<Math.min(start+5,400);i++){const row=document.createElement('div'); row.role='option';
        row.textContent='Depot '+String(i).padStart(3,'0'); row.style='position:absolute;top:'+i*25+'px;height:25px';
        row.onclick=()=>{chosen.textContent=row.textContent;row.setAttribute('aria-selected','true');}; items.append(row);}}
      depots.addEventListener('scroll',paint); paint();</script></main>`);
  const first = await snapshot(page); acknowledgeSnapshot(page, first.number);
  assert.doesNotMatch(first.text, /Depot 317/);
  const ref = /listbox "Delivery depot" \[ref=([^\]]+)\]/.exec(first.text)[1];
  const fill = createFillFields({ check: () => 'allow', runSteps: () => assert.fail('listbox search uses its existing guarded strategy') });
  const result = await fill({ page, state: { snapshotNo: first.number } }, [{ ref, value: 'Depot 317' }], {}, {});
  assert.equal(result.rows[0].status, 'set', JSON.stringify(result));
  assert.equal(await page.locator('output').textContent(), 'Depot 317');
  t.diagnostic('PF7 listbox proof ' + JSON.stringify({ fillCalls: 1, totalOptions: 400, renderedOptions: 5, targetInitiallyObserved: false, containerObserved: true }));
});
