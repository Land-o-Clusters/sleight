import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fillForm, fillFormCode } from '../plugins/sleight/lib/fill-form.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function fixture(specs) {
  const calls = [];
  const controls = Object.fromEntries(Object.entries(specs).map(([name, spec]) => {
    const el = { tagName: 'INPUT', type: 'text', value: '', checked: false,
      getAttribute: key => spec[key] ?? null, ...spec };
    const loc = {
      count: async () => spec.count ?? 1,
      evaluate: async (fn, arg) => fn(new Proxy(el, {
        get(target, key) { return spec.isolated && key === 'checked' ? false : target[key]; },
        set() { throw Error('page evaluation must only read'); },
      }), arg),
      fill: async value => { calls.push([name, 'fill', value]); if (spec.fillError) throw Error(spec.fillError); el.value = value; },
      type: async value => { calls.push([name, 'type', value]); el.value = value; },
      press: async key => {
        calls.push([name, 'press', key]);
        if (key === 'Home') el.value = spec.min ?? 0;
        if (key === 'ArrowRight') el.value = Number(el.value) + Number(spec.step ?? 1);
      },
      setChecked: async value => { calls.push([name, 'check', value]); if (spec.checkError) throw Error(spec.checkError); el.checked = value; },
      click: async () => { calls.push([name, 'click']); el.checked = !el.checked; },
      selectOption: async value => { calls.push([name, 'select', value]); if (spec.labelError && value.label) throw Error('no option label'); },
    };
    return [name, new Proxy(loc, { get(target, key) {
      if (!(key in target)) throw Error('unsupported engine locator method: ' + String(key));
      return target[key];
    } })];
  }));
  const tab = { playwright: { getByLabel: name => controls[name], locator: name => controls[name] },
    getAXState: async () => 'Browser tab: 1, Title: "Form", URL: "https://example.com".\n0 AXWebArea Form\n\t1 text field Description: Name, ID: name\n\t2 checkbox Description: Terms' };
  return { tab, controls, calls };
}

test('fills text, checkbox, radio, select, slider and switch in field order', async () => {
  const h = fixture({ Name: {}, Terms: { type: 'checkbox' }, Choice: { type: 'radio' },
    Country: { tagName: 'SELECT' }, Amount: { type: 'range', min: '0', max: '10', step: '2' },
    Alerts: { role: 'switch', 'aria-checked': 'false' } });
  const out = await fillForm(h.tab, [
    { label: 'Name', value: 'Ada' }, { label: 'Terms', value: true }, { label: 'Choice', value: true },
    { label: 'Country', value: 'UK' }, { label: 'Amount', value: 4 }, { label: 'Alerts', value: false },
  ]);
  assert.match(out, /^Filled 6 of 6 fields\./);
  assert.deepEqual(h.calls, [['Name', 'fill', 'Ada'], ['Terms', 'check', true], ['Choice', 'check', true],
    ['Country', 'select', { label: 'UK' }], ['Amount', 'press', 'Home'], ['Amount', 'press', 'ArrowRight'],
    ['Amount', 'press', 'ArrowRight'], ['Alerts', 'check', false]]);
});

test('resolves indices by current IDs or labels and accepts locator strings and objects', async () => {
  const h = fixture({ '[id="name"]': {}, Terms: { type: 'checkbox' }, '#note': {}, extra: {} });
  const out = await fillForm(h.tab, [{ index: 1, value: 'Ada' }, { index: 2, value: true },
    { locator: '#note', value: 'text' }, { locator: h.controls.extra, value: 'more' }]);
  assert.match(out, /^Filled 4 of 4 fields\./);
  assert.deepEqual(h.calls.map(call => call[0]), ['[id="name"]', 'Terms', '#note', 'extra']);
});

test('fallbacks replace text, select by value and verify checkbox state before toggling', async () => {
  const h = fixture({ Name: { fillError: 'use typing' }, Country: { tagName: 'SELECT', labelError: true },
    Terms: { type: 'checkbox', checkError: 'custom check' } });
  const out = await fillForm(h.tab, [{ label: 'Name', value: 'Ada' }, { label: 'Country', value: 'uk' }, { label: 'Terms', value: true }]);
  assert.match(out, /^Filled 3 of 3 fields\./);
  assert.ok(h.calls.some(call => call[1] === 'type'));
  assert.ok(h.calls.some(call => call[1] === 'select' && call[2].value === 'uk'));
  assert.equal(h.calls.filter(call => call[1] === 'click').length, 1);
  assert.match(out, /fallback/);
});

