#!/bin/sh
# Compile before acquiring the shared app lock. Keep evidence on every failure.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != '--geometry-pair' ]; }; then
    printf '%s\n' 'Only --geometry-pair is accepted' >&2
    exit 2
fi
bank=$(mktemp -d /private/tmp/sleight-text-drag-followup-XXXXXX)
node bench/background-text-drag-followup.mjs prepare "$bank"
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/sleight-live.lock' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node bench/background-text-drag-followup.mjs run "$bank" "$@"
