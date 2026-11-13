#!/bin/bash
# Focused, headless parser-consumer checks. Never evaluates recorded programs.
set -euo pipefail
cd "$(dirname "$0")/../.."
gate="$HOME/Projects/sleight-wt/ledger/vc/night/lanes-may-test"
fuzz_gate="$HOME/Projects/sleight-wt/ledger/vc/night/fuzz-may-run"
wait_tests() {
  while [ ! -e "$gate" ] || [ -e /tmp/sleight-hold ]; do sleep 60; done
}
wait_fuzz() {
  while [ ! -e "$gate" ] || [ ! -e "$fuzz_gate" ] || [ -e /tmp/sleight-hold ]; do sleep 60; done
}
run_tests() {
  local log
  wait_tests
  log=$(mktemp /tmp/lane-ps3-tests-XXXXXX)
  echo "Test details: $log"
  CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node --experimental-vm-modules --test --test-concurrency=1 \
    --test-reporter=spec --test-reporter-destination="$log" --test-reporter=dot --test-reporter-destination=stdout "$@"
}
case "${1:-tests}" in
  unit)
    run_tests tests/statement-consumers.test.mjs tests/statement-parity.test.mjs tests/statement-oracle.test.mjs
    ;;
  tests)
    run_tests tests/statement-consumers.test.mjs tests/statement-parity.test.mjs tests/statement-oracle.test.mjs tests/text-save.test.mjs tests/menu-continuation.test.mjs tests/checkout-tab-probe.test.mjs tests/code-line-terminators.test.mjs tests/code-ast.test.mjs tests/code-ast-compat.test.mjs tests/code-ast-runtime.test.mjs tests/code-ast-oracle.test.mjs tests/code-ast-batch.test.mjs
    ;;
  replay)
    wait_fuzz
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/code-ast/statement-replay.mjs
    ;;
  differential|reviewers|shaped)
    wait_fuzz
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/code-ast/batch.mjs "$1" --statement-consumers
    ;;
  measure)
    wait_fuzz
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/code-ast/statement-measure.mjs
    ;;
  related)
    run_tests tests/statement-consumers.test.mjs tests/statement-parity.test.mjs tests/text-save.test.mjs tests/menu-continuation.test.mjs tests/checkout-tab-probe.test.mjs tests/code-line-terminators.test.mjs tests/fr1-review-regressions.test.mjs tests/office-routes.test.mjs tests/guard-messages.test.mjs tests/prompt-budget.test.mjs tests/engine-browser-open.test.mjs tests/first-call-steering.test.mjs tests/checkout-native-certificate.test.mjs tests/editable-click-timing.test.mjs tests/fr2-tokenizer.test.mjs tests/code-ast.test.mjs
    ;;
  evidence)
    wait_tests
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
const digest = data => createHash('sha256').update(data).digest('hex');
const result = JSON.parse(readFileSync('bench/code-ast/statement-results.json'));
const results = JSON.parse(readFileSync('bench/code-ast/results.json'));
const archive = readFileSync(results.statementDifferences.file.replace(/^~\//, process.env.HOME + '/'));
const data = gunzipSync(archive);
assert.equal(digest(archive), result.archiveSha256);
assert.equal(digest(data), result.differencesSha256);
assert.equal(archive.length, result.archiveBytes);
assert.equal(data.length, result.uncompressedBytes);
const records = data.toString().trim().split('\n').map(JSON.parse);
assert.equal(records.length, result.differences);
assert.equal(results.statementDifferences.records, records.length);
assert.equal(results.statementDifferences.bytes, archive.length);
assert.equal(results.statementDifferences.sha256, digest(archive));
assert.equal(results.statementDifferences.uncompressedSha256, digest(data));
assert.equal(result.regressions, 0);
assert.equal(result.unclassified, 0);
for (const [name, expected] of Object.entries(result.sources)) {
  const source = name.startsWith('new:') ? readFileSync(name.slice(4))
    : execFileSync('/usr/bin/git', ['show', result.base + ':' + name]);
  assert.equal(digest(source), expected, name);
}
let fuzzChecks = 0, cells = 0, newAccepts = 0, rangeChecks = 0;
for (const [mode, expected] of Object.entries({ differential: 3000000, reviewers: 2000000, shaped: 100000 })) {
  const run = results.ps3r.fuzz[mode];
  assert.equal(run.exit, 0);
  assert.equal(run.jobs.reduce((sum, job) => sum + job.tested, 0), expected);
  for (const job of run.jobs) {
    assert.equal(job.failures, 0);
    assert.equal(job.newThrows, 0);
    assert.equal(job.ranges.mismatches, 0);
    assert.equal(job.ranges.grammarDisagreements, 0);
    rangeChecks += job.ranges.checked;
    cells += job.cells;
    fuzzChecks += job.tested;
    for (const totals of Object.values(job.consumers)) {
      assert.equal(totals.unjustified, 0);
      assert.equal(totals.newlyAccepted, totals.justified);
      newAccepts += totals.newlyAccepted;
    }
  }
  for (const [path, expectedHash] of Object.entries(run.sourceHashes))
    assert.equal(digest(readFileSync(/^(?:plugins|tests)\//.test(path) ? path : 'bench/code-ast/' + path)), expectedHash, path);
}
assert.equal(cells, 8100000);
assert.equal(newAccepts, 2124);
const measurement = results.ps3r.measurements;
assert.equal(measurement.refused, 0);
for (const series of Object.values(measurement.timings)) assert.equal(series.samples, 5371);
for (const [path, expected] of Object.entries(measurement.sourceHashes)) assert.equal(digest(readFileSync(path)), expected, path);
console.log(JSON.stringify({ records: records.length, archiveBytes: archive.length,
  sourceHashes: Object.keys(result.sources).length, regressions: result.regressions, unclassified: result.unclassified,
  fuzzChecks, cells, newAccepts, rangeChecks }));
JS
    ;;
  prose)
    wait_tests
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 npm run lint:prose -- "$HOME/Projects/sleight-wt/ledger/vc/lanes160/ps3r-REPORT.md"
    ;;
  report)
    wait_tests
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 vale --config .vale.ini "$HOME/Projects/sleight-wt/ledger/vc/lanes160/ps3r-REPORT.md"
    ;;
  *) echo 'expected unit, tests, related, replay, differential, reviewers, shaped, measure, evidence, prose or report' >&2; exit 2 ;;
esac