test('reports individual failures and continues without submitting or mutating page JavaScript', async () => {
  const h = fixture({ Ambiguous: { count: 2 }, Bad: { type: 'range', min: '0', max: '10000' }, Name: {}, Terms: { type: 'checkbox' } });
  const out = await fillForm(h.tab, [{ label: 'Ambiguous', value: 'x' }, { label: 'Bad', value: 1000 },
    { label: 'Terms', value: 'maybe' }, { index: 99, value: 'x' }, { label: 'Name', value: 'Ada' }]);
  assert.match(out, /^Filled 1 of 5 fields\./);
  for (const field of ['Ambiguous', 'Bad', 'Terms', '99']) assert.ok(out.includes(field));
  assert.deepEqual(h.calls, [['Name', 'fill', 'Ada']]);
});

test('rejects buttons and invalid values, and never toggles an already-correct fallback checkbox', async () => {
  const h = fixture({ Submit: { type: 'submit' }, Name: {}, Terms: { type: 'checkbox', checked: true, checkError: 'already sent' } });
  const out = await fillForm(h.tab, [{ label: 'Submit', value: 'send' }, { label: 'Name', value: {} }, { label: 'Terms', value: true }]);
  assert.match(out, /^Filled 1 of 3 fields\./);
  assert.deepEqual(h.calls, [['Terms', 'check', true]]);
});

test('a custom combobox uses an exact option locator after the fill fallback', async () => {
  const h = fixture({ Country: { tagName: 'DIV', role: 'combobox', fillError: 'not editable' }, UK: {} });
  h.tab.playwright.getByRole = (role, options) => {
    assert.equal(role, 'option'); assert.deepEqual(options, { name: 'UK', exact: true });
    return h.controls.UK;
  };
  assert.match(await fillForm(h.tab, [{ label: 'Country', value: 'UK' }]), /^Filled 1 of 1 fields\./);
  assert.deepEqual(h.calls, [['Country', 'fill', 'UK'], ['Country', 'click'], ['UK', 'click']]);
});

test('a custom host with only the engine default checked property is unverifiable without input', async () => {
  const h = fixture({
    TwoFactor: { tagName: 'FB-SECURE-SWITCH', type: undefined, isolated: true, checkError: 'not a checkbox' },
    Name: {},
  });
  for (const value of [true, false]) {
    h.calls.length = 0;
    const out = await fillForm(h.tab, [{ label: 'TwoFactor', value }, { label: 'Name', value: 'Ada' }]);
    assert.match(out, /^Filled 1 of 2 fields\./);
    assert.match(out, /TwoFactor\) unverifiable:/);
    assert.match(out, /screenshot of it\. Click once only if it shows the other state\. Never click again to verify/);
    assert.doesNotMatch(out, /TwoFactor\) failed|Input may have been sent/);
    assert.deepEqual(h.calls, [['Name', 'fill', 'Ada']]);
  }
});

test('a custom host with reflected pressed state can be verified in a fresh injection realm', async () => {
  const h = fixture({ Toggle: { tagName: 'CUSTOM-TOGGLE', type: undefined, 'aria-pressed': 'true',
    checked: false, checkError: 'not a checkbox' } });
  const context = createContext({ tab: h.tab });
  const out = await runInContext('(async () => {' + fillFormCode('return await sleight.fillForm(tab, [{label:"Toggle",value:true}])') + '})()', context);
  assert.equal(out, 'Filled 1 of 1 fields.\nField 1 (Toggle): checked state verified after fallback.');
  assert.deepEqual(h.calls, [['Toggle', 'check', true]]);
});

test('a custom host with reflected checked state takes the check path rather than text fill', async () => {
  const h = fixture({ Toggle: { tagName: 'CUSTOM-TOGGLE', type: undefined, 'aria-checked': 'true',
    checked: false, checkError: 'not a checkbox' } });
  assert.match(await fillForm(h.tab, [{ label: 'Toggle', value: true }]), /^Filled 1 of 1 fields\./);
  assert.deepEqual(h.calls, [['Toggle', 'check', true]]);
});

