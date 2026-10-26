// sleight's own menu bar glove, approval cards and payment cards belong to its consent host, the bare `consent-host`
// binary sleight builds in its helper cache (direct-browser/host.mjs). Only the person's click may answer them, so no
// tool acts on that process. The native helpers (lease-target.js, hover.js, drag.js, select-window.js, menubar.js)
// check the same identity by pid themselves.
import { execFileSync } from 'node:child_process';

export const OWN_HOST_LINE = "That is sleight's own confirmation window; only you can answer it.";
const HELPER_CACHE = /\/Library\/Caches\/sleight\/turbo-host\//i;
// The host's name however it is spelled: case, spaces, `-` or `_`, a path before it or `.app` after it.
const hostName = value => value.trim().replace(/^.*\//, '').replace(/\.app$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'consenthost';

// macOS's own authentication sheets: Touch ID and password for LocalAuthentication (coreautha, which sleight's high-stakes
// settings changes use, person-confirm.mjs) and authorization prompts (SecurityAgent). Bundle ids and paths found on this Mac
// (macOS 27, 2026-10-26); the names are the bundles' CFBundleName. No tool acts on them, as on sleight's own host.
export const AUTH_DIALOG_LINE = "That is macOS's own Touch ID or password dialog; only you can answer it.";
const AUTH_BUNDLES = ['com.apple.localauthentication.uiagent', 'com.apple.securityagent'];
const AUTH_NAMES = ['coreautha', 'coreauthd', 'securityagent', 'authorizationhost', 'userauthd'];
const AUTH_PATH = /\/System\/Library\/Frameworks\/(?:LocalAuthentication\.framework|Security\.framework)\/|\/SecurityAgentPlugins\//i;
const authName = value => { const key = value.trim().replace(/^.*\//, '').replace(/\.(?:app|bundle)$/i, '').toLowerCase();
  return AUTH_BUNDLES.includes(key) || AUTH_NAMES.includes(key.replace(/[^a-z0-9]/g, '')); };
export const isAuthDialog = (...values) => values.some(value => typeof value === 'string' && (authName(value) || AUTH_PATH.test(value)));

const isConsentHost = (...values) => values.some(value => typeof value === 'string' && (hostName(value) || HELPER_CACHE.test(value)));
// A name, bundle id or path that only the person may answer: the host (its name, or any file in sleight's helper cache) or a
// system authentication sheet.
export const isOwnHost = (...values) => isConsentHost(...values) || isAuthDialog(...values);
/** The line Claude gets for values that name one of them: the system sheet's own line, or the host's. */
export const ownLine = (...values) => isAuthDialog(...values) ? AUTH_DIALOG_LINE : OWN_HOST_LINE;
// Text that names the host or a system authentication agent anywhere, such as an approval card's message.
export const mentionsOwnHost = text => typeof text === 'string' && (/consent[\s_-]*host(?![a-z])/i.test(text) || HELPER_CACHE.test(text) ||
  /\b(?:coreautha|coreauthd|securityagent|com\.apple\.localauthentication)\b/i.test(text));

// Whether a running pid is the host or an authentication agent, from the executable ps names (both start by full path).
export function ownHostPid(pid, run = execFileSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { return isOwnHost(String(run('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 1000 })).trim()); }
  catch { return false; }
}

// An app as Claude or the engine names it (a name, bundle id, path, or pid as a number or digits) that is the host.
export function namesOwnHost(app, pidCheck = ownHostPid) {
  if (typeof app === 'number') return pidCheck(app);
  if (typeof app !== 'string') return false;
  return /^\s*\d+\s*$/.test(app) ? pidCheck(Number(app)) : isOwnHost(app);
}

// The getApp targets in js code: each argument made only of string literals (joined with +, escapes decoded) or digits.
// A computed argument is left out: only the engine's approval card can name it, and the relay declines the host's card.
const LITERAL = String.raw`"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\x60(?:[^\x60\\$]|\\[\s\S]|\$(?!\{))*\x60`;
const PLAIN = new RegExp(String.raw`\s*((?:${LITERAL})(?:\s*\+\s*(?:${LITERAL}))*|\d+)\s*\)`, 'y');
const GET_APP = String.raw`\bcua\s*(?:(?:\?\.|\.)\s*getApp\b|(?:\?\.\s*)?\[\s*(["'\x60])getApp\1\s*\])`;
const decode = body => body.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|(\r\n|[\n\r])|([\s\S]))/g,
  (_, x, braced, u, line, other) => {
    if (x || braced || u) { try { return String.fromCodePoint(parseInt(x ?? braced ?? u, 16)); } catch { return ''; } }
    if (line) return '';
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[other] ?? other;
  });
export function getAppTargets(code) {
  const source = String(code ?? ''), literals = [];
  const aliases = new Set();
  // Keep function aliases local to this code. Computed targets still rely on the engine's approval card.
  // GET_APP's quote backreference is group 1, so capture the alias after matching the assignment separately.
  for (const assignment of source.matchAll(new RegExp(String.raw`[A-Za-z_$][\w$]*\s*=\s*${GET_APP}(?=\s*(?:[;,}\n]|$))`, 'g'))) {
    aliases.add(assignment[0].match(/^[A-Za-z_$][\w$]*/)[0]);
  }
  for (const binding of source.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*cua\b/g)) {
    for (const field of binding[1].split(',')) {
      const alias = field.match(/^\s*getApp\s*(?::\s*([A-Za-z_$][\w$]*))?\s*$/);
      if (alias) aliases.add(alias[1] ?? 'getApp');
    }
  }
  const calls = [...source.matchAll(new RegExp(String.raw`${GET_APP}\s*(?:\?\.\s*)?\(`, 'g'))];
  for (const call of source.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(/g)) {
    if (aliases.has(call[1])) calls.push(call);
  }
  for (const call of calls.sort((a, b) => a.index - b.index)) {
    PLAIN.lastIndex = call.index + call[0].length;
    const plain = PLAIN.exec(source);
    if (!plain) continue;
    literals.push(/^\d+$/.test(plain[1]) ? plain[1]
      : [...plain[1].matchAll(new RegExp(LITERAL, 'g'))].map(part => decode(part[0].slice(1, -1))).join(''));
  }
  return literals;
}
