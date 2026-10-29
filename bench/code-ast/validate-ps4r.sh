#!/bin/bash
# Offline lane checks. Never opens a load gate or launches a browser.
set -euo pipefail
cd "$(dirname "$0")/../.."
gate="$HOME/Projects/sleight-wt/ledger/vc/night/lanes-may-test"
while [ ! -e "$gate" ]; do sleep 60; done
unset SLEIGHT_LIVE_DOM_TEST
case "${1:-sb3}" in
  sb3) files=(tests/write-effect*.test.mjs tests/write-trace.test.mjs tests/safari-wrong-field.test.mjs tests/ps4r-parser-consumers.test.mjs) ;;
  escape) files=(tests/ps4r-evaluate-escapes.test.mjs tests/evaluate-write.test.mjs tests/unawaited-page.test.mjs tests/code-line-terminators.test.mjs) ;;
  ca2-tests|ca2-corpus) exec bash bench/code-ast/validate-ca2.sh "${1#ca2-}" ;;
  statements|turbo|removal) exec bash bench/code-ast/validate-ps4.sh "$1" ;;
  prompt) files=(tests/prompt-budget.test.mjs) ;;
  bank)
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/replay/write-effect-bank.mjs \
      "$HOME/Projects/sleight-wt/race-1017/validation-150f-rel2" "$HOME/Projects/sleight-wt/race-1017/validation-150f-rel3" \
      --assert-recordings --out /private/tmp/lane-ps4r-bank.json
    exit ;;
  prose)
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 npm run lint:prose -- "$HOME/Projects/sleight-wt/ledger/vc/lanes160/ps4r-REPORT.md"
    exit ;;
  report)
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 vale --config .vale.ini "$HOME/Projects/sleight-wt/ledger/vc/lanes160/ps4r-REPORT.md"
    exit ;;
  *) exit 2 ;;
esac
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node --test --test-concurrency=1 "${files[@]}"
