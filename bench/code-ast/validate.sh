#!/bin/bash
# Headless CA1 checks. No app launches, engine calls or source evaluation.
set -euo pipefail
cd "$(dirname "$0")/../.."
gate="$HOME/Projects/sleight-wt/ledger/vc/night/lanes-may-test"
fuzz_gate="$HOME/Projects/sleight-wt/ledger/vc/night/fuzz-may-run"
wait_gate() {
  while [ ! -e "$gate" ]; do sleep 30; done
  while [ -e /tmp/sleight-hold ]; do sleep 30; done
}
wait_fuzz() {
  until [ -e "$fuzz_gate" ]; do sleep 60; done
}
run_node() {
  wait_gate
  CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node --experimental-vm-modules "$@"
}
case "${1:-tests}" in
  tests)
    files=()
    while IFS= read -r file; do files+=("$file"); done < <(rg -l 'relay\.mjs|code-ast\.mjs|prompt-notice\.mjs|compat/(static|parser)\.mjs' tests --glob '*.test.mjs' | sort)
    for file in tests/{flow-rules,fr2-tokenizer,fr3-tokenizer,fr3-review-regressions,code-line-terminators,native-arguments,text-save,menu-continuation,clipboard}.test.mjs; do
      if [ -f "$file" ]; then files+=("$file"); fi
    done
    run_node --test --test-concurrency=1 "${files[@]}" tests/temp-leftovers.test.mjs tests/compat-contract.test.mjs tests/code-ast-batch.test.mjs
    ;;
  notices)
    run_node --input-type=module - <<'JS'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { noticeInventory, sharedNoticeInventory, taggedNoticeInventory } from './bench/prompt-budget.mjs';
const path='tests/fixtures/prompt-default.json';
const fixture=JSON.parse(readFileSync(path));
fixture.notices=createHash('sha256').update(JSON.stringify([...noticeInventory(),...sharedNoticeInventory(),...taggedNoticeInventory()].map(entry=>entry.text))).digest('hex');
writeFileSync(path,JSON.stringify(fixture,null,2)+'\n');
console.log(fixture.notices);
JS
    ;;
  corpus) run_node bench/code-ast/replay.mjs ;;
  differential) wait_fuzz; run_node bench/code-ast/batch.mjs differential ;;
  shaped) wait_fuzz; run_node bench/code-ast/batch.mjs shaped ;;
  cases)
    status=0
    for file in bench/code-ast/reviewer/m{1,2,3,4,5,6,7}.mjs; do run_node "$file" || status=1; done
    exit "$status"
    ;;
  reviewers)
    wait_fuzz
    run_node bench/code-ast/batch.mjs reviewers
    ;;
  measure) run_node bench/code-ast/measure.mjs ;;
  compat) run_node bench/compat-static.mjs --app /Applications/ChatGPT.app ;;
  *) echo 'expected tests, notices, corpus, differential, shaped, cases, reviewers, measure or compat' >&2; exit 2 ;;
esac
