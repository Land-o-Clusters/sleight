#!/usr/bin/env node
// Static engine compatibility check: did a new ChatGPT release change what sleight depends on? It runs anywhere Node
// runs (Linux included) because it only reads the engine's files.
//
//   node bench/compat-static.mjs --app /Applications/ChatGPT.app [--report FILE]
//   node bench/compat-static.mjs --feed [--state DIR] [--force] [--keep-docs] [--report FILE]
//   node bench/compat-static.mjs --probe [--state DIR]     prints changed or unchanged (and sets it as a GitHub output)
//
// --feed polls ChatGPT's update feed and does nothing more until the version changes. Then it downloads the release,
// checks its Sparkle signature, unpacks it, and checks the contract. --state (default ~/.local/state/sleight-compat)
// keeps last.json and results.jsonl, which hold versions, dates and check names only. --keep-docs also keeps the
// engine's API docs per version in <state>/docs and diffs them there; use it only on a private machine, since those docs
// are OpenAI's text. Output and the report never contain engine text. Exit 0 on pass or no change, 1 on a failed
// check, 2 when the check couldn't run (feed or download), which retries on the next run.
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SAFE_VERSION, analyzeBundle, engineDocs, findApp } from './compat/static.mjs';
import { FEED_URL, download, fetchText, latestItem, parseAppcast, unpack, verifySignature } from './compat/feed.mjs';

const execute = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function verdictOf(steps) {
  if (steps.some(step => step.status === 'error')) return 'error';
  return steps.some(step => step.status === 'fail') ? 'fail' : 'pass';
}

// The sleight commit whose contract was checked.
export function sleightCommit(root = ROOT) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}

export function summary(report) {
  const head = `static compat ${report.appVersion ?? '?'} (engine ${report.engineVersion ?? '?'}): ${report.verdict.toUpperCase()}`;
  return [head, ...report.steps.map(step => `  ${step.status.padEnd(5)} ${step.id}${step.reason ? `: ${step.reason}` : ''}`)].join('\n');
}

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, path);
};

export function checkApp(app, { now = () => new Date() } = {}) {
  const analysis = analyzeBundle(app);
  return { checkedAt: now().toISOString(), source: 'static', appVersion: analysis.appVersion, engineVersion: analysis.engineVersion,
    sleight: sleightCommit(), verdict: verdictOf(analysis.results), steps: analysis.results, fingerprint: analysis.fingerprint };
}

// Line counts only: the diff itself stays in the state folder, and a failed diff reports no engine text.
async function keepDocs(state, version, app, run = execute) {
  const dir = join(state, 'docs');
  const previous = existsSync(join(dir, 'latest')) ? readFileSync(join(dir, 'latest'), 'utf8').trim() : undefined;
  mkdirSync(join(dir, version), { recursive: true });
  for (const [name, text] of Object.entries(engineDocs(app))) writeFileSync(join(dir, version, name), text, { mode: 0o600 });
  writeFileSync(join(dir, 'latest'), version + '\n');
  if (!previous || previous === version || !SAFE_VERSION.test(previous) || !existsSync(join(dir, previous))) return { docsBaseline: previous && SAFE_VERSION.test(previous) ? previous : null };
  let diff;
  try {
    diff = await run('diff', ['-ru', join(dir, previous), join(dir, version)], { maxBuffer: 64 << 20 }).then(r => r.stdout, error => {
      if (error.code === 1) return error.stdout;
      throw error;
    });
  } catch { return { docsBaseline: previous, docsDiff: 'failed' }; }
  writeFileSync(join(dir, `${version}.diff`), diff, { mode: 0o600 });
  return { docsBaseline: previous, docsChangedLines: diff.split('\n').filter(line => /^[+-](?![+-])/.test(line)).length };
}

export const MAX_ATTEMPTS = 3;
export const exitFor = verdict => (verdict === 'pass' ? 0 : verdict === 'fail' ? 1 : 2);
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };

// A checked release (pass or fail) is written to last.json and not checked again. A check that couldn't finish (bad
// signature, unpack failure, full disk) retries on the next runs, and after MAX_ATTEMPTS it's recorded as an error so
// the same download doesn't repeat every hour. A failed download or feed read always retries.
// Is there a release the state folder hasn't recorded? Reads only the feed.
export async function probeFeed({ state, feedUrl = FEED_URL, fetchImpl = fetch } = {}) {
  const last = readJson(join(state, 'last.json'));
  const item = latestItem(parseAppcast(await fetchText(feedUrl, { fetchImpl })));
  if (!item) return undefined;
  return !(last?.version === item.version && last?.build === item.build);
}