test('a custom control already in the AX state requested gets no input', async () => {
  const h = fixture({ Toggle: { tagName: 'CUSTOM-TOGGLE', id: 'toggle', role: 'switch', isolated: true } });
  h.tab.getAXState = async () => 'Browser tab: 1, Title: "Form", URL: "https://example.com".\n0 AXWebArea Form\n\t3 switch Description: Toggle, Value: 1, ID: toggle';
  assert.match(await fillForm(h.tab, [{ label: 'Toggle', value: true }]), /^Filled 1 of 1 fields\./);
  assert.deepEqual(h.calls, []);
});

// The engine's setChecked reads the isolated default (false), so it would call an on switch already off.
test('a verified custom control set to false takes one click and is read back, never engine setChecked', async () => {
  const h = fixture({ Toggle: { tagName: 'CUSTOM-TOGGLE', id: 'toggle', role: 'switch', isolated: true } });
  let on = true;
  const click = h.controls.Toggle.click;
  h.tab.playwright.getByLabel = () => new Proxy(h.controls.Toggle, { get(target, key) {
    return key === 'click' ? async options => { on = !on; return click(options); } : target[key];
  } });
  h.tab.getAXState = async () => `\t3 switch Description: Toggle, Value: ${on ? 1 : 0}, ID: toggle`;
  assert.match(await fillForm(h.tab, [{ label: 'Toggle', value: false }]), /^Filled 1 of 1 fields\./);
  assert.deepEqual(h.calls, [['Toggle', 'click']]);
  assert.equal(on, false);
});

test('a custom control unreadable after its one click is unverifiable and says the click was sent', async () => {
  const h = fixture({ Toggle: { tagName: 'CUSTOM-TOGGLE', id: 'toggle', role: 'switch', isolated: true,
    checkError: 'not a checkbox' } });
  let reads = 0;
  h.tab.getAXState = async () => ++reads === 1 ? '\t3 switch Description: Toggle, Value: 0, ID: toggle' : '';
  const out = await fillForm(h.tab, [{ label: 'Toggle', value: true }]);
  assert.match(out, /Toggle\) unverifiable: One click was sent\. Read the control's state from a screenshot/);
  assert.doesNotMatch(out, /failed:/);
  assert.deepEqual(h.calls, [['Toggle', 'click']]);
});

test('a read-only picker reports its UI path without typing and continues other fields', async () => {
  const h = fixture({ Dates: { readOnly: true, 'aria-haspopup': 'dialog' }, Name: {} });
  const out = await fillForm(h.tab, [{ label: 'Dates', value: 'Dec 14 2026' }, { label: 'Name', value: 'Ada' }]);
  assert.match(out, /^Filled 1 of 2 fields\./);
  assert.match(out, /read-only.*locator\.click\(\).*picker/);
  assert.deepEqual(h.calls, [['Name', 'fill', 'Ada']]);
});

test('an ARIA switch uses aria-checked before the engine default checked property', async () => {
  const h = fixture({ Alerts: { tagName: 'BUTTON', role: 'switch', 'aria-checked': 'true',
    checked: false, checkError: 'not a checkbox' } });
  const out = await fillForm(h.tab, [{ label: 'Alerts', value: true }]);
  assert.match(out, /^Filled 1 of 1 fields\./);
  assert.deepEqual(h.calls, [['Alerts', 'check', true]]);
});

test('the injected helper refuses read-only text and keeps ARIA check state in its own scope', async () => {
  const h = fixture({ Dates: { readOnly: true }, Alerts: { tagName: 'BUTTON', role: 'switch',
    'aria-checked': 'true', checked: false, checkError: 'not a checkbox' } });
  const context = createContext({ tab: h.tab });
  const out = await runInContext('(async () => {' + fillFormCode('return await sleight.fillForm(tab, [{label:"Dates",value:"x"},{label:"Alerts",value:true}])') + '})()', context);
  assert.match(out, /^Filled 1 of 2 fields\./);
  assert.deepEqual(h.calls, [['Alerts', 'check', true]]);
});

