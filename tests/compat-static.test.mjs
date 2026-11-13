import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { BUNDLE, analyzeBundle, definesMember, engineDocs, findApp, plistString } from '../bench/compat/static.mjs';
import { checkDownloadUrl, download, latestItem, parseAppcast, unpack, verifySignature } from '../bench/compat/feed.mjs';
import { probeFeed, runFeed, sleightCommit, summary } from '../bench/compat-static.mjs';
import { recordedDocPath, recordedDocumentation } from './fixtures/engine-docs-26-1111.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const plist = version => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string>\n</dict></plist>\n`;
const docPath = name => join(dirname(BUNDLE.policy), `tinysky-alt-${name}.md`);
const coreDoc = docPath('core-cua-repl');
const nativeDoc = () => `## Computer Use\n\nControl apps.\n\n## API\n\n\`\`\`typescript\n${fixture('engine-api-26.1007.71326.ts')}\`\`\`\n\n## Notes\n\nNotes.\n`;
const browserRoot = join(dirname(dirname(dirname(BUNDLE.policy))), 'browser-desktop');

function temp(t) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-compat-static-')));
  // A download stopped at its size limit can still be opening its file when the test ends, so retry the removal.
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return dir;
}

// An unpacked ChatGPT.app holding only the files the static check reads, built from recorded engine text.
function bundle(root, { app = '26.1013.40934', engine = '26.1013.1001501', layout = 'legacy', drop = [], edit = {} } = {}) {
  const dir = join(root, 'ChatGPT.app');
  const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), edit[rel] ?? text); };
  put(BUNDLE.appInfo, plist(app));
  put(BUNDLE.helperInfo, plist(engine));
  put(BUNDLE.node, 'binary');
  const cellParser = 'parseModule(code, {next:true,module:true,ranges:true,loc:false,disableWebCompat:true,onToken:diagnosticTokens,onComment(_kind,_value,start,end){ diagnosticComments.push({start,end}); }})';
  put(BUNDLE.nodeRepl, 'x\0codetimeout_msserver_instructions\0js_reset\0turn_ended\0hook_event_name\0x-codex-turn-metadatasession_idturn_id\0MCP elicitation request cancelled\0Meriyah v7.0.0\0' + cellParser + '\0' + cellParser);
  put(BUNDLE.replBin, 'import "@oai/cua-repl";');
  put(BUNDLE.launch, 'const _=i.env.CUA_REPL_NODE_REPL_PATH,c=i.env.CUA_REPL_ENABLED_SURFACES;tools:{js:{},js_reset:{}};NODE_REPL_TOOL_OVERRIDES:1');
  if (layout === 'legacy') {
    put(coreDoc, nativeDoc());
    put(docPath('core-node-repl'), 'Node documentation.\n');
  } else {
    put(docPath('core-cua-repl-mac'), nativeDoc());
    for (const name of ['core-cua-repl-no-cua', 'core-node-repl-mac', 'core-node-repl-no-cua', 'core-cua-repl-linux', 'core-cua-repl-windows'])
      put(docPath(name), `Not the Mac computer API: ${name}.\n`);
  }
  put(BUNDLE.policy, fixture('engine-confirmations-policy.txt'));
  put(docPath('audio'), 'Audio documentation.\n');
  put(docPath('other-browser-apis'), 'Browser documentation.\n');
  put(join(BUNDLE.tinysky, 'create_documentation.js'), layout === 'legacy' ? 'const i=yield n(t);' : 'n(`${t}-${i}`)');
  put(join(browserRoot, 'scripts/browser-service.mjs'), 'l=["# Selected Browser",`- Name: ${t.name}`,`- Type: ${t.type}`,`- ID: ${t.id}`,"Reuse.","Recover."].join');
  put(join(browserRoot, 'environment-docs/codex-app/documents.json'), '[]');
  put(join(browserRoot, 'environment-docs/codex-app/api.json'), '{"root":"Agent","interfaces":{"Agent":{}},"types":{}}');
  // The recorded js description split at its first three blank lines: launch.js joins its four parts with blank lines.
  const description = fixture('engine-js-description.txt').trimEnd();
  const cuts = []; for (let at = -1; cuts.length < 3;) { at = description.indexOf('\n\n', at + 1); cuts.push(at); }
  const parts = [description.slice(0, cuts[0]), description.slice(cuts[0] + 2, cuts[1]), description.slice(cuts[1] + 2, cuts[2]), description.slice(cuts[2] + 2)];
  // Its second part stands in for browser-disabled.md, the one sleight's default CUA_REPL_ENABLED_SURFACES=computer uses.
  ['macos/description', 'browser-disabled', 'macos/computer', 'macos/output'].forEach((name, i) => put(join(BUNDLE.instructions, `${name}.md`), parts[i] + '\n'));
  put(join(BUNDLE.instructions, 'macos/browser.md'), 'Browser guidance.\n');
  put(join(BUNDLE.tinysky, 'create_tinysky_alt.js'), 'const x={getApp(t){},getState(){},listApps(){},listBrowsers(){},getBrowser(){},getTab(){},createBrowserTab(){},listTabs(){}};');
  put(join(BUNDLE.tinysky, 'bind_mac_app.js'), 'class A{getAXState(){}getScreenshot(){}getAXStateAndScreenshot(){}click(){}drag(){}scroll(){}selectText(){}setValue(){}performSecondaryAction(){}paste(){}pressKey(){}typeText(){}}');
  put(join(BUNDLE.plugin, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: { command: 'node', enabled_tools: ['js', 'js_reset', 'turn_ended'] } } }));
  put(join(BUNDLE.plugin, '.codex-plugin/plugin.json'), JSON.stringify({ hooks: { Stop: [{ tool: 'turn_ended', input: { hook_event_name: 1, session_id: 1, turn_id: 1 } }] } }));
  if (layout === '26.1111') recordedDocumentation(put, { core: nativeDoc(), policy: fixture('engine-confirmations-policy.txt') });
  for (const rel of drop) rmSync(join(dir, rel), { recursive: true, force: true });
  return dir;
}

