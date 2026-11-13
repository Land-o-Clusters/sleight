#!/bin/sh
# AS-3 A/B: SLEIGHT_BROWSER_CORE off and on (browser_open on the engine path), the sleight arm in Safari and Firefox, on the
# held-out browser tasks (bench/world/tasks/browser-open-heldout.json), never the 12 race tasks. Haiku, effort high,
# 5 rounds per cell and browser. Rotate through all six cell orders across rounds.
# Run it from the race worktree at a build with AS-3 and its harness plumbing:
#   open -a Terminal <race worktree>/bench/fowl/as3-ab.command
# Before every round it waits while /tmp/sleight-hold, /tmp/sleight-live.lock or $O/pause exists. It never creates or
# removes any of them. Rounds go to $O/as3-ao-<browser>-<off|on|on-prompt>-r<n> (relay trace beside each as .trace), the log to
# $O/as3-ab.log, and the score of everything under $O/as3-ao-* to $O/as3-score.txt at the end. A round folder that already
# holds results.json is kept, so a stopped block resumes where it was.
# AS3_OUT, AS3_RUNNER, AS3_HOLD, AS3_LOCK and AS3_POLL exist for the offline test (tests/as3-ab.test.mjs).
set -u
R=$(cd "$(dirname "$0")/../.." && pwd)
O=${AS3_OUT:-$HOME/Projects/sleight-wt/race-1017}
N=${AS3_ROUNDS:-5}
RUNNER=${AS3_RUNNER:-$R/bench/fowl/rounds.sh}
HOLD=${AS3_HOLD:-/tmp/sleight-hold}
LOCK=${AS3_LOCK:-/tmp/sleight-live.lock}
POLL=${AS3_POLL:-20}
TASKS=$R/bench/world/tasks/browser-open-heldout.json
LOG=$O/as3-ab.log
mkdir -p "$O" || exit 1
# A build without the plumbing would run arm B without browser_open and score it as a loss.
grep -q 'SLEIGHT_BROWSER_CORE="$SLEIGHT_BROWSER_CORE"' "$R/bench/fowl/rounds.sh" && grep -q 'browser_open' "$R/bench/fowl/real-gate-setup.mjs" &&
  grep -q 'AS3_WINDOW_PROMPT="$AS3_WINDOW_PROMPT"' "$R/bench/fowl/rounds.sh" && grep -q 'AS3_WINDOW_PROMPT' "$R/bench/fowl/real-gate-setup.mjs" &&
  [ -f "$R/plugins/sleight/lib/engine-browser-open.mjs" ] && [ -f "$TASKS" ] ||
  { echo "as3-ab: $R lacks AS-3 or its harness plumbing; move the race worktree first" | tee -a "$LOG" >&2; exit 1; }
now() { date -u +%H:%M:%SZ; }
gate() { while [ -e "$HOLD" ] || [ -d "$LOCK" ] || [ -e "$O/pause" ]; do sleep "$POLL"; done; }
race() { # browser off|on|on-prompt round
  out=$O/as3-ao-$1-$2-r$3; core=0; prompt=0
  [ "$2" = off ] || core=1
  [ "$2" != on-prompt ] || prompt=1
  [ -e "$out/results.json" ] && { echo "$(basename "$out") kept $(now)" >> "$LOG"; return 0; }
  rc=1; try=0
  while [ $try -lt 60 ]; do
    try=$((try + 1)); gate
    echo "$(basename "$out") start $(now)" >> "$LOG"; rm -rf "$out"
    env DISABLE_AUTOUPDATER=1 SLEIGHT_NO_HUB=1 SLEIGHT_BROWSER_CORE=$core AS3_WINDOW_PROMPT=$prompt SLEIGHT_TRACE="$out.trace" "$RUNNER" --world --real-browser "$1" \
      --surface sleight --model haiku --effort high --tasks "$TASKS" --out "$out" > "$out.log" 2>&1
    rc=$?
    # Another round took the lock or the hold came on between the wait and the start, or Safari was still open: wait again.
    if grep -q -e 'EEXIST.*sleight-live.lock' -e 'Benchmark hold is active' "$out.log" ||
      grep -q 'Quit safari before starting this round' "$out/failure.json" 2>/dev/null; then
      rm -rf "$out"; sleep "$POLL"; continue
    fi
    break
  done
  echo "$(basename "$out") exit $rc $(now)" >> "$LOG"
}
echo "as3-ab start $(now) build $(git -C "$R" rev-parse --short HEAD 2>/dev/null || echo unknown) rounds $N" >> "$LOG"
n=1
while [ $n -le "$N" ]; do
  for br in safari firefox; do
    case $(((n - 1) % 6)) in
      0) cells="off on on-prompt" ;;
      1) cells="on on-prompt off" ;;
      2) cells="on-prompt off on" ;;
      3) cells="off on-prompt on" ;;
      4) cells="on-prompt on off" ;;
      5) cells="on off on-prompt" ;;
    esac
    for cell in $cells; do race "$br" "$cell" "$n"; done
  done
  n=$((n + 1))
done
node "$R/bench/fowl/as3-score.mjs" "$O/as3-ao-*" > "$O/as3-score.txt" 2>&1
echo "as3-ab done $(now), score exit $? in $O/as3-score.txt" >> "$LOG"
