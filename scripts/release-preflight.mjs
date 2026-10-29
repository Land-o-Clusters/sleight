#!/usr/bin/env node
import { readFile as readText } from 'node:fs/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReleaseVersion } from './release-version.mjs';
import { isReleaseVersion } from '../plugins/sleight/lib/version.mjs';
import { parseLinuxReceipt, runLinuxPreflight, runOwnedCommand } from './linux-preflight.mjs';
import { runColimaPreflight } from './linux-preflight-colima.mjs';
import { fileURLToPath } from 'node:url';
import { privateIdentity, privateMatches } from './lib/public-privacy.mjs';

export const manifestFiles = Object.freeze([
  'plugins/sleight/.claude-plugin/plugin.json', 'plugins/sleight/.codex-plugin/plugin.json',
  'plugins/sleight/.cursor-plugin/plugin.json', '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json', '.cursor-plugin/marketplace.json',
]);
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const validTag = tag => typeof tag === 'string' && tag.startsWith('v') && isReleaseVersion(tag.slice(1));
const validRef = ref => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
  && !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.');
const placeholder = /\b(?:TODO|TBD|FIXME|XXX|CHANGEME)\b|\bv?X\.Y\.Z\b|\{\{[^}]+\}\}|\[INSERT\b|<!--\s*(?:GB12\b|GB14\b|cursor-row\b|pending\b)/i;

// No exception text, document text, runner output or private match is copied to the result.
export async function preflight({ root = process.cwd(), mode = 'release', tag, version, historyBase = 'origin/main',
  linuxRuntime = 'docker', runner, readFile = path => readText(path, 'utf8'), identity = privateIdentity(), privateTerms = [], privateTermsFile } = {}) {
  const result = { ok: false, mode: mode === 'candidate' ? 'candidate' : 'release', releaseReady: false, failures: [] };
  const fail = (check, code, details = {}) => result.failures.push({ check, code, ...details });
  const requested = mode === 'release' && validTag(tag) ? tag.slice(1) : version;
  if (!['release', 'candidate'].includes(mode) || !isReleaseVersion(requested)
    || (mode === 'release' && (!validTag(tag) || version !== undefined))
    || (mode === 'candidate' && tag !== undefined) || !validRef(historyBase) || !['docker', 'colima'].includes(linuxRuntime)
    || typeof runner !== 'function' || (privateTermsFile !== undefined && typeof privateTermsFile !== 'string')
    || (!privateTermsFile && (!Array.isArray(privateTerms) || !privateTerms.length
      || privateTerms.some(term => typeof term !== 'string' || !term.trim())))) {
    fail('arguments', 'invalid-options');
    return result;
  }
  result.version = requested;
  try { root = realpathSync(root); }
  catch { fail('files', 'invalid-root'); return result; }
  const run = async (step, data = {}) => {
    let response;
    try { response = await runner({ step, ...data }); }
    catch { fail(step, 'runner-error'); return null; }
    if (response?.status !== 0 || typeof response.stdout !== 'string') {
      fail(step, 'command-failed', { exitCode: Number.isInteger(response?.status) ? response.status : null });
      return null;
    }
    return response.stdout.trim();
  };
  const clean = async () => {
    const status = await run('status');
    if (status === null) return false;
    if (status) { fail('status', 'dirty-tree'); return false; }
    return true;
  };
  if (!await clean()) return result;
  const head = await run('head');
  if (head === null) return result;
  if (!shaPattern.test(head)) { fail('head', 'invalid-commit'); return result; }
  result.head = head;
  if (privateTermsFile) {
    try { privateTerms = JSON.parse(await readFile(privateTermsFile)); }
    catch { fail('arguments', 'invalid-private-terms'); return result; }
    if (!Array.isArray(privateTerms) || !privateTerms.length || privateTerms.some(term => typeof term !== 'string' || !term.trim())) {
      fail('arguments', 'invalid-private-terms'); return result;
    }
  }
  try {
    const inspection = inspectReleaseVersion({ root, expectedVersion: requested, ...(mode === 'release' ? { tag } : {}) });
    if (!inspection.ok) fail('version', 'release-version-inspection-failed');
  } catch { fail('version', 'release-version-inspection-failed'); }
  // Keep the advertised sleight entries unambiguous in the required host catalogs.
  for (const file of manifestFiles) {
    try {
      const manifest = JSON.parse(await readFile(join(root, file)));
      if (file.endsWith('/plugin.json') ? manifest?.name !== 'sleight'
        : manifest?.plugins?.filter(entry => entry?.name === 'sleight').length !== 1) {
        fail('version', 'invalid-manifest', { file });
      }
    } catch { fail('version', 'invalid-manifest', { file }); }
  }
  const texts = new Map();
  for (const file of ['README.md', 'CHANGELOG.md']) {
    try { texts.set(file, await readFile(join(root, file))); }
    catch { fail('files', 'unreadable', { file }); }
  }
  const changelog = texts.get('CHANGELOG.md') ?? '';
  const headings = [...changelog.matchAll(/^##\s+(.+)$/gm)];
  const releaseIndex = mode === 'candidate' && /^\[?Unreleased\]?$/i.test(headings[0]?.[1] ?? '') ? 1 : 0;
  const heading = /^(\S+) \((\d{4}-\d{2}-\d{2}|unreleased)\)$/i.exec(headings[releaseIndex]?.[1] ?? '');
  const date = heading?.[2];
  const validDate = date && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!heading || heading[1] !== requested || !(validDate || (mode === 'candidate' && /^unreleased$/i.test(date ?? '')))
    || headings.slice(releaseIndex + 1).some(item => item[1].split(' ')[0] === requested)) {
    fail('version', 'changelog-disagreement', { file: 'CHANGELOG.md' });
  }
  for (const file of ['README.md', 'CHANGELOG.md']) {
    (texts.get(file) ?? '').split('\n').forEach((line, index) => {
      if (placeholder.test(line)) fail('docs', 'placeholder', { file, line: index + 1 });
    });
  }
  // Inspect only the newest release's notes. The historical addition scan covers the Git range.
  const noteEnd = headings[releaseIndex + 1]?.index ?? changelog.length;
  // Candidate notes include Unreleased as well as the newest dated release.
  const noteStart = headings[0]?.index ?? 0;
  const firstLine = changelog.slice(0, noteStart).split('\n').length;
  changelog.slice(noteStart, noteEnd).split('\n').forEach((line, index) => {
    if (privateMatches(line, identity).length || /\/(?:Users|home)\/[^\s/]+/.test(line)
      || /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(line)
      || /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/.test(line)
      || privateTerms.some(term => line.toLowerCase().includes(term.toLowerCase()))) {
      fail('privacy', 'private-notes', { file: 'CHANGELOG.md', line: firstLine + index });
    }
  });
  if (result.failures.length) return result;

  const unchanged = async () => {
    if (!await clean()) return false;
    const after = await run('head');
    if (after === null) return false;
    if (after !== head) { fail('head', 'changed-during-check'); return false; }
    return true;
  };
  if (!await unchanged()) return result;
  const checkTag = async () => {
    if (mode === 'candidate') return true;
    const commit = await run('tag', { tag });
    if (commit === null) return false;
    if (commit !== head) { fail('tag', 'tag-not-at-head'); return false; }
    return true;
  };
  if (!await checkTag()) return result;
  const base = await run('base', { ref: historyBase });
  if (base === null) return result;
  if (!shaPattern.test(base)) { fail('base', 'invalid-commit'); return result; }
  if (await run('ancestor', { base, head }) === null || await run('sources') === null) return result;
  const parser = await run('cell-parser');
  if (parser === null) return result;
  try {
    const checked = JSON.parse(parser);
    if (checked.id !== 'cell-parser' || checked.status !== 'pass') throw Error();
    result.cellParser = checked;
  } catch { fail('cell-parser', 'invalid-parser-receipt'); return result; }
  // The benchmark hub's pages, charts, explore.html and the README's generated blocks must match the data files they come from.
  // Collect available raw results, then render in memory and compare with the committed tree. Missing external banks keep saved data.
  let hub;
  try { hub = await runner({ step: 'hub' }); }
  catch { fail('hub', 'runner-error'); return result; }
  if (hub?.status !== 0) {
    // --check prints a "would change" line for each stale file and exits 1. A crash exits 1 with no such line, or with another status.
    if (hub?.status === 1 && typeof hub.stdout === 'string' && /^would change /m.test(hub.stdout)) fail('hub', 'stale-output');
    else fail('hub', 'hub-error', { exitCode: Number.isInteger(hub?.status) ? hub.status : null });
    return result;
  }
  const history = await run('history', { range: `${base}..${head}` });
  if (history === null) return result;
  if (history !== 'Release history scan: 0 added line(s) contain private identity data.') {
    fail('history', 'findings-or-invalid-summary'); return result;
  }
  const linux = await run('linux', { head });
  if (linux === null) return result;
  try {
    const receipt = parseLinuxReceipt(linux, { commit: head, worktree: root });
    result.linux = { commit: receipt.commit, platform: receipt.platform, exitCode: receipt.exitCode,
      counts: Object.fromEntries(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, receipt.counts[key]])),
      cleanupConfirmed: receipt.cleanupConfirmed };
  } catch { fail('linux', 'invalid-test-receipt'); return result; }
  if (!await unchanged()) return result;
  if (!await checkTag()) return result;
  result.ok = true;
  result.releaseReady = mode === 'release';
  return result;
}