test('a bundle built from the recorded engine passes every static check', t => {
  const report = analyzeBundle(bundle(temp(t)));
  assert.equal(report.appVersion, '26.1013.40934');
  assert.equal(report.engineVersion, '26.1013.1001501');
  // The fixture core doc has no Workflow section (its lines are pinned by hash only), so that rewrite warns here.
  assert.deepEqual(report.results.filter(r => r.status !== 'pass').map(r => r.id), ['workflow-rewrite']);
  assert.match(report.fingerprint, /^[0-9a-f]{64}$/);
});
test('split documentation reaches the Mac API checks and private doc export', t => {
  const dir = bundle(temp(t), { layout: 'split' });
  const report = analyzeBundle(dir);
  assert.equal(report.results.find(r => r.id === 'bundle-layout')?.status, 'pass');
  for (const id of ['api-contract', 'doc-headings', 'repl-methods'])
    assert.equal(report.results.find(r => r.id === id)?.status, 'pass', id);
  assert.equal(report.results.filter(r => r.status === 'fail').length, 0);
  assert.equal(engineDocs(dir)['api.md'], nativeDoc());
});

test('26.1111 recorded paths pass compatibility and a genuinely missing core still fails', t => {
  const dir = bundle(temp(t), { layout: '26.1111', app: '26.1111.21308', engine: '26.1111.1001923' });
  const report = analyzeBundle(dir);
  assert.equal(report.appVersion, '26.1111.21308');
  assert.equal(report.engineVersion, '26.1111.1001923');
  assert.equal(report.results.find(r => r.id === 'bundle-layout')?.status, 'pass');
  assert.equal(report.results.filter(r => r.status === 'fail').length, 0);
  assert.equal(engineDocs(dir)['api.md'], nativeDoc());
  rmSync(join(dir, recordedDocPath('core-cua-repl-mac')));
  writeFileSync(join(dir, coreDoc), nativeDoc());
  assert.equal(analyzeBundle(dir).results[0].status, 'fail');
  assert.throws(() => engineDocs(dir), { code: 'ENOENT' });
});
// 26.1029 moved the launch environment out of launch.js into an environment.js that launch.js imports.
test('launch-env reads environment.js only when launch.js imports it, never through a link', t => {
  const env = join(dirname(BUNDLE.launch), 'environment.js');
  const names = 'const _=i.env.CUA_REPL_NODE_REPL_PATH,c=i.env.CUA_REPL_ENABLED_SURFACES;tools:{js:{},js_reset:{}};NODE_REPL_TOOL_OVERRIDES:1';
  const launchEnv = dir => analyzeBundle(dir).results.find(r => r.id === 'launch-env');
  const split = bundle(temp(t), { edit: { [BUNDLE.launch]: 'import{create_launch_environment as i}from"./environment.js";const p=i.env.CUA_REPL_NODE_REPL_PATH;' } });
  writeFileSync(join(split, env), names);
  assert.equal(launchEnv(split).status, 'pass');
  // The same environment.js beside a launch.js that doesn't import it proves nothing about the launcher.
  const unimported = bundle(temp(t), { edit: { [BUNDLE.launch]: 'const p=i.env.CUA_REPL_NODE_REPL_PATH;' } });
  writeFileSync(join(unimported, env), names);
  assert.equal(launchEnv(unimported).status, 'fail');
  assert.match(launchEnv(unimported).reason, /CUA_REPL_ENABLED_SURFACES, NODE_REPL_TOOL_OVERRIDES, js_reset/);
  // An imported environment.js that is a symbolic link fails rather than being followed.
  const linked = bundle(temp(t), { edit: { [BUNDLE.launch]: 'import{create_launch_environment as i}from"./environment.js";const p=i.env.CUA_REPL_NODE_REPL_PATH;' } });
  const outside = join(temp(t), 'environment.js');
  writeFileSync(outside, names);
  symlinkSync(outside, join(linked, env));
  assert.equal(launchEnv(linked).status, 'fail');
});
test('a Linux checker still selects the Mac document from the macOS bundle', t => {
  const dir = bundle(temp(t), { layout: 'split' });
  const module = new URL('../bench/compat/static.mjs', import.meta.url).href;
  const code = `Object.defineProperty(process, 'platform', { value: 'linux' });
    const { analyzeBundle, engineDocs } = await import(${JSON.stringify(module)});
    console.log(JSON.stringify({ report: analyzeBundle(process.argv[1]), docs: engineDocs(process.argv[1]) }));`;
  const { report, docs } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, dir], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' }));
  assert.equal(report.results.find(r => r.id === 'api-contract')?.status, 'pass');
  assert.equal(docs['api.md'], nativeDoc());
});
test('a missing split Mac doc fails even when the retired single doc exists', t => {
  const dir = bundle(temp(t), { layout: 'split', drop: [docPath('core-cua-repl-mac')] });
  writeFileSync(join(dir, coreDoc), nativeDoc());
  const report = analyzeBundle(dir);
  assert.equal(report.results[0].status, 'fail');
  assert.match(report.results[0].reason, /coreDoc/);
  assert.equal(report.results.some(r => r.id === 'api-contract'), false);
  assert.equal(report.fingerprint, undefined);
  assert.throws(() => engineDocs(dir), /ENOENT/);
});
test('an unknown documentation builder fails instead of guessing from filenames', t => {
  const dir = bundle(temp(t), { edit: { [join(BUNDLE.tinysky, 'create_documentation.js')]: 'unknown reader' } });
  const report = analyzeBundle(dir);
  assert.equal(report.results[0].status, 'fail');
  assert.equal(report.fingerprint, undefined);
  assert.throws(() => engineDocs(dir), /Unknown engine core documentation format/);
});
test('documentation discovery refuses symlinks and manifest paths outside the bundle', t => {
  const root = temp(t);
  const linked = bundle(join(root, 'linked'));
  const service = join(linked, browserRoot, 'scripts/browser-service.mjs');
  rmSync(service);
  symlinkSync('/etc/hosts', service);
  assert.equal(analyzeBundle(linked).results[0].status, 'fail');
  assert.throws(() => engineDocs(linked), /symbolic link/);
  const escaped = bundle(join(root, 'escaped'), { edit: {
    [join(browserRoot, 'environment-docs/codex-app/documents.json')]: JSON.stringify([{ name: '../'.repeat(30) + 'outside', mode: 'included' }]),
  } });
  assert.equal(analyzeBundle(escaped).results[0].status, 'fail');
  assert.throws(() => engineDocs(escaped), /outside the bundle/);
});
test('the installed native API format has a separate conservative compatibility check', t => {
  const report = analyzeBundle(bundle(temp(t), { edit: { [coreDoc]: fixture('native-api-docs.txt') } }));
  const check = report.results.find(r => r.id === 'documentation-format');
  assert.equal(check?.status, 'pass');
  assert.equal(check.removedCharacters, 201);
});

