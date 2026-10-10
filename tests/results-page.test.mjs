import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadResults, buildPage, summarize, byTask, cpuBuckets, perArm, renderMarkdown, renderHtml } from '../bench/results-page.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const release = loadResults('2026-10-05-release-0.7.0.json', fixture('results-page-release.json'));
const h2h = loadResults('2026-10-10-h2h-guard-2.json', fixture('results-page-h2h.json'));

test('classifies a release file by its name and reads its last pass', () => {
  assert.equal(release.kind, 'release');
  assert.equal(release.version, '0.7.0');
  assert.equal(release.results.length, 3, 'the page reports the release pass, not the passes on the way');
  assert.equal(release.model, 'claude-sonnet-5-5');
  assert.equal(release.date, '2026-10-05');
  assert.match(release.note, /Fixture/);
});

test('classifies a head-to-head by its arms and names the rival', () => {
  assert.equal(h2h.kind, 'h2h');
  assert.equal(h2h.rival, 'codex');
  assert.equal(h2h.version, undefined);
  assert.equal(h2h.ownerAway, true);
  assert.equal(h2h.auth, 'api');
});

test('summarizes a pass: rate, turns, time and model time, failures included', () => {
  const total = summarize(release.results);
  assert.equal(total.runs, 3);
  assert.equal(total.passed, 2);
  assert.ok(Math.abs(total.seconds - 65.5) < 1e-9);
  assert.equal(total.turns, 25);
  assert.ok(Math.abs(total.modelS - 40) < 1e-9);
});

test('groups runs by task without dropping the failure', () => {
  const tasks = byTask(release.results);
  assert.deepEqual(tasks.map(one => one.task), ['calculator-click', 'textedit-save']);
  const save = tasks.find(one => one.task === 'textedit-save');
  assert.equal(save.runs.length, 1);
  assert.equal(save.runs[0].passed, false);
  assert.match(save.runs[0].reason, /no file at ~/);
  assert.doesNotMatch(save.runs[0].reason, /\/Users\//);
});

test('splits footprint CPU into engine, sleight, client and other, summing to the total', () => {
  const buckets = cpuBuckets(h2h.results[0].footprint);
  assert.ok(Math.abs(buckets.engine - 4.27) < 1e-9, 'engine node plus the shared engine helper');
  assert.ok(Math.abs(buckets.sleight - 0.94) < 1e-9, 'the relay node, MCP servers and osascript');
  assert.ok(Math.abs(buckets.client - 1.76) < 1e-9, 'the host CLI, here Claude Code');
  assert.ok(Math.abs(buckets.other - 1.12) < 1e-9, 'the target app and anything unclassified');
  const sum = buckets.engine + buckets.sleight + buckets.client + buckets.other;
  assert.ok(Math.abs(sum - h2h.results[0].footprint.cpuSeconds) < 0.005);
  assert.ok(Math.abs(cpuBuckets(h2h.results[1].footprint).sleight - 0.19) < 1e-9, 'the same rule on the other arm');
});

test('per-arm numbers: model time only where the file has it', () => {
  const arms = perArm(h2h.results);
  assert.equal(arms.sleight.runs, 1);
  assert.ok(Math.abs(arms.sleight.modelS - 7.762) < 1e-9);
  assert.equal(arms.codex.modelS, undefined, 'the Codex arm records no model time');
  assert.ok(Math.abs(arms.codex.cpu - 4.7) < 1e-9);
});

test('the pages link every raw file and scrub home paths', () => {
  const page = buildPage([release, h2h]);
  assert.equal(page.latestRelease.version, '0.7.0');
  assert.equal(page.rivals[0].rival, 'codex');
  for (const rendered of [renderMarkdown(page), renderHtml(page)]) {
    assert.match(rendered, /2026-10-05-release-0\.7\.0\.json/);
    assert.doesNotMatch(rendered, /\/Users\//);
    assert.match(rendered, /~/);
  }
  const html = renderHtml(page);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /(href|src)="https?:\/\//, 'no external requests');
  const md = renderMarkdown(page);
  assert.match(md, /\.\.\/benchmarks\/2026-10-10-h2h-guard-2\.json/);
});
