#!/bin/sh
# Run only during an owner-agreed away window. Hold the lock for this run.
set -eu
if [ "$#" -lt 1 ]; then
  echo 'usage: sh bench/double-keys-live.sh OWNER_AGREED_WINDOW [--raw-only]' >&2
  exit 64
fi
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/sleight-live.lock' EXIT
node bench/double-keys.mjs "$@"
