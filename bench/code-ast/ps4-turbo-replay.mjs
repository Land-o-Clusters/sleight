// Inspect saved Chrome/Helium cells. Caller code is parsed, never executed.
// The page guards are unchanged in PS4. Pins make this a baseline audit, not a
// qualification claim for a future AST replacement of those guards.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { evaluateWrite } from '../../plugins/sleight/lib/evaluate-write.mjs';
import { withoutPageCallbacks } from '../../plugins/sleight/lib/page-callbacks.mjs';
import { unawaitedAction } from '../../plugins/sleight/lib/relay.mjs';
import { parseCell, walk, memberCall } from '../../plugins/sleight/lib/code-ast.mjs';

const digest = source => createHash('sha256').update(source).digest('hex');
const root = join(homedir(), 'Projects/sleight-wt/race-1017');
const before = '2026-10-28T07:28:00Z';
const pins = {
  'evaluate-write.mjs': '375161e8e87fcc65054c428152fc5dbbffc38e2506fb4de2f6027a73471564f6',
  'page-callbacks.mjs': '063c95a8d42373ad25fad941fb4486b192fae08823426f3fd72239f35daf482b',
};
for (const [file, expected] of Object.entries(pins))
  assert.equal(digest(readFileSync(new URL('../../plugins/sleight/lib/' + file, import.meta.url))), expected, file);
const relay = readFileSync(new URL('../../plugins/sleight/lib/relay.mjs', import.meta.url), 'utf8');
const awaitSection = relay.slice(relay.indexOf('const INPUT_METHODS ='), relay.indexOf('// `require(` outside strings'));
assert.equal(digest(awaitSection), '9b1dd9283a701b01295217bb43f1eee6d65bceb1571d7409a55973e37c2c1530');

// Fixed probes document existing gaps without running a page or a kernel action.
const assessment = [
  ['plain-write-control', 'await tab.evaluate(() => { document.body.click(); return 1; }); nodeRepl.write("done");'],
  ['escaped-write-member', String.raw`await tab.evaluate(() => { document.body.cl\u0069ck(); return 1; }); nodeRepl.write("done");`],
  ['escaped-computed-write-member', String.raw`await tab.evaluate(() => { document.body["\u0063lick"](); return 1; }); nodeRepl.write("done");`],
  ['escaped-evaluate-member', String.raw`await tab.eval\u0075ate(() => { button.click(); return 1; }); nodeRepl.write("done");`],
  ['nonpage-evaluate-receiver', 'const helper = { evaluate: f => f() }; await helper.evaluate(() => { app.typeText("x"); return 1; }); await app.getAXState();'],
].map(([id, code]) => {
  const parsed = parseCell(code);
  assert.equal(parsed.error, null, id);
  const methods = [...walk(parsed.ast)].filter(node => node.type === 'CallExpression').map(node => memberCall(node)?.method).filter(name => typeof name === 'string');
  assert.ok(methods.includes('evaluate'), id + ' AST evaluate');
  assert.ok(methods.includes(id === 'nonpage-evaluate-receiver' ? 'typeText' : 'click'), id + ' AST action');
  return { id, source: digest(code), methods, writeRefused: Boolean(evaluateWrite(code)),
    callbackMasked: withoutPageCallbacks(code) !== code, awaitRefusal: unawaitedAction(code) ?? null };
});

function* files(directory, depth = 0) {
  if (depth > 8 || lstatSync(directory).isSymbolicLink()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path, depth + 1);
    else if (entry.isFile() && ['events.jsonl', 'transcript.jsonl'].includes(entry.name)) yield path;
  }
}
const totals = () => ({ files: 0, toolCalls: 0, turboCalls: 0, cells: 0, evaluateCells: 0, evaluateCalls: 0, parseErrors: 0,
  writeRefusals: 0, maskedCells: 0, awaitRefusals: 0 });
const counts = { chrome: totals(), helium: totals() };
const manifest = createHash('sha256'), outputs = createHash('sha256');
let malformed = 0;
for (const file of files(root)) {
  const relative = file.slice(root.length + 1);
  // The leaf directory is the task, whose name can itself contain "helium".
  // Only bank ancestors identify the browser for this audit.
  const browser = relative.split('/').slice(0, -2).map(part => /(?:^|-)(chrome|helium)(?:-|$)/i.exec(part)?.[1]?.toLowerCase()).find(Boolean);
  if (!browser) continue;
  const seen = new Set();
  let line = 0, used = false;
  for await (const text of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    line++;
    let event;
    try { event = JSON.parse(text); } catch { malformed++; continue; }
    const timestamp = event.timestamp ?? event.t;
    if (typeof timestamp === 'string' && Date.parse(timestamp) > Date.parse(before)) continue;
    const calls = event.item?.type === 'mcp_tool_call' ? [event.item]
      : Array.isArray(event.message?.content) ? event.message.content.filter(part => part.type === 'tool_use') : [];
    for (const call of calls) {
      if (call.id && seen.has(call.id)) continue;
      if (call.id) seen.add(call.id);
      used = true;
      const count = counts[browser];
      const tool = call.tool ?? call.name;
      count.toolCalls++;
      if (/(?:^|__)browser_(?:open|read|act|fill|tabs)$/.test(tool ?? '')) count.turboCalls++;
      if (!/(?:^|__)js$/.test(tool ?? '')) continue;
      const args = call.input ?? call.arguments, code = args?.code ?? args?.command;
      if (typeof code !== 'string') continue;
      count.cells++;
      const coordinate = { browser, file: relative, line, sha256: digest(code) };
      manifest.update(JSON.stringify(coordinate) + '\n');
      const write = evaluateWrite(code) ?? null, masked = withoutPageCallbacks(code), awaiting = unawaitedAction(code) ?? null;
      const parsed = parseCell(code);
      if (parsed.error) count.parseErrors++;
      const evaluations = parsed.ast ? [...walk(parsed.ast)].filter(node => node.type === 'CallExpression' &&
        ['evaluate', 'evaluateAll'].includes(memberCall(node)?.method)).length : 0;
      if (evaluations) count.evaluateCells++;
      count.evaluateCalls += evaluations;
      if (write) count.writeRefusals++;
      if (masked !== code) count.maskedCells++;
      if (awaiting) count.awaitRefusals++;
      outputs.update(JSON.stringify({ ...coordinate, write, masked: digest(masked), awaiting }) + '\n');
    }
  }
  if (used) counts[browser].files++;
}
assert.equal(malformed, 0, 'malformed transcript lines');
for (const [browser, count] of Object.entries(counts)) {
  assert.ok(count.cells > 0, browser + ' cells');
  assert.ok(count.turboCalls > 0, browser + ' turbo coverage');
}
const result = { base: 'c9fb85bb', before, bank: '~/Projects/sleight-wt/race-1017', counts, malformed, assessment,
  manifest: manifest.digest('hex'), outputDigest: outputs.digest('hex'), sourcePins: pins,
  awaitSectionSha256: digest(awaitSection), changedGuardModules: 0, pageGuardMigrationQualified: false,
  note: 'Unchanged-guard baseline audit. No parser replacement of either page guard was qualified.' };
writeFileSync(new URL('ps4-turbo-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
