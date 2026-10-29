#!/bin/bash
# Headless PS4 checks. The lane never opens either load gate.
set -euo pipefail
cd "$(dirname "$0")/../.."
gate="$HOME/Projects/sleight-wt/ledger/vc/night/lanes-may-test"
while [ ! -e "$gate" ]; do sleep 60; done
# Opt-in real-browser tests must stay off in this lane, including inherited flags.
unset SLEIGHT_LIVE_DOM_TEST
case "${1:-removal}" in
  ca2-tests|ca2-corpus)
    log=$(mktemp /tmp/lane-ps4-ca2-XXXXXX)
    echo "Details: $log"
    mode="${1#ca2-}"
    if CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 bash bench/code-ast/validate-ca2.sh "$mode" >"$log" 2>&1; then status=0; else status=$?; fi
    tail -n 18 "$log"
    exit "$status"
    ;;
  removal)
    files=(tests/cell-tokenizer-removal.test.mjs tests/fr1-review-regressions.test.mjs tests/fr2-tokenizer.test.mjs tests/code-line-terminators.test.mjs tests/code-ast-oracle.test.mjs)
    ;;
  fixture)
    files=(tests/cell-tokenizer-removal.test.mjs)
    ;;
  statements)
    # code-ast-batch.test.mjs starts fuzz generators, so it needs the separate fuzz gate.
    files=(tests/statement-consumers.test.mjs tests/statement-parity.test.mjs tests/statement-oracle.test.mjs tests/text-save.test.mjs tests/menu-continuation.test.mjs tests/checkout-tab-probe.test.mjs tests/code-line-terminators.test.mjs tests/code-ast.test.mjs tests/code-ast-compat.test.mjs tests/code-ast-runtime.test.mjs tests/code-ast-oracle.test.mjs)
    ;;
  tab-probe)
    files=(tests/checkout-tab-probe.test.mjs)
    ;;
  turbo)
    files=(tests/evaluate-write.test.mjs tests/evaluate-scope-guidance.test.mjs tests/unawaited-page.test.mjs tests/unawaited-guidance.test.mjs tests/tab-errors.test.mjs tests/direct-browser-page.test.mjs tests/turbo-v3-server.test.mjs tests/turbo-v3-protocol.test.mjs)
    ;;
  turbo-replay)
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/code-ast/ps4-turbo-replay.mjs
    exit
    ;;
  prose)
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 npm run lint:prose -- "$HOME/Projects/sleight-wt/ledger/vc/lanes160/ps4-REPORT.md"
    exit
    ;;
  report)
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 vale --config .vale.ini "$HOME/Projects/sleight-wt/ledger/vc/lanes160/ps4-REPORT.md"
    exit
    ;;
  commit-prose)
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 vale --config .vale.ini /private/tmp/lane-ps4-commit-message.md
    exit
    ;;
  *) echo 'expected removal, fixture, ca2-tests, ca2-corpus, statements, tab-probe, turbo, turbo-replay, prose, report or commit-prose' >&2; exit 2 ;;
esac
log=$(mktemp /tmp/lane-ps4-tests-XXXXXX)
echo "Test details: $log"
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node --experimental-vm-modules --test --test-concurrency=1 \
  --test-reporter=spec --test-reporter-destination="$log" --test-reporter=dot --test-reporter-destination=stdout "${files[@]}"
tail -n 10 "$log"
