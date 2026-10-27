// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { appRefusal, createPermissionCheck, lastUse, noteCurrentApp, pageRefusal, pageSite, permissionsPath, readPermissions, siteRefusal, stampUse, usedWords }
  from '../plugins/sleight/lib/permissions.mjs';
import { applyMenuEvent, blockSiteForUser, grantUses, permissionsCommand, permissionsDoctorLines, permissionsMenu } from '../plugins/sleight/lib/permissions-command.mjs';
import { SiteMemory } from '../plugins/sleight/lib/site-memory.mjs';
import { livePreapproved, PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';

const HOUR = 3600000;
function world(t) {
  const home = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-permissions-')))));
  const support = join(home, 'Library/Application Support/sleight'), logs = join(home, 'Library/Logs/sleight');
  mkdirSync(support, { recursive: true, mode: 0o700 }); mkdirSync(logs, { recursive: true, mode: 0o700 });
  const path = permissionsPath(home), lines = [];
  const records = [];
  const grants = { list: () => [...records], remove: key => { const at = records.findIndex(r => r.key === key); if (at < 0) return false; records.splice(at, 1); return true; } };
  const engineFile = join(home, 'engine-approvals.json');
  const options = { home, out: text => lines.push(text), grants: () => grants, logs, engineFile, now: () => 10 * 24 * HOUR, appNames: () => [], tty: true };
  const command = (args, extra = {}) => permissionsCommand(args, { ...options, ...extra });
  const write = (name, data, mode = 0o600) => { const file = join(support, name); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), { mode }); chmodSync(file, mode); return file; };
  const output = () => { const text = lines.join(''); lines.length = 0; return text; };
  return { home, support, logs, path, records, options, command, write, output, engineFile };
}

test('the permissions file: absent is empty, a link, a shared mode or an odd shape is unsafe', t => {
  const w = world(t);
  assert.deepEqual(readPermissions(w.path), { state: 'absent', apps: [], sites: [] });
  w.write('permissions.json', { version: 1, apps: [{ id: 'com.example.app', name: 'Example' }], sites: ['https://example.com'] });
  assert.deepEqual(readPermissions(w.path), { state: 'ok', apps: [{ id: 'com.example.app', name: 'Example' }], sites: ['https://example.com'] });
  w.write('permissions.json', { version: 1, apps: [], sites: [], only: ['https://a.example'] });
  assert.deepEqual(readPermissions(w.path).only, ['https://a.example']);
  w.write('permissions.json', { version: 1, apps: [], sites: [] }, 0o644);
  assert.equal(readPermissions(w.path).state, 'unsafe');
  for (const bad of [{ version: 2, apps: [], sites: [] }, { version: 1, apps: [{ id: 'not a bundle' }], sites: [] },
    { version: 1, apps: [], sites: ['example.com'] }, { version: 1, apps: [], sites: [], extra: 1 }, 'not json']) {
    w.write('permissions.json', bad);
    assert.equal(readPermissions(w.path).state, 'unsafe', JSON.stringify(bad));
  }
  const elsewhere = join(w.home, 'elsewhere.json'); writeFileSync(elsewhere, JSON.stringify({ version: 1, apps: [], sites: [] }), { mode: 0o600 });
  const linked = join(w.support, 'linked.json'); symlinkSync(elsewhere, linked);
  assert.equal(readPermissions(linked).state, 'unsafe');
});

