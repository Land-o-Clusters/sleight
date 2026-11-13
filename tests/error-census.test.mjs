import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { censusEvents, censusRound, classifyCause, renderCensus } from '../bench/fowl/error-census.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const call = (id, t, name = 'js') => ({ type: 'assistant', t, message: { content: [{ type: 'tool_use', id, name, input: { code: 'PRIVATE-CODE' } }] } });
const result = (id, t, content, is_error = true) => ({ type: 'user', t, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] } });
function fixture(t) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-census-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('causes distinguish input, API, stale state, refusal and timeout errors', () => {
  for (const [text, cause] of [
    ['tab.playwright.locator(...).scroll is not a function', 'invented-api'],
    ['sleight: locator.drag is unavailable. Use sleight.dragTo(tab, locator, target).', 'invented-api'],
    ['sleight stopped this call before it ran: x.click has no await and more code follows.', 'unawaited-action'],
    ['Input lease: a bundle ID and full window header are required.', 'input-lease'],
    ['strict mode violation: button resolved to 222 elements', 'ambiguous-selector'],
    ['not a valid selector', 'invalid-selector'],
    ['Playwright selector deadline exceeded', 'selector-timeout'],
    ['Line 7: evaluate is read-only; scrollTop cannot run there.', 'read-only-evaluate'],
    ['TypeError: DragEvent is not a constructor\n at __playwrightEvaluate', 'read-only-evaluate'],
    ['TypeError: Cannot add property fetch, object is not extensible\n at __playwrightEvaluate', 'read-only-evaluate'],
    ['TypeError: parseInt is not a function\n at __playwrightEvaluate', 'evaluate-scope'],
    ['Tab not found: PRIVATE-URL', 'stale-handle'],
    ['Accessibility capture belongs to a previous page', 'stale-element'],
    ["Claude requested permissions to use a tool, but you haven't granted it yet.", 'permission-refusal'],
    ['Browser Use rejected this action due to browser security policy.', 'permission-refusal'],
    ['Automation is blocking automation because another extension UI is open.', 'browser-blocked'],
    ['js execution timed out; kernel reset, rerun your request', 'engine-timeout'],
    ['[235:5-235:6]: Unexpected token', 'syntax-error'],
    ['Accessibility action requires an element index or point', 'invalid-input'],
    ["Cannot use 'in' operator to search for 'mention' in 123", 'invalid-input'],
    ["TypeError: Cannot read properties of null (reading 'children')", 'data-shape'],
    ['Capability is not available: viewport', 'capability-unavailable'],
    ['Required documentation has not been read: capabilities/tab/cdp', 'documentation-gate'],
    ["playwright.waitForEvent only supports 'download' and 'filechooser'", 'api-limitation'],
    ['unrecognized private error', 'other'],
  ]) assert.equal(classifyCause(text), cause, text);
});

test('docs-only initialization and fenced examples do not become fabricated failures', () => {
  assert.equal(classifyCause('## Computer Use\n```typescript\nthrow new Error("Tab not found");\n```\nUse documented methods.'), 'initialization-gate');
  assert.equal(classifyCause('# API Reference\n```ts\n// DragEvent is not a constructor\n```\nTab not found in browser 1.'), 'stale-handle');
  assert.equal(classifyCause('tab.evaluate is not a function\n## Computer Use\nUse tab.getJsDialog() after a click.'), 'invented-api');
  assert.equal(classifyCause('# API Reference\n```ts\ninterface Tab { getJsDialog(): unknown }\n```\nCDP command Input.dispatchMouseEvent timed out after 494ms. Next: await tab.getJsDialog().'), 'engine-timeout');
  assert.equal(classifyCause('# API Reference\n```ts\ninterface Tab {}\n```\nBrowser tab: 123\nFound inputs: []'), 'initialization-gate');
  assert.equal(classifyCause('# API Reference\n```ts\ninterface Tab {}\n```\nAccessibility action requires an element index or point'), 'invalid-input');
  assert.equal(classifyCause('# API Reference\n```ts\ninterface Tab {}\n```\nBrowser input requires an element index from the latest AX snapshot'), 'invalid-input');
});

