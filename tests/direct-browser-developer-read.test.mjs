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
  'apikey', 'api key', 'api-key', 'api_key', 'api.key', 'apikeys', 'api keys', 'api-keys', 'api_keys',
  'privatekey', 'private key', 'private-key', 'private_key', 'jwt', 'bearer', 'auth', 'authorization', 'otp', 'code',
  'key', 'keys', 'pass', 'passes', 'passphrase', 'passphrases', 'pw', 'access_key', 'access-key', 'access key',
  'signature', 'signatures', 'sig', 'sigs', 'sess', 'pin', 'pins', 'cvv', 'cvvs', 'ssn', 'ssns',
  'accessTokens', 'session_id', 'clientSecret', 'reset-code', 'authToken', 'sessionKey', 'apiAccessKey', 'oauthToken'];
for (const label of credentialLabels) {
  test(`credential label omits the suffix: ${label}`, () => {
    for (const separator of [': ', '=', ' = ', '\n', ' ', '\":\"']) {
      const text = scrubDeveloperText('User ' + label + separator + 'briefvalue diagnostic tail');
      assert.match(text, /\[omitted\]$/);
      assert.doesNotMatch(text, /briefvalue|diagnostic tail/);
    }
  });
  test(`split console arguments are joined before label checks: ${label}`, async t => {
    const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
    f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [
      ...label.split(/[ _.\-]/).map(value => ({ type: 'string', value })),
      { type: 'string', value: 'briefvalue diagnostic tail' }] });
    const text = await f.reader.read({ console: true });
    assert.match(text, /\[omitted\]/); assert.doesNotMatch(text, /briefvalue|diagnostic tail/);
  });
}
const reviewValues = ['sk-shortkey', 'AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE', 'ghp_shortkey', 'gho_shortkey',
  'github_pat_shortkey', 'xoxa-shortkey', 'xoxb-shortkey', 'xoxp-shortkey',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', 'eyJhbGciOiJIUzI1NiJ9',
  'a123456789bcdefgh', '123456789abcdefg', 'a'.repeat(23) + '1', 'Ab3dE7gH9k', '482913',
  'ABCD-1234-EFGH-5678', 'abcdefghijklmnop', 'a'.repeat(16), 'Zm9vYmFy', 'deadbeef', '0xff',
  '4111-1111-1111-1111', '123-45-6789', 'a1', 'ab_cd', 'abc=def', 'abc:def', 'abc?def', 'abc#def', 'abc@def'];
for (const value of reviewValues) {
  test(`unknown or key-shaped token is masked: ${value}`, () => {
    const text = scrubDeveloperText('debug ' + value + ' tail');
    assert.doesNotMatch(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(text, /\[(?:value|omitted)\]/);
  });
}
test('200 generated key-shaped values do not survive in text, console arguments, exceptions or URLs', async t => {
  const f = fixture(); t.after(f.reader.stop); await f.reader.ready;
  let seed = 0x6c2026;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.';
  for (let i = 0; i < 200; i++) {
    let value = alphabet[random(52)] + String(random(10));
    for (let n = random(36) + 1; n > 0; n--) value += alphabet[random(alphabet.length)];
    value += '-_.'[i % 3] + alphabet[random(52)];
    assert.ok(!scrubDeveloperText('debug ' + value).includes(value), `text case ${i}`);
    assert.ok(!safeDeveloperURL('https://example.invalid/reset/' + value).includes('/' + value), `URL case ${i}`);
    assert.ok(!safeDeveloperURL('https://' + value + '.example.invalid/ready').toLowerCase().includes(value.toLowerCase()), `host case ${i}`);
    f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value }] });
    f.cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'Error: ' + value } } });
    assert.ok(!(await f.reader.read({ console: true })).includes(value), `capture case ${i}`);
  }
});
test('normalization deletes format characters and folds Cyrillic and Greek before checks', () => {
  for (const char of ['\u00ad', '\u061c', '\u200b', '\u200c', '\u200d', '\u200e', '\u202e', '\u2060', '\u2066', '\ufeff']) {
    assert.doesNotMatch(scrubDeveloperText('to' + char + 'ken=briefvalue tail'), /briefvalue|tail/);
    assert.equal(scrubDeveloperText('debug Ab3' + char + 'dE7gH9k'), 'debug [value]');
  }
  for (const text of ['tоken=briefvalue', 'tοken=briefvalue', 'раss:briefvalue', 'Αuth:briefvalue',
    'ａｐｉ＿ｋｅｙ＝briefvalue', 'api\u200b.key=briefvalue', 'aυth:briefvalue', 'db_secret:briefvalue']) {
    assert.match(scrubDeveloperText(text), /\[omitted\]/, text);
    assert.doesNotMatch(scrubDeveloperText(text), /briefvalue/);
  }
  assert.equal(scrubDeveloperText('ｒｅａｄｙ １２３４'), 'ready 1234');
  assert.equal(scrubDeveloperText('ready' + '\u200b'.repeat(5000)), 'ready');
});
const readable = ['Compiled with exit code 1', 'code splitting enabled', 'Are you sure?', 'metadata: useful',
  'Next.js docs', 'sure? still ready', 'year 2026', 'port 8080', 'HTTP 404 count 1234',
  'ready 1.2345 1234.5678 0 9999', 'ready, (ok)!', 'true false null undefined', 'DOMContentLoaded',
  'cOmPiLeD WITH Exit CODE 1', 'INTERNATIONALIZATION ready', 'ready - (ok) + 1 = 2'];
