#!/bin/sh
# One app-driving trial per lock. Node owns and collects its Claude child.
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/sleight-live.lock' EXIT
trap '' INT
node bench/action-notes-live.mjs "$@"