test('errors pair by ID once and retain timing gaps as unknown', () => {
  const rows = [call('a', 100), call('a', 110), call('b', 200),
    result('a', 400, [{ type: 'text', text: 'tab.fake is not a function' }, { type: 'image', data: 'PRIVATE-IMAGE' }]),
    result('a', 450, 'tab.fake is not a function'), result('b', 500, 'ok', false),
    result('missing', 700, 'Tab not found'), call('bad', 900), result('bad', 800, 'Unexpected token'),
    call('reset', 1000, 'mcp__computer__js_reset')];
  const out = censusEvents(rows);
  assert.equal(out.errors.length, 3);
  assert.equal(out.failedCallMs, 300);
  assert.equal(out.timedErrors, 1);
  assert.equal(out.unknownTiming, 2);
  assert.equal(out.explicitResets, 1);
  assert.equal(out.errors[0].milliseconds, 300);
  assert.equal(out.errors[1].milliseconds, null);
  assert.ok(!JSON.stringify(out).includes('PRIVATE'));
});

test('round census reports affected failed tasks without claiming causation or leaking text', t => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'failed')); mkdirSync(join(dir, 'passed'));
  writeFileSync(join(dir, 'report.md'), '| agent | surface | browser | outcome |\n| --- | --- | --- | --- |\n| failed | surface | browser | FAIL, score 1/2 |\n| passed | surface | browser | ok |\n');
  for (const task of ['failed', 'passed']) writeFileSync(join(dir, task, 'events.jsonl'),
    [call('a', 100), result('a', 350, 'tab.PRIVATE is not a function')].map(JSON.stringify).join('\n') + '\n');
  const report = censusRound(dir);
  assert.equal(report.total, 2);
  assert.equal(report.failedCallMs, 500);
  assert.equal(report.timedErrors, 2);
  assert.equal(report.classes['invented-api'].count, 2);
  assert.deepEqual(report.classes['invented-api'].failedTasks, ['failed']);
  assert.deepEqual(report.classes['invented-api'].tasks, ['failed', 'passed']);
  assert.equal(report.runs.failed.failed, true);
  assert.equal(report.runs.passed.failed, false);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  assert.match(renderCensus([report]), /invented-api.*2.*0\.500/);
  assert.match(renderCensus([report]), /failed/);
});

test('round loading refuses malformed traces and symbolic links', t => {
  const dir = fixture(t); mkdirSync(join(dir, 'task'));
  const file = join(dir, 'task/events.jsonl'); writeFileSync(file, '{private-invalid-json}\n');
  assert.throws(() => censusRound(dir), /events.jsonl:1/);
  writeFileSync(file, 'null\n');
  assert.throws(() => censusRound(dir), /events.jsonl:1 is not an event object/);
  rmSync(file); const target = join(dir, 'outside'); writeFileSync(target, '{}\n'); symlinkSync(target, file);
  assert.throws(() => censusRound(dir), /symbolic link/);
});

test('the offline CLI emits text or JSON and refuses unknown flags', t => {
  const dir = fixture(t); mkdirSync(join(dir, 'task'));
  writeFileSync(join(dir, 'task/events.jsonl'), [call('a', 10), result('a', 110, 'tab.PRIVATE is not a function')].map(JSON.stringify).join('\n'));
  const cli = new URL('../bench/fowl/error-census.mjs', import.meta.url).pathname;
  for (const json of [false, true]) {
    const ran = spawnSync(process.execPath, [cli, dir, ...(json ? ['--json'] : [])], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.ok(!ran.stdout.includes('PRIVATE'));
    if (json) assert.equal(JSON.parse(ran.stdout).rounds[0].total, 1);
    else assert.match(ran.stdout, /invented-api.*1/);
  }
  assert.equal(spawnSync(process.execPath, [cli, '--unknown'], { encoding: 'utf8' }).status, 1);
});
