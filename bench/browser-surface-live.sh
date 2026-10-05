#!/bin/sh
set -eu
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/sleight-live.lock' EXIT
node bench/browser-surface.mjs "$@"
