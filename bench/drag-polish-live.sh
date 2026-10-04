#!/bin/sh
# The lock belongs only to this run, including its cleanup.
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/sleight-live.lock' EXIT
case "$1" in
  --windows) shift; node bench/drag-windows.mjs "$@" & ;;
  *) node bench/drag-polish.mjs "$@" & ;;
esac
child=$!
stop() {
  trap '' INT TERM
  kill -TERM "$child" 2>/dev/null
  wait "$child"
  exit "$1"
}
trap 'stop 130' INT
trap 'stop 143' TERM
wait "$child"