for (const text of readable) test(`readable diagnostics survive: ${text}`, () => assert.equal(scrubDeveloperText(text), text));
test('numeric boundaries and punctuation do not open holes in unknown tokens', () => {
  for (const value of ['12345', '12345.1', '1.12345', '123456.123456', 'abc12', 'abc12.', '(abc12)',
    'a=b', 'a:b', 'a?b', 'a#b', 'a@b', 'abc/def', 'deadBEEF', 'YWJjZA=='])
    assert.match(scrubDeveloperText(value), /\[value\]/, value);
});
for (const [input, expected] of [
  ['https://u:p@ab3.example.invalid/reset/Ab3dE7gH9k?key=briefvalue#tail', 'https://[sub].example.invalid/reset/[seg]'],
  ['https://482913.example.invalid/verify/482913', 'https://[sub].example.invalid/verify/[seg]'],
  ['localhost:3000/api/reset?key=briefvalue#tail', 'localhost:3000/api/reset'],
  ['api.example.com?k=briefvalue', 'api.example.com'],
  ['/api/reset?key=briefvalue#tail', '/api/reset'],
  ['../api/reset?key=briefvalue', '../api/reset'],
  ['https://example.invalid/app-v.js/alpha_beta/app1.js/1234', 'https://example.invalid/app-v.js/[seg]/[seg]/[seg]'],
  ['https://example.invalid/abcdefghijklmnopqrstu', 'https://example.invalid/[seg]'],
  ['https://example.invalid/%41b3dE7gH9k/%72eady', 'https://example.invalid/[seg]/ready'],
  ['https://ab\u200b3.example.invalid/reset/Ab3\u00addE7gH9k', 'https://[sub].example.invalid/reset/[seg]'],
]) test(`URL allowlist and query removal: ${input}`, () => {
  assert.equal(safeDeveloperURL(input), expected);
  assert.equal(scrubDeveloperText('load ' + input), 'load ' + expected);
});
test('relative URLs after punctuation lose queries and fragments', () => {
  for (const prefix of ['failed:', 'failed=', 'failed!', 'failed;', 'failed,', 'failed(', 'failed[', 'failed{', 'failed-', 'failed_', 'failed.']) {
    const text = scrubDeveloperText(prefix + '/api/reset?key=briefvalue#tail');
    assert.match(text, /\/api\/reset/); assert.doesNotMatch(text, /briefvalue|tail|\?key|#tail/);
  }
});
test('URL and stack handling never exempts a later credential label', () => {
  for (const text of ['load https://example.invalid/api api.key=briefvalue tail',
    'at app.js:1:2 key=briefvalue tail', 'Compiled with exit code 1 token briefvalue tail',
    'code splitting enabled passphrase briefvalue tail']) {
    assert.match(scrubDeveloperText(text), /\[omitted\]/);
    assert.doesNotMatch(scrubDeveloperText(text), /briefvalue|tail/);
  }
});
test('credential labels and known credential prefixes in URL paths remain hidden', () => {
  for (const path of ['token/shortsecret/orders', '%74oken/shortsecret/orders',
    'sk-shortkey', 'xoxb-shortkey', 'ghp_shortkey', 'eyJhbGciOiJIUzI1NiJ9']) {
    const text = safeDeveloperURL('https://example.invalid/' + path);
    assert.match(text, /\[seg\]/);
    assert.doesNotMatch(text, /shortsecret|shortkey|eyJhbGciOiJIUzI1NiJ9/);
  }
});
test('stack frames preserve only the bounded file name and line:column', () => {
  for (const text of ['at app.js:1:2', 'at app_12-v.min.js:100:20', 'at fn (app.js:1:2)', 'at bundle:1:2'])
    assert.equal(scrubDeveloperText(text), text);
  assert.equal(scrubDeveloperText('at https://user:pass@example.invalid/Ab3dE7gH9k/app_12.js:1:2?key=briefvalue'),
    'at https://example.invalid/[seg]/app_12.js:1:2');
  assert.equal(scrubDeveloperText('at app.js:1:2?query=briefvalue#tail'), 'at app.js:1:2');
  assert.equal(scrubDeveloperText('at https://example.invalid/code.js:1:2'), 'at https://example.invalid/code.js:1:2');
});
test('non-web schemes, malformed inputs and oversized text fail closed', () => {
  for (const value of ['data:text/plain,briefvalue', 'file:///private/key', 'blob:https://example.invalid/private', 'bad', 'x'.repeat(9000)])
    assert.equal(safeDeveloperURL(value), '[URL omitted]');
  assert.equal(scrubDeveloperText('load data:text/plain,briefvalue'), 'load [URL omitted]');
  assert.equal(scrubDeveloperText('x'.repeat(4097)), '[long text omitted]');
  assert.equal(scrubDeveloperText(null), '[value]');
  assert.equal(scrubDeveloperText('ready\u001b\nline\u202e'), 'ready  line');
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
  f.cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'prior site message' }] });
  request(f.cdp, 'old', 'https://old.invalid/api');
  request(f.cdp, 'new', 'https://new.invalid/page?x=omitted', { type: 'Document' });
  f.cdp.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main', url: 'https://frame.invalid' } });
  assert.match(await f.reader.read({ console: true }), /prior site message/);
  f.cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://new.invalid/page?x=omitted' } });
  f.cdp.emit('Network.responseReceived', { requestId: 'old', response: { status: 555 } });
  f.cdp.emit('Network.responseReceived', { requestId: 'new', response: { status: 200 } });
  const text = await f.reader.read({ console: true, network: true });
  assert.match(text, /new.invalid\/page.*"status":200/);
  assert.doesNotMatch(text, /prior site message|old.invalid|555/);
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