test('the injected helper runs in a fresh realm and is hooked into browser calls', async t => {
  const h = fixture({ Name: {} });
  const context = createContext({ tab: h.tab });
  const value = await runInContext('(async () => {' + fillFormCode('return await sleight.fillForm(tab, [{ label: "Name", value: "Ada" }])') + '})()', context);
  assert.match(value, /^Filled 1 of 1 fields\./);
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [];
  serverIn.on('data', chunk => sent.push(JSON.parse(chunk.toString())));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => relay.close());
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'js', arguments: { code: 'nodeRepl.write(await sleight.fillForm(tab, [{label:"Name", value:"Ada"}]))' } } }) + '\n');
  assert.match(sent[0].params.arguments.code, /globalThis\.sleight/);
});

function groupedSelect({ mismatch = false } = {}) {
  // Languages and groups from FowlBrowser test/forms/site/settings.html:45-48.
  const groups = { Europe: [['en-GB', 'English (UK)'], ['de', 'German'], ['fr', 'French'], ['pt-PT', 'Portuguese (Portugal)'], ['es', 'Spanish (Spain)']],
    Americas: [['en-US', 'English (US)'], ['pt-BR', 'Portuguese (Brazil)'], ['es-MX', 'Spanish (Mexico)'], ['fr-CA', 'French (Canada)']],
    Asia: [['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['hi', 'Hindi']] };
  const options = Object.entries(groups).flatMap(([group, rows]) => rows.map(([value, label]) => ({ group, value, label, selected: value === 'en-GB' })));
  const calls = [], element = { tagName: 'SELECT', type: 'select-multiple', multiple: true,
    getAttribute: () => null, get selectedOptions() { return options.filter(option => option.selected); } };
  const loc = { count: async () => 1,
    evaluate: async (fn, arg) => { calls.push(['read']); return fn(new Proxy(element, { set() { throw Error('read-only'); } }), arg); },
    selectOption: async (input, config) => {
      assert.deepEqual(config, { timeoutMs: 1000 });
      calls.push(['select', input]);
      const wanted = Array.isArray(input) ? input : [input];
      const matches = wanted.map(descriptor => options.find(option => descriptor.label !== undefined ? option.label === descriptor.label : option.value === descriptor.value));
      if (matches.some(option => !option)) throw Error('option missing');
      if (!mismatch) options.forEach(option => { option.selected = matches.includes(option); });
    } };
  return { tab: { playwright: { getByLabel: () => loc } }, calls, options };
}

test('a grouped multi-select accepts labels across groups and verifies selectedOptions', async () => {
  const h = groupedSelect();
  const out = await fillForm(h.tab, [{ label: 'Languages', value: ['French (Canada)', 'Korean'] }]);
  assert.equal(out, 'Filled 1 of 1 fields.');
  assert.deepEqual(h.calls, [['read'], ['select', [{ label: 'French (Canada)' }, { label: 'Korean' }]], ['read']]);
  assert.deepEqual(h.options.filter(option => option.selected).map(option => option.value), ['fr-CA', 'ko']);
});

test('multi-select values fall back together and a scalar replaces the selection with one option', async () => {
  const h = groupedSelect();
  assert.match(await fillForm(h.tab, [{ label: 'Languages', value: ['fr-CA', 'ko'] }]), /^Filled 1 of 1 fields\./);
  assert.deepEqual(h.calls.filter(call => call[0] === 'select'), [
    ['select', [{ label: 'fr-CA' }, { label: 'ko' }]], ['select', [{ value: 'fr-CA' }, { value: 'ko' }]],
  ]);
  assert.match(await fillForm(h.tab, [{ label: 'Languages', value: 'French' }]), /^Filled 1 of 1 fields\./);
  assert.deepEqual(h.options.filter(option => option.selected).map(option => option.value), ['fr']);
});

test('an empty multi-select array clears it and duplicate requested labels count once', async () => {
  const h = groupedSelect();
  assert.equal(await fillForm(h.tab, [{ label: 'Languages', value: [] }]), 'Filled 1 of 1 fields.');
  assert.equal(h.options.filter(option => option.selected).length, 0);
  assert.equal(await fillForm(h.tab, [{ label: 'Languages', value: ['Korean', 'Korean'] }]), 'Filled 1 of 1 fields.');
  assert.equal(h.options.filter(option => option.selected).length, 1);
});

test('multi-select readback mismatch is a field failure and never claims the selection succeeded', async () => {
  const h = groupedSelect({ mismatch: true });
  const out = await fillForm(h.tab, [{ label: 'Languages', value: ['French (Canada)', 'Korean'] }]);
  assert.match(out, /^Filled 0 of 1 fields\./);
  assert.match(out, /selected options did not match/);
  assert.match(out, /Input may have been sent/);
});

test('duplicate selected labels cannot stand in for a different requested label', async () => {
  const h = groupedSelect({ mismatch: true });
  h.options.forEach(option => { option.selected = option.value === 'ko'; });
  h.options.push({ group: 'Other', label: 'Korean', value: 'other-ko', selected: true });
  const out = await fillForm(h.tab, [{ label: 'Languages', value: ['Korean', 'French'] }]);
  assert.match(out, /^Filled 0 of 1 fields\./);
  assert.match(out, /selected options did not match/);
});

test('arrays are rejected on other controls and non-string array entries send no input', async () => {
  const h = fixture({ Name: {}, Country: { tagName: 'SELECT' } });
  const out = await fillForm(h.tab, [{ label: 'Name', value: ['Ada'] }, { label: 'Country', value: ['UK'] }, { label: 'Name', value: 'Ada' }]);
  assert.match(out, /^Filled 1 of 3 fields\./);
  assert.deepEqual(h.calls, [['Name', 'fill', 'Ada']]);
  const multi = groupedSelect();
  assert.match(await fillForm(multi.tab, [{ label: 'Languages', value: ['French', 2] }]), /^Filled 0 of 1 fields\./);
  assert.equal(multi.calls.filter(call => call[0] === 'select').length, 0);
});

const playwrightModule = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
const formsSite = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/test/forms/site');

test('real fixture forms preserve read-only dates and already-on ARIA switches', {
  skip: !existsSync(playwrightModule) ? 'playwright-core is not installed' :
    !existsSync(join(formsSite, 'travel.html')) ? 'FowlBrowser fixture forms are not installed' :
      process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'live browser test is reserved for sleight-arch; set SLEIGHT_LIVE_DOM_TEST=1',
}, async t => {
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const server = createServer((req, res) => {
    const file = join(formsSite, (req.url ?? '/').replace(/\?.*$/, ''));
    if (!file.startsWith(formsSite + '/') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'text/plain' });
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const executablePath = [1234, 1228].map(version => join(homedir(),
    `Library/Caches/ms-playwright/chromium_headless_shell-${version}/chrome-headless-shell-mac-arm64/chrome-headless-shell`))
    .find(path => existsSync(path));
  if (!executablePath) { t.skip('headless Chromium is not installed'); return; }
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // Only the engine locator methods fillForm uses are exposed. Playwright's timeout name
  // is adapted here; unsupported methods throw rather than inheriting Playwright's extras.
  const loc = selector => {
    const target = page.locator(selector);
    const api = { count: () => target.count(), evaluate: (fn, arg) => target.evaluate(fn, arg),
      fill: (value, options) => target.fill(value, { timeout: options.timeoutMs }),
      setChecked: (value, options) => target.setChecked(value, { timeout: options.timeoutMs }),
      click: options => target.click({ timeout: options.timeoutMs }) };
    return new Proxy(api, { get(target, key) {
      if (!(key in target)) throw Error('unsupported engine locator method: ' + String(key));
      return target[key];
    } });
  };
  const tab = { playwright: { locator: loc } }, origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin + '/travel.html');
  const dates = await fillForm(tab, [{ locator: '#dates', value: 'Dec 14 2026' }]);
  assert.match(dates, /^Filled 0 of 1 fields\./);
  assert.match(dates, /read-only.*locator\.click\(\)/);
  assert.equal(await page.locator('#dates').inputValue(), '');
  await page.goto(origin + '/settings.html');
  const alerts = await fillForm(tab, [{ locator: '#emailAlerts button', value: true }]);
  assert.match(alerts, /^Filled 1 of 1 fields\./);
  assert.equal(await page.locator('#emailAlerts button').getAttribute('aria-checked'), 'true');
});
