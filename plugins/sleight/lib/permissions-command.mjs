// What sleight may do, in one place: `sleight-mcp permissions` lists it, `permissions revoke` takes it away, `permissions block`
// and `unblock` set where sleight never acts, and `permissions sites only` limits turbo to some sites. The glove's Permissions
// menu uses the same list and writers (permissionsMenu, applyMenuEvent). Revoking and blocking only remove access, so neither
// asks. Nothing here grants: Always allow is written only by the user's click on an approval card.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, lstatSync, statSync, unlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPreapproved, removePreapproved } from './preapproved.mjs';
import { writeConfigFile } from './direct-browser/turbo-setup.mjs';
import { installedConfigPath, readInstalledConfigFile } from './direct-browser/installed-config.mjs';
import { grantStorePath } from './direct-browser/electron-config.mjs';
import { createGrantStore } from './direct-browser/electron-consent.mjs';
import { browserApplicationName } from './direct-browser/browsers.mjs';
import { SiteMemory, recipeLine, recipeOrigin } from './site-memory.mjs';
import { ALIASES, BUNDLE_ID, LIMIT, NAME, PERMISSIONS_BYTES, currentApp, lastUse, permissionsPath, readPermissions, coveringBlock, sameBlock, sameListed, siteOrigin, usedFolder, usedWords } from './permissions.mjs';

// ChatGPT's own Always allow list, which its helper honors itself. sleight only reads it, for the listing.
const engineFile = home => join(home, 'Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json');

// The names macOS gives an installed app, from LaunchServices (app-names.js, read-only: it finds the bundle and opens no app).
function installedAppNames(bundleId) {
  try {
    const names = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./app-names.js', import.meta.url)), bundleId],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
    return Array.isArray(names) ? names : [];
  } catch { return []; }
}

// Library callers may share stdout with MCP JSON-RPC. Only the CLI supplies a stdout writer.
function context({ home = userInfo().homedir, uid = process.getuid(), out = () => {}, now = Date.now, appNames = installedAppNames,
  tty = process.stdout.isTTY === true, ...rest } = {}) {
  return { home, uid, out, now, appNames, tty, path: permissionsPath(home), folder: usedFolder(home), logs: join(home, 'Library/Logs/sleight'),
    grants: () => createGrantStore({ path: grantStorePath(home) }), engineFile: engineFile(home), ...rest };
}

/** The latest use of each pre-approved app, from the grant audit every relay already writes (preapproved-<pid>.jsonl and its one
 *  rotated file). Only the newest `limit` files by time are read, so the listing stays cheap after many sessions. */