// This is the only real subprocess boundary. Tests inject execute; there is no shell or arbitrary command option.
// Call A5 directly, so this process retains the signal channel and awaits container cleanup.
export function createReviewedRunner(root, { execute = runOwnedCommand, signal, linuxRuntime = 'docker' } = {}) {
  if (!['docker', 'colima'].includes(linuxRuntime)) throw Error('Invalid Linux runtime');
  return async request => {
    let command = '/usr/bin/git', args, timeout = 30_000;
    switch (request.step) {
      case 'status': args = ['status', '--porcelain=v1', '--untracked-files=all']; break;
      case 'head': args = ['rev-parse', '--verify', 'HEAD^{commit}']; break;
      case 'tag':
        if (!validTag(request.tag)) throw Error('Invalid tag');
        args = ['rev-parse', '--verify', `refs/tags/${request.tag}^{commit}`]; break;
      case 'base':
        if (!validRef(request.ref)) throw Error('Invalid base');
        args = ['rev-parse', '--verify', `${request.ref}^{commit}`]; break;
      case 'ancestor':
        if (!shaPattern.test(request.base ?? '') || !shaPattern.test(request.head ?? '')) throw Error('Invalid commits');
        args = ['merge-base', '--is-ancestor', request.base, request.head]; break;
      case 'hub': command = process.execPath; args = ['bench/results-hub.mjs', '--check']; timeout = 120_000; break;
      case 'cell-parser': command = process.execPath; args = ['bench/compat/parser.mjs']; break;
      case 'sources': args = ['ls-files', '--error-unmatch', '--', 'scripts/release-history-scan.mjs', 'scripts/linux-preflight.mjs', 'bench/results-hub.mjs',
        'bench/compat/parser.mjs',
        ...(linuxRuntime === 'colima' ? ['scripts/linux-preflight-colima.mjs'] : [])]; break;
      case 'history':
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\.\.(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.range ?? '')) throw Error('Invalid range');
        command = process.execPath; args = ['scripts/release-history-scan.mjs', request.range]; timeout = 120_000; break;
      case 'linux': {
        if (!shaPattern.test(request.head ?? '')) throw Error('Invalid commit');
        if (linuxRuntime === 'colima') {
          const result = await runColimaPreflight({ worktree: root, commit: request.head, execute, signal });
          if (result.exitCode !== 0 || result.vm?.cleanupConfirmed !== true || result.vm?.childCollected !== true) {
            return { status: Number.isInteger(result.exitCode) && result.exitCode !== 0 ? result.exitCode : 1, stdout: '' };
          }
          const stdout = JSON.stringify(result.linuxReceipt);
          try { parseLinuxReceipt(stdout, { commit: request.head, worktree: realpathSync(root) }); }
          catch { return { status: 1, stdout: '' }; }
          return { status: 0, stdout };
        }
        const receipt = await runLinuxPreflight({ worktree: root, commit: request.head, execute, signal });
        return { status: receipt.exitCode, stdout: JSON.stringify(receipt) };
      }
      default: throw Error('Unknown preflight operation');
    }
    const config = mkdtempSync(join(tmpdir(), 'lane-claude-'));
    try {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: config, npm_config_offline: 'true', GIT_TERMINAL_PROMPT: '0' };
      for (const key of Object.keys(env)) {
        if ((key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') || ['NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
      }
      return await execute(command, args, { signal, cwd: root, encoding: 'utf8', shell: false, env, timeout,
        maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } finally { rmSync(config, { recursive: true, force: true }); }
  };
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const log = dependencies.log ?? console.log;
  const signals = dependencies.signals ?? process;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signals.on('SIGINT', cancel); signals.on('SIGTERM', cancel);
  try {
    const options = { linuxRuntime: 'docker' }, seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!['--tag', '--candidate', '--history-base', '--private-terms', '--linux-runtime'].includes(flag)
        || seen.has(flag) || !value || value.startsWith('--')) throw Error();
      seen.add(flag);
      if (flag === '--tag') { options.mode = 'release'; options.tag = value; }
      if (flag === '--candidate') { options.mode = 'candidate'; options.version = value; }
      if (flag === '--history-base') options.historyBase = value;
      if (flag === '--private-terms') options.privateTermsFile = value;
      if (flag === '--linux-runtime') options.linuxRuntime = value;
    }
    if (seen.has('--tag') === seen.has('--candidate') || !seen.has('--private-terms') || !['docker', 'colima'].includes(options.linuxRuntime)) throw Error();
    const root = dependencies.root ?? process.cwd();
    const result = await preflight({ ...dependencies, root, tag: undefined, version: undefined,
      runner: dependencies.runner ?? createReviewedRunner(root, { execute: dependencies.execute, signal: controller.signal,
        linuxRuntime: options.linuxRuntime }), ...options });
    log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch {
    log(JSON.stringify({ ok: false, releaseReady: false, failures: [{ check: 'arguments', code: 'invalid-options-or-private-terms' }] }));
    return 1;
  } finally { signals.removeListener('SIGINT', cancel); signals.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
