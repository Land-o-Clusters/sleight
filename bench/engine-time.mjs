// Targeted engine probes, no model calls. Only the three benchmark apps.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { probeClient, benchmarkApproval } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { calculatorValue } from './calculator-value.mjs';
import { windowFromText, guardedCode, elementLines, hasIdentifier } from '../plugins/sleight/lib/document-scope.mjs';

const mode = process.argv[2] ?? 'inspect';
assert.ok(['inspect', 'latency', 'floor'].includes(mode));
const bank = await mkdtemp('/private/tmp/sleight-engine-time-');
const server = resolveServer();
const report = { mode, engine: server.version, started: new Date().toISOString(),
  approvals: 'benchmark allowlist, exact app/risk/schema repeats cached in this client', trials: [], failures: [] };
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('interrupted')));
const scrub = text => String(text).replace(/\/Users\/[^/\s"']+/g, '~')
  .replace(/Window: "(?:[^"\\]|\\.)*", App: Chess\.?/g, 'Window: "[game]", App: Chess.');
let client, unlock;
const approvals = new Map();
async function approve(params) {
  // Match the relay's session scope. Still ask the existing benchmark hook on
  // every new app/risk/schema, and never remember a decline or cancellation.
  const key = JSON.stringify([params.message, params._meta?.tool_params?.app,
    params._meta?.riskLevel, params.requestedSchema]);
  if (approvals.has(key)) return approvals.get(key);
  const answer = await benchmarkApproval(params);
  if (answer.action === 'accept') approvals.set(key, answer);
  return answer;
}
async function call(code) {
  controller.signal.throwIfAborted();
  const start = performance.now();
  const result = await client.call('js', { code, timeout_ms: 60000 });
  const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const entry = { code, totalMs: performance.now() - start, failed: !!result.isError };
  if (text.includes('engine-probe:')) entry.measurements = JSON.parse(text.match(/^engine-probe:(.*)$/m)[1]);
  else entry.text = result.isError ? scrub(text) : { chars: text.length, header: windowFromText(text) };
  report.trials.push(entry);
  console.log(JSON.stringify({ totalMs: entry.totalMs, failed: entry.failed, measurements: entry.measurements, text: entry.text }));
  if (result.isError) throw new Error(text);
  return text;
}
try {
  console.log(`Waiting for live lock. Evidence: ${bank}/results.json`);
  unlock = await acquireLiveLock(undefined, { wait: true, signal: controller.signal });
  console.log('Live lock acquired.');
  client = await probeClient(server, { relay: false, label: 'engine-time', approve, record: () => {} });
  await call('var app = await cua.getApp("com.apple.calculator")');
  await call('nodeRepl.write("engine-probe:" + JSON.stringify({ listWindows: typeof cua.listWindows }));');
  if (mode === 'latency') {
    for (let repetition = 1; repetition <= 5; repetition++) {
      for (const method of ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot']) {
        await call(`{
          const out = { repetition: ${repetition}, method: ${JSON.stringify(method)} };
          const read = () => app.${method}({ emit: false, disableDiffing: true });
          let start = performance.now(); await read(); out.idleMs = performance.now() - start;
          start = performance.now(); const result = await app.pressKey("Escape");
          out.actionMs = performance.now() - start; out.actionResult = typeof result;
          start = performance.now(); await read(); out.afterActionMs = performance.now() - start;
          start = performance.now(); await read(); out.repeatMs = performance.now() - start;
          nodeRepl.write('engine-probe:' + JSON.stringify(out));
        }`);
      }
      for (const waitMs of [0, 100, 350, 700]) {
        await call(`{
          await app.pressKey("Escape");
          const out = { repetition: ${repetition}, waitMs: ${waitMs} };
          const start = performance.now();
          await new Promise(resolve => setTimeout(resolve, ${waitMs}));
          out.elapsedWaitMs = performance.now() - start;
          const readStart = performance.now();
          const text = await app.getAXState({ emit: false, disableDiffing: true });
          out.readMs = performance.now() - readStart; out.totalMs = performance.now() - start;
          out.chars = text.length;
          nodeRepl.write('engine-probe:' + JSON.stringify(out));
        }`);
      }
    }
    await call(`{
      const start = performance.now(), apps = await cua.listApps({ emit: false });
      const calculator = apps.find(a => a.id === "com.apple.calculator");
      nodeRepl.write('engine-probe:' + JSON.stringify({ inventoryMs: performance.now() - start,
        listWindows: typeof cua.listWindows, calculator }));
    }`);
  }
  if (mode === 'floor') {
    // A fixed Calculator experiment, not a proposed production guard. The floor
    // deliberately skips intermediate identity/selector checks to price the
    // guarantee. Nothing in the plugin selects this path.
    await call('var direct = app;');
    const target = { title: 'Calculator', app: 'Calculator', url: null };
    const names = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    for (let repetition = 1; repetition <= 5; repetition++) {
      for (const arm of repetition % 2 ? ['strict', 'floor'] : ['floor', 'strict']) {
        const expected = `123456${repetition}${arm === 'strict' ? 0 : 1}`;
        const ids = [...expected].map(digit => names[Number(digit)]);
        const reset = await call('await direct.pressKey("Escape"); nodeRepl.write(await direct.getAXState({ emit: false, disableDiffing: true }));');
        assert.equal(calculatorValue(reset), '0');
        report.trials.at(-1).verifiedValue = '0';
        const body = arm === 'strict'
          ? guardedCode(`for (const id of ${JSON.stringify(ids)}) await app.click({ id });`, target)
          : `{
            const text = await direct.getAXState({ emit: false, disableDiffing: true });
            const parse = ${windowFromText.toString()}, elements = ${elementLines.toString()}, match = ${hasIdentifier.toString()};
            if (JSON.stringify(parse(text)) !== ${JSON.stringify(JSON.stringify(target))}) throw new Error('Calculator identity changed');
            const numbers = ${JSON.stringify(ids)}.map(id => {
              const found = [...elements(text)].filter(([, line]) => match(line, id));
              if (found.length !== 1) throw new Error('Calculator selector is not unique');
              return found[0][0];
            });
            for (const number of numbers) await direct.click(number);
            nodeRepl.write(await direct.getAXState({ emit: false, disableDiffing: true }));
          }`;
        const text = await call(`{ const start = performance.now();
          ${body}
          nodeRepl.write('\\nengine-probe:' + JSON.stringify({ repetition: ${repetition}, arm: ${JSON.stringify(arm)}, ms: performance.now() - start }));
        }`);
        report.trials.at(-1).expectedValue = expected;
        report.trials.at(-1).observedValue = calculatorValue(text);
        assert.equal(report.trials.at(-1).observedValue, expected);
        report.trials.at(-1).passed = true;
      }
    }
  }
} catch (error) {
  report.failures.push(scrub(error.message)); process.exitCode = 1;
  console.error(scrub(error.message));
} finally {
  if (client) {
    try { await client.close(); report.engineCollected = true; }
    catch (error) { report.failures.push(scrub(error.message)); process.exitCode = 1; }
  }
  if (unlock) await unlock();
  await writeFile(join(bank, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${bank}/results.json`);
}
