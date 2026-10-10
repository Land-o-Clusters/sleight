import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FlowRules, loadFlowRules } from '../plugins/sleight/lib/flow-rules.mjs';

const pattern = { id: 'ssns', kind: 'pattern', pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b', destinations: ['*'], except: ['1Password'] };
const source = { id: 'contacts-mail', kind: 'source', sources: ['Contacts'], destinations: ['Mail'] };
const rules = (...entries) => new FlowRules({ version: 1, rules: entries });
const analyze = (flow, code, app = 'Mail') => flow.analyze('js', { code }, { app });
const result = (app, text, appId) => ({ content: [{ type: 'text', text: `Window: "Test", App: ${app}\n0 standard window Test\n1 text entry area Value: ${text}\n2 menu bar\n3 File` }],
  _meta: { 'codex/toolSurface': { app: { appId } } } });

test('pattern rules check typeText, paste and setValue before forwarding', () => {
  const flow = rules(pattern);
  for (const code of ['await app.typeText("123-45-6789")', "await app.paste('123-45-6789')", 'await app.setValue(2, "123-45-6789")']) {
    assert.deepEqual(analyze(flow, code).violations.map(v => v.rule), ['ssns']);
  }
  assert.equal(analyze(flow, 'await app.typeText("123-45-6789")', '1Password').violations.length, 0);
  assert.equal(analyze(flow, 'await app.typeText("ordinary text")').violations.length, 0);
});

test('decodes literal escapes and constant templates without reading comments or unrelated strings', () => {
  const flow = rules(pattern);
  assert.equal(analyze(flow, 'await app.typeText("\\x31\\u0032\\u{33}-45-6789")').violations.length, 1);
  assert.equal(analyze(flow, 'await app.typeText(`123-45-6789`)').violations.length, 1);
  assert.equal(analyze(flow, 'await app["typeText"]("123-45-6789")').violations.length, 1);
  assert.equal(analyze(flow, '// app.typeText("123-45-6789")\nconst sample="123-45-6789"; await app.typeText("safe")').violations.length, 0);
  assert.equal(analyze(flow, 'const sample=/app.typeText("123-45-6789")/; await app.typeText("safe")').violations.length, 0);
});

test('joins literal pressKey sequences within and across accepted calls', () => {
  const flow = rules(pattern);
  const prefix = analyze(flow, 'await app.pressKey("1 2 3 minus 4 5 minus 6 7 8")');
  assert.equal(prefix.violations.length, 0); flow.forward(prefix);
  assert.equal(analyze(flow, 'await app.pressKey("9")').violations.length, 1);
  assert.equal(analyze(flow, 'await app.pressKey("super+a"); await app.pressKey("9")').violations.length, 0);
  const complete = '123-45-6789'.split('').map(c => `await app.pressKey(${JSON.stringify(c)});`).join('\n');
  assert.equal(analyze(rules(pattern), complete).violations.length, 1);
});

test('source rules remember read field values, including multiline data', () => {
  const flow = rules(source);
  flow.observe(result('Contacts', 'alice@example.org\n123 Oak Street'), analyze(flow, 'let app = await cua.getApp("Contacts")', 'Contacts'));
  assert.equal(analyze(flow, 'await app.typeText("Email alice@example.org about it")').violations[0].rule, 'contacts-mail');
  assert.equal(analyze(flow, 'await app.setValue(2,"123 Oak Street")').violations.length, 1);
  assert.equal(analyze(flow, 'await app.typeText("public totals")').violations.length, 0);
  assert.equal(analyze(flow, 'await app.typeText("alice@example.org")', 'Numbers').violations.length, 0);
  assert.equal(analyze(flow, 'await app.typeText("File")').violations.length, 0);
});

test('records plain emitted text and JSON values from a protected app', () => {
  const flow = rules(source);
  const plan = analyze(flow, 'let app = await cua.getApp("Contacts")', 'Contacts');
  flow.forward(plan);
  flow.observe({ content: [{ type: 'text', text: '{"email":"alice@example.org"}' }, { type: 'text', text: 'private note' }] }, plan);
  assert.equal(analyze(flow, 'let out=await cua.getApp("Mail"); await out.paste("alice@example.org")').violations.length, 1);
  assert.equal(analyze(flow, 'let out=await cua.getApp("Mail"); await out.typeText("private note")').violations.length, 1);
});

test('records the indented text fields returned by the live engine', () => {
  const flow = rules({ id: 'textedit', kind: 'source', sources: ['TextEdit'], destinations: ['TextEdit'] });
  flow.observe({ content: [{ type: 'text', text: 'Window: "SOURCE.txt", App: TextEdit.\n0 standard window SOURCE.txt\n\t1 scroll area\n\t\t2 text entry area (settable) ID: First Text View, Value: FLOW PROTECTED VALUE\n\n\t\t3 scroll bar (disabled) 0\n11 menu bar\n\t12 TextEdit\n\t13 File' }] }, analyze(flow, 'let app = await cua.getApp("TextEdit")', 'TextEdit'));
  assert.equal(analyze(flow, 'await app.typeText("FLOW PROTECTED VALUE")', 'TextEdit').violations.length, 1);
  assert.equal(analyze(flow, 'await app.typeText("File")', 'TextEdit').violations.length, 0);
});

test('data returned before a tool error is still protected, and ends with the session', () => {
  const flow = rules(source);
  flow.observe({ ...result('Contacts', 'alice@example.org'), isError: true }, analyze(flow, 'let app = await cua.getApp("Contacts")', 'Contacts'));
  assert.equal(analyze(flow, 'await app.typeText("alice@example.org")').violations.length, 1);
  flow.dispose();
  assert.equal(analyze(flow, 'await app.typeText("alice@example.org")').violations.length, 0);
});

test('ordinary API headings in UI data cannot suppress source recording', () => {
  const flow = rules(source);
  const plan = analyze(flow, 'let app = await cua.getApp("Contacts")', 'Contacts');
  flow.observe(result('Contacts', 'alice@example.org\n## API reference notes'), plan);
  assert.equal(analyze(flow, 'await app.typeText("alice@example.org")').violations.length, 1);
});

test('previously allowed text does not block harmless additions, but new split matches do', () => {
  const flow = rules({ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] });
  flow.forward(analyze(flow, 'await app.typeText("SECRET")'));
  assert.equal(analyze(flow, 'await app.typeText(" ordinary note")').violations.length, 0);
  assert.equal(analyze(flow, 'await app.typeText("SECRET")').violations.length, 1);
  const split = rules({ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] });
  split.forward(analyze(split, 'await app.typeText("SECRE")'));
  assert.equal(analyze(split, 'await app.typeText("T")').violations.length, 1);
  const overlap = rules({ id: 'overlap', kind: 'pattern', pattern: 'ABA', destinations: ['*'] });
  overlap.forward(analyze(overlap, 'await app.typeText("ABA")'));
  assert.equal(analyze(overlap, 'await app.typeText("BA")').violations.length, 1);
  for (const pattern of ['S(?=ECRET)', '(?=SECRET)']) {
    const lookahead = rules({ id: 'lookahead', kind: 'pattern', pattern, destinations: ['*'] });
    lookahead.forward(analyze(lookahead, 'await app.typeText("SECRE")'));
    assert.equal(analyze(lookahead, 'await app.typeText("T")').violations.length, 1);
  }
  const fromSource = rules(source);
  fromSource.observe(result('Contacts', 'alice@example.org'), analyze(fromSource, 'let app = await cua.getApp("Contacts")', 'Contacts'));
  fromSource.forward(analyze(fromSource, 'await app.typeText("alice@example.org")'));
  assert.equal(analyze(fromSource, 'await app.typeText(" ordinary note")').violations.length, 0);
});