export function grantUses({ directory, limit = 24 } = {}) {
  const uses = new Map();
  let files;
  try { files = readdirSync(directory).filter(name => /^preapproved-\d+\.jsonl(?:\.1)?$/.test(name)); } catch { return uses; }
  const dated = files.flatMap(name => { try { const stat = lstatSync(join(directory, name)); return stat.isFile() ? [{ name, at: stat.mtimeMs }] : []; } catch { return []; } });
  for (const { name } of dated.sort((a, b) => b.at - a.at).slice(0, limit)) {
    let text;
    try { text = readFileSync(join(directory, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const app = record?.grant?.app, at = Date.parse(record?.t);
      if (typeof app === 'string' && Number.isFinite(at) && !(uses.get(app) >= at)) uses.set(app, at);
    }
  }
  return uses;
}

/** Every standing permission as { title, detail, used, target }: always-allowed apps, Electron debugger grants (one row per app)
 *  and turbo's browser. problems names a file that couldn't be read. */
export function standing(options) {
  const o = context(options), grants = [], problems = [];
  try {
    const uses = grantUses({ directory: o.logs });
    for (const entry of listPreapproved({ home: o.home, uid: o.uid })) grants.push({ title: entry.app, detail: 'always', used: uses.get(entry.app), target: 'app:' + entry.app });
  } catch (error) { problems.push(error.message); }
  try {
    const seen = new Set();
    for (const record of o.grants().list()) {
      if (seen.has(record.bundleId)) continue;
      seen.add(record.bundleId);
      grants.push({ title: record.name || record.bundleId, detail: 'debugger, always', used: lastUse('electron:' + record.bundleId, { folder: o.folder }), target: 'electron:' + record.bundleId });
    }
  } catch { problems.push('electron-grants.json could not be read'); }
  try {
    const turbo = readInstalledConfigFile(installedConfigPath(o.home));
    if (turbo?.enabled === true) grants.push({ title: browserApplicationName(turbo.executable) ?? 'its browser', detail: 'turbo', used: lastUse('turbo', { folder: o.folder }), target: 'turbo' });
  } catch { problems.push('turbo.json is a link or has another owner or mode'); }
  return { grants, problems };
}

/** ChatGPT's own list: { state: 'absent' | 'ok' | 'unreadable', apps }. */
export function engineApprovals(file) {
  try {
    const apps = JSON.parse(readFileSync(file, 'utf8')).approvedBundleIdentifiers;
    return Array.isArray(apps) ? { state: 'ok', apps: apps.filter(app => typeof app === 'string' && app.length <= 255).slice(0, 200) } : { state: 'unreadable', apps: [] };
  } catch (error) { return { state: error.code === 'ENOENT' ? 'absent' : 'unreadable', apps: [] }; }
}

// Read, change and write permissions.json through turbo's atomic writer, then prove it with the reader the checks use.
function update(o, change) {
  const before = readPermissions(o.path, o.uid);
  if (before.state === 'unsafe') throw Error('PERMISSIONS_UNSAFE');
  const next = change({ apps: before.apps, sites: before.sites, only: before.only });
  if (!next) return false;
  // An empty allow-only list would be written as no limit at all, so it never is: only `sites all` lifts the limit.
  if (Array.isArray(next.only) && !next.only.length) throw Error('PERMISSIONS_LAST_SITE');
  const data = { version: 1, apps: next.apps, sites: next.sites, ...next.only?.length ? { only: next.only } : {} };
  // A file the reader would refuse would stop every action, so a write past its limits never happens.
  if (data.apps.length > LIMIT || data.sites.length > LIMIT || Buffer.byteLength(JSON.stringify(data)) > PERMISSIONS_BYTES) throw Error('PERMISSIONS_FULL');
  writeConfigFile(o.path, data, o.uid);
  const after = readPermissions(o.path, o.uid);
  if (after.state !== 'ok' || JSON.stringify(after.apps) !== JSON.stringify(data.apps) || JSON.stringify(after.sites) !== JSON.stringify(data.sites)) throw Error('PERMISSIONS_UNSAFE');
  return true;
}
// An app's names, first the one to show, without the bundle id, repeats or anything the reader would refuse.
const appNames = (id, names) => names.filter(NAME).filter((name, at, all) => name.toLowerCase() !== id.toLowerCase() &&
  all.findIndex(other => other.toLowerCase() === name.toLowerCase()) === at).slice(0, ALIASES + 1);
// A block by bundle id alone also stores the names the app goes by, so Claude's getApp("Its Name") matches it.
const blockApp = (o, id, name, names = name ? [name] : o.appNames(id)) => update(o, p => p.apps.some(app => app.id.toLowerCase() === id.toLowerCase()) ? false
  : (([first, ...aliases]) => ({ ...p, apps: [...p.apps, { id, ...first ? { name: first } : {}, ...aliases.length ? { aliases } : {} }] }))(appNames(id, names.map(n => String(n).slice(0, 128)))));
// Permission changes commit before optional cache cleanup. A damaged cache cannot undo or hide a restriction.
function clearSiteMemory(o, matches) {
  try {
    const memory = new SiteMemory({ home: o.home });
    if (matches) memory.clearMatching(matches); else memory.clear();
  } catch (error) {
    o.out(`Permission change applied; site memory not cleared: ${error.message}; run memory clear all (sleight-mcp permissions memory clear all).\n`);
  }
}
// A site an existing block already covers (the same host, www. or not, or a subdomain) is already blocked.
const blockSite = (o, origin) => {
  const changed = update(o, p => coveringBlock(p.sites, origin) ? false : { ...p, sites: [...p.sites, origin] });
  clearSiteMemory(o, site => !!coveringBlock([origin], site));
  return changed;
};

/** Turbo's worker writes the menu's Never Act on row through this. */
export function blockSiteForUser(origin, options) {
  const site = siteOrigin(origin);
  if (!site) throw Error('INVALID_SITE');
  return blockSite(context(options), site);
}

// Revoking: an app name or bundle id takes the pre-approved entry and its Electron debugger grants; turbo writes turbo's opt-out.
function revokeApp(o, name) {
  let removed = 0;
  if (removePreapproved(name, { home: o.home, uid: o.uid })) removed++;
  const store = o.grants();
  for (const record of store.list()) if ((record.bundleId === name || record.name === name) && store.remove(record.key)) removed++;
  return removed;
}
const revokeTurbo = o => writeConfigFile(installedConfigPath(o.home), { version: 1, enabled: false }, o.uid);
// The menu's Revoke All leaves turbo alone: Turn Turbo Off… is turbo's one path, with its one confirmation.
function revokeAll(o, { includeTurbo = true } = {}) {
  let apps = 0, debuggers = 0, turbo = false;
  for (const entry of listPreapproved({ home: o.home, uid: o.uid })) if (removePreapproved(entry.app, { home: o.home, uid: o.uid })) apps++;
  const store = o.grants(), bundles = new Set();
  for (const record of store.list()) if (store.remove(record.key)) bundles.add(record.bundleId);
  debuggers = bundles.size;
  if (includeTurbo) try { if (readInstalledConfigFile(installedConfigPath(o.home))?.enabled === true) { revokeTurbo(o); turbo = true; } } catch {}
  clearSiteMemory(o);
  return { apps, debuggers, turbo };
}

/** `permissions repair`: an unsafe permissions.json (a link, another owner, a shared mode or a bad shape) is replaced by a
 *  private file holding every valid block and allow-only site it had. Everything in it only restricts, so keeping it is safe
 *  whatever wrote it. A link is removed, never followed for writing. A file it can't read at all, or an allow-only list with
 *  no readable site, would come out with less in it than the user set, so repair changes nothing then unless told to discard. */
function repair(o, discard = false) {
  const before = readPermissions(o.path, o.uid);
  // A file gone since a session read it leaves that session acting nowhere until one exists again; an empty one ends that.
  if (before.state === 'absent') {
    writeConfigFile(o.path, { version: 1, apps: [], sites: [] }, o.uid);
    if (readPermissions(o.path, o.uid).state !== 'ok') throw Error('PERMISSIONS_UNSAFE');
    return 'Wrote an empty permissions.json. The old one is gone, and its blocks with it; sleight-mcp permissions block sets them again.\n';
  }
  if (before.state === 'ok') return 'permissions.json is fine.\n';
  let data;
  try {
    const stat = statSync(o.path);
    if (stat.isFile() && stat.size <= PERMISSIONS_BYTES) data = JSON.parse(readFileSync(o.path, 'utf8'));
  } catch {}
  const discarding = 'sleight-mcp permissions repair --discard replaces it with an empty file, which removes every block and limit.';
  if (discard) {
    const link = lstatSync(o.path);
    if (link.isSymbolicLink() || !link.isFile()) unlinkSync(o.path);
    writeConfigFile(o.path, { version: 1, apps: [], sites: [] }, o.uid);
    if (readPermissions(o.path, o.uid).state !== 'ok') throw Error('PERMISSIONS_UNSAFE');
    return 'Replaced permissions.json with an empty one: no blocks and no site limit. sleight acts again from its next action.\n';
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw Object.assign(Error('PERMISSIONS_UNREADABLE'), { line: `sleight couldn't read the old permissions.json, so repair kept nothing and changed nothing. ${discarding}\n` });
  }
  const apps = [], sites = [], only = [], seen = new Set();
  let dropped = 0;
  for (const app of Array.isArray(data?.apps) ? data.apps : []) {
    const id = typeof app?.id === 'string' && app.id.length <= 255 && BUNDLE_ID.test(app.id) ? app.id : undefined;
    if (!id || seen.has(id.toLowerCase()) || apps.length >= LIMIT) { dropped++; continue; }
    seen.add(id.toLowerCase());
    const name = NAME(app.name) ? app.name : undefined, aliases = Array.isArray(app.aliases) ? app.aliases.filter(NAME).slice(0, ALIASES) : [];
    apps.push({ id, ...name ? { name } : {}, ...aliases.length ? { aliases } : {} });
  }
  const origins = (list, into) => { for (const site of Array.isArray(list) ? list : []) {
    const origin = siteOrigin(site);
    if (!origin || into.includes(origin) || into.length >= LIMIT) dropped++; else into.push(origin);
  } };
  origins(data?.sites, sites); origins(data?.only, only);
  if (data.only !== undefined && !only.length) {
    throw Object.assign(Error('PERMISSIONS_UNREADABLE'), { line: `permissions.json limits sleight to some sites, and none of them can be read, so repair keeps it as it is. ${discarding}\n` });
  }
  // A link or anything but a file goes first; a plain file is replaced in one rename, so a failed write keeps the old blocks.
  const link = lstatSync(o.path);
  if (link.isSymbolicLink() || !link.isFile()) unlinkSync(o.path);
  writeConfigFile(o.path, { version: 1, apps, sites, ...only.length ? { only } : {} }, o.uid);
  if (readPermissions(o.path, o.uid).state !== 'ok') throw Error('PERMISSIONS_UNSAFE');
  return `Repaired permissions.json: kept ${count(apps.length, 'blocked app')}, ${count(sites.length, 'blocked site')}` +
    `${only.length ? ` and ${count(only.length, 'allowed site')}` : ''}${dropped ? `, dropped ${dropped} unreadable ${dropped === 1 ? 'entry' : 'entries'}` : ''}. ` +
    'sleight acts again from its next action.\n';
}

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const usage = 'usage: sleight-mcp permissions [list]\n       sleight-mcp permissions revoke <app|turbo|all|origin>\n       sleight-mcp permissions repair [--discard]\n' +
  '       sleight-mcp permissions block|unblock <app bundle id|origin>\n       sleight-mcp permissions sites only <origin...>\n' +
  '       sleight-mcp permissions sites all\n       sleight-mcp permissions memory [list|clear <origin|all>]\n';
const target = value => typeof value === 'string' && value.includes('://') ? (siteOrigin(value) && { site: siteOrigin(value) })
  : typeof value === 'string' && value.length <= 255 && BUNDLE_ID.test(value) ? { app: value } : undefined;

function listing(o) {
  const lines = [], { grants, problems } = standing(o), now = o.now();
  if (grants.length) lines.push('sleight may act in', ...grants.map(g => `  ${g.title} · ${g.detail} · ${usedWords(g.used, now)}`),
    'sleight-mcp permissions revoke <app|turbo|all> takes one away.');
  else lines.push("sleight may act in: nothing beyond this session's approvals");
  for (const problem of problems) lines.push(`  (${problem})`);
  const perms = readPermissions(o.path, o.uid);
  if (perms.state === 'unsafe') lines.push('Blocked: permissions.json is unsafe, so sleight acts nowhere (sleight-mcp permissions repair fixes it, keeping the valid blocks)');
  else if (perms.apps.length || perms.sites.length) lines.push('Blocked', ...perms.apps.map(app => `  ${app.name ? `${app.name} (${app.id})` : app.id}`),
    ...perms.sites.map(site => `  ${site}`), 'sleight-mcp permissions unblock <app bundle id|origin> lifts a block.');
  lines.push(perms.only ? `Sites: only ${perms.only.join(', ')} (turbo and browser windows on the engine path)`
    : 'Sites: any site you haven\'t blocked (sleight-mcp permissions sites only <origin...> limits sleight to those)');
  try {
    const entries = new SiteMemory({ home: o.home }).list();
    lines.push(`${entries.reduce((n, entry) => n + entry.recipes.length, 0)} saved control recipes. sleight-mcp permissions memory lists them; memory clear <origin|all> clears them.`);
  } catch (error) { lines.push(error.line?.trim() ?? 'Control recipes are unreadable; sleight-mcp permissions memory clear all clears them.'); }
  // ChatGPT's list lives in its group container, and reading that can raise macOS's "data from other apps" prompt. Only a
  // person at a terminal gets it; Claude's shell, which has no terminal, gets the pointer.
  if (!o.tty) { lines.push("ChatGPT's own Always allow list: run sleight-mcp permissions in Terminal to see it."); return lines.join('\n') + '\n'; }
  const engine = engineApprovals(o.engineFile);
  lines.push("ChatGPT's own Always allow list, managed in ChatGPT's settings (sleight can't change it)",
    ...engine.state === 'ok' && engine.apps.length ? engine.apps.map(app => `  ${app}`) : [engine.state === 'unreadable' ? '  (unreadable)' : '  (empty)']);
  return lines.join('\n') + '\n';
}

/** `sleight-mcp permissions …`. Exit code 0 on success, 1 on failure, 2 on usage. */
export function permissionsCommand(args, options) {
  const o = context(options), [op = 'list', ...rest] = args;
  try {
    if (op === 'memory') {
      const memory = new SiteMemory({ home: o.home });
      if (!rest.length || rest.length === 1 && rest[0] === 'list') {
        const entries = memory.list();
        o.out(entries.length ? entries.map(entry => `${entry.origin}\n${entry.recipes.map(item => '  ' + recipeLine(item)).join('\n')}`).join('\n') + '\n'
          : 'No saved control recipes. Learning follows the action-log opt-in.\n');
        return 0;
      }
      if (rest.length === 2 && rest[0] === 'clear' && (rest[1] === 'all' || recipeOrigin(rest[1]))) {
        o.out(`Cleared ${memory.clear(rest[1] === 'all' ? undefined : rest[1])} control recipes.\n`); return 0;
      }
      o.out(usage); return 2;
    }
    if (op === 'list' && !rest.length) { o.out(listing(o)); return 0; }
    if (op === 'repair' && (!rest.length || rest.length === 1 && rest[0] === '--discard')) { o.out(repair(o, rest[0] === '--discard')); return 0; }
    if (op === 'revoke' && rest.length === 1) {
      const [what] = rest;
      if (what === 'all') {
        const done = revokeAll(o);
        o.out(`Revoked everything sleight may do: ${count(done.apps, 'app')}, ${count(done.debuggers, 'debugger grant')}${done.turbo ? ' and turbo' : ''}. Blocks stay.\n`); return 0;
      }
      if (what === 'turbo') { revokeTurbo(o); o.out('Turbo is off. sleight-mcp turbo on turns it back on.\n'); return 0; }
      const site = what.includes('://') ? siteOrigin(what) : undefined;
      if (what.includes('://')) {
        if (!site) { o.out(usage); return 2; }
        // Taking the last site off would leave no limit, which widens what sleight may do, so that revoke is refused.
        const only = readPermissions(o.path, o.uid).only;
        if (only?.length && only.every(listed => sameListed(listed, site))) {
          o.out(`${site} is the only site sleight may act on, so it stays. sleight-mcp permissions sites all lifts the limit, and sleight-mcp permissions block ${site} stops sleight there.\n`);
          return 1;
        }
        const changed = update(o, p => p.only?.some(s => sameListed(s, site)) ? { ...p, only: p.only.filter(s => !sameListed(s, site)) } : false);
        if (changed) clearSiteMemory(o, origin => sameListed(origin, site));
        o.out(changed ? `${site} is off the sites sleight may act on.\n` : `${site} isn't on an allow-only list.\n`); return 0;
      }
      const removed = revokeApp(o, what);
      o.out(removed ? `Revoked ${what} (${removed}). It asks again from its next action.\n` : `Nothing to revoke for ${what}.\n`); return 0;
    }
    if (['block', 'unblock'].includes(op) && rest.length === 1) {
      const chosen = target(rest[0]);
      if (!chosen) { o.out(usage); return 2; }
      const name = chosen.app ?? chosen.site;
      if (op === 'block') {
        const changed = chosen.app ? blockApp(o, chosen.app) : blockSite(o, chosen.site);
        const shown = chosen.app && readPermissions(o.path, o.uid).apps.find(app => app.id === chosen.app)?.name;
        const nameless = changed && chosen.app && !shown ? " macOS gave no name for it, so a getApp by the app's name won't match this block, though the read and actions after it still stop." : '';
        o.out(changed ? `sleight won't act ${chosen.app ? 'in' : 'on'} ${shown ? `${shown} (${name})` : name} from its next action, in every session.${nameless}\n` : `${name} is already blocked.\n`); return 0;
      }
      const changed = update(o, p => chosen.app
        ? p.apps.some(app => app.id.toLowerCase() === chosen.app.toLowerCase()) && { ...p, apps: p.apps.filter(app => app.id.toLowerCase() !== chosen.app.toLowerCase()) }
        : p.sites.some(site => sameBlock(site, chosen.site)) && { ...p, sites: p.sites.filter(site => !sameBlock(site, chosen.site)) });
      o.out(changed ? `sleight may act ${chosen.app ? 'in' : 'on'} ${name} again. Approvals still ask as before.\n` : `${name} isn't blocked.\n`); return 0;
    }
    if (op === 'sites' && rest[0] === 'all' && rest.length === 1) {
      update(o, p => p.only ? { ...p, only: undefined } : false);
      o.out('sleight may act on any site you haven\'t blocked.\n'); return 0;
    }
    if (op === 'sites' && rest[0] === 'only' && rest.length > 1) {
      const sites = rest.slice(1).map(siteOrigin);
      if (sites.some(site => !site) || sites.length > 256) { o.out(usage); return 2; }
      const only = sites.filter((site, at) => sites.findIndex(other => sameListed(other, site)) === at);
      update(o, p => ({ ...p, only }));
      o.out(`sleight acts only on ${only.join(', ')} from its next action, in turbo and in browser windows on the engine path. sleight-mcp permissions sites all lifts the limit.\n`); return 0;
    }
  } catch (error) {
    if (typeof error?.line === 'string') { o.out(error.line); return 1; }
    const code = /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message.replace(/^TURBO_/, 'PERMISSIONS_') : error?.code ?? 'PERMISSIONS_FAILED';
    o.out(`permissions ${args.join(' ')} failed: ${code}${code === 'PERMISSIONS_UNSAFE' ? ` (${o.path} is a link or has another owner, mode or format; sleight-mcp permissions repair fixes it and keeps the valid blocks)` : ''}\n`);
    return 1;
  }
  o.out(usage); return 2;
}

// The menu's payload stays inside the host's 8 KiB frame line with room for the rest of the frame.
const clip = text => text.length > 80 ? text.slice(0, 79) + '…' : text;
// What the host admits (consent-host.swift permissionsData): a row it would refuse would end the host, so it is left out here.
const printable = text => typeof text === 'string' && text.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(text);
const HOST_TARGET = /^(?:app:.{1,255}|electron:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|turbo)$/;
/** { payload, offered } for the glove's Permissions menu. payload: { grants: [{ title, detail, used, target }], current?,
 *  blocked: [title], only? }, with used in seconds. offered: the targets a click may act on, so the menu can only revoke what it
 *  showed and block the app it named. */
export function permissionsMenu(options) {
  const o = context(options), { grants } = standing(o), perms = readPermissions(o.path, o.uid), app = currentApp();
  const rows = grants.filter(g => printable(g.title) && printable(g.target) && HOST_TARGET.test(g.target)).slice(0, 24)
    .map(g => ({ title: clip(g.title), detail: g.detail, used: Number.isFinite(g.used) ? Math.floor(g.used / 1000) : null, target: g.target }));
  const blocked = perms.state === 'unsafe' ? ['permissions.json is unsafe: run sleight-mcp permissions repair'] : [...perms.apps.map(a => clip(a.name ?? a.id)), ...perms.sites.map(clip)].slice(0, 24);
  const offerBlock = app && perms.state !== 'unsafe' && perms.apps.length < LIMIT;
  const current = offerBlock && !perms.apps.some(a => a.id.toLowerCase() === app.bundleId.toLowerCase()) ? { title: clip(app.name), target: app.bundleId } : undefined;
  const payload = { grants: rows, blocked, ...current ? { current } : {}, ...perms.only ? { only: perms.only.slice(0, 12).map(clip) } : {} };
  while (Buffer.byteLength(JSON.stringify(payload)) > 5800 && payload.grants.length) payload.grants.pop();
  const offered = new Set(payload.grants.map(g => g.target).filter(target => target !== 'turbo'));
  if (current) offered.add('block:' + current.target);
  return { payload, offered, names: current ? { [current.target]: app.name } : {} };
}

/** A click from the menu, already matched to this session's nonce by the hand client: revoke one offered row, revoke all, or
 *  block the offered app. Returns whether it changed anything. The menu never lifts a block or grants. */
export function applyMenuEvent(event, offered, options) {
  const o = context(options);
  if (event?.permissions === 'revoke-all') { revokeAll(o, { includeTurbo: false }); return true; }
  if (event?.permissions === 'revoke' && typeof event.target === 'string' && event.target !== 'turbo' && offered?.has(event.target)) {
    const [kind, name] = [event.target.slice(0, event.target.indexOf(':')), event.target.slice(event.target.indexOf(':') + 1)];
    if (kind === 'app') return removePreapproved(name, { home: o.home, uid: o.uid });
    if (kind === 'electron') {
      const store = o.grants();
      let removed = false;
      for (const record of store.list()) if (record.bundleId === name && store.remove(record.key)) removed = true;
      return removed;
    }
    return false;
  }
  if (event?.permissions === 'block' && typeof event.target === 'string' && offered?.has('block:' + event.target)) {
    // The menu names the app it offers; it never asks LaunchServices from inside the session.
    return blockApp(o, event.target, undefined, currentApp()?.bundleId === event.target ? [currentApp().name] : []);
  }
  return false;
}

/** Doctor section. Only an unsafe permissions.json is a problem: it refuses every action. */
export function permissionsDoctorLines(options) {
  const o = context(options), perms = readPermissions(o.path, o.uid), lines = ['permissions'];
  if (perms.state === 'unsafe') {
    lines.push('PROBLEM   permissions.json is a link or has another owner, mode or format, so sleight acts nowhere',
      '          fix: sleight-mcp permissions repair (it keeps the valid blocks)');
    return lines;
  }
  const blocks = [perms.apps.length && count(perms.apps.length, 'app'), perms.sites.length && count(perms.sites.length, 'site')].filter(Boolean);
  lines.push(`ok        blocks: ${blocks.length ? blocks.join(', ') : 'none'} (sleight-mcp permissions lists what sleight may do)`,
    `ok        sites: ${perms.only ? 'only ' + perms.only.join(', ') : 'any site'}`);
  return lines;
}
