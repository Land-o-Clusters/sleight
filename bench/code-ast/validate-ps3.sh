#!/bin/bash
# Focused, headless parser-consumer checks. Never evaluates recorded programs.
set -euo pipefail
cd "$(dirname "$0")/../.."
gate="$HOME/Projects/sleight-wt/ledger/vc/night/lanes-may-test"
fuzz_gate="$HOME/Projects/sleight-wt/ledger/vc/night/fuzz-may-run"
while [ ! -e "$gate" ] || [ -e /tmp/sleight-hold ]; do sleep 60; done
run_tests() {
  local log
  log=$(mktemp /tmp/lane-ps3-tests-XXXXXX)
  echo "Test details: $log"
  CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node --test --test-concurrency=1 \
    --test-reporter=spec --test-reporter-destination="$log" --test-reporter=dot --test-reporter-destination=stdout "$@"
}
case "${1:-tests}" in
  unit)
    run_tests tests/statement-consumers.test.mjs tests/statement-parity.test.mjs
    ;;
  tests)
    run_tests tests/statement-consumers.test.mjs tests/statement-parity.test.mjs tests/text-save.test.mjs tests/menu-continuation.test.mjs tests/checkout-tab-probe.test.mjs tests/code-line-terminators.test.mjs
    ;;
  replay)
    while [ ! -e "$fuzz_gate" ]; do sleep 60; done
    while [ ! -e "$gate" ] || [ -e /tmp/sleight-hold ]; do sleep 60; done
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/code-ast/statement-replay.mjs
    ;;
  related)
    run_tests tests/statement-consumers.test.mjs tests/statement-parity.test.mjs tests/text-save.test.mjs tests/menu-continuation.test.mjs tests/checkout-tab-probe.test.mjs tests/code-line-terminators.test.mjs tests/fr1-review-regressions.test.mjs tests/office-routes.test.mjs tests/guard-messages.test.mjs tests/prompt-budget.test.mjs tests/engine-browser-open.test.mjs tests/first-call-steering.test.mjs tests/checkout-native-certificate.test.mjs tests/editable-click-timing.test.mjs tests/fr2-tokenizer.test.mjs tests/code-ast.test.mjs
    ;;
  evidence)
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
const digest = data => createHash('sha256').update(data).digest('hex');
const result = JSON.parse(readFileSync('bench/code-ast/statement-results.json'));
const archive = readFileSync('bench/code-ast/statement-differences.jsonl.gz');
const data = gunzipSync(archive);
assert.equal(digest(archive), result.archiveSha256);
assert.equal(digest(data), result.differencesSha256);
assert.equal(archive.length, result.archiveBytes);
assert.equal(data.length, result.uncompressedBytes);
const records = data.toString().trim().split('\n').map(JSON.parse);
assert.equal(records.length, result.differences);
assert.equal(result.regressions, 0);
assert.equal(result.unclassified, 0);
for (const [name, expected] of Object.entries(result.sources)) {
  const source = name.startsWith('new:') ? readFileSync(name.slice(4))
    : execFileSync('/usr/bin/git', ['show', result.base + ':' + name]);
  assert.equal(digest(source), expected, name);
}
console.log(JSON.stringify({ records: records.length, archiveBytes: archive.length,
  sourceHashes: Object.keys(result.sources).length, regressions: result.regressions, unclassified: result.unclassified }));
JS
    ;;
  prose)
    nice -n 20 npm run lint:prose -- "$HOME/Projects/sleight-wt/ledger/vc/lanes160/ps3-REPORT.md"
    ;;
  report)
    nice -n 20 vale --config .vale.ini "$HOME/Projects/sleight-wt/ledger/vc/lanes160/ps3-REPORT.md"
    ;;
  *) echo 'expected unit, tests, related, replay, evidence, prose or report' >&2; exit 2 ;;
esac
