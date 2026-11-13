// The apps and sites the user told sleight never to act in, and when sleight last used each standing permission. The blocks
// live in ~/Library/Application Support/sleight/permissions.json, written only by `sleight-mcp permissions` (permissions-command
// .mjs) and the user's click in sleight's menu, and the write guard keeps Claude's file and shell tools away from it. This module
// only reads: the relay checks apps before any action, turbo checks sites, and both read the file again when it changes, so a
// block applies at once in every session. A file that isn't safe to read refuses every action until the user fixes it.
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, utimesSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

const support = home => join(home, 'Library/Application Support/sleight');
export const permissionsPath = (home = userInfo().homedir) => join(support(home), 'permissions.json');
// One empty file per permission whose modification time is its last use (stampUse). Nothing else is ever written there.
export const usedFolder = (home = userInfo().homedir) => join(support(home), 'used');
export const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
// The most blocks of each kind, and the file's size limit, which 256 apps with long names and ids fit inside.
export const LIMIT = 256, PERMISSIONS_BYTES = 262144, ALIASES = 4;
export const NAME = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

/** The web origin of an http(s) URL without credentials, lowercased as URL writes it, or undefined. */
export function siteOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : undefined;
  } catch { return undefined; }
}

/** { state: 'absent' | 'ok' | 'unsafe', apps: [{ id, name?, aliases? }], sites: [origin], only?: [origin] }. Unsafe is a link,
 *  another owner, a mode other than 0600, or anything but { version: 1, apps, sites, only? } with bundle ids and canonical
 *  origins. aliases are the app's other names (at most 4), so a block by bundle id matches what Claude calls the app. */
export function readPermissions(path = permissionsPath(), uid = process.getuid()) {
  const empty = state => ({ state, apps: [], sites: [] });
  let stat;
  try { stat = lstatSync(path); } catch (error) { return empty(error.code === 'ENOENT' ? 'absent' : 'unsafe'); }
  try {
    if (!isAbsolute(path) || normalize(path) !== path || !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
        stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size > PERMISSIONS_BYTES) return empty('unsafe');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const origins = list => Array.isArray(list) && list.length <= LIMIT && list.every(site => siteOrigin(site) === site) && new Set(list).size === list.length;
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['version', 'apps', 'sites', 'only'].includes(key)) ||
        data.version !== 1 || !Array.isArray(data.apps) || data.apps.length > LIMIT || !origins(data.sites) ||
        data.only !== undefined && (!origins(data.only) || !data.only.length) ||
        !data.apps.every(app => app && typeof app === 'object' && Object.keys(app).every(key => ['id', 'name', 'aliases'].includes(key)) &&
          typeof app.id === 'string' && app.id.length <= 255 && BUNDLE_ID.test(app.id) && (app.name === undefined || NAME(app.name)) &&
          (app.aliases === undefined || Array.isArray(app.aliases) && app.aliases.length > 0 && app.aliases.length <= ALIASES && app.aliases.every(NAME)))) return empty('unsafe');
    return { state: 'ok', apps: data.apps.map(app => ({ ...app, ...app.aliases ? { aliases: [...app.aliases] } : {} })), sites: [...data.sites], ...data.only ? { only: [...data.only] } : {} };
  } catch { return empty('unsafe'); }
}

const UNSAFE = "sleight's permissions file is a link or has another owner, mode or format, so sleight acts nowhere until you run sleight-mcp permissions repair.";
const MISSING = "sleight's permissions file is gone since this session read it, so sleight acts nowhere until you run sleight-mcp permissions repair.";
// The line for a file sleight can't trust: unsafe, or missing after this session read it (createPermissionCheck).
const stopped = perms => perms?.state === 'unsafe' ? UNSAFE : perms?.state === 'missing' ? MISSING : undefined;
const words = list => list.length <= 4 ? list.slice(0, -1).join(', ') + (list.length > 1 ? ' and ' : '') + list.at(-1)
  : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;

