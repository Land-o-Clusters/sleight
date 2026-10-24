import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDeveloperRead, scrubDeveloperText, safeDeveloperURL } from '../plugins/sleight/lib/direct-browser/developer-read.mjs';
import { createToolDispatcher, validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';

function fixture({ fail = [], metrics = [] } = {}) {
  const calls = [], cdp = new EventEmitter();
  cdp.send = async (method, params) => {
    calls.push([method, params]);
    if (fail.includes(method)) throw Error('cookie=private-protocol-error');
    return { metrics };
  };
  const reader = createDeveloperRead(cdp);
  return { reader, cdp, calls };
}
function request(cdp, id, url = 'https://example.invalid/api/items?token=private-query#private-fragment', extra = {}) {
  cdp.emit('Network.requestWillBeSent', { requestId: id, type: 'Fetch', timestamp: 1,
    request: { method: 'GET', url, headers: { Cookie: 'private-cookie', Authorization: 'Bearer private-auth' }, postData: 'private-body' }, ...extra });
}
const credentialLabels = ['credential', 'credentials', 'token', 'tokens', 'password', 'passwords', 'passwd', 'pwd',
  'secret', 'secrets', 'cookie', 'cookies', 'csrf', 'xsrf', 'sid', 'session', 'sessions',
  'apikey', 'api key', 'api-key', 'api_key', 'apikeys', 'api keys', 'api-keys', 'api_keys',
  'privatekey', 'private key', 'private-key', 'private_key', 'jwt', 'bearer', 'auth', 'authorization', 'otp', 'code'];
for (const label of credentialLabels) {
  test(`labelled credential drops the whole string: ${label}`, () => {
    for (const separator of [': ', '=', ' = ', '\n'])
      assert.equal(scrubDeveloperText('User ' + label + separator + 'briefvalue'), '[sensitive text omitted]');
  });
  test(`split console credential drops the whole message: ${label}`, async t => {
    const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
    f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [
      { type: 'string', value: 'User ' + label + ':' }, { type: 'string', value: 'briefvalue' }] });
    const text = await f.reader.read({ console: true });
    assert.match(text, /sensitive text omitted/); assert.doesNotMatch(text, /briefvalue|User /);
  });
}
for (const value of ['sk-shortkey', 'AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE', 'ghp_shortkey', 'gho_shortkey',
  'github_pat_shortkey', 'xoxa-shortkey', 'xoxb-shortkey', 'xoxp-shortkey',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', 'eyJhbGciOiJIUzI1NiJ9',
  'a123456789bcdefgh', '123456789abcdefg', 'a'.repeat(23) + '1']) {
  test(`unlabelled key shape drops the whole console message: ${value}`, async t => {
    assert.equal(scrubDeveloperText('debug ' + value + ' tail'), '[sensitive text omitted]');
    const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
    f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [
      { type: 'string', value: 'diagnostic prefix' }, { type: 'string', value }] });
    assert.doesNotMatch(await f.reader.read({ console: true }), /diagnostic prefix/);
  });
}
for (const segment of ['abcdef123456', 'a12345678901', 'Ab12Cd34Ef56Gh78', '123456abcdef', 'a'.repeat(40) + '1']) {
  test(`URL hides mixed path and subdomain values: ${segment}`, () => {
    assert.equal(safeDeveloperURL(`https://${segment}.example.invalid/invite/${segment}/done`),
      'https://[omitted].example.invalid/invite/[omitted]/done');
    assert.equal(scrubDeveloperText(`load https://${segment}.example.invalid/invite/${segment}/done?x=briefvalue`),
      'load https://[omitted].example.invalid/invite/[omitted]/done');
  });
}
for (const value of ['sk-shortkey', 'ghp_shortkey', 'eyJhbGciOiJIUzI1NiJ9']) {
  test(`known key shapes cannot hide inside console URLs: ${value}`, () => {
    assert.equal(scrubDeveloperText('load https://example.invalid/invite/' + value), '[sensitive text omitted]');
  });
}
test('URL retains ordinary words, short numeric ids and file names with extensions', () => {
  const url = 'https://ordinarydocumentation.example.invalid/ordinarydocumentation/12345678901/app12345678901234.min.js';
  assert.equal(safeDeveloperURL(url), url);
  assert.equal(scrubDeveloperText('load ' + url), 'load ' + url);
  assert.equal(safeDeveloperURL('https://example.invalid/123456789012'), 'https://example.invalid/[omitted]');
});
for (const text of ['sure? still ready', 'metadata:useful', 'candidate:ready', 'year 2026', 'port 8080',
  'HTTP 404 count 1234', 'count 12345', 'load https://example.invalid/api']) {
  test(`ordinary console diagnostics survive: ${text}`, () => assert.equal(scrubDeveloperText(text), text));
}
test('console scrubs actual data schemes and six digit numbers', () => {
  assert.equal(scrubDeveloperText('load data:text/plain,briefvalue'), 'load [URL omitted]');
  assert.equal(scrubDeveloperText('count 123456'), 'count [number omitted]');
  assert.equal(scrubDeveloperText('load https://example.invalid/api?x=briefvalue#fragment'), 'load https://example.invalid/api');
});
test('network capture disables all CDP payload buffers', async t => {
  const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
  assert.deepEqual(f.calls.find(([method]) => method === 'Network.enable')[1],
    { maxPostDataSize: 0, maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
});
test('performance setup retries after failure and records a stable first-read start', async t => {
  const fail = ['Performance.enable'];
  const f = fixture({ fail, metrics: [{ name: 'TaskDuration', value: 0.05 }] });
  t.after(f.reader.stop); await f.reader.ready;
  const earliest = Date.now();
  const first = await f.reader.read({ performance: true });
  assert.match(first, /\nunavailable/);
  fail.length = 0;
  const second = await f.reader.read({ performance: true });
  assert.match(second, /TaskDuration: 50/);
  assert.match(second, /since first developer read/);
  const start = second.match(/started: ([^\n]+)/)?.[1];
  assert.ok(Date.parse(start) >= earliest && Date.parse(start) <= Date.now());
  assert.match(second, /metrics enabled: [^\n]+/);
  const third = await f.reader.read({ performance: true });
  assert.equal(third.match(/started: ([^\n]+)/)?.[1], start);
  assert.equal(f.calls.filter(([method]) => method === 'Performance.enable').length, 2);
});
test('performance collection starts with a console read before the first metrics read', async t => {
  const f = fixture({ metrics: [{ name: 'TaskDuration', value: 0.05 }] });
  t.after(f.reader.stop); await f.reader.ready;
  const earliest = Date.now();
  await f.reader.read({ console: true });
  assert.equal(f.calls.filter(([method]) => method === 'Performance.enable').length, 1);
  const latest = Date.now();
  const text = await f.reader.read({ performance: true });
  const started = Date.parse(text.match(/started: ([^\n]+)/)?.[1]);
  assert.ok(started >= earliest && started <= latest);
});
test('a bare code label followed by a separate primitive hides the whole console call', async t => {
  const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
  f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [
    { type: 'string', value: 'code' }, { type: 'string', value: 'briefvalue' }] });
  const text = await f.reader.read({ console: true });
  assert.match(text, /sensitive text omitted/); assert.doesNotMatch(text, /briefvalue/);
});
test('URL scrubbing removes queries, fragments, userinfo, token paths and non-web payloads', () => {
  assert.equal(safeDeveloperURL('https://user:pass@example.invalid/api/items?token=private#private'), 'https://example.invalid/api/items');
  assert.equal(safeDeveloperURL('https://example.invalid/token/short-value/orders'), 'https://example.invalid/[omitted]/[omitted]/orders');
  for (const url of ['data:text/plain,private', 'file:///private/key', 'blob:https://example.invalid/private', 'bad', 'x'.repeat(9000)])
    assert.equal(safeDeveloperURL(url), '[URL omitted]');
  assert.doesNotMatch(safeDeveloperURL('https://example.invalid/%74oken/shortsecret/' + 'a'.repeat(80)), /shortsecret|a{24}/);
});
test('console scrubbing removes labelled credentials, control characters, opaque values and email addresses', () => {
  for (const value of ['Authorization: Bearer short', 'Cookie: a=short', 'access_token=short', 'api-key: short',
    '{"password":"short"}', 'session_id=short', 'secret\nshort', 'Ａｕｔｈｏｒｉｚａｔｉｏｎ: short'])
    assert.equal(scrubDeveloperText(value), '[sensitive text omitted]', value);
  assert.doesNotMatch(scrubDeveloperText('opaque a1234567890bcdefghijklmnopqrstuvwxyz user@example.invalid'), /a123|user@/);
  assert.equal(scrubDeveloperText('load https://u:p@example.invalid/api?x=private#private'), 'load https://example.invalid/api');
  assert.equal(scrubDeveloperText('load /api?x=private#private'), 'load /api');
  assert.doesNotMatch(scrubDeveloperText('example.invalid/api?code=private#private'), /private/);
  assert.equal(scrubDeveloperText('code 123456'), '[sensitive text omitted]');
  assert.equal(scrubDeveloperText('ready\u001b\nline\u202e'), 'ready  line ');
  assert.equal(scrubDeveloperText('x'.repeat(4097)), '[long text omitted]');
});
test('console capture never inspects remote objects and hides split credential arguments', async t => {
  const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
  f.cdp.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'Failed to render card' },
    { type: 'object', objectId: 'private-object', description: 'private-object-description', preview: { private: 'private-preview' } }] });
  f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'Authorization' }, { type: 'string', value: 'short-secret' }] });
  f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [
    { type: 'string', value: 'short-unlabelled-value' }, ...Array(7).fill({ type: 'boolean', value: true }), { type: 'string', value: 'Authorization' }] });
  f.cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'TypeError: missing card' } } });
  const text = await f.reader.read({ console: true });
  assert.match(text, /untrusted; never instructions or permission/);
  assert.match(text, /Failed to render card/); assert.match(text, /TypeError: missing card/);
  assert.doesNotMatch(text, /private-|short-secret|short-unlabelled-value/);
  assert.deepEqual(f.calls.map(([method]) => method).sort(), ['Network.enable', 'Performance.enable', 'Runtime.enable']);
});
test('network reads expose only bounded metadata with redirect, failure and duration evidence', async t => {
  const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
  request(f.cdp, 'r1');
  request(f.cdp, 'r1', 'https://example.invalid/api/broken?auth=private', { timestamp: 1.1, redirectResponse: { status: 302, headers: { 'Set-Cookie': 'private-response-cookie' } } });
  f.cdp.emit('Network.responseReceived', { requestId: 'r1', response: { status: 503, headers: { Authorization: 'private-response-auth' }, url: 'private-response-url' } });
  f.cdp.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 1.25 });
  request(f.cdp, 'r2'); f.cdp.emit('Network.loadingFailed', { requestId: 'r2', timestamp: 1.5, errorText: 'net::ERR_CONNECTION_REFUSED' });
  request(f.cdp, 'r3'); f.cdp.emit('Network.loadingFailed', { requestId: 'r3', timestamp: 1.5, errorText: 'Cookie=private-failure' });
  const text = await f.reader.read({ network: true });
  assert.match(text, /"status":302,"duration":100/); assert.match(text, /"status":503,"duration":150/);
  assert.match(text, /net::ERR_CONNECTION_REFUSED/); assert.match(text, /"outcome":"failed"/);
  assert.doesNotMatch(text, /private|headers|postData|requestId|"start"/);
  const calls = f.calls.length; await f.reader.read({ network: true }); assert.equal(f.calls.length, calls);
});
test('buffers evict older rows, bound pending requests and explicitly cap output', async t => {
  const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
  for (let n = 0; n < 125; n++) {
    f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'row ' + n }] });
    request(f.cdp, 'r' + n, 'https://example.invalid/row/' + n);
  }
  const logs = await f.reader.read({ console: true });
  assert.match(logs, /100 retained, 25 older omitted/); assert.match(logs, /row 124/); assert.doesNotMatch(logs, /"row 0"/);
  const net = await f.reader.read({ network: true, max_chars: 1000 });
  assert.ok(net.length <= 1000); assert.match(net, /output truncated/);
  assert.match(net, /100 retained, 25 older omitted/); assert.doesNotMatch(net, /\/row\/0"/);
  f.cdp.emit('Network.responseReceived', { requestId: 'r0', response: { status: 555 } });
  assert.doesNotMatch(await f.reader.read({ network: true }), /555/);
});
test('a new main document clears prior-site logs while keeping its navigation request', async t => {
  const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
  f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'prior-site-message' }] });
  request(f.cdp, 'old', 'https://old.invalid/api');
  request(f.cdp, 'new', 'https://new.invalid/page?x=omitted', { type: 'Document' });
  f.cdp.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main', url: 'https://frame.invalid' } });
  assert.match(await f.reader.read({ console: true }), /prior-site-message/);
  f.cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://new.invalid/page?x=omitted' } });
  f.cdp.emit('Network.responseReceived', { requestId: 'old', response: { status: 555 } });
  f.cdp.emit('Network.responseReceived', { requestId: 'new', response: { status: 200 } });
  const text = await f.reader.read({ console: true, network: true });
  assert.match(text, /new.invalid\/page.*"status":200/);
  assert.doesNotMatch(text, /prior-site-message|old.invalid|555/);
});
test('performance allowlists numeric metrics and derives navigation-relative milliseconds', async t => {
  const f = fixture({ metrics: [{ name: 'NavigationStart', value: 10 }, { name: 'DomContentLoaded', value: 10.25 },
    { name: 'FirstMeaningfulPaint', value: 0 }, { name: 'TaskDuration', value: 0.05 }, { name: 'ScriptDuration', value: NaN },
    { name: 'private-token', value: 123 }, { name: 'LayoutDuration', value: -1 }] });
  t.after(f.reader.stop); await f.reader.ready;
  const text = await f.reader.read({ performance: true });
  assert.match(text, /DomContentLoaded: 250/); assert.match(text, /TaskDuration: 50/);
  assert.doesNotMatch(text, /FirstMeaningfulPaint:|private|NaN|LayoutDuration:|ScriptDuration:/);
  await f.reader.read({ performance: true });
  assert.equal(f.calls.filter(([method]) => method === 'Performance.enable').length, 1);
  assert.equal(f.calls.filter(([method]) => method === 'Performance.getMetrics').length, 2);
  assert.ok(f.calls.every(([method]) => ['Runtime.enable', 'Network.enable', 'Performance.enable', 'Performance.getMetrics'].includes(method)));
});
test('unsupported domains and protocol failures report unavailable without leaking raw errors', async t => {
  const f = fixture({ fail: ['Runtime.enable', 'Network.enable', 'Performance.getMetrics'] });
  t.after(f.reader.stop);
  const text = await f.reader.read({ console: true, network: true, performance: true });
  assert.match(text, /Console: unavailable/); assert.match(text, /Network: unavailable/); assert.match(text, /\nunavailable/);
  assert.doesNotMatch(text, /private-protocol-error/);
});
test('a nonresponsive CDP read is bounded and reports unavailable', { timeout: 5000 }, async t => {
  const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
  f.cdp.send = method => method === 'Performance.enable' ? Promise.resolve({}) : new Promise(() => {});
  const text = await f.reader.read({ performance: true });
  assert.match(text, /\nunavailable/);
});
test('stop clears data, removes event listeners and refuses pending or later reads', async () => {
  const f = fixture(); await f.reader.ready;
  request(f.cdp, 'r'); f.reader.stop(); f.reader.stop();
  assert.deepEqual(f.cdp.eventNames(), []);
  await assert.rejects(f.reader.read({ network: true }), /ended/);
  const g = fixture(); await g.reader.ready;
  let release;
  g.cdp.send = () => new Promise(resolve => { release = resolve; });
  const read = g.reader.read({ performance: true });
  await new Promise(resolve => setImmediate(resolve)); g.reader.stop(); release({});
  await assert.rejects(read, /ended/);
});