test('missing files, members and strings fail by sleight\'s names, never with engine text', t => {
  const root = temp(t);
  const dir = bundle(root, { drop: [BUNDLE.helperInfo], edit: {
    [BUNDLE.nodeRepl]: 'code js_reset turn_ended hook_event_name session_id turn_id elicitation',
    [join(BUNDLE.tinysky, 'bind_mac_app.js')]: 'class A{getAXState(){}click(){}} x.typeText(1)',
  } });
  const results = Object.fromEntries(analyzeBundle(dir).results.map(r => [r.id, r]));
  assert.equal(results['bundle-layout'].status, 'fail');
  assert.match(results['bundle-layout'].reason, /helperInfo/);
  assert.match(results['tool-schema'].reason, /timeout_ms, x-codex-turn-metadata/);
  assert.match(results['repl-methods'].reason, /App\.typeText/);
  assert.ok(!JSON.stringify(results).includes('Computer Use Confirmations'));
});

test('a symbolic link among the files the check reads stops it', t => {
  const root = temp(t);
  const dir = bundle(root);
  rmSync(join(dir, BUNDLE.policy));
  symlinkSync('/etc/hosts', join(dir, BUNDLE.policy));
  const report = analyzeBundle(dir);
  assert.equal(report.results.length, 1);
  assert.match(report.results[0].reason, /refusing 1 symbolic link/);
  const linked = bundle(join(root, 'two'));
  rmSync(join(linked, BUNDLE.tinysky), { recursive: true });
  symlinkSync(root, join(linked, BUNDLE.tinysky));
  assert.equal(analyzeBundle(linked).results[0].status, 'fail');
});

