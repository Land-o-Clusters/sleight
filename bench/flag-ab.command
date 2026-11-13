#!/bin/zsh
# Flag A/Bs (g3): every opt-in flag alone against the same build without it, held-out native tasks, rounds alternating which
# side runs first, Office last. The plan comes from bench/flag-ab.mjs; the runs come from $WT, which must not move meanwhile.
# Waits on /tmp/sleight-hold, /tmp/sleight-live.lock and $O/flags-pause (never touches the first two). After a STOP, or with
# Word or Excel left running, it creates the pause file and waits: clear the app, then rm $O/flags-pause.
# Closes loc arch's CLEAR while it runs and reopens it at the end. Score: node bench/flag-ab.mjs score
#   open -a Terminal bench/flag-ab.command                          (defaults: 5 rounds, race-131, logs in race-1017)
#   ROUNDS=2 START=6 ARMS=office zsh bench/flag-ab.command          (top-up rounds 6 and 7 of one arm)
set -u
REPO=${0:A:h:h}
O=${O:-$HOME/Projects/sleight-wt/race-1017}; WT=${WT:-$HOME/Projects/sleight-wt/race-131}
ROUNDS=${ROUNDS:-5}; START=${START:-1}; ARMS=${ARMS:-}; AFTER=${AFTER:-}
PAUSE=$O/flags-pause; LOG=$O/flags.log; MANIFEST=$O/flags-manifest.tsv
unset -m 'SLEIGHT_*'  # the plan explicitly sets each tested switch, including the off side
plan=$(node $REPO/bench/flag-ab.mjs plan --rounds $ROUNDS --start $START ${ARMS:+--arms} ${ARMS:+$ARMS}) && [[ -n $plan ]] || exit 1
[[ -n $AFTER ]] && until grep -q '^done' $AFTER 2>/dev/null; do sleep 30; done
commit=$(git -C $WT rev-parse HEAD) || exit 1
[[ -z $(git -C $WT status --porcelain --untracked-files=no) ]] || { echo "$WT has uncommitted changes" | tee -a $LOG; exit 1; }
[[ -e $MANIFEST ]] || printf 'round\tarm\tside\texit\tstops\tresults\tlog\tcommit\n' > $MANIFEST
rm -f $O/CLEAR
echo "start $(date -u +%H:%M:%S) commit ${commit:0:8} rounds $START-$((START + ROUNDS - 1)) arms ${ARMS:-all}" >> $LOG
cd $WT || exit 1
while IFS=$'\t' read -r -u 3 round arm side runs tasks flag; do
  name=flags-$arm-$side-r$round
  while true; do
    while [ -e /tmp/sleight-hold ] || [ -d /tmp/sleight-live.lock ] || [ -e $PAUSE ]; do sleep 20; done
    [[ $(git -C $WT rev-parse HEAD) == $commit ]] || { echo "$WT moved off ${commit:0:8}; stopped before $name" >> $LOG; exit 1; }
    left=
    for i in {1..6}; do
      left=$(for app in "Microsoft Word" "Microsoft Excel"; do pgrep -xq "$app" && echo -n "$app "; done)
      [[ -z $left ]] && break; sleep 10
    done
    [[ -z $left ]] && break
    touch $PAUSE; echo "paused before $name: ${left}still running; quit it, then rm $PAUSE" >> $LOG
  done
  echo "$name $(date -u +%H:%M:%S)" >> $LOG
  env DISABLE_AUTOUPDATER=1 SLEIGHT_NO_HUB=1 ${=flag} node bench/run.mjs --suite world --arm sleight --tasks $tasks --runs $runs \
    --model claude-haiku-5-5 --effort high --owner-away < /dev/null > $O/$name.log 2>&1
  code=$?
  results=$(sed -n 's/^results: //p' $O/$name.log | tail -1); stops=$(grep -c '^STOP:' $O/$name.log)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' $round $arm $side $code $stops "$results" $O/$name.log $commit >> $MANIFEST
  echo "$name exit $code stops $stops $(date -u +%H:%M:%S)" >> $LOG
  if (( stops )); then touch $PAUSE; echo "paused after a STOP in $name.log; clear it, then rm $PAUSE" >> $LOG; fi
done 3<<< "$plan"
touch $O/CLEAR
echo "done $(date -u +%H:%M:%S); score: node $REPO/bench/flag-ab.mjs score --manifest $MANIFEST; CLEAR opened for loc arch" >> $LOG
exit
