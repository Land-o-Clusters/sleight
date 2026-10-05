#!/bin/sh
# The lock covers only this small app-driving check, including fixture cleanup.
set -e
probe_bank=$(mktemp -d /private/tmp/sleight-window-targeting-ax.XXXXXX)
swiftc bench/window-targeting-ax.swift -o "$probe_bank/probe" -module-cache-path "$probe_bank/cache"
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/sleight-live.lock' EXIT
node bench/window-targeting.mjs "$1" "$probe_bank/probe"
