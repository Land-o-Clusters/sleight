#!/usr/bin/env node
// How many characters sleight sends Claude, per target, tracked over time. Each target gets a fresh sleight session and
// the same reads: acquire (the first call, which carries the engine's docs and sleight's skill), a full read, a read with
// nothing changed, a screenshot. Each result is split by kind with bench/fowl/anatomy.mjs's splitter plus sleight's skill
// and notices. One line per target goes to docs/benchmarks/char-audit/history.jsonl with the commit and engine version, and the table
// shows the change since the last line for that target. No model; reads only.
// Usage: node bench/char-audit.mjs [--only a,b] [--no-save]
// Hold /tmp/sleight-live.lock while it runs. Needs FowlBrowser's demo server for the local pages (started here) and
// approves only the benchmark's apps and sites (LAWS).
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultKinds } from './fowl/anatomy.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FOWL = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
const HISTORY = join(REPO, 'docs/benchmarks/char-audit/history.jsonl');
const HELIUM = '2f6fb307-288b-46d7-9fc2-5262c30ea852';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? true]] : acc), []));

const tab = (url) => ({
  acquire: `let b = await cua.getBrowser({ extensionInstanceId: '${HELIUM}' }); let t = await cua.createBrowserTab(b.browserId, '${url}', { sessionName: 'char audit' });`,
  read: 'await t.getAXState({ disableDiffing: true })', again: 'await t.getAXState()', shot: 'await t.getScreenshot()', close: 'await t.close?.(); 1',
});
const app = (name, setup) => ({
  setup,
  acquire: `let a = await cua.getApp(${JSON.stringify(name)});`,
  read: 'await a.getAXState({ disableDiffing: true })', again: 'await a.getAXState()', shot: 'await a.getScreenshot()', close: '1',
});
let note;
const makeNote = () => { note = join(mkdtempSync(join(tmpdir(), 'sleight-char-audit-')), 'audit-note.txt'); writeFileSync(note, 'Char audit\nA short plain-text document for the audit.\n'); return note; };
const TARGETS = {
  'web-form-travel': tab('http://127.0.0.1:5413/travel'),
  'web-form-settings': tab('http://127.0.0.1:5413/settings'),
  'web-form-checkout': tab('http://127.0.0.1:5413/checkout'),
  'web-shop': tab('http://127.0.0.1:5420/t/audit/shop/'),
  'web-mail': tab('http://127.0.0.1:5420/t/audit/mail/'),
  'web-wikipedia': tab('https://en.wikipedia.org/wiki/Mount_Kilimanjaro'),
  'web-mdn': tab('https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/418'),
  'app-calculator': app('Calculator'),
  'app-textedit': app('TextEdit', () => execFileSync('/usr/bin/open', ['-g', '-a', 'TextEdit', makeNote()])),
};
const APPS = ['Calculator', 'TextEdit', 'Helium'];
const SITES = /^http:\/\/127\.0\.0\.1:(5411|5412|5413|5414|5420|5421)$|^https:\/\/(en\.wikipedia\.org|developer\.mozilla\.org)$/;

