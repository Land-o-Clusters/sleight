#!/bin/sh
set -eu
echo 'Waiting for the live-check lock.'
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/sleight-live.lock' EXIT
echo 'Live-check lock acquired.'
node bench/clipboard.mjs "$@"