test('a changed js description or policy warns; a bundle without the engine stops early', t => {
  const root = temp(t);
  const dir = bundle(root, { edit: { [join(BUNDLE.instructions, 'macos/output.md')]: 'New output rules.\n',
    [BUNDLE.policy]: fixture('engine-confirmations-policy.txt').replace('Delete data', 'Remove data') } });
  const results = Object.fromEntries(analyzeBundle(dir).results.map(r => [r.id, r.status]));
  assert.equal(results['js-description'], 'warn');
  assert.equal(results['policy-rewrite'], 'warn');
  const bare = analyzeBundle(bundle(join(root, 'bare'), { drop: [coreDoc] }));
  assert.deepEqual(bare.results.map(item => item.id), ['bundle-layout', 'tool-schema', 'cell-parser']);
  assert.equal(bare.results.find(item => item.id === 'cell-parser').status, 'pass');
  assert.equal(bare.fingerprint, undefined);
});

test('helpers: plist strings, member definitions, finding the app', t => {
  assert.equal(plistString(plist('1.2'), 'CFBundleShortVersionString'), '1.2');
  assert.ok(definesMember('x={getApp(t){}}', 'getApp'));
  assert.ok(definesMember('{getApp:function(){}}', 'getApp'));
  assert.ok(definesMember('{getApp:(a,b)=>a}', 'getApp'));
  assert.ok(definesMember('x.y=1;getApp=async t=>t', 'getApp'));
  for (const mention of ['cua.getApp(t)', 'f(getApp(t))', '{getApp:1}', 'x.getApp=()=>1']) assert.ok(!definesMember(mention, 'getApp'), mention);
  const root = temp(t);
  bundle(join(root, 'volume', 'ChatGPT 26'));
  assert.equal(findApp(root), join(root, 'volume', 'ChatGPT 26', 'ChatGPT.app'));
  assert.equal(findApp(join(root, 'volume', 'none')), undefined);
});