test('refusal lines: a blocked app by bundle id or name, a blocked site, allow-only sites, and an unsafe file refuses everything', () => {
  const perms = { state: 'ok', apps: [{ id: 'com.example.app', name: 'Example App' }], sites: ['https://blocked.example'] };
  assert.equal(appRefusal(perms, { bundleId: 'com.example.app' }), 'You blocked sleight in Example App (sleight-mcp permissions unblock com.example.app lifts it).');
  assert.match(appRefusal(perms, { name: 'example app' }), /^You blocked sleight in Example App/);
  assert.match(appRefusal(perms, { bundleId: 'COM.EXAMPLE.APP' }), /^You blocked sleight/);
  assert.equal(appRefusal(perms, { bundleId: 'com.other.app', name: 'Other' }), undefined);
  assert.equal(siteRefusal(perms, 'https://blocked.example/path?q=1'), 'You blocked sleight on https://blocked.example (sleight-mcp permissions unblock https://blocked.example lifts it).');
  assert.equal(siteRefusal(perms, 'https://fine.example/'), undefined);
  // Only the browser runtime checks sites (Electron app turns get none), so a page that isn't http(s) there proves no site.
  assert.match(siteRefusal(perms, 'vscode-file://vscode-app/x'), /can't tell which site/);
  const only = { ...perms, only: ['https://a.example', 'https://b.example'] };
  assert.equal(siteRefusal(only, 'https://a.example/x'), undefined);
  assert.equal(siteRefusal(only, 'https://c.example/'), 'You allow sleight only on https://a.example and https://b.example, not https://c.example (sleight-mcp permissions lists them).');
  assert.match(siteRefusal(only, 'https://blocked.example/'), /^You blocked sleight on/);
  const unsafe = { state: 'unsafe', apps: [], sites: [] };
  for (const line of [appRefusal(unsafe, { bundleId: 'com.any.app' }), siteRefusal(unsafe, 'https://any.example/')]) {
    assert.equal(line, "sleight's permissions file is a link or has another owner, mode or format, so sleight acts nowhere until you run sleight-mcp permissions repair.");
  }
});

test('block, unblock and sites from the command write a private file that the check reads again at once', t => {
  const w = world(t);
  const check = createPermissionCheck({ path: w.path });
  assert.equal(check.app({ bundleId: 'com.example.app' }), undefined);
  assert.equal(w.command(['block', 'com.example.app']), 0);
  assert.match(w.output(), /sleight won't act in com\.example\.app from its next action, in every session\./);
  assert.equal(lstatSync(w.path).mode & 0o777, 0o600);
  assert.match(check.app({ bundleId: 'com.example.app' }), /^You blocked sleight in com\.example\.app/);
  assert.equal(w.command(['block', 'https://Example.COM/some/page']), 0);
  assert.deepEqual(readPermissions(w.path).sites, ['https://example.com']);
  assert.match(check.site('https://example.com/other'), /^You blocked sleight on https:\/\/example\.com/);
  assert.equal(w.command(['block', 'com.example.app']), 0); assert.match(w.output(), /already blocked/);
  assert.equal(w.command(['unblock', 'com.example.app']), 0); assert.match(w.output(), /sleight may act in com\.example\.app again/);
  assert.equal(check.app({ bundleId: 'com.example.app' }), undefined);
  assert.equal(w.command(['unblock', 'com.example.app']), 0); assert.match(w.output(), /isn't blocked/);
  assert.equal(w.command(['sites', 'only', 'https://a.example', 'https://b.example/x']), 0);
  assert.deepEqual(readPermissions(w.path).only, ['https://a.example', 'https://b.example']);
  assert.match(check.site('https://c.example/'), /^You allow sleight only on/);
  // Revoking a site takes it off the allow-only list.
  assert.equal(w.command(['revoke', 'https://b.example']), 0);
  assert.deepEqual(readPermissions(w.path).only, ['https://a.example']);
  assert.equal(w.command(['sites', 'all']), 0);
  assert.equal(readPermissions(w.path).only, undefined);
  assert.equal(check.site('https://c.example/'), undefined);
  for (const args of [['block'], ['block', 'not a target'], ['block', 'ftp://x.example'], ['sites'], ['sites', 'only'], ['sites', 'only', 'nope'], ['frobnicate']]) {
    assert.equal(w.command(args), 2, args.join(' ')); w.output();
  }
});

test('a site block covers its bare host, www., a trailing dot, subdomains, any port and both schemes, on turbo and the engine path', () => {
  const blocks = { state: 'ok', apps: [], sites: ['https://bestbuy.com'] };
  const LINE = 'You blocked sleight on https://bestbuy.com (sleight-mcp permissions unblock https://bestbuy.com lifts it).';
  for (const url of ['https://www.bestbuy.com/x', 'https://bestbuy.com./x', 'https://BestBuy.com:8443/', 'http://bestbuy.com/', 'https://m.bestbuy.com/', 'https://www.bestbuy.com.:443/']) {
    assert.equal(siteRefusal(blocks, url), LINE, url);
  }
  for (const page of [{ host: 'www.bestbuy.com' }, { host: 'bestbuy.com.' }, { host: 'bestbuy.com:8443', scheme: 'https' }, { host: 'm.bestbuy.com', scheme: 'http' }]) {
    assert.equal(pageRefusal(blocks, page), LINE, JSON.stringify(page));
  }
  assert.equal(siteRefusal(blocks, 'https://notbestbuy.com/'), undefined);
  assert.equal(pageRefusal(blocks, { host: 'notbestbuy.com' }), undefined);
  assert.match(siteRefusal({ ...blocks, sites: ['https://www.bestbuy.com'] }, 'https://bestbuy.com/'), /^You blocked sleight on https:\/\/www\.bestbuy\.com/);
});

test('www. comes off only when a dot remains, so a block on www.com never covers every .com site', () => {
  const blocks = { state: 'ok', apps: [], sites: ['https://www.com'] };
  assert.equal(siteRefusal(blocks, 'https://example.com/'), undefined);
  assert.equal(pageRefusal(blocks, { host: 'example.com' }), undefined);
  assert.match(siteRefusal(blocks, 'https://www.com/'), /^You blocked sleight on https:\/\/www\.com /);
  assert.match(siteRefusal(blocks, 'https://shop.www.com/'), /^You blocked sleight on https:\/\/www\.com /);
});

test('a block by bundle id with no names found says that getApp by name won\'t match it', t => {
  const w = world(t);
  assert.equal(w.command(['block', 'com.example.unknown']), 0);
  assert.equal(w.output(), "sleight won't act in com.example.unknown from its next action, in every session. macOS gave no name for it, so a getApp by the app's name won't match this block, though the read and actions after it still stop.\n");
});

test('allow-only treats www. and the bare host as one site and ignores a default port, but keeps the scheme, a port and subdomains apart', () => {
  const only = { state: 'ok', apps: [], sites: [], only: ['https://www.a.example'] };
  for (const url of ['https://a.example/x', 'https://a.example.:443/', 'https://WWW.A.EXAMPLE/']) assert.equal(siteRefusal(only, url), undefined, url);
  for (const url of ['http://a.example/', 'https://a.example:8443/', 'https://sub.a.example/']) assert.match(siteRefusal(only, url), /^You allow sleight only on https:\/\/www\.a\.example, not /, url);
  assert.equal(pageRefusal(only, { host: 'a.example' }), undefined);
  assert.equal(pageRefusal(only, { host: 'www.a.example.', scheme: 'https' }), undefined);
  assert.match(pageRefusal(only, { host: 'a.example:8443' }), /^You allow sleight only/);
});

test('turbo\'s site check fails closed while limits exist: credentials are judged by their host, and other schemes or no URL refuse', () => {
  const blocks = { state: 'ok', apps: [], sites: ['https://bestbuy.com'] };
  assert.match(siteRefusal(blocks, 'https://u:p@bestbuy.com/'), /^You blocked sleight on https:\/\/bestbuy\.com /);
  for (const url of ['blob:https://bestbuy.com/0d5c', 'view-source:https://bestbuy.com/', 'data:text/html,x', 'file:///x.html', 'chrome://settings', undefined, '', 'not a url']) {
    assert.match(siteRefusal(blocks, url), /^You limited the sites sleight acts on, and it can't tell which site this tab shows/, String(url));
  }
  assert.equal(siteRefusal(blocks, 'about:blank'), undefined, 'a blank tab shows no site');
  const only = { state: 'ok', apps: [], sites: [], only: ['https://a.example'] };
  assert.equal(siteRefusal(only, 'https://u:p@a.example/'), undefined);
  assert.match(siteRefusal(only, 'https://u:p@b.example/'), /not https:\/\/b\.example /);
  assert.match(siteRefusal(only, 'blob:https://a.example/1'), /can't tell which site/);
  const none = { state: 'ok', apps: [], sites: [] };
  for (const url of ['blob:x', undefined, 'https://u:p@bestbuy.com/']) assert.equal(siteRefusal(none, url), undefined, 'without limits nothing is checked');
});

test('the command compares sites the way the checks do', t => {
  const w = world(t);
  assert.equal(w.command(['block', 'https://example.com']), 0); w.output();
  assert.equal(w.command(['block', 'https://www.example.com/x']), 0);
  assert.match(w.output(), /^https:\/\/www\.example\.com is already blocked/);
  assert.equal(w.command(['unblock', 'http://www.example.com.']), 0);
  assert.match(w.output(), /^sleight may act on http:\/\/www\.example\.com\. again/);
  assert.deepEqual(readPermissions(w.path).sites, []);
  assert.equal(w.command(['sites', 'only', 'https://a.example', 'https://www.a.example', 'https://b.example']), 0); w.output();
  assert.deepEqual(readPermissions(w.path).only, ['https://a.example', 'https://b.example']);
  assert.equal(w.command(['revoke', 'https://www.b.example']), 0);
  assert.deepEqual(readPermissions(w.path).only, ['https://a.example']);
  assert.equal(w.command(['revoke', 'https://www.a.example']), 1, 'the last site stays, however it is spelled');
});

test('a permissions file that disappears after a session read it refuses every action until repair writes a new one', t => {
  const w = world(t);
  w.write('permissions.json', { version: 1, apps: [], sites: ['https://blocked.example'] });
  const check = createPermissionCheck({ path: w.path });
  assert.equal(check.app({ bundleId: 'com.any.app' }), undefined);
  rmSync(w.path);
  const line = "sleight's permissions file is gone since this session read it, so sleight acts nowhere until you run sleight-mcp permissions repair.";
  assert.equal(check.app({ bundleId: 'com.any.app' }), line);
  assert.equal(check.site('https://fine.example/'), line);
  assert.equal(check.page({ host: 'fine.example' }), line);
  assert.equal(check.sitesLimited(), true);
  assert.equal(w.command(['repair']), 0);
  assert.match(w.output(), /^Wrote an empty permissions\.json\. The old one is gone, and its blocks with it/);
  assert.deepEqual(readPermissions(w.path), { state: 'ok', apps: [], sites: [] });
  assert.equal(check.app({ bundleId: 'com.any.app' }), undefined, 'repair lets the session act again');
  // A session that never read a file has nothing to miss.
  rmSync(w.path);
  assert.equal(createPermissionCheck({ path: w.path }).app({ bundleId: 'com.any.app' }), undefined);
});

test('a block by bundle id stores the app\'s names, so a display name, a path or a .app name matches it too', t => {
  const w = world(t), asked = [];
  assert.equal(w.command(['block', 'com.example.editor'], { appNames: id => { asked.push(id); return ['Example Editor', 'Editor', 'com.example.editor', 'example editor']; } }), 0);
  assert.match(w.output(), /^sleight won't act in Example Editor \(com\.example\.editor\) from its next action, in every session\.\n$/);
  assert.deepEqual(asked, ['com.example.editor']);
  assert.deepEqual(readPermissions(w.path).apps, [{ id: 'com.example.editor', name: 'Example Editor', aliases: ['Editor'] }]);
  const check = createPermissionCheck({ path: w.path });
  for (const name of ['Example Editor', 'editor', '/Applications/Example Editor.app', 'Example Editor.app']) {
    assert.match(check.app({ bundleId: name, name }), /^You blocked sleight in Example Editor \(sleight-mcp permissions unblock com\.example\.editor lifts it\)\.$/, name);
  }
  assert.equal(check.app({ name: 'Other Editor' }), undefined);
  // A file with aliases is repaired with them.
  chmodSync(w.path, 0o644);
  assert.equal(w.command(['repair']), 0); w.output();
  assert.deepEqual(readPermissions(w.path).apps, [{ id: 'com.example.editor', name: 'Example Editor', aliases: ['Editor'] }]);
});

test('open_file never opens sleight\'s own settings folder or a file in it, by its path or through a link', async t => {
  const { openDocument } = await import('../plugins/sleight/lib/launch.mjs');
  const w = world(t), opened = [], resolved = [];
  w.write('permissions.json', { version: 1, apps: [], sites: [] });
  const link = join(w.home, 'notes.json'); symlinkSync(w.path, link);
  for (const path of [w.path, link, join(w.support, 'preapproved.json')]) {
    writeFileSync(join(w.support, 'preapproved.json'), '{}', { mode: 0o600 });
    const result = await openDocument({ app: 'Example Editor', path }, { home: w.home, resolve: async app => { resolved.push(app); return 'com.example.editor'; }, exec: async (...args) => opened.push(args) });
    assert.deepEqual(result, { content: [{ type: 'text', text: "open_file doesn't open sleight's own settings files; only the user changes them." }], isError: true }, path);
  }
  assert.deepEqual(opened, []);
  assert.deepEqual(resolved, []);
});

test('open_file refuses a blocked app before it asks the user to approve opening files there', async () => {
  const { callLocalTool, prepareOpenFile } = await import('../plugins/sleight/lib/launch.mjs');
  const line = 'You blocked sleight in Example Editor (sleight-mcp permissions unblock com.example.editor lifts it).';
  const blocked = bundleId => bundleId === 'com.example.editor' ? line : undefined, asked = [];
  const approve = async (...args) => { asked.push(args); return true; };
  const args = { app: 'Some Name', path: '/tmp/x.txt' };
  assert.deepEqual(await callLocalTool('open_file', args, approve, undefined, undefined, undefined, { blocked, resolve: async () => 'com.example.editor' }),
    { content: [{ type: 'text', text: line }], isError: true });
  const prepared = prepareOpenFile(args, approve, { resolve: async () => 'com.example.editor', blocked });
  assert.equal(await prepared.approval, false);
  assert.deepEqual(await callLocalTool('open_file', args, approve, undefined, undefined, prepared, { blocked }), { content: [{ type: 'text', text: line }], isError: true });
  assert.deepEqual(asked, []);
});

test('open_file refuses an app the user blocked once its name resolves, before anything opens', async t => {
  const { openDocument } = await import('../plugins/sleight/lib/launch.mjs');
  const w = world(t), path = join(w.home, 'note.txt'), opened = [];
  writeFileSync(path, 'hello');
  const line = 'You blocked sleight in Example Editor (sleight-mcp permissions unblock com.example.editor lifts it).';
  const result = await openDocument({ app: 'Some Other Name', path }, { resolve: async () => 'com.example.editor', exec: async (...args) => opened.push(args),
    blocked: (bundleId, app) => bundleId === 'com.example.editor' ? line : undefined });
  assert.deepEqual(result, { content: [{ type: 'text', text: line }], isError: true });
  assert.deepEqual(opened, []);
});

test('revoking the last allow-only site is refused, so the list never empties into no limit at all', t => {
  const w = world(t);
  assert.equal(w.command(['sites', 'only', 'https://a.example']), 0); w.output();
  assert.equal(w.command(['revoke', 'https://a.example']), 1);
  assert.equal(w.output(), "https://a.example is the only site sleight may act on, so it stays. sleight-mcp permissions sites all lifts the limit, and sleight-mcp permissions block https://a.example stops sleight there.\n");
  assert.deepEqual(readPermissions(w.path).only, ['https://a.example'], 'allow-only stays on');
  assert.match(createPermissionCheck({ path: w.path }).site('https://other.example/'), /^You allow sleight only on https:\/\/a\.example/);
});

test('repair keeps a broken allow-only list as a refusal and replaces an unreadable file only when told to discard it', t => {
  const w = world(t);
  w.write('permissions.json', { version: 1, apps: [{ id: 'com.example.app' }], sites: [], only: ['nope', 'ftp://x.example'] }, 0o644);
  assert.equal(w.command(['repair']), 1);
  assert.match(w.output(), /^permissions\.json limits sleight to some sites, and none of them can be read, so repair keeps it as it is\. sleight-mcp permissions repair --discard replaces it with an empty file, which removes every block and limit\.\n$/);
  assert.equal(readPermissions(w.path).state, 'unsafe', 'nothing was written');
  w.write('permissions.json', 'not json', 0o600);
  assert.equal(w.command(['repair']), 1);
  assert.match(w.output(), /^sleight couldn't read the old permissions\.json, so repair kept nothing and changed nothing\. sleight-mcp permissions repair --discard replaces it with an empty file/);
  assert.equal(readPermissions(w.path).state, 'unsafe');
  assert.equal(w.command(['repair', '--discard']), 0);
  assert.match(w.output(), /^Replaced permissions\.json with an empty one: no blocks and no site limit\./);
  assert.deepEqual(readPermissions(w.path), { state: 'ok', apps: [], sites: [] });
  // A failure that leaves the file unsafe points at repair, never at deleting the file.
  w.write('permissions.json', { version: 1, apps: [], sites: [] }, 0o644);
  assert.equal(w.command(['block', 'com.example.app']), 1);
  assert.match(w.output(), /failed: PERMISSIONS_UNSAFE \(.*; sleight-mcp permissions repair fixes it and keeps the valid blocks\)\n$/);
});

test('the listing: always-allowed apps with when sleight last used them, debugger grants, turbo, blocks and ChatGPT\'s own list', t => {
  const w = world(t);
  w.write('preapproved.json', { version: 1, apps: [{ app: 'Calculator', riskLevel: 'low', added: '2026-10-01', source: 'always-allow' }, { app: 'com.example.notes', riskLevel: 'high' }] });
  // The grant audit each relay already writes is the record of use. Two sessions, the newer use wins.
  const audit = (pid, at, app) => JSON.stringify({ t: new Date(at).toISOString(), pid, direction: 'preapproved-app', grant: { app, riskLevel: 'low', tool: 'engine', source: 'x' } }) + '\n';
  writeFileSync(join(w.logs, 'preapproved-11.jsonl'), audit(11, 10 * 24 * HOUR - 5 * HOUR, 'Calculator'));
  writeFileSync(join(w.logs, 'preapproved-12.jsonl.1'), audit(12, 10 * 24 * HOUR - 2 * HOUR, 'Calculator') + 'not json\n');
  w.records.push({ key: 'k1', name: 'Chat App', bundleId: 'com.example.chat' });
  w.write('turbo.json', { version: 1, enabled: true, executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', profileRoot: '/x' });
  const folder = join(w.support, 'used');
  stampUse('turbo', { folder, now: () => 10 * 24 * HOUR - 5 * 60000 });
  w.write('permissions.json', { version: 1, apps: [{ id: 'com.example.blocked', name: 'Blocked App' }], sites: ['https://blocked.example'] });
  writeFileSync(w.engineFile, JSON.stringify({ approvedBundleIdentifiers: ['com.apple.TextEdit'] }));
  assert.equal(w.command([]), 0);
  const text = w.output();
  assert.match(text, /^sleight may act in\n/);
  assert.match(text, /\n {2}Calculator · always · used 2h ago\n/);
  assert.match(text, /\n {2}com\.example\.notes · always · not used yet\n/);
  assert.match(text, /\n {2}Chat App · debugger, always · not used yet\n/);
  assert.match(text, /\n {2}Google Chrome · turbo · used 5m ago\n/);
  assert.match(text, /sleight-mcp permissions revoke <app\|turbo\|all> takes one away\./);
  assert.match(text, /\nBlocked\n {2}Blocked App \(com\.example\.blocked\)\n {2}https:\/\/blocked\.example\n/);
  assert.match(text, /\nChatGPT's own Always allow list, managed in ChatGPT's settings \(sleight can't change it\)\n {2}com\.apple\.TextEdit\n/);
  assert.equal(w.command(['list']), 0);
  assert.equal(w.output(), text);
});

test('site limits are worded for every path they hold on, and ChatGPT\'s list is read only for a person at a terminal', t => {
  const w = world(t);
  assert.equal(w.command(['sites', 'only', 'https://a.example']), 0);
  assert.equal(w.output(), 'sleight acts only on https://a.example from its next action, in turbo and in browser windows on the engine path. sleight-mcp permissions sites all lifts the limit.\n');
  assert.equal(w.command([]), 0);
  assert.match(w.output(), /\nSites: only https:\/\/a\.example \(turbo and browser windows on the engine path\)\n/);
  assert.equal(w.command(['sites', 'all']), 0);
  assert.equal(w.output(), 'sleight may act on any site you haven\'t blocked.\n');
  writeFileSync(w.engineFile, JSON.stringify({ approvedBundleIdentifiers: ['com.example.secret'] }));
  assert.equal(w.command([], { tty: false }), 0);
  const text = w.output();
  assert.doesNotMatch(text, /com\.example\.secret/);
  assert.match(text, /\nChatGPT's own Always allow list: run sleight-mcp permissions in Terminal to see it\.\n$/);
});

test('revoke takes an app off the list and its debugger grants, turbo writes the opt-out, and all clears every grant but no block', t => {
  const w = world(t);
  w.write('preapproved.json', { version: 1, apps: [{ app: 'Calculator', riskLevel: 'low' }, { app: 'com.example.chat', riskLevel: 'high' }] });
  w.records.push({ key: 'k1', name: 'Chat App', bundleId: 'com.example.chat' }, { key: 'k2', name: 'Other', bundleId: 'com.example.other' });
  w.write('turbo.json', { version: 1, enabled: true, executable: '/Applications/Helium.app/Contents/MacOS/Helium', profileRoot: '/x' });
  w.write('permissions.json', { version: 1, apps: [{ id: 'com.example.blocked' }], sites: [] });
  assert.equal(w.command(['revoke', 'com.example.chat']), 0);
  assert.match(w.output(), /Revoked com\.example\.chat \(2\)\. It asks again from its next action\./);
  assert.deepEqual(JSON.parse(readFileSync(join(w.support, 'preapproved.json'), 'utf8')).apps.map(a => a.app), ['Calculator']);
  assert.deepEqual(w.records.map(r => r.key), ['k2']);
  assert.equal(w.command(['revoke', 'Nothing Here']), 0); assert.match(w.output(), /Nothing to revoke for Nothing Here/);
  assert.equal(w.command(['revoke', 'turbo']), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(w.support, 'turbo.json'), 'utf8')), { version: 1, enabled: false });
  assert.equal(w.command(['revoke', 'all']), 0);
  assert.match(w.output(), /Revoked everything sleight may do: 1 app, 1 debugger grant\. Blocks stay\./);
  assert.deepEqual(JSON.parse(readFileSync(join(w.support, 'preapproved.json'), 'utf8')).apps, []);
  assert.deepEqual(w.records, []);
  assert.deepEqual(readPermissions(w.path).apps, [{ id: 'com.example.blocked' }]);
});

test('running sessions see a revoke at once: the live list reloads when the file changes and allows nothing when it turns unsafe', t => {
  const w = world(t);
  const file = w.write('preapproved.json', { version: 1, apps: [{ app: 'Calculator', riskLevel: 'high' }] });
  const live = livePreapproved(new PreapprovedApps({ version: 1, apps: [{ app: 'Calculator', riskLevel: 'high' }] }), { file, load: () => new PreapprovedApps(JSON.parse(readFileSync(file, 'utf8'))) });
  assert.equal(live.allows('Calculator', 'low'), true);
  const removed = [];
  live.onRemoved(apps => removed.push(...apps));
  assert.equal(w.command(['revoke', 'Calculator']), 0);
  assert.equal(live.allows('Calculator', 'low'), false);
  assert.deepEqual(removed, ['Calculator'], 'the relay hears which apps a reload took off');
  assert.deepEqual(live.list(), []);
  const failing = livePreapproved(new PreapprovedApps({ version: 1, apps: [{ app: 'Calculator', riskLevel: 'high' }] }), { file, load: () => { throw Error('Preapproved apps: unsafe'); } });
  w.write('preapproved.json', { version: 1, apps: [{ app: 'Calculator', riskLevel: 'high' }] }, 0o644);
  assert.equal(failing.allows('Calculator', 'low'), false);
  assert.equal(failing.size, 0);
});

test('use stamps are empty files named by a digest, so they hold a time and nothing else', t => {
  const w = world(t), folder = join(w.support, 'used');
  assert.equal(lastUse('electron:com.example.chat', { folder }), undefined);
  stampUse('electron:com.example.chat', { folder, now: () => 1760000000000 });
  const [name] = readdirSync(folder);
  assert.match(name, /^[0-9a-f]{24}$/);
  assert.equal(lstatSync(join(folder, name)).size, 0);
  assert.equal(lstatSync(join(folder, name)).mode & 0o777, 0o600);
  assert.equal(lastUse('electron:com.example.chat', { folder }), 1760000000000);
  stampUse('electron:com.example.chat', { folder, now: () => 1760000500000 });
  assert.equal(lastUse('electron:com.example.chat', { folder }), 1760000500000);
  assert.ok(!existsSync(join(folder, 'electron:com.example.chat')));
});

test('grant uses come from the newest audit files only and keep the latest time per app', t => {
  const w = world(t);
  for (let i = 0; i < 30; i++) {
    const file = join(w.logs, `preapproved-${100 + i}.jsonl`);
    writeFileSync(file, JSON.stringify({ t: new Date(i * HOUR).toISOString(), grant: { app: i < 5 ? 'Old' : 'New' } }) + '\n');
    utimesSync(file, i * 3600, i * 3600);
  }
  const uses = grantUses({ directory: w.logs, limit: 24 });
  assert.equal(uses.get('New'), 29 * HOUR);
  assert.equal(uses.has('Old'), false, 'files past the newest 24 are not read');
  assert.equal(grantUses({ directory: join(w.home, 'missing') }).size, 0);
});

test('relative words for the last use', () => {
  const now = 100 * 24 * HOUR;
  assert.equal(usedWords(undefined, now), 'not used yet');
  assert.equal(usedWords(now - 20000, now), 'used just now');
  assert.equal(usedWords(now - 5 * 60000, now), 'used 5m ago');
  assert.equal(usedWords(now - 2 * HOUR, now), 'used 2h ago');
  assert.equal(usedWords(now - 3 * 24 * HOUR, now), 'used 3d ago');
});

test('the menu payload offers revokes and a block for the app sleight last acted in, and a click can act only on what it offered', t => {
  const w = world(t);
  w.write('preapproved.json', { version: 1, apps: [{ app: 'Calculator', riskLevel: 'low' }] });
  w.records.push({ key: 'k1', name: 'Chat App', bundleId: 'com.example.chat' });
  w.write('permissions.json', { version: 1, apps: [], sites: ['https://blocked.example'] });
  noteCurrentApp({ bundleId: 'com.example.editor', name: 'Editor' });
  const menu = permissionsMenu(w.options);
  assert.deepEqual(menu.payload.grants.map(g => [g.title, g.detail, g.target]), [['Calculator', 'always', 'app:Calculator'], ['Chat App', 'debugger, always', 'electron:com.example.chat']]);
  assert.deepEqual(menu.payload.current, { title: 'Editor', target: 'com.example.editor' });
  assert.deepEqual(menu.payload.blocked, ['https://blocked.example']);
  assert.ok(Buffer.byteLength(JSON.stringify(menu.payload)) < 6000);
  // A target the menu didn't offer does nothing.
  assert.equal(applyMenuEvent({ permissions: 'revoke', target: 'app:Unlisted' }, menu.offered, w.options), false);
  assert.equal(applyMenuEvent({ permissions: 'block', target: 'com.example.other' }, menu.offered, w.options), false);
  assert.equal(applyMenuEvent({ permissions: 'unblock', target: 'https://blocked.example' }, menu.offered, w.options), false, 'the menu never lifts a block');
  assert.equal(applyMenuEvent({ permissions: 'block', target: 'com.example.editor' }, menu.offered, w.options), true);
  assert.deepEqual(readPermissions(w.path).apps, [{ id: 'com.example.editor', name: 'Editor' }]);
  assert.equal(applyMenuEvent({ permissions: 'revoke', target: 'electron:com.example.chat' }, menu.offered, w.options), true);
  assert.deepEqual(w.records, []);
  assert.equal(applyMenuEvent({ permissions: 'revoke-all' }, menu.offered, w.options), true);
  assert.deepEqual(JSON.parse(readFileSync(join(w.support, 'preapproved.json'), 'utf8')).apps, []);
  // A blocked current app is not offered again, and a long list stays inside the host's frame limit.
  const again = permissionsMenu(w.options);
  assert.equal(again.payload.current, undefined);
  w.write('preapproved.json', { version: 1, apps: Array.from({ length: 200 }, (_, i) => ({ app: `App number ${i} ${'x'.repeat(60)}`, riskLevel: 'low' })) });
  const long = permissionsMenu(w.options);
  assert.ok(Buffer.byteLength(JSON.stringify(long.payload)) < 6000);
  assert.ok(long.payload.grants.length <= 24);
  assert.ok(long.payload.grants.every(g => g.title.length <= 80));
  noteCurrentApp(undefined);
});

test('the doctor: an unsafe file is the one problem, with its fix; otherwise counts', t => {
  const w = world(t);
  assert.deepEqual(permissionsDoctorLines({ home: w.home }), ['permissions', 'ok        blocks: none (sleight-mcp permissions lists what sleight may do)', 'ok        sites: any site']);
  w.write('permissions.json', { version: 1, apps: [{ id: 'com.example.app' }], sites: ['https://a.example'], only: ['https://b.example'] });
  assert.deepEqual(permissionsDoctorLines({ home: w.home }), ['permissions', 'ok        blocks: 1 app, 1 site (sleight-mcp permissions lists what sleight may do)', 'ok        sites: only https://b.example']);
  w.write('permissions.json', { version: 1, apps: [], sites: [] }, 0o666);
  assert.deepEqual(permissionsDoctorLines({ home: w.home }), ['permissions',
    'PROBLEM   permissions.json is a link or has another owner, mode or format, so sleight acts nowhere',
    '          fix: sleight-mcp permissions repair (it keeps the valid blocks)']);
});

test('the doctor prints the permissions section after the ghost hand\'s, read-only', async t => {
  const w = world(t), lines = [];
  const { doctor } = await import('../plugins/sleight/lib/launch.mjs');
  const code = await doctor({ settings: () => [], env: { CODEX_HOME: '/no-such-sleight-home', SLEIGHT_CHATGPT_APP: '/no-such-ChatGPT.app' }, log: x => lines.push(x),
    turbo: async () => ['turbo (direct browser path)'], hand: async () => ['ghost hand'], permissions: async () => permissionsDoctorLines({ home: w.home }) });
  assert.equal(code, 1);
  assert.match(lines[0], /^sleight \d+\.\d+\.\d+$/);
  assert.deepEqual(lines.slice(1, 5), ['turbo (direct browser path)', 'ghost hand', 'permissions', 'ok        blocks: none (sleight-mcp permissions lists what sleight may do)']);
  assert.equal(existsSync(w.path), false);
});

test('a write the reader would refuse never happens, and the menu leaves out a row the host would refuse', t => {
  const w = world(t);
  w.write('permissions.json', { version: 1, apps: Array.from({ length: 256 }, (_, i) => ({ id: `com.example.app${i}` })), sites: [] });
  assert.equal(w.command(['block', 'com.example.one.more']), 1);
  assert.match(w.output(), /failed: PERMISSIONS_FULL/);
  assert.equal(readPermissions(w.path).state, 'ok', 'the file stays readable, so sleight still acts');
  w.write('preapproved.json', { version: 1, apps: [{ app: 'Fine', riskLevel: 'low' }, { app: 'Odd\u0085Name', riskLevel: 'low' }, { app: 'x'.repeat(300), riskLevel: 'low' }] });
  w.records.push({ key: 'k1', name: 'Underscored', bundleId: 'com.example.under_score' });
  assert.deepEqual(permissionsMenu(w.options).payload.grants.map(g => g.target), ['app:Fine']);
  noteCurrentApp({ bundleId: 'com.example.editor', name: 'Bad\u0085Name' });
  assert.deepEqual(permissionsMenu(w.options).payload.current, undefined, 'a full list offers no block');
  noteCurrentApp(undefined);
});

test('without a terminal the launcher refuses an unknown permissions op (VC5S), exit 3, and reads nothing', async () => {
  const { spawnSync } = await import('node:child_process');
  const launch = new URL('../plugins/sleight/lib/launch.mjs', import.meta.url).pathname;
  const run = spawnSync(process.execPath, [launch, 'permissions', 'frobnicate'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stderr, /^sleight: permissions frobnicate changes sleight's settings, so run it yourself in a terminal/);
  assert.equal(run.stdout, '');
});

test('an unknown permissions op prints the usage, exit 2', () => {
  const lines = [];
  assert.equal(permissionsCommand(['frobnicate'], { out: text => lines.push(text) }), 2);
  assert.match(lines.join(''), /^usage: sleight-mcp permissions \[list\]\n/);
  assert.match(lines.join(''), /permissions block\|unblock <app bundle id\|origin>/);
});

test('repair replaces an unsafe file with a private one that keeps every valid block, and leaves a safe file alone', t => {
  const w = world(t);
  w.write('permissions.json', { version: 1, apps: [{ id: 'com.example.app', name: 'Example' }, { id: 'not a bundle' }, { id: 'com.example.app' }],
    sites: ['https://blocked.example', 'nope'], only: ['https://a.example'], extra: true }, 0o644);
  assert.equal(readPermissions(w.path).state, 'unsafe');
  assert.match(createPermissionCheck({ path: w.path }).app({ bundleId: 'com.any.app' }), /until you run sleight-mcp permissions repair/);
  assert.equal(w.command(['repair']), 0);
  assert.match(w.output(), /^Repaired permissions\.json: kept 1 blocked app, 1 blocked site and 1 allowed site, dropped 3 unreadable entries\./);
  assert.deepEqual(readPermissions(w.path), { state: 'ok', apps: [{ id: 'com.example.app', name: 'Example' }], sites: ['https://blocked.example'], only: ['https://a.example'] });
  assert.equal(lstatSync(w.path).mode & 0o777, 0o600);
  assert.equal(w.command(['repair']), 0); assert.match(w.output(), /permissions\.json is fine/);
  // A link is removed, never written through; its target is read only for blocks to keep.
  const target = join(w.home, 'elsewhere.json');
  writeFileSync(target, JSON.stringify({ version: 1, apps: [{ id: 'com.example.kept' }], sites: [] }), { mode: 0o600 });
  rmSync(w.path); symlinkSync(target, w.path);
  assert.equal(w.command(['repair']), 0); w.output();
  assert.equal(lstatSync(w.path).isSymbolicLink(), false);
  assert.deepEqual(readPermissions(w.path).apps, [{ id: 'com.example.kept' }]);
  assert.equal(readFileSync(target, 'utf8'), JSON.stringify({ version: 1, apps: [{ id: 'com.example.kept' }], sites: [] }), 'the link target is untouched');
});

test('the menu shows turbo\'s row without offering it, and its Revoke All leaves turbo on', t => {
  const w = world(t);
  w.write('preapproved.json', { version: 1, apps: [{ app: 'Calculator', riskLevel: 'low' }] });
  w.write('turbo.json', { version: 1, enabled: true, executable: '/Applications/Helium.app/Contents/MacOS/Helium', profileRoot: '/x' });
  const menu = permissionsMenu(w.options);
  assert.deepEqual(menu.payload.grants.map(g => g.target), ['app:Calculator', 'turbo']);
  assert.deepEqual([...menu.offered], ['app:Calculator']);
  assert.equal(applyMenuEvent({ permissions: 'revoke', target: 'turbo' }, new Set(['turbo']), w.options), false, 'turbo is never revoked from this menu');
  assert.equal(applyMenuEvent({ permissions: 'revoke-all' }, menu.offered, w.options), true);
  assert.deepEqual(JSON.parse(readFileSync(join(w.support, 'preapproved.json'), 'utf8')).apps, []);
  assert.equal(JSON.parse(readFileSync(join(w.support, 'turbo.json'), 'utf8')).enabled, true);
});

// Engine tree shapes recorded from real reads: Safari's web area names its page without a scheme (bestbuy.com, 2026-10-11),
// Firefox's address bar shows a URL the user may have typed and not loaded.
const safari = url => 'Window: "Personal — HP 24yh 23.8" IPS LED Full HD Monitor (VGA, DVI D, HDMI) Black - Best Buy", App: Safari.\n' +
  '0 standard window Personal — HP 24yh 23.8" IPS LED Full HD Monitor (VGA, DVI D, HDMI) Black - Best Buy, ID: SafariWindow, Secondary Actions: Raise\n' +
  `\t5 HTML content Description: HP monitor, URL: ${url}\n\t\t13 link Shop now, Value: bestbuy.com/top-deals`;
const firefox = 'Window: "Mozilla Firefox", App: Firefox.\n0 standard window Mozilla Firefox\n\t14 container\n' +
  '\t\t17 combo box (settable) Description: Search with Google or enter address, Value: https://example.test/\n\t\t\t18 text https://example.test/';
test('the site an engine read shows: a web area\'s URL with or without scheme, nothing from an address bar, and no guess between two', () => {
  assert.deepEqual(pageSite(safari('bestbuy.com/product/hp-24yh/JJ86HQ9R94')), { host: 'bestbuy.com' });
  assert.deepEqual(pageSite(safari('https://www.bestbuy.com/x')), { host: 'www.bestbuy.com', scheme: 'https' });
  assert.deepEqual(pageSite(firefox), undefined, 'no web area: the tree shows no page');
  assert.deepEqual(pageSite('Window: "x", App: Some App.\n0 standard window x\n\t1 button Save'), undefined);
  assert.deepEqual(pageSite('Window: "x", App: B.\n0 standard window x\n\t2 HTML content URL: a.example/x\n\t3 HTML content URL: b.example/y'), { unproven: true });
  assert.deepEqual(pageSite('Window: "x", App: B.\n0 standard window x\n\t2 HTML content URL: a.example/x\n\t\t3 HTML content URL: ads.example/f'), { host: 'a.example' }, 'only the outermost web areas count');
  for (const bad of ['about:blank', `file://${MAC_USERS}x/page.html`, 'user@evil.example/x', '']) {
    assert.deepEqual(pageSite(`Window: "x", App: B.\n0 standard window x\n\t2 HTML content URL: ${bad}`), { unproven: true }, bad);
  }
  assert.deepEqual(pageSite('Window: "x", App: B.\nURL: https://header.example/a\n0 standard window x', { title: 'x', url: 'https://header.example/a' }),
    { host: 'header.example', scheme: 'https' }, 'the window\'s own URL field decides');
});

test('the site proof comes only from the window\'s URL field and the web areas\' URL attribute, never from the page\'s title or description', async () => {
  const { windowFromText } = await import('../plugins/sleight/lib/document-scope.mjs');
  const site = text => pageSite(text, windowFromText(text));
  // A title that names an allowed site, on a page whose web area shows the real one.
  const title = 'Deals URL: https://allowed.example/';
  assert.deepEqual(site(`Window: "${title}", App: B.\n0 standard window ${title}, ID: W\n\t5 HTML content URL: evil.example/x`), { host: 'evil.example' });
  assert.deepEqual(site(`Window: "${title}", App: B.\n0 standard window ${title}, ID: W\n\t5 button Go`), { unproven: true }, 'a title is no proof, and no web area means no site');
  // A description that carries its own URL: token.
  assert.deepEqual(site('Window: "x", App: B.\n0 standard window x\n\t5 HTML content Description: x URL: allowed.example, URL: evil.example/x'), { unproven: true });
  assert.deepEqual(site('Window: "x", App: B.\n0 standard window x\n\t5 HTML content Description: see myURL: allowed.example, URL: evil.example/x'), { unproven: true });
  // The window's own field and the web area must agree.
  assert.deepEqual(site('Window: "x", App: B.\nURL: https://a.example/p\n0 standard window x\n\t5 HTML content URL: www.a.example/p'), { host: 'a.example', scheme: 'https' });
  assert.deepEqual(site('Window: "x", App: B.\nURL: https://a.example/p\n0 standard window x\n\t5 HTML content URL: b.example/p'), { unproven: true });
  assert.deepEqual(site('Window: "x", App: B.\n0 standard window x, URL: https://a.example/, ID: W\n\t1 button Go'), { host: 'a.example', scheme: 'https' });
});

test('a read without the window\'s root line (a find or a diff) proves no site, so a page-written "HTML content" line can\'t stand in', () => {
  assert.equal(pageSite('\t\t\t9 HTML content Description: x, URL: allowed.example/x\n\t\t\t\t10 button Buy'), undefined);
  assert.equal(pageSite('Window: "x", App: B.\n+ \t\t9 HTML content URL: allowed.example/x'), undefined);
  assert.deepEqual(pageSite('Window: "x", App: B.\n0 standard window x\n\t2 HTML content URL: a.example/x'), { host: 'a.example' });
});

test('engine-path site lines: a blocked host whatever its scheme, an unlisted host in allow-only mode, and an unprovable page', () => {
  const blocks = { state: 'ok', apps: [], sites: ['https://bestbuy.com'] };
  assert.equal(pageRefusal(blocks, { host: 'bestbuy.com' }), 'You blocked sleight on https://bestbuy.com (sleight-mcp permissions unblock https://bestbuy.com lifts it).');
  assert.equal(pageRefusal(blocks, { host: 'bestbuy.com', scheme: 'http' }), pageRefusal(blocks, { host: 'bestbuy.com' }));
  assert.equal(pageRefusal(blocks, { host: 'fine.example' }), undefined);
  assert.match(pageRefusal(blocks, { unproven: true }), /^You limited the sites sleight acts on, and it can't tell which site this window shows/);
  assert.match(pageRefusal(blocks, undefined), /can't tell which site/);
  const only = { state: 'ok', apps: [], sites: [], only: ['https://a.example'] };
  assert.equal(pageRefusal(only, { host: 'a.example' }), undefined);
  assert.equal(pageRefusal(only, { host: 'a.example', scheme: 'http' }), 'You allow sleight only on https://a.example, not http://a.example (sleight-mcp permissions lists them).');
  assert.match(pageRefusal(only, { host: 'b.example' }), /not b\.example/);
  assert.equal(pageRefusal({ state: 'ok', apps: [], sites: [] }, { unproven: true }), undefined, 'without site limits nothing is checked');
});

test('which apps are web browsers: LaunchServices\' answer joined with known browsers, and on a failed or empty answer the known ones only', async () => {
  const { webBrowserCheck } = await import('../plugins/sleight/lib/launch.mjs');
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const asked = [];
  const check = webBrowserCheck(async (script, request) => { asked.push([script, request]); return { ok: true, ids: ['com.example.Browser'] }; });
  assert.equal(check('com.example.browser'), undefined, 'unknown until the answer arrives');
  assert.equal(check('com.apple.Safari'), true, 'a known browser is one before the answer, too');
  await flush();
  assert.equal(check('com.example.browser'), true);
  assert.equal(check('com.apple.safari'), true, 'a short answer never clears a known browser');
  assert.equal(check('com.example.editor'), false);
  assert.equal(check(undefined), null, 'no bundle id: judged by what the read shows');
  assert.deepEqual(asked, [['web-browsers.js', {}]]);
  // An empty answer is a failed one: known browsers stay browsers, every other app is judged by its read.
  for (const answer of [{ ok: true, ids: [] }, { ok: false, error: 'no' }]) {
    let at = 0, tries = 0;
    const failed = webBrowserCheck(async () => { tries++; return answer; }, () => at);
    failed('com.example.browser'); await flush();
    assert.equal(failed('com.example.browser'), null, JSON.stringify(answer));
    assert.equal(failed('org.mozilla.firefox'), true);
    assert.equal(failed.failed(), true);
    assert.equal(tries, 1);
    at = 60000; failed('com.example.browser'); await flush();
    assert.equal(tries, 1, 'no retry storm');
    at = 301000; failed('com.example.browser'); await flush();
    assert.equal(tries, 2, 'asked again after 5 minutes');
  }
  // The launcher asks at startup when the file already has site limits.
  const primed = [];
  webBrowserCheck(async script => { primed.push(script); return { ok: true, ids: ['x.y'] }; }).ask();
  await flush();
  assert.deepEqual(primed, ['web-browsers.js']);
});

test('the doctor says when sleight couldn\'t list the browsers', async () => {
  const { browserDoctorLines } = await import('../plugins/sleight/lib/launch.mjs');
  assert.deepEqual(await browserDoctorLines(async () => ({ ok: true, ids: ['com.example.browser', 'x.y'] })), ['ok        browsers: 2 apps open https links']);
  for (const answer of [{ ok: true, ids: [] }, { ok: false, error: 'no' }]) {
    assert.deepEqual(await browserDoctorLines(async () => answer), ['PROBLEM   sleight couldn\'t list your browsers, so site limits on the engine path hold for known browsers and for windows that show web content',
      '          a session asks again every 5 minutes']);
  }
});

test('a check primes itself when created, so a file deleted before the first call still reads as tampered', t => {
  const w = world(t);
  w.write('permissions.json', { version: 1, apps: [], sites: ['https://blocked.example'] });
  const check = createPermissionCheck({ path: w.path });
  rmSync(w.path);
  assert.match(check.site('https://fine.example/'), /^sleight's permissions file is gone since this session read it/);
});

// A recipe failure must never prevent or misreport a permission restriction.
for (const fault of ['mode', 'bad-json', 'busy']) {
  for (const operation of ['revoke-site', 'block-site', 'revoke-all', 'menu-block-site', 'menu-revoke-all', 'menu-revoke-app']) {
    test(`${operation} keeps its permission result with ${fault} site memory`, t => {
      const w = world(t);
      w.write('permissions.json', { version: 1, apps: [], sites: [], only: ['https://a.example', 'https://b.example'] });
      w.write('preapproved.json', { version: 1, apps: [{ app: 'Calculator', riskLevel: 'low' }] });
      w.write('turbo.json', { version: 1, enabled: true, executable: '/Applications/Helium.app/Contents/MacOS/Helium', profileRoot: '/x' });
      w.records.push({ key: 'k1', name: 'Chat App', bundleId: 'com.example.chat' });
      const memory = w.write('site-memory.json', { version: 1, epoch: '0', origins: [
        { origin: 'https://b.example', recipes: [{ target: { role: 'button', name: 'Export' }, lastUsed: Date.now() }] }
      ] });
      if (fault === 'mode') chmodSync(memory, 0o644);
      if (fault === 'bad-json') writeFileSync(memory, '{');
      if (fault === 'busy') w.write('site-memory.json.lock', { pid: process.pid });
      const before = readFileSync(memory, 'utf8');
      if (operation === 'revoke-site') {
        assert.equal(w.command(['revoke', 'https://b.example']), 0);
        assert.deepEqual(readPermissions(w.path).only, ['https://a.example']);
        assert.match(w.output(), /site memory not cleared: .*run memory clear all[\s\S]*is off the sites/);
      } else if (operation.endsWith('block-site')) {
        if (operation === 'block-site') assert.equal(w.command(['block', 'https://b.example']), 0);
        else assert.equal(blockSiteForUser('https://b.example', w.options), true);
        assert.match(createPermissionCheck({ path: w.path }).site('https://b.example/'), /^You blocked/);
        const output = w.output();
        assert.match(output, /[Pp]ermission change applied.*site memory not cleared: .*run memory clear all/);
        if (operation === 'block-site') assert.match(output, /sleight won't act on/);
      } else if (operation === 'menu-revoke-app') {
        assert.equal(applyMenuEvent({ permissions: 'revoke', target: 'app:Calculator' }, new Set(['app:Calculator']), w.options), true);
        assert.deepEqual(JSON.parse(readFileSync(join(w.support, 'preapproved.json'))).apps, []);
        assert.equal(w.output(), '');
      } else {
        if (operation === 'revoke-all') assert.equal(w.command(['revoke', 'all']), 0);
        else assert.equal(applyMenuEvent({ permissions: 'revoke-all' }, new Set(), w.options), true);
        assert.deepEqual(JSON.parse(readFileSync(join(w.support, 'preapproved.json'))).apps, []);
        assert.deepEqual(w.records, []);
        assert.equal(JSON.parse(readFileSync(join(w.support, 'turbo.json'))).enabled, operation === 'menu-revoke-all');
        const output = w.output();
        if (operation === 'revoke-all') assert.match(output, /Revoked everything/);
        if (fault === 'busy') assert.match(output, /[Pp]ermission change applied.*site memory not cleared: .*run memory clear all/);
        else { assert.doesNotMatch(output, /site memory not cleared/); assert.equal(existsSync(memory), false); }
      }
      if (operation.includes('site') || fault === 'busy' || operation === 'menu-revoke-app') assert.equal(readFileSync(memory, 'utf8'), before);
      if (fault === 'busy') assert.equal(existsSync(memory + '.lock'), true);
    });
  }
}

test('a refused or unchanged site revoke leaves recipes and their generation untouched', t => {
  const w = world(t);
  w.write('permissions.json', { version: 1, apps: [], sites: [], only: ['https://a.example'] });
  const memory = w.write('site-memory.json', { version: 1, epoch: '0', origins: [
    { origin: 'https://a.example', recipes: [{ target: { role: 'button', name: 'Export' }, lastUsed: Date.now() }] }
  ] });
  const before = readFileSync(memory, 'utf8');
  assert.equal(w.command(['revoke', 'https://a.example']), 1);
  assert.equal(readFileSync(memory, 'utf8'), before);
  assert.equal(w.command(['revoke', 'https://missing.example']), 0);
  assert.equal(readFileSync(memory, 'utf8'), before);
  chmodSync(w.path, 0o644);
  assert.equal(w.command(['revoke', 'https://a.example']), 1);
  assert.equal(readFileSync(memory, 'utf8'), before);
});

test('permission restrictions are visible before optional memory cleanup begins', t => {
  const w = world(t), seen = [];
  w.write('permissions.json', { version: 1, apps: [], sites: [], only: ['https://a.example', 'https://b.example'] });
  w.write('preapproved.json', { version: 1, apps: [{ app: 'Calculator', riskLevel: 'low' }] });
  w.records.push({ key: 'k1', name: 'Chat App', bundleId: 'com.example.chat' });
  t.mock.method(SiteMemory.prototype, 'clearMatching', () => {
    seen.push(readPermissions(w.path));
    throw Error('SITE_MEMORY_BUSY');
  });
  assert.equal(w.command(['revoke', 'https://b.example']), 0);
  assert.deepEqual(seen[0].only, ['https://a.example']);
  assert.equal(w.command(['block', 'https://b.example']), 0);
  assert.deepEqual(seen[1].sites, ['https://b.example']);
  assert.equal(blockSiteForUser('https://c.example', w.options), true);
  assert.deepEqual(seen[2].sites, ['https://b.example', 'https://c.example']);
  let atClear;
  t.mock.method(SiteMemory.prototype, 'clear', () => {
    atClear = { apps: JSON.parse(readFileSync(join(w.support, 'preapproved.json'))).apps, grants: [...w.records] };
    throw Error('SITE_MEMORY_BUSY');
  });
  assert.equal(applyMenuEvent({ permissions: 'revoke-all' }, new Set(), w.options), true);
  assert.deepEqual(atClear, { apps: [], grants: [] });
});

for (const operation of ['revoke-all', 'block-site']) test(`menu ${operation} failure never writes to process.stdout without a writer`, t => {
  const w = world(t), { out, ...options } = w.options;
  w.write('preapproved.json', { version: 1, apps: [{ app: 'Calculator', riskLevel: 'low' }] });
  w.write('site-memory.json', { version: 1, epoch: '0', origins: [] });
  const lock = w.write('site-memory.json.lock', JSON.stringify({ pid: process.pid }));
  const stdout = t.mock.method(process.stdout, 'write', () => true);
  let changed;
  try {
    changed = operation === 'revoke-all' ? applyMenuEvent({ permissions: 'revoke-all' }, new Set(), options)
      : blockSiteForUser('https://blocked.example', options);
  } finally { stdout.mock.restore(); }
  assert.equal(changed, true);
  assert.equal(stdout.mock.callCount(), 0, 'plain text would corrupt the MCP JSON-RPC stream');
  assert.equal(existsSync(lock), true, 'the other writer keeps its lock');
  if (operation === 'revoke-all') assert.deepEqual(JSON.parse(readFileSync(join(w.support, 'preapproved.json'))).apps, []);
  else assert.deepEqual(readPermissions(w.path).sites, ['https://blocked.example']);
});

test('library command calls without a writer leave stdout alone', t => {
  const w = world(t), { out, ...options } = w.options;
  const stdout = t.mock.method(process.stdout, 'write', () => true);
  let code;
  try { code = permissionsCommand(['unknown'], options); } finally { stdout.mock.restore(); }
  assert.equal(code, 2);
  assert.equal(stdout.mock.callCount(), 0);
});