test('targets literal app acquisitions and learned bundle aliases instead of the last unrelated window', () => {
  const flow = rules(source);
  const read = analyze(flow, 'let contacts = await cua.getApp("com.apple.AddressBook")', 'Contacts');
  flow.forward(read); flow.observe(result('Contacts', 'alice@example.org', 'com.apple.AddressBook'), read);
  const mail = analyze(flow, 'let mail = await cua.getApp("Mail")', 'Mail');
  flow.forward(mail); flow.observe(result('Mail', 'inbox', 'com.apple.mail'), mail);
  assert.equal(analyze(flow, 'await mail.typeText("alice@example.org")', 'Numbers').violations.length, 1);
  assert.equal(analyze(flow, 'let out=await cua.getApp("com.apple.mail"); await out.typeText("alice@example.org")', 'Numbers').violations.length, 1);
});

test('checks string arguments of menu_bar and drag before local effects', () => {
  const flow = rules(pattern);
  assert.equal(flow.analyze('menu_bar', { app: 'Mail', op: 'choose', path: ['123-45-6789'] }).violations.length, 1);
  assert.equal(flow.analyze('drag', { app: 'Mail', from: [0, 0], to: [2, 3], note: '123-45-6789' }).violations.length, 1);
  assert.equal(flow.analyze('drag', { app: 'Mail', from: [0, 0], to: [2, 3] }).violations.length, 0);
});