const appcast = items => `<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>${items.map(item =>
  `<item><title>ChatGPT</title>${item.channel ? `<sparkle:channel>${item.channel}</sparkle:channel>` : ''}<sparkle:version>${item.build}</sparkle:version><sparkle:shortVersionString>${item.version}</sparkle:shortVersionString><enclosure url="${item.url}" length="10" type="application/octet-stream" sparkle:edSignature="${item.sig ?? 'c2ln'}"/></item>`).join('')}</channel></rss>`;

test('the appcast parser picks the newest default-channel release', () => {
  const items = parseAppcast(appcast([
    { version: '26.1013.40934', build: '20770', url: 'https://persistent.oaistatic.com/a.zip' },
    { version: '26.1020.1', build: '20900', url: 'https://persistent.oaistatic.com/b.zip', channel: 'beta' },
    { version: '26.1007.1', build: '20500', url: 'https://persistent.oaistatic.com/c.zip' },
  ]));
  assert.equal(items.length, 3);
  assert.deepEqual(latestItem(items), { version: '26.1013.40934', build: '20770', url: 'https://persistent.oaistatic.com/a.zip', length: 10, edSignature: 'c2ln', channel: undefined });
  assert.equal(latestItem(parseAppcast('<rss></rss>')), undefined);
  // Delta archives patch an older app, so the full enclosure is the one taken, with its entities decoded.
  const delta = parseAppcast(`<item><sparkle:version>2</sparkle:version><sparkle:deltas><enclosure url="https://persistent.oaistatic.com/d.delta" sparkle:deltaFrom="1"/></sparkle:deltas><enclosure url="https://persistent.oaistatic.com/d2.delta" sparkle:deltaFrom="1"/><enclosure url="https://persistent.oaistatic.com/a.zip?x=1&amp;y=&#38;&quot;" sparkle:edSignature="c2ln"/></item>`);
  assert.equal(delta[0].url, 'https://persistent.oaistatic.com/a.zip?x=1&y=&"');
  assert.throws(() => checkDownloadUrl('http://persistent.oaistatic.com/a.zip'), /refusing/);
  assert.throws(() => checkDownloadUrl('https://evil.example/a.zip'), /refusing/);
  assert.ok(checkDownloadUrl('https://persistent.oaistatic.com/a.zip'));
});

test('downloads stop at the size limit, and the Sparkle signature is checked against the key', async t => {
  const dir = temp(t);
  const body = Buffer.from('PK\x03\x04 release bytes');
  const fetchImpl = async () => new Response(body, { status: 200 });
  const path = join(dir, 'release');
  assert.equal(await download('https://persistent.oaistatic.com/a.zip', path, { fetchImpl }), body.length);
  // Every redirect hop is checked, and there are at most five.
  const redirect = to => new Response(null, { status: 302, headers: { location: to } });
  let hops = 0;
  const viaCdn = async url => (url.endsWith('/a.zip') ? redirect('https://cdn.oaistatic.com/b.zip') : new Response(body, { status: 200 }));
  assert.equal(await download('https://persistent.oaistatic.com/a.zip', join(dir, 'hop'), { fetchImpl: viaCdn }), body.length);
  await assert.rejects(download('https://persistent.oaistatic.com/a.zip', join(dir, 'evil'), { fetchImpl: async () => redirect('https://evil.example/x') }), /refusing/);
  await assert.rejects(download('https://persistent.oaistatic.com/a.zip', join(dir, 'loop'), { fetchImpl: async () => (hops++, redirect('https://persistent.oaistatic.com/a.zip')) }), /more than 5 redirects/);
  assert.equal(hops, 6);
  await assert.rejects(download('https://persistent.oaistatic.com/a.zip', join(dir, 'big'), { fetchImpl, maxBytes: 4 }), /larger than 4/);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const signature = sign(null, readFileSync(path), privateKey).toString('base64');
  assert.equal(verifySignature(path, signature, key), true);
  writeFileSync(path, 'tampered');
  assert.equal(verifySignature(path, signature, key), false);
  assert.equal(verifySignature(path, undefined, key), false);
});

