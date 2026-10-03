#!/bin/sh
# Weekly check that a ChatGPT update hasn't broken sleight. Runs
# `sleight-mcp --doctor`; when the engine version differs from the last run,
# it also runs one benchmark task. Logs to ~/Library/Logs/sleight/watch.log and
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

doctor="$("$ROOT/plugins/sleight/bin/sleight-mcp" --doctor 2>&1)"
doctor_rc=$?
version="$(printf '%s\n' "$doctor" | sed -n 's/^Codex computer-use //p' | head -1)"
if [ "$doctor_rc" -ne 0 ]; then
  log "doctor FAILED (rc $doctor_rc): $(printf '%s' "$doctor" | tr '\n' ' ')"
  notify "Doctor failed: the ChatGPT computer-use engine is missing or moved. See $LOG"
  exit 1
fi

previous="$(cat "$STATE" 2>/dev/null || true)"
printf '%s\n' "$version" > "$STATE"
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
  notify "ChatGPT engine updated to $version. sleight still works (benchmark passed)."
else
  log "benchmark FAILED on engine $version (rc $bench_rc): $(printf '%s' "$bench" | grep -E 'PASS|FAIL' | tr '\n' ' ')"
  notify "ChatGPT engine updated to $version and the sleight benchmark FAILED. See $LOG"
  exit 1
fi
