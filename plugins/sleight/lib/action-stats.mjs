// `sleight-mcp stats` and the dropdown's usage row: a summary of the opt-in action log (action-outcomes.mjs) read back on this
// Mac. Nothing here writes, and nothing leaves the Mac. Only numbers and words from fixed sets reach the output, so a line
// planted in the log can't put its own text on the terminal or in the menu.
import { constants, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { actionLogPath, REASONS } from './action-outcomes.mjs';

const DAY = 86400000;
const MAX_FILE = 16 * 1024 * 1024;
const USAGE = 'usage: sleight-mcp stats [--days N] [--json] [--log <file name>]\n';
// The reasons a summary names; any other is counted as other.
const NAMED = new Set([...REASONS, 'error', 'engine error', 'covered']);

// One file's rows, 'big' for a file over the limit, or none: only a regular file, opened without following a link.
async function fileRows(path, maxBytes) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return;
    if (stat.size > maxBytes) return 'big';
    const rows = [];
    for (const line of (await handle.readFile('utf8')).split('\n')) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
    return rows;
  } catch { return; } finally { await handle?.close().catch(() => {}); }
}

/** The log and its two rotated files, oldest first. files counts the ones read, skipped the ones over maxBytes (16 MB). */
export async function readLogRows(path, { maxBytes = MAX_FILE } = {}) {
  const rows = [];
  let files = 0, skipped = 0;
  for (const file of [`${path}.2`, `${path}.1`, path]) {
    const found = await fileRows(file, maxBytes);
    if (found === 'big') skipped++;
    else if (found) { files++; rows.push(...found); }
  }
  return { rows, files, skipped };
}

const round = value => Math.round(value * 1000) / 1000;
// Samples are [seconds, weight]: a call's actions share one sample, never expanded. The quantile interpolates between the
// closest ranks as if each sample were repeated weight times.
function quantile(sorted, total, q) {
  const h = (total - 1) * q, low = Math.floor(h);
  const at = rank => { let seen = 0; for (const [value, weight] of sorted) { seen += weight; if (rank < seen) return value; } return sorted.at(-1)[0]; };
  const a = at(low), b = at(low + 1);
  return round(a + (h - low) * (b - a));
}
const spread = samples => {
  const sorted = [...samples].sort((a, b) => a[0] - b[0]), total = sorted.reduce((sum, [, weight]) => sum + weight, 0);
  return total ? { median: quantile(sorted, total, 0.5), p90: quantile(sorted, total, 0.9) } : { median: null, p90: null };
};
// A row's counts are capped: the guard keeps 30 records a call and an engine browser call names at most 100 actions, so
// anything larger came from a corrupt or planted line.
const count = (value, cap = 1000) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : 0;

// How many actions a row stands for: a row that ran is one, an engine browser call the actions its code named, and a record-cap
// line the actions that ran past the cap.
function weight(row) {
  if (row.kind === 'read' || row.kind === 'recipe') return 0;
  if (row.result === 'ok' || row.result === 'failed') return row.kind === 'call' && count(row.actions) > 0 ? count(row.actions, 100) : 1;
  if (row.result === 'not logged') return count(row.count);
  return 0;
}
const pathOf = rows => rows[0].tool.startsWith('browser_') ? 'turbo' : rows.some(row => row.surface === 'browser') ? 'engine' : 'native';

