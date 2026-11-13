import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  classifyError, collectErrors, tallyErrors, sumRound, errorBody,
} from '../bench/fowl/error-tally.mjs';

const stack = '\n    at __playwrightEvaluate (<anonymous>:1:1)';

test('classifyError maps each batch H class from a recorded-shaped string', () => {
  assert.equal(classifyError('sleight stopped this call before it ran: `x.click(…)` has no await and more code follows it.'), 'unawaited');
  assert.equal(classifyError('Input lease: a bundle ID and full window header are required. Send exactly `await cua.getState()` in js.'), 'input-lease');
  assert.equal(classifyError("Error: strict mode violation: getByLabel('Dates') resolved to 2 elements:"), 'playwright-strict');
  assert.equal(classifyError('Error: Playwright selector deadline exceeded\nLocator diagnostics: {"kind":"no_matches"}'), 'playwright-deadline');
  assert.equal(classifyError('TypeError: DragEvent is not a constructor' + stack), 'evaluate-write');
  assert.equal(classifyError('Tab not found: 1. Existing tabs: 2'), 'lost-handle');
  assert.equal(classifyError('getTab({ url }) requires an explicit browser.'), 'lost-handle');
  assert.equal(classifyError('tab.playwright.press is not a function'), 'invented-api');
  assert.equal(classifyError('Accessibility element 16 is stale or missing'), 'other');
});

test('docs dumps classify from the error after the last fence', () => {
  const src = '# API Reference\n```ts\ngetTab(id: string): Promise<Tab>\n```\nTab not found in browser 1.';
  assert.match(errorBody(src), /Tab not found in browser 1/);
  assert.equal(classifyError(src), 'lost-handle');
});

test('tallyErrors counts classes and keeps three example lines', () => {
  const texts = [
    'tab.evaluate is not a function',
    'cua.getAXState is not a function',
    'tab.waitForTimeout is not a function',
    'tab.readState is not a function',
    'TypeError: prio.insertBefore is not a function' + stack,
    'Error: Playwright selector deadline exceeded',
  ];
  const out = tallyErrors(texts);
  assert.equal(out.total, 6);
  assert.equal(out.classes['invented-api'], 4);
  assert.equal(out.classes['evaluate-write'], 1);
  assert.equal(out.classes['playwright-deadline'], 1);
  assert.equal(out.examples['invented-api'].length, 3);
});

test('collectErrors reads is_error tool results from stream-json events', () => {
  const events = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'tab.evaluate is not a function' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', is_error: false, content: 'ok' }] } },
  ];
  assert.deepEqual(collectErrors(events), ['tab.evaluate is not a function']);
});

test('the CLI prints counts and --json for a tiny round dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'error-tally-'));
  mkdirSync(join(root, 'task-a'));
  writeFileSync(join(root, 'task-a', 'events.jsonl'), JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', is_error: true, content: 'tab.evaluate is not a function' }] },
  }) + '\n');
  const bin = join(process.cwd(), 'bench/fowl/error-tally.mjs');
  const text = spawnSync(process.execPath, [bin, root], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /invented-api 1/);
  const json = spawnSync(process.execPath, [bin, root, '--json'], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  const round = Object.values(parsed.rounds)[0];
  assert.equal(round.total, 1);
  assert.equal(round.classes['invented-api'], 1);
  assert.equal(sumRound(round.tasks).total, 1);
});