test('runtime variables and clipboard data remain outside literal inspection', () => {
  const flow = rules(pattern);
  assert.equal(analyze(flow, 'let s="123-45-6789"; await app.typeText(s)').violations.length, 0);
  assert.equal(analyze(flow, 'await app.typeText(`value ${s}`)').violations.length, 0);
  assert.equal(analyze(flow, 'await app.pressKey("super+v")').violations.length, 0);
});

test('validates rules rather than silently disabling bad configuration', () => {
  for (const config of [{}, { version: 2, rules: [] }, { version: 1, rules: [{ ...pattern, pattern: '[' }] },
    { version: 1, rules: [null] }, { version: 1, rules: [pattern, pattern] }, { version: 1, rules: [{ ...source, destinations: [] }] }]) {
    assert.throws(() => new FlowRules(config), /flow rules/i);
  }
});

test('loads opt-in user files once and rejects a rules file inside the working project', t => {
  const bank = mkdtempSync(join(tmpdir(), 'sleight-flow-test-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const file = join(bank, 'rules.json'); writeFileSync(file, JSON.stringify({ version: 1, rules: [pattern] }));
  assert.equal(loadFlowRules({}), undefined);
  const flow = loadFlowRules({ SLEIGHT_FLOW_RULES: file }, { cwd: process.cwd() });
  writeFileSync(file, JSON.stringify({ version: 1, rules: [] }));
  assert.equal(analyze(flow, 'await app.typeText("123-45-6789")').violations.length, 1);
  assert.throws(() => loadFlowRules({ SLEIGHT_FLOW_RULES: file }, { cwd: bank }), /outside.*project/);
  assert.throws(() => loadFlowRules({ SLEIGHT_FLOW_RULES: join(bank, 'missing.json') }), /flow rules/i);
});

test('rules paths cannot enter the project through symlinks or a subdirectory cwd', t => {
  const bank = mkdtempSync(join(tmpdir(), 'sleight-flow-path-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const project = join(bank, 'project'); const sub = join(project, 'sub');
  mkdirSync(sub, { recursive: true }); mkdirSync(join(project, '.git'));
  const file = join(project, 'rules.json'); writeFileSync(file, JSON.stringify({ version: 1, rules: [pattern] }));
  const link = join(bank, 'outside.json'); symlinkSync(file, link);
  assert.throws(() => loadFlowRules({ SLEIGHT_FLOW_RULES: link }, { cwd: sub }), /outside.*project/);
});

// Header shapes recorded in the native document and browser-surface fixtures.
const webResult = (host, value = 'PRIVATE VALUE', app = 'Helium') => ({ content: [{ type: 'text',
  text: `Window: "Test", App: ${app}.\n0 standard window Test, URL: https://${host}/private, Secondary Actions: Raise\n\t1 text ${value}` }] });
const tabResult = (host, value = 'PRIVATE VALUE', id = '1') => ({ content: [{ type: 'text',
  text: `Browser tab: ${id}, Title: "Test", URL: "https://${host}/private".\n0 AXWebArea Test\n\t1 text ${value}` }] });
const read = (flow, code, result) => { const plan = flow.analyze('js', { code }); flow.forward(plan); flow.observe(result, plan); };
const sitePattern = { id: 'site-secret', kind: 'pattern', pattern: 'SECRET', destinations: ['site:example.com'] };

test('site destinations use native window URLs, with exact hosts and label-bounded wildcards', () => {
  for (const [selector, host, count] of [
    ['site:example.com', 'EXAMPLE.COM', 1], ['site:example.com', 'sub.example.com', 0],
    ['site:*.example.com', 'sub.example.com', 1], ['site:*.example.com', 'a.b.example.com', 1],
    ['site:*.example.com', 'example.com', 0], ['site:*.example.com', 'notexample.com', 0],
    ['site:*.example.com', 'example.com.evil.test', 0],
  ]) {
    const flow = rules({ ...sitePattern, destinations: [selector] });
    read(flow, 'let app = await cua.getApp("Helium")', webResult(host));
    assert.equal(flow.analyze('js', { code: 'await app.typeText("SECRET")' }).violations.length, count, `${selector}, ${host}`);
  }
});

test('site source values retain their observed host after a later read on another site', () => {
  const flow = rules({ ...source, sources: ['site:*.example.com'] });
  read(flow, 'let app = await cua.getApp("Helium")', webResult('private.example.com'));
  read(flow, 'await app.getAXState()', webResult('public.test', 'PUBLIC VALUE'));
  assert.equal(analyze(flow, 'let mail = await cua.getApp("Mail"); await mail.typeText("PRIVATE VALUE")').violations.length, 1);
  assert.equal(analyze(flow, 'await mail.typeText("PUBLIC VALUE")').violations.length, 0);
});

test('browser tab headers attribute protected text to a site and preserve browser source rules', () => {
  for (const selector of ['site:example.com', 'browser']) {
    const flow = rules({ ...source, sources: [selector] });
    read(flow, 'let tab = await cua.getTab("1")', tabResult('example.com'));
    assert.equal(analyze(flow, 'let mail = await cua.getApp("Mail"); await mail.paste("PRIVATE VALUE")').violations.length, 1);
  }
});

test('saved browser tabs and derived locators keep distinct site destinations', () => {
  const flow = rules(sitePattern);
  read(flow, 'let privateTab = await cua.getTab("1")', tabResult('example.com'));
  read(flow, 'let publicTab = await cua.getTab("2")', tabResult('public.test', 'PUBLIC VALUE', '2'));
  assert.equal(flow.analyze('js', { code: 'await privateTab.playwright.getByRole("textbox").fill("SECRET")' }).violations.length, 1);
  assert.equal(flow.analyze('js', { code: 'await publicTab.playwright.getByRole("textbox").fill("SECRET")' }).violations.length, 0);
  read(flow, 'let field = privateTab.playwright.getByRole("textbox")', tabResult('example.com'));
  assert.equal(flow.analyze('js', { code: 'await field.fill("SECRET")' }).violations.length, 1);
  read(flow, 'await privateTab.getAXState()', tabResult('public.test'));
  assert.equal(flow.analyze('js', { code: 'await field.fill("SECRET")' }).violations.length, 0);
});

test('site exceptions require a current unambiguous observed HTTP URL', () => {
  for (const text of [
    'Window: "Test", App: Helium.\n0 standard window Test',
    'Window: "Test", App: Helium.\nURL: https://example.com\nURL: https://evil.test',
    'Window: "Test", App: Helium.\nURL: file:///tmp/example.com',
    'Window: "Test", App: Helium.\nURL: https://example.com@evil.test',
    'Window: "Test", App: Helium.\nURL: not a URL',
  ]) {
    const flow = rules({ ...pattern, except: ['site:example.com'] });
    read(flow, 'let app = await cua.getApp("Helium")', webResult('example.com'));
    read(flow, 'await app.getAXState()', { content: [{ type: 'text', text }] });
    assert.equal(flow.analyze('js', { code: 'await app.typeText("123-45-6789")' }).violations.length, 1, text);
  }
  const flow = rules({ ...pattern, except: ['site:example.com'] });
  read(flow, 'let app = await cua.getApp("Helium")', webResult('EXAMPLE.COM'));
  assert.equal(flow.analyze('js', { code: 'await app.typeText("123-45-6789")' }).violations.length, 0);
});

test('missing browser headers cannot inherit another tab site or a site exception', () => {
  const flow = rules({ ...pattern, except: ['site:example.com'] });
  read(flow, 'let approved = await cua.getTab("1")', tabResult('example.com'));
  read(flow, 'let unknown = await cua.getTab("2")', { content: [{ type: 'text', text: 'No state' }] });
  assert.equal(flow.analyze('js', { code: 'await unknown.playwright.getByRole("textbox").fill("123-45-6789")' }).violations.length, 1);
  assert.equal(flow.analyze('js', { code: 'await approved.playwright.getByRole("textbox").fill("123-45-6789")' }).violations.length, 0);
  const dest = rules(sitePattern);
  read(dest, 'let unknown = await cua.getTab("2")', { content: [{ type: 'text', text: 'No state' }] });
  assert.equal(dest.analyze('js', { code: 'await unknown.playwright.getByRole("textbox").fill("SECRET")' }).violations.length, 1);
});

test('navigation checks the requested URL host and invalidates earlier site exceptions', () => {
  const flow = rules({ ...sitePattern, pattern: 'SECRET', except: ['site:public.test'] });
  read(flow, 'let tab = await cua.getTab("1")', tabResult('public.test'));
  assert.equal(flow.analyze('js', { code: 'await tab.goto("https://example.com/?SECRET")' }).violations.length, 1);
  assert.equal(flow.analyze('js', { code: 'let tab = await cua.createBrowserTab("chrome", "https://example.com/?SECRET")' }).violations.length, 1);
  assert.equal(flow.analyze('js', { code: 'await tab.goto("https://example.com"); await tab.playwright.getByRole("textbox").fill("SECRET")' }).violations.length, 1);
});

test('site typing tails stay separate while existing browser pattern rules still join calls', () => {
  for (const [destinations, count] of [[['site:example.com'], 0], [['browser'], 1]]) {
    const flow = rules({ ...sitePattern, destinations });
    read(flow, 'let a = await cua.getTab("1")', tabResult('example.com'));
    flow.forward(flow.analyze('js', { code: 'await a.playwright.getByRole("textbox").type("SECRE")' }));
    read(flow, 'let b = await cua.getTab("2")', tabResult('public.test', 'PUBLIC VALUE', '2'));
    assert.equal(flow.analyze('js', { code: 'await b.playwright.getByRole("textbox").type("T")' }).violations.length, count);
  }
});

test('ambiguous site selector syntax refuses configuration in every selector position', () => {
  for (const selector of ['site:', 'site:*', 'site:*.com', 'site:foo*.example.com', 'site:**.example.com',
    'site:example.*', 'site:https://example.com', 'site:example.com/path', 'site:example.com:443',
    'site:example.com?x', 'site: example.com', 'site:example.com.', 'site:ex ample.com', 'site:*.127.0.0.1']) {
    for (const key of ['sources', 'destinations', 'except']) {
      assert.throws(() => rules({ ...source, [key]: [selector] }), /site.*host|host.*site/i, `${key}: ${selector}`);
    }
  }
});

test('native missing or conflicting window headers clear earlier site exceptions', () => {
  for (const reply of [
    { content: [{ type: 'text', text: 'No state' }] },
    { content: [...webResult('evil.test').content, ...webResult('example.com').content] },
  ]) {
    const flow = rules({ ...pattern, except: ['site:example.com'] });
    read(flow, 'let app = await cua.getApp("Helium")', webResult('example.com'));
    read(flow, 'await app.getAXState()', reply);
    assert.equal(flow.analyze('js', { code: 'await app.typeText("123-45-6789")' }).violations.length, 1);
  }
});

test('browser headers with DOM snapshots protect readable site values', () => {
  const flow = rules({ ...source, sources: ['site:example.com'] });
  const reply = tabResult('example.com');
  reply.content[0].text += '\n- paragraph: DOM PRIVATE VALUE\n- textbox "Email": secret@example.org';
  read(flow, 'let tab = await cua.getTab("1")', reply);
  assert.equal(analyze(flow, 'let mail = await cua.getApp("Mail"); await mail.paste("DOM PRIVATE VALUE")').violations.length, 1);
  assert.equal(analyze(flow, 'await mail.paste("secret@example.org")').violations.length, 1);
});

test('browser history and reload clear stale site destinations before later input', () => {
  for (const method of ['back', 'forward', 'reload']) {
    const flow = rules(sitePattern);
    read(flow, 'let tab = await cua.getTab("1")', tabResult('public.test'));
    assert.equal(flow.analyze('js', { code: `await tab.${method}(); await tab.playwright.getByRole("textbox").fill("SECRET")` }).violations.length, 1, method);
    read(flow, `await tab.${method}()`, { content: [{ type: 'text', text: 'Navigation complete' }] });
    assert.equal(flow.analyze('js', { code: 'await tab.playwright.getByRole("textbox").fill("SECRET")' }).violations.length, 1, `${method}, later call`);
  }
});

test('unfamiliar native browsers retain learned web status after ambiguous or missing URLs', () => {
  for (const reply of [
    { content: [...webResult('example.com', 'PRIVATE VALUE', 'Vivaldi').content, ...webResult('public.test', 'PUBLIC VALUE', 'Vivaldi').content] },
    { content: [{ type: 'text', text: 'Window: "Test", App: Vivaldi.\n0 standard window Test' }] },
  ]) {
    const flow = rules(sitePattern);
    read(flow, 'let app = await cua.getApp("Vivaldi")', webResult('example.com', 'PRIVATE VALUE', 'Vivaldi'));
    read(flow, 'await app.getAXState()', reply);
    assert.equal(flow.analyze('js', { code: 'await app.typeText("SECRET")' }).violations.length, 1);
  }
});