export async function runFeed({ state, force = false, keep = false, feedUrl = FEED_URL, fetchImpl = fetch, now = () => new Date(),
  unpackImpl = unpack, verifyImpl = verifySignature, downloadImpl = download, log = console.log } = {}) {
  mkdirSync(state, { recursive: true });
  const lastPath = join(state, 'last.json'), attemptsPath = join(state, 'attempts.json');
  const last = readJson(lastPath);
  let item;
  try { item = latestItem(parseAppcast(await fetchText(feedUrl, { fetchImpl }))); }
  catch (error) { log(`static compat: could not read the update feed (${error.name})`); return { exit: 2 }; }
  if (!item) { log('static compat: the update feed lists no release'); return { exit: 2 }; }
  if (!SAFE_VERSION.test(item.version) || (item.build !== undefined && !SAFE_VERSION.test(item.build))) {
    log('static compat: the update feed\'s version is not a plain version string'); return { exit: 2 };
  }
  if (last?.version === item.version && last?.build === item.build && !force) {
    log(`static compat: ChatGPT ${item.version} unchanged since ${last.checkedAt} (${last.verdict})`);
    return { exit: exitFor(last.verdict), unchanged: true };
  }
  const attempts = readJson(attemptsPath);
  const attempt = attempts?.version === item.version && attempts?.build === item.build ? attempts.count + 1 : 1;
  const temp = mkdtempSync(join(tmpdir(), 'sleight-compat-'));
  let report;
  try {
    const archive = join(temp, 'release');
    try { await downloadImpl(item.url, archive, { fetchImpl }); }
    catch (error) { log(`static compat: download of ChatGPT ${item.version} failed (${/^(?:download|more than|refusing)/.test(error.message) ? error.message : error.name}); retrying next run`); return { exit: 2 }; }
    const base = { checkedAt: now().toISOString(), source: 'static', appVersion: item.version, build: item.build, sleight: sleightCommit() };
    const failed = (id, reason) => ({ ...base, verdict: 'error', attempt, steps: [{ id, status: 'error', reason }] });
    let verified = false;
    try { verified = verifyImpl(archive, item.edSignature); } catch {}
    if (!verified) report = failed('signature', "the download's Sparkle signature doesn't match ChatGPT's pinned key");
    else {
      const out = join(temp, 'unpacked');
      mkdirSync(out);
      let app;
      try { await unpackImpl(archive, out); app = findApp(out); }
      catch (error) { report = failed('unpack', /needs 7-Zip/.test(error.message) ? error.message : `unpacking failed${typeof error.code === 'number' ? ` (exit ${error.code})` : error.code ? ` (${error.code})` : ''}`); }
      if (!report && !app) report = failed('unpack', 'no ChatGPT.app with the engine in the download');
      if (!report) {
        report = { ...checkApp(app, { now }), build: item.build };
        if (report.appVersion !== item.version) report.steps.push({ id: 'feed-version', status: 'warn', reason: `the feed says ${item.version}, the app says ${report.appVersion ?? 'no plain version'}` });
        report.fingerprintChanged = last?.fingerprint ? last.fingerprint !== report.fingerprint : null;
        if (keep) Object.assign(report, await keepDocs(state, report.appVersion ?? item.version, app));
      }
    }
  } catch (error) {
    report = { checkedAt: now().toISOString(), source: 'static', appVersion: item.version, build: item.build, verdict: 'error', attempt,
      steps: [{ id: 'check', status: 'error', reason: `the check stopped (${error.code ?? error.name})` }] };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  appendFileSync(join(state, 'results.jsonl'), JSON.stringify(report) + '\n');
  if (report.verdict !== 'error' || attempt >= MAX_ATTEMPTS) {
    writeJson(lastPath, { version: item.version, build: item.build, checkedAt: report.checkedAt, verdict: report.verdict, fingerprint: report.fingerprint });
    rmSync(attemptsPath, { force: true });
  } else writeJson(attemptsPath, { version: item.version, build: item.build, count: attempt });
  log(summary(report) + (report.verdict === 'error' ? `\n  attempt ${attempt} of ${MAX_ATTEMPTS}` : ''));
  return { exit: exitFor(report.verdict), report };
}

function option(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

export async function main(argv = process.argv.slice(2)) {
  // Only an error code, never a message that could quote the engine's files.
  try { return await run(argv); }
  catch (error) { console.error(`static compat: internal error (${error.code ?? error.name})`); return 2; }
}

async function run(argv) {
  const reportPath = option(argv, 'report');
  if (argv.includes('--app')) {
    const app = option(argv, 'app');
    if (!app) { console.error('usage: compat-static.mjs --app <ChatGPT.app>'); return 2; }
    const report = checkApp(resolve(app));
    if (reportPath) writeJson(resolve(reportPath), report);
    console.log(summary(report));
    return exitFor(report.verdict);
  }
  if (argv.includes('--probe')) {
    const state = resolve(option(argv, 'state') ?? join(homedir(), '.local', 'state', 'sleight-compat'));
    const changed = await probeFeed({ state, feedUrl: option(argv, 'feed-url') ?? FEED_URL });
    if (changed === undefined) { console.log('static compat: the update feed lists no release'); return 2; }
    console.log(changed ? 'changed' : 'unchanged');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
    return 0;
  }
  if (argv.includes('--feed')) {
    const state = resolve(option(argv, 'state') ?? join(homedir(), '.local', 'state', 'sleight-compat'));
    const { exit, report } = await runFeed({ state, force: argv.includes('--force'), keep: argv.includes('--keep-docs'), feedUrl: option(argv, 'feed') ?? FEED_URL });
    if (reportPath && report) writeJson(resolve(reportPath), report);
    return exit;
  }
  console.error('usage: compat-static.mjs --app <ChatGPT.app> | --feed [URL] [--state DIR] [--force] [--keep-docs] [--report FILE]');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