// The MCP client comes from FowlBrowser's pinned clone, loaded only when the audit runs (tests import auditKinds alone).
let Client, StdioClientTransport, ElicitRequestSchema;
function loadSdk() {
  const sdk = createRequire(join(FOWL, 'mcp/node_modules/'));
  ({ Client } = sdk('@modelcontextprotocol/sdk/client/index.js'));
  ({ StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js'));
  ({ ElicitRequestSchema } = sdk('@modelcontextprotocol/sdk/types.js'));
}

const SKILL_HEAD = /^# Driving Mac apps with sleight/m;
// Splits one result text: the engine's docs by section, sleight's skill, trees, sleight's notices, the rest.
export function auditKinds(text) {
  const out = { docs: 0, skill: 0, tree: 0, notice: 0, other: 0 };
  let rest = text;
  const skillAt = rest.search(SKILL_HEAD);
  if (skillAt >= 0) {
    const end = rest.slice(skillAt).search(/\n(?=Browser tab: |Window: )/);
    const skill = end < 0 ? rest.slice(skillAt) : rest.slice(skillAt, skillAt + end);
    out.skill = skill.length; rest = rest.replace(skill, '');
  }
  const k = resultKinds(rest);
  out.docs = Object.values(k.docs).reduce((a, b) => a + b, 0); out.tree = k.tree;
  for (const line of rest.split('\n')) if (/^sleight[:\s]/i.test(line)) out.notice += line.length + 1;
  out.other = Math.max(0, k.other - out.notice);
  return out;
}

async function session(name, target) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE'))), SLEIGHT_SURFACES: 'browser,computer' };
  const client = new Client({ name: 'char-audit', version: '0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    const m = req.params.message ?? '';
    const site = /^Allow Browser use to access (\S+)\?$/.exec(m)?.[1];
    const appName = /^Allow Computer Use to use "(.+)"\?$/.exec(m)?.[1];
    const ok = (site && SITES.test(site)) || (appName && APPS.includes(appName));
    return { action: ok ? 'accept' : 'decline', content: {} };
  });
  await client.connect(new StdioClientTransport({ command: join(REPO, 'plugins/sleight/bin/sleight-mcp'), args: [], env, stderr: 'ignore' }));
  const row = {};
  for (const step of ['acquire', 'read', 'again', 'shot']) {
    const r = await client.callTool({ name: 'js', arguments: { code: target[step], title: 'char audit' } }, undefined, { timeout: 90000 });
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    row[step] = { chars: text.length, error: !!r.isError, ...auditKinds(text) };
  }
  await client.callTool({ name: 'js', arguments: { code: target.close, title: 'char audit' } }).catch(() => {});
  await client.close();
  return row;
}

if (import.meta.main) {
  loadSdk();
  const sha = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).toString().trim();
  const engine = readdirSync(join(homedir(), '.codex/plugins/cache/openai-bundled/unified-computer-use')).sort().at(-1);
  const previous = {};
  if (existsSync(HISTORY)) for (const line of readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(line); previous[r.target] = r; }
  const only = args.only ? String(args.only).split(',') : Object.keys(TARGETS);
  const demo = spawn('node', ['test/demo/server.mjs', '--all'], { cwd: FOWL, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const launched = APPS.filter((a) => spawnSyncRunning(a) === false);
  const rows = [];
  try {
    for (const name of only) {
      const target = TARGETS[name];
      // A document it opens in an app the user already had running would stay open, so that target is skipped.
      if (target.setup && !launched.includes(name.replace('app-', '').replace(/^\w/, (c) => c.toUpperCase()).replace('Textedit', 'TextEdit'))) { console.log(`${name}: skipped, the app was already running`); continue; }
      target.setup?.();
      const row = await session(name, target);
      const total = Object.values(row).reduce((a, s) => a + s.chars, 0);
      const rec = { at: new Date().toISOString(), sha, engine, target: name, total, steps: row };
      rows.push(rec);
      const before = previous[name]?.total;
      const f = (s) => `${s.chars}${s.error ? '!' : ''} (docs ${s.docs}, skill ${s.skill}, tree ${s.tree}, notice ${s.notice}, other ${s.other})`;
      console.log(`${name.padEnd(18)} total ${String(total).padStart(6)}${before != null ? ` (${total - before >= 0 ? '+' : ''}${total - before} since ${previous[name].sha})` : ''}`);
      for (const step of ['acquire', 'read', 'again', 'shot']) console.log(`  ${step.padEnd(8)} ${f(row[step])}`);
    }
  } finally {
    demo.kill();
    // Quit only the apps this audit started (LAWS: a run quits every app it launched).
    for (const a of launched) if (spawnSyncRunning(a)) execFileSync('/usr/bin/osascript', ['-e', `tell application "${a}" to quit saving no`]);
    if (note) rmSync(dirname(note), { recursive: true, force: true });
  }
  if (!args['no-save']) { mkdirSync(dirname(HISTORY), { recursive: true }); for (const r of rows) appendFileSync(HISTORY, JSON.stringify(r) + '\n'); }
}

function spawnSyncRunning(name) {
  try { execFileSync('/usr/bin/pgrep', ['-x', name]); return true; } catch { return false; }
}