test('unpack uses unzip for a zip and 7-Zip twice for a disk image', async t => {
  const dir = temp(t);
  const calls = [];
  writeFileSync(join(dir, 'a.zip'), 'PK\x03\x04');
  await unpack(join(dir, 'a.zip'), join(dir, 'out'), { run: async (cmd, args) => calls.push([cmd, args[0]]) });
  writeFileSync(join(dir, 'b.dmg'), 'koly');
  mkdirSync(join(dir, 'img'));
  await unpack(join(dir, 'b.dmg'), join(dir, 'img'), { which: tool => tool === '/usr/bin/7zz', run: async (cmd, args) => {
    calls.push([cmd, args.at(-1).split('/').at(-1)]);
    if (args.at(-1).endsWith('b.dmg')) writeFileSync(join(dir, 'img', '4.apfs'), '');
  } });
  assert.deepEqual(calls, [['unzip', '-q'], ['/usr/bin/7zz', 'b.dmg'], ['/usr/bin/7zz', '4.apfs']]);
  await assert.rejects(unpack(join(dir, 'b.dmg'), join(dir, 'img'), { which: () => false }), /needs 7-Zip/);
});

test('the feed run checks a new release once, records it, and bounds incomplete attempts', async t => {
  const root = temp(t);
  const state = join(root, 'state');
  const source = bundle(join(root, 'source'));
  let version = '26.1013.40934';
  const fetchImpl = async () => new Response(appcast([{ version, build: version.split('.').at(-1), url: 'https://persistent.oaistatic.com/r.zip' }]));
  const logs = [];
  const deps = { state, fetchImpl, log: line => logs.push(line), now: () => new Date('2026-10-19T05:00:00Z'), verifyImpl: () => true,
    downloadImpl: async (url, path) => writeFileSync(path, 'PK'), unpackImpl: async (archive, out) => cpSync(source, join(out, 'ChatGPT.app'), { recursive: true }) };
  assert.equal(await probeFeed(deps), true);
  const first = await runFeed(deps);
  assert.equal(await probeFeed(deps), false);
  assert.equal(first.exit, 0);
  assert.equal(first.report.verdict, 'pass');
  assert.equal(first.report.checkedAt, '2026-10-19T05:00:00.000Z');
  assert.equal(first.report.fingerprintChanged, null);
  assert.equal(JSON.parse(readFileSync(join(state, 'last.json'), 'utf8')).version, version);
  assert.match(summary(first.report), /^static compat 26\.1013\.40934 \(engine 26\.1013\.1001501\): PASS/);
  assert.equal((await runFeed(deps)).unchanged, true);

  version = '26.1014.1';
  assert.equal((await runFeed({ ...deps, downloadImpl: async () => { throw new Error('HTTP 503'); } })).exit, 2);
  assert.equal(JSON.parse(readFileSync(join(state, 'last.json'), 'utf8')).version, '26.1013.40934');
  // A check that couldn't finish retries on the next runs, then is recorded after the third attempt.
  for (const attempt of [1, 2]) {
    const unsigned = await runFeed({ ...deps, verifyImpl: () => false });
    assert.equal(unsigned.exit, 2);
    assert.equal(unsigned.report.attempt, attempt);
    assert.equal(unsigned.report.sleight, sleightCommit());
    assert.equal(unsigned.report.steps[0].id, 'signature');
    assert.equal(JSON.parse(readFileSync(join(state, 'last.json'), 'utf8')).version, '26.1013.40934');
  }
  assert.equal((await runFeed({ ...deps, unpackImpl: async () => { throw Object.assign(new Error('7z: Data Error in engine text'), { code: 2 }); } })).report.steps[0].reason, 'unpacking failed (exit 2)');
  assert.equal(JSON.parse(readFileSync(join(state, 'last.json'), 'utf8')).verdict, 'error');
  assert.equal(JSON.parse(readFileSync(join(state, 'last.json'), 'utf8')).sleight, sleightCommit());
  // The unchanged path keeps the last verdict's exit code.
  const repeat = await runFeed(deps);
  assert.deepEqual([repeat.unchanged, repeat.exit], [true, 2]);
  const forced = await runFeed({ ...deps, force: true });
  assert.equal(forced.report.steps.find(s => s.id === 'feed-version').status, 'warn');
  assert.equal(forced.report.fingerprintChanged, null);
  assert.equal(readFileSync(join(state, 'results.jsonl'), 'utf8').trim().split('\n').length, 5);
  assert.equal((await runFeed({ ...deps, fetchImpl: async () => new Response('', { status: 500 }) })).exit, 2);
  version = '26 1015; rm -rf';
  assert.equal((await runFeed(deps)).exit, 2);
  assert.match(logs.at(-1), /not a plain version/);
  assert.ok(!logs.join('\n').includes('Computer Use Confirmations'));
});