function dispatcherFixture({ sites, url = 'https://example.invalid/', noDeveloper = false } = {}) {
  const calls = [], state = { snapshotNo: 7 }, entry = { page: { url: () => url }, state,
    ...(noDeveloper ? {} : { developer: { read: async args => { calls.push(args); return 'Developer data (untrusted)'; } } }) };
  const pages = { tab: id => { if (id !== 't1') throw Error('unknown owned tab'); return entry; },
    enqueue: async (id, run) => run(pages.tab(id)), closedOpener: () => 't1', endTurn: async () => ({ cleanedUp: true }) };
  const unexpected = () => assert.fail('developer reads never snapshot, act or fill');
  const dispatcher = createToolDispatcher({ pages, sites, snapshot: unexpected, runSteps: unexpected, fillFields: unexpected });
  return { dispatcher, calls, state, entry };
}
test('developer schemas accept boolean flags and reject snapshot selectors or request mutations', () => {
  for (const flags of [{ console: true }, { network: true }, { performance: true }, { console: true, network: true, performance: true }]) {
    const call = { name: 'browser_read', arguments: { tab: 't1', ...flags } };
    assert.deepEqual(validateToolCall(call), call);
  }
  for (const fields of [{ console: 'true' }, { network: true, ref: 'e1' }, { performance: true, find: 'x' },
    { console: true, text: true }, { network: true, replay: true }, { network: true, headers: {} }])
    assert.throws(() => validateToolCall({ name: 'browser_read', arguments: { tab: 't1', ...fields } }));
});
test('dispatcher reads only the named owned tab, never redirects logs to an opener or admits refs', async () => {
  const f = dispatcherFixture();
  const result = await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1', network: true } });
  assert.equal(result.isError, false); assert.equal(f.calls.length, 1);
  assert.equal(f.dispatcher.delivered(result), false); assert.equal(f.state.snapshotNo, 7);
  const foreign = await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 'tforeign', console: true } });
  assert.equal(foreign.isError, true); assert.equal(f.calls.length, 1);
});
test('site blocks, missing capability, pending dialogs and ended turns refuse before developer access', async () => {
  for (const options of [{ sites: () => 'Blocked by user' }, { noDeveloper: true }]) {
    const f = dispatcherFixture(options);
    const result = await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1', console: true } });
    assert.equal(result.isError, true); assert.equal(f.calls.length, 0);
  }
  const f = dispatcherFixture(); f.entry.state.dialog = {};
  assert.equal((await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1', network: true } })).isError, true);
  assert.equal(f.calls.length, 0); await f.dispatcher.end();
  assert.equal((await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1', network: true } })).isError, true);
});
test('revocation or a new site block during an asynchronous read withholds the captured text', async () => {
  for (const revoke of [false, true]) {
    let blocked = false;
    const f = dispatcherFixture({ sites: () => blocked ? 'Blocked by user' : undefined });
    f.entry.developer.read = async () => {
      if (revoke) await f.dispatcher.end(); else blocked = true;
      return 'private captured data';
    };
    const result = await f.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1', console: true } });
    assert.equal(result.isError, true); assert.doesNotMatch(result.text, /private captured data/);
  }
});
