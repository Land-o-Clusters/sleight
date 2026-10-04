#!/bin/sh
# One bounded Calculator run. Keep the shared lock only while this driver runs.
set -eu
case "${1:-}" in listed|unlisted) ;; *) echo 'usage: sh bench/preapproved-live.sh listed|unlisted' >&2; exit 2 ;; esac
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/sleight-live.lock' EXIT
driver=
stop() {
  trap '' INT TERM
  if [ -n "$driver" ]; then kill -TERM "$driver" 2>/dev/null || :; wait "$driver" || :; fi
  exit "$1"
}
trap 'stop 130' INT
trap 'stop 143' TERM
node "$(dirname "$0")/preapproved-live.mjs" "$1" &
driver=$!
wait "$driver"