test('probe and run retry a failed build after a sleight change, then record the repaired result', async t => {
  const root = temp(t);
  const state = join(root, 'state');
  const source = bundle(join(root, 'source'), { drop: [coreDoc] });
  const commit = sleightCommit();
  assert.ok(commit);
  let downloads = 0;
  const deps = { state, log: () => {}, now: () => new Date('2026-10-19T05:00:00Z'), verifyImpl: () => true,
    fetchImpl: async () => new Response(appcast([{ version: '26.1013.40934', build: '40934', url: 'https://persistent.oaistatic.com/r.zip' }])),
    downloadImpl: async (url, path) => { downloads++; writeFileSync(path, 'PK'); },
    unpackImpl: async (archive, out) => cpSync(source, join(out, 'ChatGPT.app'), { recursive: true }) };
  const lastPath = join(state, 'last.json');
  const failed = await runFeed(deps);
  assert.equal(failed.exit, 1);
  assert.equal(failed.report.sleight, commit);
  const last = JSON.parse(readFileSync(lastPath, 'utf8'));
  assert.deepEqual(last, { version: '26.1013.40934', build: '40934', checkedAt: failed.report.checkedAt,
    verdict: 'fail', sleight: commit });
  assert.equal(await probeFeed(deps), false);
  assert.deepEqual(await runFeed(deps), { exit: 1, unchanged: true });
  assert.equal(downloads, 1);

  writeFileSync(lastPath, JSON.stringify({ ...last, sleight: `${commit}-previous` }));
  writeFileSync(join(source, coreDoc), nativeDoc());
  assert.equal(await probeFeed(deps), true);
  assert.equal(downloads, 1, 'probing never downloads the bundle');
  const repaired = await runFeed(deps);
  assert.equal(repaired.exit, 0);
  assert.equal(repaired.report.verdict, 'pass');
  assert.equal(repaired.report.sleight, commit);
  assert.equal(downloads, 2);
  assert.deepEqual(JSON.parse(readFileSync(lastPath, 'utf8')), {
    ...last, verdict: 'pass', sleight: commit, fingerprint: repaired.report.fingerprint,
  });
  const results = readFileSync(join(state, 'results.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(results.map(result => [result.verdict, result.sleight]), [['fail', commit], ['pass', commit]]);
  assert.equal(await probeFeed(deps), false);
  assert.deepEqual(await runFeed(deps), { exit: 0, unchanged: true });
  assert.equal(downloads, 2);
});

test('matching-build skips preserve passes and errors; legacy failures retry once per sleight commit', async t => {
  const root = temp(t);
  const source = bundle(join(root, 'source'), { drop: [coreDoc] });
  const commit = sleightCommit();
  assert.ok(commit);
  const cases = [
    { name: 'pass-same', verdict: 'pass', sleight: commit, retry: false, exit: 0 },
    { name: 'pass-changed', verdict: 'pass', sleight: `${commit}-previous`, retry: false, exit: 0 },
    { name: 'pass-legacy', verdict: 'pass', retry: false, exit: 0 },
    { name: 'fail-same', verdict: 'fail', sleight: commit, retry: false, exit: 1 },
    { name: 'fail-changed', verdict: 'fail', sleight: `${commit}-previous`, retry: true, exit: 1 },
    { name: 'fail-legacy', verdict: 'fail', retry: true, exit: 1 },
    { name: 'error-changed', verdict: 'error', sleight: `${commit}-previous`, retry: false, exit: 2 },
    { name: 'new-build', verdict: 'pass', sleight: commit, build: 'older', retry: true, exit: 1 },
    { name: 'new-version', verdict: 'pass', sleight: commit, version: '26.1012.1', retry: true, exit: 1 },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const state = join(root, entry.name);
    mkdirSync(state);
    const lastPath = join(state, 'last.json');
    const last = { version: entry.version ?? '26.1013.40934', build: entry.build ?? '40934', checkedAt: '2026-10-19T05:00:00.000Z',
      verdict: entry.verdict, sleight: entry.sleight, fingerprint: 'previous-fingerprint' };
    writeFileSync(lastPath, JSON.stringify(last));
    const before = readFileSync(lastPath, 'utf8');
    let downloads = 0;
    const deps = { state, log: () => {}, verifyImpl: () => true,
      fetchImpl: async () => new Response(appcast([{ version: '26.1013.40934', build: '40934', url: 'https://persistent.oaistatic.com/r.zip' }])),
      downloadImpl: async (url, path) => { downloads++; writeFileSync(path, 'PK'); },
      unpackImpl: async (archive, out) => cpSync(source, join(out, 'ChatGPT.app'), { recursive: true }) };
    assert.equal(await probeFeed(deps), entry.retry);
    const result = await runFeed(deps);
    assert.equal(result.exit, entry.exit);
    assert.equal(downloads, Number(entry.retry));
    if (entry.retry) {
      assert.equal(result.report.verdict, 'fail');
      assert.equal(result.report.fingerprintChanged, true);
      assert.equal(JSON.parse(readFileSync(lastPath, 'utf8')).sleight, commit);
      assert.equal(await probeFeed(deps), false);
      assert.deepEqual(await runFeed(deps), { exit: 1, unchanged: true });
      assert.equal(downloads, 1);
      assert.equal(readFileSync(join(state, 'results.jsonl'), 'utf8').trim().split('\n').length, 1);
    } else {
      assert.equal(result.unchanged, true);
      assert.equal(readFileSync(lastPath, 'utf8'), before);
      assert.equal(existsSync(join(state, 'results.jsonl')), false);
    }
  });
});

test('--keep-docs keeps the docs and a diff in the state folder and reports only line counts', async t => {
  const root = temp(t);
  const state = join(root, 'state');
  let version = '1.0';
  const sources = { '1.0': bundle(join(root, 'a'), { app: '1.0' }), '2.0': bundle(join(root, 'b'), { app: '2.0', edit: { [coreDoc]: '## Computer Use\n\n## API\n\n```typescript\ninterface X {}\n```\n' } }) };
  const deps = { state, keep: true, log: () => {}, verifyImpl: () => true, downloadImpl: async (url, path) => writeFileSync(path, 'PK'),
    fetchImpl: async () => new Response(appcast([{ version, build: version, url: 'https://persistent.oaistatic.com/r.zip' }])),
    unpackImpl: async (archive, out) => cpSync(sources[version], join(out, 'ChatGPT.app'), { recursive: true }) };
  await runFeed(deps);
  version = '2.0';
  const second = await runFeed(deps);
  assert.equal(second.report.verdict, 'fail');
  assert.equal(second.report.docsBaseline, '1.0');
  assert.ok(second.report.docsChangedLines > 100);
  assert.ok(existsSync(join(state, 'docs', '2.0.diff')));
  assert.equal(second.report.fingerprintChanged, true);
});
