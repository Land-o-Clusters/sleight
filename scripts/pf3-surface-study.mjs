// Offline PF3 inventory. Reads Git objects and saved events only; never starts a browser or model.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { browserTools } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { turboFirstRules } from '../plugins/sleight/lib/turbo-first-rules.mjs';
import { screenshotGuidance } from '../plugins/sleight/lib/screenshot-guidance.mjs';
import { NATIVE_HANDOFF_TOOL } from '../plugins/sleight/lib/native-handoff.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const size = text => ({ characters: text.length, bytes: Buffer.byteLength(text), sha256: hash(text) });
const source = (revision, path) => revision === 'working'
  ? readFileSync(join(root, path), 'utf8')
  : execFileSync('/usr/bin/git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' });

export function catalogAt(revision) {
  if (revision === 'working') return browserTools('bbench');
  const text = source(revision, 'plugins/sleight/lib/direct-browser/tools.mjs');
  const catalog = text.slice(text.indexOf('// v3\'s five'), text.indexOf('\nfunction data('));
  if (!catalog || !catalog.includes('export function browserTools')) throw Error('Unsupported catalog source');
  return JSON.parse(JSON.stringify(runInNewContext(catalog.replaceAll('export function ', 'function ') + '\nbrowserTools("bbench")',
    { structuredClone, process: { env: {} }, pointInputEnabled: () => false }, { timeout: 1000 })));
}

export function surfaceAt(revision) {
  const catalog = catalogAt(revision);
  const browserRules = source(revision, 'plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md')
    .trimEnd().replace('{browser}', 'bbench').replace('{application}', ' (Google Chrome)');
  const skill = screenshotGuidance(source(revision, 'plugins/sleight/skills/drive-mac-apps/SKILL.md')
    .replace(/^---\n[\s\S]*?\n---\n+/, '').trim());
  const fullRules = skill.replace(/## Browsers\n[\s\S]*?(?=\n## |$)/, browserRules + '\n');
  const firstRules = revision === 'working' ? turboFirstRules(fullRules) : fullRules;
  // This definition is identical on 559e731a, 24268ea4 and PF3. It was absent on df27db01.
  const handoff = revision === 'df27db01' ? '' : JSON.stringify(NATIVE_HANDOFF_TOOL);
  return { revision, catalog: size(JSON.stringify(catalog)), browserRules: size(browserRules),
    firstRules: size(firstRules), fullRules: size(fullRules),
    // The host wrapper, engine companion and task add tokens not measured by this byte inventory.
    firstContent: size(JSON.stringify(catalog) + '\n' + firstRules),
    addedNativeTool: size(handoff), firstContentWithAddedTool: size(JSON.stringify(catalog) + '\n' + firstRules + handoff),
    chromeSurface: size(JSON.stringify(catalog) + '\n' + browserRules),
    tools: catalog.map(({ name, description, inputSchema }) => ({ name, description: size(description), schema: size(JSON.stringify(inputSchema)) })) };
}

export function traceAt(file) {
  const raw = readFileSync(file, 'utf8'), events = raw.trim().split('\n').map(JSON.parse);
  const calls = [], results = new Map();
  let firstInputTokens;
  for (const [index, event] of events.entries()) {
    const usage = event.message?.usage;
    if (event.type === 'assistant' && firstInputTokens === undefined && usage)
      firstInputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') calls.push({ line: index + 1, id: block.id, tool: block.name, input: block.input });
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map(c => c.text ?? '').join('\n');
        results.set(block.tool_use_id, { line: index + 1, text, characters: text.length });
      }
    }
  }
  return { file, sha256: hash(raw), firstInputTokens, calls: calls.map(call => ({ ...call, result: results.get(call.id) })) };
}

export function traceSummary(row) {
  const counts = {}, steps = {}, observe = {};
  let resultCharacters = 0, compactedCharacters = 0;
  for (const call of row.calls) {
    const name = call.tool.split('__').at(-1);
    counts[name] = (counts[name] ?? 0) + 1;
    for (const step of call.input.steps ?? []) steps[step.do] = (steps[step.do] ?? 0) + 1;
    if (name === 'browser_act') observe[call.input.observe ?? 'default'] = (observe[call.input.observe ?? 'default'] ?? 0) + 1;
    const text = call.result?.text ?? '';
    resultCharacters += text.length;
    // Apply only the repeated trusted prefix from the old runner, never page lines.
    // This is an offline text projection, not a replay of actions or a speed measurement.
    const prefix = text.split(/\n(?=# (?:Changes|Snapshot))/)[0];
    const matches = [...prefix.matchAll(/^(\d+ [a-z]+(?: [a-z0-9]+)?: )([0-9]+) lines changed \(batch observation below\)/gm)];
    if (matches.length > 1 && matches.every(m => m[2] === matches[0][2])) {
      const shorter = prefix.replace(/^(\d+ [a-z]+(?: [a-z0-9]+)?: )[0-9]+ lines changed \(batch observation below\)/gm, '$1input sent');
      compactedCharacters += prefix.length - shorter.length - ('\nBatch observation: ' + matches[0][2] + ' lines changed.').length;
    }
  }
  return { sha256: row.sha256, firstInputTokens: row.firstInputTokens, calls: row.calls.length, counts, steps, observe,
    resultCharacters, projectedResultCharacters: resultCharacters - compactedCharacters, compactedCharacters };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.SLEIGHT_MT === '0' || process.env.SLEIGHT_POINT_INPUT === '1')
    throw Error('The comparison requires the default MT surface with point input off');
  const traces = process.argv.indexOf('--traces');
  if (traces !== -1) {
    const bank = resolve(process.argv[traces + 1]);
    for (const round of ['chrome-A-r1', 'chrome-B-r1', 'chrome-B-r2', 'chrome-A-r2']) {
      for (const task of readdirSync(join(bank, round), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()) {
        const row = traceAt(join(bank, round, task, 'events.jsonl'));
        console.log(JSON.stringify({ round, task, ...(process.argv.includes('--summary') ? traceSummary(row) : row) }));
      }
    }
  } else {
    console.log(JSON.stringify(['df27db01', '559e731a', '24268ea4', 'working'].map(surfaceAt), null, 2));
  }
}
