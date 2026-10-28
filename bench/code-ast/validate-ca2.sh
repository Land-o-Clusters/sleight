#!/bin/bash
# Headless CA2 validation. Every CPU run waits for the owner's load gates.
set -euo pipefail
cd "$(dirname "$0")/../.."
gate="$HOME/Projects/sleight-wt/ledger/vc/night/lanes-may-test"
fuzz_gate="$HOME/Projects/sleight-wt/ledger/vc/night/fuzz-may-run"
while [ ! -e "$gate" ]; do sleep 60; done
case "${1:-tests}" in
  corpus)
    while [ ! -e "$fuzz_gate" ] || [ ! -e "$gate" ]; do sleep 60; done
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/code-ast/consumers.mjs
    ;;
  fuzz)
    while [ ! -e "$fuzz_gate" ] || [ ! -e "$gate" ]; do sleep 60; done
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/code-ast/call-set-fuzz.mjs
    ;;
  tests)
    files=()
    while IFS= read -r file; do files+=("$file"); done < <(rg -l 'relay\.mjs|literal-elements\.mjs|native-arguments\.mjs|clipboard\.mjs|flow-rules\.mjs|dispatched-calls\.mjs' tests --glob '*.test.mjs' | sort)
    CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node --test --test-concurrency=1 "${files[@]}" tests/temp-leftovers.test.mjs
    ;;
  *) echo 'expected tests, corpus or fuzz' >&2; exit 2 ;;
esac
