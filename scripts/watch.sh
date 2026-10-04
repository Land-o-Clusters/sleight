#!/bin/sh
# Weekly check that a ChatGPT update hasn't broken sleight. Runs
# `sleight-mcp --doctor`; when the engine version differs from the last run,
# it also diffs the runtime API docs and runs one benchmark task.
# Logs to ~/Library/Logs/sleight/watch.log and
# posts a macOS notification when something fails or the engine changed.
#   scripts/watch.sh            check now
#   SLEIGHT_WATCH_FORCE=1 ...   run the benchmark task even if nothing changed
# scripts/watch-install.sh schedules it weekly.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$HOME/Library/Logs/sleight"
STATE="$LOGS/watch-engine-version"
LOG="$LOGS/watch.log"
mkdir -p "$LOGS"
# launchd starts jobs with a bare PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }
notify() { osascript -e "display notification \"$1\" with title \"sleight watch\"" >/dev/null 2>&1; }
docs_failed() {
  log "API docs capture failed on engine $version: $1"
  notify "API docs capture failed on engine $version. See $LOG"
  exit 1
}
docs_tmp=''
diff_tmp=''
trap '[ -z "$docs_tmp" ] || rm -f -- "$docs_tmp"; [ -z "$diff_tmp" ] || rm -f -- "$diff_tmp"' EXIT

doctor="$("$ROOT/plugins/sleight/bin/sleight-mcp" --doctor 2>&1)"
doctor_rc=$?
version="$(printf '%s\n' "$doctor" | sed -n 's/^Codex computer-use //p' | head -1)"
if [ "$doctor_rc" -ne 0 ]; then
  log "doctor FAILED (rc $doctor_rc): $(printf '%s' "$doctor" | tr '\n' ' ')"
  notify "Doctor failed: the ChatGPT computer-use engine is missing or moved. See $LOG"
  exit 1
fi
if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+(\.[0-9]+)*$'; then
  docs_failed "doctor returned an invalid version"
fi

previous="$(cat "$STATE" 2>/dev/null || true)"
docs="$LOGS/engine-api-$version.md"
docs_note="API docs: $docs"
if [ ! -s "$docs" ]; then
  docs_tmp="$(mktemp "$docs.XXXXXX")" || docs_failed "could not create snapshot file"
  if ! node "$ROOT/scripts/engine-docs.mjs" > "$docs_tmp" 2>> "$LOG"; then
    docs_failed "MCP client failed"
  fi
  [ -s "$docs_tmp" ] || docs_failed "MCP client returned no text"
  mv "$docs_tmp" "$docs" || docs_failed "could not save snapshot"
  log "saved API docs: $docs"
fi
if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
  previous_docs="$LOGS/engine-api-$previous.md"
  if [ -s "$previous_docs" ]; then
    diff_file="$LOGS/engine-api-$version.diff"
    diff_tmp="$(mktemp "$diff_file.XXXXXX")" || docs_failed "could not create diff file"
    diff -u "$previous_docs" "$docs" > "$diff_tmp"
    diff_rc=$?
    # diff returns 1 when the files differ, which is the expected update case.
    [ "$diff_rc" -le 1 ] || docs_failed "diff failed (rc $diff_rc)"
    mv "$diff_tmp" "$diff_file" || docs_failed "could not save diff"
    docs_note="API diff: $diff_file"
    log "$docs_note"
  else
    docs_note="API docs: $docs; previous API snapshot unavailable"
    log "$docs_note"
  fi
fi
# Keep the previous baseline when capture or diff fails, so the next run retries.
printf '%s\n' "$version" > "$STATE" || docs_failed "could not record version"
if [ -z "$previous" ]; then
  log "doctor ok, engine $version (first run, recorded as the baseline)"
  [ "${SLEIGHT_WATCH_FORCE:-}" = 1 ] || exit 0
elif [ "$previous" = "$version" ] && [ "${SLEIGHT_WATCH_FORCE:-}" != 1 ]; then
  log "doctor ok, engine $version unchanged"
  exit 0
fi

log "engine $previous -> $version; running the calculator-click benchmark task"
bench="$(cd "$ROOT" && node bench/run.mjs --arm sleight --tasks calculator-click --runs 1 2>&1)"
bench_rc=$?
if [ "$bench_rc" -eq 0 ] && printf '%s' "$bench" | grep -q '^PASS'; then
  log "benchmark PASS on engine $version"
  notify "ChatGPT engine updated to $version. sleight still works (benchmark passed). $docs_note"
else
  log "benchmark FAILED on engine $version (rc $bench_rc): $(printf '%s' "$bench" | grep -E 'PASS|FAIL' | tr '\n' ' ')"
  notify "ChatGPT engine updated to $version and the sleight benchmark FAILED. $docs_note. See $LOG"
  exit 1
fi
