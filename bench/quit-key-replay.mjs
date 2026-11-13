// Offline policy replay only. Do not import the live benchmark runner or execute recorded JS.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRecording, parseRecording } from './replay/recording.mjs';
import { evidenceRoots } from './evidence.mjs';
import { parseCell, walk, memberCall, UNKNOWN } from '../plugins/sleight/lib/code-ast.mjs';
import { argumentValue } from '../plugins/sleight/lib/call-inspection.mjs';
import { quitKeyBlocked } from '../plugins/sleight/lib/quit-key.mjs';

export function inspectQuitKeys(code) {
  const { ast, error } = parseCell(code);
  if (error) return { keys: 0, blocked: 0, unresolved: 1 };
  let keys = 0, blocked = 0, unresolved = 0;
  const unknown = value => value === UNKNOWN || Array.isArray(value) && value.some(unknown) ||
    value && typeof value === 'object' && Object.values(value).some(unknown);
  for (const node of walk(ast)) {
    if (node.type !== 'CallExpression') continue;
    const call = memberCall(node);
    if (!call || !['pressKey', 'press', 'typeText', 'click', 'doubleClick', 'rightClick', 'drag', 'scroll'].includes(call.method)) continue;
    const args = call.args.map(argumentValue);
    if (['click', 'doubleClick', 'rightClick', 'drag', 'scroll'].includes(call.method) &&
        !args.some(arg => arg === UNKNOWN || arg && typeof arg === 'object' && ['key', 'modifier', 'modifiers'].some(key => arg[key]))) continue;
    keys++;
    // Plain typing has no shortcut, even when its text is computed.
    if (call.method === 'typeText' && args.length === 1) continue;
    if (call.args.some(arg => arg.type === 'SpreadElement') || args.some(unknown)) { unresolved++; continue; }
    if (quitKeyBlocked(call.method, args)) blocked++;
  }
  return { keys, blocked, unresolved };
}

// Two retained release transcripts use bare engine tool names. The live replay
// loader refuses those; this offline check normalizes only the known native tools.
// Calls, arguments and results remain byte-for-byte data after JSON decoding.
export function offlineRecording(input, selectors) {
  try { return loadRecording(input, selectors); }
  catch (error) {
    if (!/^Unsupported recorded tool: (?:js|select_window|turn_ended)$/.test(error.message)) throw error;
    const data = JSON.parse(readFileSync(input, 'utf8'));
    const transcript = evidenceRoots().flatMap(root => ['transcript.jsonl', 'events.jsonl'].map(file =>
      join(root, data.stamp, `${selectors.arm}-${selectors.task}-${selectors.run}`, file))).find(existsSync);
    if (!transcript) throw error;
    const source = readFileSync(transcript, 'utf8');
    let normalizedNames = 0;
    const normalized = source.trim().split('\n').map(line => {
      const event = JSON.parse(line);
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block.type === 'tool_use' && ['js', 'select_window', 'turn_ended'].includes(block.name)) {
          block.name = 'mcp__plugin_sleight_computer__' + block.name; normalizedNames++;
        }
      }
      return JSON.stringify(event);
    }).join('\n');
    return { transcript, normalizedNames, transcriptSHA256: createHash('sha256').update(source).digest('hex'), calls: parseRecording(normalized) };
  }
}

function emptyReport(directory, kind) {
  return { kind, directory: resolve(directory), resultFiles: 0, recordings: 0, calls: 0, jsCalls: 0, keys: 0, changedCalls: 0, unresolved: 0, missing: [], inputs: [] };
}

function appendRecording(report, recording, coordinates) {
  report.recordings++;
  const entry = { ...coordinates, transcript: recording.transcript, sha256: recording.transcriptSHA256, calls: recording.calls.length, normalizedNames: recording.normalizedNames ?? 0, changed: 0 };
  report.calls += recording.calls.length;
  for (const call of recording.calls) {
    if (call.name !== 'js' || typeof call.arguments?.code !== 'string') continue;
    report.jsCalls++;
    const checked = inspectQuitKeys(call.arguments.code);
    report.keys += checked.keys; report.unresolved += checked.unresolved;
    if (checked.blocked) { report.changedCalls++; entry.changed++; }
  }
  report.inputs.push(entry);
}

// This retained subset covers three claim-task names, not a complete claim run.
export function replayQuitEvidence(directory) {
  const report = emptyReport(directory, 'evidence');
  for (const stamp of readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
    for (const folder of readdirSync(join(directory, stamp), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const match = /^sleight-(calculator-click|textedit-save|textedit-drag)-(\d+)$/.exec(folder.name);
      if (!match) continue;
      const input = join(directory, stamp, folder.name), coordinates = { input, stamp, task: match[1], run: Number(match[2]) };
      let recording;
      try { recording = loadRecording(input); }
      catch (error) { report.missing.push({ ...coordinates, reason: error.message }); continue; }
      appendRecording(report, recording, coordinates);
    }
  }
  return report;
}

export function replayQuitBank(directory, kind, load = offlineRecording) {
  const report = emptyReport(directory, kind);
  for (const file of readdirSync(directory).sort()) {
    if (!(kind === 'release' ? /^native-[AB]-r\d+(?:-(?:ab|ba))?\.json$/ : /\.json$/).test(file)) continue;
    const input = join(directory, file), data = JSON.parse(readFileSync(input, 'utf8'));
    const rows = data.results?.filter(row => row.arm === 'sleight' && typeof row.task === 'string') ?? [];
    if (!rows.length) continue;
    report.resultFiles++;
    for (const row of rows) {
      let recording;
      try { recording = load(input, { task: row.task, arm: row.arm, run: row.run }); }
      catch (error) { report.missing.push({ input, task: row.task, run: row.run, reason: error.message }); continue; }
      appendRecording(report, recording, { input, task: row.task, run: row.run });
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [kind, directory] = process.argv.slice(2);
  if (!['claim', 'release', 'evidence'].includes(kind) || !directory || process.argv.length !== 4) throw Error('usage: quit-key-replay.mjs claim|release|evidence DIRECTORY');
  const report = kind === 'evidence' ? replayQuitEvidence(resolve(directory)) : replayQuitBank(resolve(directory), kind);
  console.log(JSON.stringify(report, null, 2));
  if (!report.recordings || report.missing.length || report.unresolved || report.changedCalls) process.exitCode = 1;
}