// An app name as Claude may write it: either case, and a path or .app around it.
const appName = value => value.trim().replace(/^.*\//, '').replace(/\.app$/i, '').toLowerCase();
/** The line Claude relays when the user blocked this app (by bundle id, name or alias, either case), or undefined. */
export function appRefusal(perms, { bundleId, name } = {}) {
  if (stopped(perms)) return stopped(perms);
  const given = [bundleId, name].filter(value => typeof value === 'string' && value.trim());
  const ids = given.map(value => value.trim().toLowerCase()), names = [...ids, ...given.map(appName)];
  const hit = given.length ? perms?.apps?.find(app => ids.includes(app.id.toLowerCase()) ||
    [app.name, ...app.aliases ?? []].some(known => known && names.includes(appName(known)))) : undefined;
  return hit && `You blocked sleight in ${hit.name ?? hit.id} (sleight-mcp permissions unblock ${hit.id} lifts it).`;
}

// Sites are compared by host: lowercased, one trailing dot and a leading www. removed, so www.example.com, example.com and
// example.com. are one site. A block covers that host's subdomains too, on any scheme and port. An allow-only entry matches
// its own scheme and port (a default port is no port) and no subdomain, since a looser match there would widen access.
// www. comes off only when a dot remains after it, so www.com stays www.com and never becomes a block on all of .com.
const siteHost = host => String(host ?? '').toLowerCase().replace(/\.$/, '').replace(/^www\.(?=[^.]+\.)/, '');
// host[:port] as a URL writes it, split without parsing so a bracketed IPv6 address keeps its colons.
const hostPort = value => { const [, host, port = ''] = /^(.*?)(?::(\d+))?$/.exec(String(value ?? '')); return { host: siteHost(host), port }; };
const covers = (origin, host) => { const blocked = siteHost(new URL(origin).hostname), seen = hostPort(host).host; return !!blocked && (seen === blocked || seen.endsWith('.' + blocked)); };
const lists = (origin, { host, scheme }) => {
  const url = new URL(origin), seen = hostPort(host);
  return siteHost(url.hostname) === seen.host && url.port === seen.port && (!scheme || url.protocol === scheme + ':');
};
/** The stored block or allow-only entry the user would mean by this origin, compared as the checks compare. */
export const sameBlock = (a, b) => siteHost(new URL(a).hostname) === siteHost(new URL(b).hostname);
export const sameListed = (a, b) => { const url = new URL(b); return lists(a, { host: url.host, scheme: url.protocol.slice(0, -1) }); };
export const coveringBlock = (sites, origin) => sites?.find(site => covers(site, new URL(origin).host));

const TAB_UNPROVEN = "You limited the sites sleight acts on, and it can't tell which site this tab shows, so it doesn't act here (sleight-mcp permissions lists your limits).";
/** The line Claude relays when the user blocked this page's site, or limited sleight to other sites, or undefined. While any
 *  site limit exists the check fails closed: a URL that isn't http(s), or no URL at all, refuses, except a blank tab. A URL
 *  with credentials is judged by its host. Turbo checks sites in browsers and opted-in Electron app turns. */
export function siteRefusal(perms, url) {
  if (stopped(perms)) return stopped(perms);
  if (!sitesLimited(perms)) return undefined;
  if (url === 'about:blank') return undefined;
  let parsed;
  try { parsed = new URL(url); } catch { return TAB_UNPROVEN; }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return TAB_UNPROVEN;
  const blocked = perms.sites?.find(site => covers(site, parsed.host));
  if (blocked) return `You blocked sleight on ${blocked} (sleight-mcp permissions unblock ${blocked} lifts it).`;
  if (perms.only && !perms.only.some(site => lists(site, { host: parsed.host, scheme: parsed.protocol.slice(0, -1) }))) {
    return `You allow sleight only on ${words(perms.only)}, not ${parsed.origin} (sleight-mcp permissions lists them).`;
  }
  return undefined;
}

// One site from an engine tree's URL text: `https://host/…` or Safari's scheme-less `host/…`. Anything else proves nothing.
function webSite(value) {
  const match = /^(?:(https?):\/\/)?([^/\s?#]+)/i.exec(String(value ?? ''));
  if (!match || /[:@]/.test(match[2].replace(/:\d{1,5}$/, ''))) return undefined;
  try { const url = new URL(`${match[1] ?? 'https'}://${match[2]}`); return { host: url.host, ...match[1] ? { scheme: match[1].toLowerCase() } : {} }; }
  catch { return undefined; }
}

/** The site a browser window shows, from an engine read: { host, scheme? } when the read proves one site, { unproven: true }
 *  when it shows web content without one provable site, and undefined when it shows no web content. Only two things count:
 *  the window's URL field (the engine's `URL:` line, or the URL attribute on the window's root line) and the URL attribute
 *  of the outermost web areas ("HTML content"), which must all name one site; Safari writes theirs without a scheme
 *  (bestbuy.com/product/…). The page writes the title and the descriptions on those same lines, so a line with more than one
 *  `URL: `, or a title with one, proves nothing. When the window field and the web areas both name a site they must agree.
 *  An address bar's text proves nothing: it may be typed and not loaded. */
export function pageSite(text, window) {
  const source = String(text ?? ''), tokens = line => line.match(/URL: /g)?.length ?? 0;
  // Only a read with the window's root line shows the outermost web area. A find or a diff without it proves nothing, since
  // the page can label its own element "HTML content", and the window keeps the site an earlier full read proved.
  if (!/^0 /m.test(source)) return undefined;
  const fields = [...source.matchAll(/^URL: .*$/gm)].length + [...source.matchAll(/^0 .*$/gm)].reduce((n, line) => n + tokens(line[0]), 0);
  const web = /^https?:\/\//i.test(window?.url ?? '');
  // A window field the page may have written is left out, and then only the web areas can prove the site.
  const fromWindow = web && fields === 1 && !/URL:/i.test(window?.title ?? '') ? webSite(window.url) ?? { unproven: true } : undefined;
  const areas = [...source.matchAll(/^(\t*)\d+ HTML content\b(.*)$/gm)];
  if (!areas.length) return fromWindow ?? (web ? { unproven: true } : undefined);
  const depth = Math.min(...areas.map(area => area[1].length));
  const sites = areas.filter(area => area[1].length === depth).map(area => tokens(area[2]) === 1 ? webSite(/URL: ([^\s,]+)/.exec(area[2])?.[1]) : undefined);
  const key = site => { const { host, port } = hostPort(site.host); return `${host}:${port}`; };
  if (sites.some(site => !site) || new Set(sites.map(site => `${site.scheme ?? ''}//${key(site)}`)).size !== 1) return { unproven: true };
  if (fromWindow && (fromWindow.unproven || key(fromWindow) !== key(sites[0]))) return { unproven: true };
  return fromWindow ?? sites[0];
}

/** The line for acting in a browser window on the engine path, or undefined. With no site blocks and no allow-only list,
 *  nothing to check. Otherwise a site the read can't prove refuses, a blocked host refuses whatever its scheme, and in
 *  allow-only mode the host (and the scheme, when the read shows one) must be listed. */
export function pageRefusal(perms, page) {
  if (stopped(perms)) return stopped(perms);
  if (!perms?.sites?.length && !perms?.only) return undefined;
  if (!page || page.unproven) return "You limited the sites sleight acts on, and it can't tell which site this window shows, so it doesn't act here (sleight-mcp permissions lists your limits).";
  const blocked = perms.sites.find(origin => covers(origin, page.host));
  if (blocked) return `You blocked sleight on ${blocked} (sleight-mcp permissions unblock ${blocked} lifts it).`;
  if (perms.only && !perms.only.some(origin => lists(origin, page))) return `You allow sleight only on ${words(perms.only)}, not ${page.scheme ? page.scheme + '://' : ''}${page.host} (sleight-mcp permissions lists them).`;
  return undefined;
}
export const sitesLimited = perms => !!stopped(perms) || !!perms?.sites?.length || !!perms?.only;

/** The checks the relay and turbo run before acting. The file is read again only when its inode, size or time changes. Only
 *  the user's command and click write the file, and neither ever deletes it, so a file this session read that is now gone
 *  was removed by something else: that refuses every action, as an unsafe file does, until `permissions repair` writes one. */
export function createPermissionCheck({ path = permissionsPath(), uid = process.getuid(), read = readPermissions } = {}) {
  let seen, cached, existed = false;
  const state = () => {
    let key;
    try { const stat = lstatSync(path); key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch (error) { key = error.code ?? 'error'; }
    if (key !== seen || !cached) {
      seen = key; cached = read(path, uid);
      if (cached.state === 'ok') existed = true;
      else if (cached.state === 'absent' && existed) cached = { state: 'missing', apps: [], sites: [] };
    }
    return cached;
  };
  // Read once now, so a file deleted before this process's first check (turbo's worker starts long before its first page)
  // still reads as tampered.
  state();
  return Object.freeze({ state, app: query => appRefusal(state(), query), site: url => siteRefusal(state(), url),
    page: page => pageRefusal(state(), page), sitesLimited: () => sitesLimited(state()) });
}

// The app sleight last acted in, for the menu's Never Act in row. The relay notes it; the hand client reads it.
let current;
export function noteCurrentApp(app) {
  current = app && typeof app.bundleId === 'string' && BUNDLE_ID.test(app.bundleId) && app.bundleId.length <= 255
    ? { bundleId: app.bundleId, name: NAME(app.name) ? app.name : app.bundleId } : undefined;
}
export const currentApp = () => current;

const stamped = new Map();
const stampFile = (key, folder) => join(folder, createHash('sha256').update(key).digest('hex').slice(0, 24));
/** Records that a permission was used now: an empty 0600 file named by a digest of the key, with its time set. At most once a
 *  minute per key and process. Never throws: a failed stamp only means an older time in the list. */
export function stampUse(key, { folder = usedFolder(), now = Date.now } = {}) {
  try {
    const at = now(), file = stampFile(key, folder), last = stamped.get(file);
    if (last !== undefined && at >= last && at - last < 60000) return;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600));
    utimesSync(file, at / 1000, at / 1000);
    stamped.set(file, at);
  } catch {}
}
/** The last use stampUse recorded, in milliseconds, or undefined. */
export function lastUse(key, { folder = usedFolder() } = {}) {
  try { const stat = lstatSync(stampFile(key, folder)); return stat.isFile() ? stat.mtimeMs : undefined; } catch { return undefined; }
}

/** "used 2h ago", for the listing and the menu. */
export function usedWords(at, now = Date.now()) {
  if (!Number.isFinite(at)) return 'not used yet';
  const seconds = Math.max(0, (now - at) / 1000);
  return seconds < 60 ? 'used just now' : seconds < 3600 ? `used ${Math.floor(seconds / 60)}m ago`
    : seconds < 86400 ? `used ${Math.floor(seconds / 3600)}h ago` : `used ${Math.floor(seconds / 86400)}d ago`;
}
