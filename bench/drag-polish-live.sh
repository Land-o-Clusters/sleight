#!/bin/sh
# The lock belongs only to this run, including its cleanup.
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
keep_lock=0
chess=0
trap '[ "$keep_lock" -eq 1 ] || rmdir /tmp/sleight-live.lock' EXIT
case "$1" in
  --windows) shift; node bench/drag-windows.mjs "$@" & ;;
  --chess) chess=1; shift; node bench/chess-drag-stacked.mjs "$@" & ;;
  *) node bench/drag-polish.mjs "$@" & ;;
esac
child=$!
stop() {
  trap '' INT TERM
  kill -TERM "$child" 2>/dev/null
  wait "$child"
  result=$?
  if [ "$chess" -eq 1 ] && [ "$result" -eq 73 ]; then
    keep_lock=1
    echo 'Owned Chess windows remain open. See the receipt and close them before removing /tmp/sleight-live.lock.' >&2
    exit 73
  fi
  exit "$1"
}
trap 'stop 130' INT
trap 'stop 143' TERM
wait "$child"
result=$?
if [ "$chess" -eq 1 ] && [ "$result" -eq 73 ]; then
  keep_lock=1
  echo 'Owned Chess windows remain open. See the receipt and close them before removing /tmp/sleight-live.lock.' >&2
fi
exit "$result"