/** The log's rows from the last `days` days: actions that ran, their seconds per action by path, reads saved and failures. */
export function summarize(rows, { now = Date.now(), days = 7 } = {}) {
  const since = now - days * DAY, calls = new Map();
  let from, to;
  for (const row of rows) {
    const time = row && typeof row === 'object' && typeof row.time === 'string' ? Date.parse(row.time) : NaN;
    if (!(time >= since && time <= now) || typeof row.tool !== 'string' || typeof row.kind !== 'string' || typeof row.result !== 'string') continue;
    from = from === undefined || time < from ? time : from; to = to === undefined || time > to ? time : to;
    // A call's rows are written together, so they share their time.
    const key = JSON.stringify([row.time, row.call, row.tool, row.pid]);
    if (!calls.has(key)) calls.set(key, []);
    calls.get(key).push(row);
  }
  const samples = { native: [], turbo: [], engine: [] }, actions = { native: 0, turbo: 0, engine: 0 };
  const refused = { count: 0, reasons: {} }, failed = { count: 0, reasons: {} };
  let callCount = 0, untimed = 0, readsSaved = 0, notRun = 0;
  const reason = (into, row, n = 1) => {
    const word = NAMED.has(row.reason) ? row.reason : 'other';
    into.count += n; into.reasons[word] = (into.reasons[word] ?? 0) + n;
  };
  for (const rows of calls.values()) {
    const path = pathOf(rows);
    let ran = 0;
    for (const row of rows) {
      ran += weight(row);
      readsSaved += count(row.saved);
      if (row.result === 'refused') reason(refused, row);
      else if (row.result === 'failed') reason(failed, row);
      else if (row.result === 'not run') notRun += row.kind === 'rest' ? count(row.count) : 1;
    }
    if (!ran) continue;
    callCount++;
    actions[path] += ran;
    const ms = rows.find(row => typeof row.ms === 'number')?.ms;
    if (!(Number.isFinite(ms) && ms >= 0 && ms <= DAY)) { untimed += ran; continue; }
    samples[path].push([ms / 1000 / ran, ran]);
  }
  const timed = list => list.reduce((sum, [, weight]) => sum + weight, 0);
  const sorted = order => Object.fromEntries(Object.entries(order).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)));
  return {
    days, from: from === undefined ? null : new Date(from).toISOString(), to: to === undefined ? null : new Date(to).toISOString(),
    calls: callCount, actions: actions.native + actions.turbo + actions.engine,
    timed: timed(samples.native) + timed(samples.turbo) + timed(samples.engine), untimed,
    paths: Object.fromEntries(Object.keys(samples).map(path => [path, { actions: actions[path], timed: timed(samples[path]), ...spread(samples[path]) }])),
    readsSaved,
    refused: { count: refused.count, reasons: sorted(refused.reasons) },
    failed: { count: failed.count, reasons: sorted(failed.reasons) },
    notRun,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const seconds = value => value.toFixed(1);
function stamp(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
const tilde = (path, home) => path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
const reasons = into => Object.entries(into.reasons).map(([word, n]) => `${word} ${n}`).join(', ');

/** The summary as the command prints it. Paths stay apart: their times measure different things. */
export function statsText(summary, { log, files, skipped = 0, timeZone }) {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const span = summary.days === 1 ? 'day' : `${summary.days} days`;
  if (!summary.from) return `No actions logged in the last ${span}.\nLog: ${log}\n`;
  const rotated = files - 1 > 0 ? `, with ${plural(files - 1, 'rotated file')}` : '';
  const lines = [`sleight stats for the last ${span}, ${stamp(Date.parse(summary.from), zone)} to ${stamp(Date.parse(summary.to), zone)} (${zone})`,
    `Log: ${log}${rotated}`, ...skipped ? [`Skipped ${plural(skipped, 'log file')} over 16 MB.`] : [],
    `${plural(summary.actions, 'action')} in ${plural(summary.calls, 'call')}`,
    summary.timed ? 'Seconds per action, from sending each call to its reply, less approval prompts:' : 'Seconds per action: no timed actions yet'];
  for (const [path, name] of [['native', 'Native apps'], ['turbo', 'Turbo'], ['engine', 'Engine path']]) {
    const part = summary.paths[path];
    if (!part.actions) continue;
    lines.push(`  ${name}: ${plural(part.actions, 'action')}, ` + (part.timed ? `median ${seconds(part.median)} s, p90 ${seconds(part.p90)} s` : 'no timing') +
      (path === 'engine' ? ', with actions counted from the code (an estimate)' : ''));
  }
  if (summary.timed) lines.push('A p90 can include waits sleight can\'t separate, such as turbo\'s own confirmation cards.');
  lines.push(`Reads saved: ${summary.readsSaved}, reads Claude asked for that went out as changed lines or were left out`);
  if (summary.refused.count) lines.push(`Refused: ${summary.refused.count} (${reasons(summary.refused)})`);
  if (summary.failed.count) lines.push(`Failed: ${summary.failed.count} (${reasons(summary.failed)})`);
  if (summary.notRun) lines.push(`Not run: ${summary.notRun}`);
  if (!summary.refused.count && !summary.failed.count && !summary.notRun) lines.push('No failures');
  if (summary.untimed) lines.push(`${plural(summary.untimed, 'action')} ${summary.untimed === 1 ? 'has' : 'have'} no timing: sleight before 1.4.0 logged ${summary.untimed === 1 ? 'it' : 'them'}.`);
  lines.push('This comes from the log on this Mac. Nothing is sent anywhere.');
  return lines.join('\n') + '\n';
}

// SLEIGHT_ACTION_LOG from the env block of ~/.claude/settings.json, where the settings docs put it.
function settingsValue(home) {
  try {
    const text = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    if (text.length > 1024 * 1024) return;
    const value = JSON.parse(text)?.env?.SLEIGHT_ACTION_LOG;
    return typeof value === 'string' && value ? value : undefined;
  } catch { return undefined; }
}

const HOW_TO = 'To turn it on, add "SLEIGHT_ACTION_LOG": "actions.jsonl" to the env block of ~/.claude/settings.json, then start a new session.\n' +
  'The log stays in ~/Library/Logs/sleight/ on this Mac. Nothing is sent anywhere.\n';

/** `sleight-mcp stats [--days N] [--json] [--log <file name>]`. Exit code 0, or 2 on usage. */
export async function statsCommand(args, { out = text => process.stdout.write(text), env = process.env, home = homedir(), now = Date.now,
  timeZone, maxBytes } = {}) {
  let days = 7, json = false, flag;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--days' && /^\d{1,3}$/.test(args[i + 1] ?? '') && Number(args[i + 1]) >= 1 && Number(args[i + 1]) <= 365) days = Number(args[++i]);
    else if (args[i] === '--log' && typeof args[i + 1] === 'string') flag = args[++i];
    else { out(USAGE); return 2; }
  }
  const value = flag ?? (env.SLEIGHT_ACTION_LOG || settingsValue(home));
  const path = actionLogPath(value, home);
  if (!path) {
    if (json) out(JSON.stringify({ log: null }) + '\n');
    else out((value ? 'SLEIGHT_ACTION_LOG takes a file name or a path under ~/Library/Logs/sleight/, so this one is ignored and the action log is off.\n'
      : 'The action log is off, so sleight has nothing to count.\n') + HOW_TO);
    return 0;
  }
  const log = tilde(path, home), { rows, files, skipped } = await readLogRows(path, maxBytes ? { maxBytes } : {});
  const summary = summarize(rows, { now: now(), days });
  if (json) { out(JSON.stringify({ log, files, skipped, ...summary }, null, 2) + '\n'); return 0; }
  out(files ? statsText(summary, { log, files, skipped, timeZone })
    : skipped ? `The action log is on (${log}). Skipped ${plural(skipped, 'log file')} over 16 MB.\n`
    : `The action log is on (${log}), and nothing is in it yet.\n`);
  return 0;
}

/** The dropdown's row: { native?, turbo?, saved } over the last 7 days, the median seconds per action on each path, or undefined
 *  without a timed native or turbo action. The engine browser path's count is an estimate, so it stays out. */
export async function menuUsage({ path, now = Date.now } = {}) {
  if (!path) return undefined;
  const { paths, readsSaved } = summarize((await readLogRows(path)).rows, { now: now(), days: 7 });
  if (!paths.native.timed && !paths.turbo.timed) return undefined;
  const tenth = value => Math.round(value * 10) / 10;
  return { ...paths.native.timed ? { native: tenth(paths.native.median) } : {}, ...paths.turbo.timed ? { turbo: tenth(paths.turbo.median) } : {}, saved: readsSaved };
}
