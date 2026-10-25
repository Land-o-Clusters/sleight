// Owned proof, evidence filtering and publication. Installs nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwned } from './preapproved-process.mjs';
import { filterPluginEvidence } from './plugin-evidence.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { evidenceRoots } from './evidence.mjs';

const mode = process.argv[2];
if (!['plugin-dry', 'mcp-dry', 'mcp-live', 'sanitize', 'filter-rate-limits', 'audit'].includes(mode)) throw new Error('unknown proof operation');
const root = fileURLToPath(new URL('..', import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bank = trackTemp(mkdtempSync('/private/tmp/sleight-plugin-arm-'));
const name = execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8' }).trim();
if (!name) throw new Error('owner-name audit unavailable');
const scrub = text => text.replaceAll(name, '<user>').replaceAll(homedir(), '~');
const evidenceDir = join(root, 'docs/benchmarks');
const evidenceFiles = () => readdirSync(evidenceDir).filter(file => file.includes('plugin-arm') && file.endsWith('.json'));

function publish(output, source, privateTerms = []) {
  const { value, counts } = filterPluginEvidence(source, { privateTerms });
  const privacy = { ...source.privacy, filteredOccurrences: Object.fromEntries(Object.entries(counts)
    .map(([key, count]) => [key, count + (source.privacy?.filteredOccurrences?.[key] ?? 0)])) };
  const json = scrub(JSON.stringify({ ...value, privacy }, null, 2)) + '\n';
  const backup = join(bank, 'published-evidence.json');
  writeFileSync(backup, json, { mode: 0o600 });
  try { writeFileSync(output, json); }
  catch (error) { console.error(`Evidence preserved at ${backup}`); throw error; }
  return counts;
}

if (mode === 'sanitize' || mode === 'filter-rate-limits') {
  const receipt = JSON.parse(readFileSync(join(evidenceDir, '2026-10-10-plugin-arm-checks.json'), 'utf8'));
  const privateTerms = mode === 'sanitize' ? [receipt.publication?.destination?.split(' branch ')[0], receipt.hold?.reason?.match(/for (.+?)'s/)?.[1]].filter(Boolean) : [];
  const totals = {};
  for (const file of evidenceFiles()) {
    const path = join(evidenceDir, file), source = JSON.parse(readFileSync(path, 'utf8'));
    if (mode === 'filter-rate-limits' && !filterPluginEvidence(source).counts.rateLimitEvents) continue;
    const counts = publish(path, source, privateTerms);
    for (const [key, count] of Object.entries(counts)) totals[key] = (totals[key] ?? 0) + count;
  }
  console.log(JSON.stringify({ files: evidenceFiles().length, filteredOccurrences: totals }));
  process.exit(0);
}
if (mode === 'audit') {
  for (const file of evidenceFiles()) {
    const text = readFileSync(join(evidenceDir, file), 'utf8'), value = JSON.parse(text);
    if (text.includes(homedir()) || text.includes(name) || JSON.stringify(filterPluginEvidence(value).value) !== JSON.stringify(value)) {
      throw new Error(`privacy audit failed: ${file}`);
    }
  }
  console.log(`Privacy and JSON audit passed for ${evidenceFiles().length} evidence files.`);
  process.exit(0);
}

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => controller.abort());
const trace = join(bank, 'trace'); mkdirSync(trace);
const config = join(bank, 'plain.json');
writeFileSync(config, JSON.stringify({ mcpServers: { 'sleight-plain': {
  command: join(root, 'plugins/sleight/bin/sleight-mcp'),
  env: { SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_TRACE: trace },
} } }), { mode: 0o600 });
const arm = mode === 'plugin-dry' ? 'plugin:sleight' : mode === 'mcp-live' ? 'mcp:sleight-plain,sleight' : 'mcp:sleight-plain';
const args = ['bench/run.mjs', '--arm', arm, '--tasks', 'calculator-click', '--runs', '1',
  ...(mode.endsWith('dry') ? ['--dry-run'] : ['--calculator-gate', '--auth', 'api'])];
const env = { ...process.env, BENCH_ARM_HOME: join(bank, 'arms'), ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  PLUGIN_ARM_SLEIGHT_DIR: join(root, 'plugins/sleight'), MCP_ARM_SLEIGHT_PLAIN_CONFIG: config };
let sourceCommit, result;
try {
  sourceCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (mode === 'mcp-live') {
    execFileSync('/usr/bin/git', ['ls-files', '--error-unmatch', 'bench/generic-server.mjs', 'bench/plugin-live.mjs', 'bench/plugin-evidence.mjs'], { cwd: root, stdio: 'pipe' });
    execFileSync('/usr/bin/git', ['diff', '--quiet', 'HEAD', '--', 'bench', 'plugins/sleight'], { cwd: root, stdio: 'pipe' });
    if (existsSync('/tmp/sleight-hold')) throw new Error('live run stopped: /tmp/sleight-hold exists');
  }
  result = await runOwned(process.execPath, args, { cwd: root, env, timeoutMs: 720000, signal: controller.signal });
} catch (error) {
  result = { exit: { code: 1 }, stdout: '', stderr: mode === 'mcp-live' && error.status
    ? 'Live proof requires committed benchmark and server paths.' : error.message, groupClean: true };
}
const path = /results: (.+)\s*$/.exec(result.stdout)?.[1]?.trim().replace(/^~(?=\/)/, homedir());
const raw = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
const traces = readdirSync(trace).filter(file => file.endsWith('.jsonl')).map(file => ({ file, text: readFileSync(join(trace, file), 'utf8') }));
const transcripts = [];
for (const base of raw ? evidenceRoots({ armHome: env.BENCH_ARM_HOME }) : []) {
  const taskEvidence = join(base, raw.stamp);
  if (!existsSync(taskEvidence)) continue;
  for (const directory of readdirSync(taskEvidence)) {
    const path = join(taskEvidence, directory, 'transcript.jsonl');
    if (!transcripts.some(row => row.directory === directory) && existsSync(path)) transcripts.push({ directory, text: readFileSync(path, 'utf8') });
  }
}
const output = join(evidenceDir, `${stamp}-plugin-arm-${mode}.json`);
publish(output, { mode, sourceCommit, command: ['node', ...args], ...result, raw, traces, transcripts });
console.log(scrub(`Published ${output}`));
console.log(JSON.stringify({ exit: result.exit, groupClean: result.groupClean,
  results: raw?.results?.map(({ arm, phase, task, passed, reason }) => ({ arm, phase, task, passed, reason: reason && scrub(reason) })) }));
process.exitCode = result.groupClean && result.exit.code === 0 ? 0 : 1;
