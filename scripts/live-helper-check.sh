#!/bin/sh
set -eu
case "${1:-}" in smoke|recovery|kill) ;; *) echo 'choose smoke, recovery or kill' >&2; exit 2 ;; esac
held=0
child=
release() { if [ "$held" -eq 1 ]; then rmdir /tmp/sleight-live.lock; fi; }
cancel() {
  trap '' INT TERM
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" || true
  fi
  exit "$1"
}
trap release EXIT
trap 'cancel 130' INT
trap 'cancel 143' TERM
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
held=1
node bench/helper-health.mjs "$@" &
child=$!
wait "$child"
