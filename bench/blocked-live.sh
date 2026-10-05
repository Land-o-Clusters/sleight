#!/bin/sh
# One bounded blocked_app live check (terminal or codex). Keeps the shared live
# lock only while the driver runs and releases it on exit, on failure too.
# Terminal is staged in the background (`open -g`), so nothing comes to front
# except what the user's Allow clicks bring.
set -eu
case "${1:-}" in terminal|codex) ;; *) echo 'usage: sh bench/blocked-live.sh terminal|codex' >&2; exit 2 ;; esac
[ "$1" = terminal ] && open -g -a Terminal
until mkdir /tmp/sleight-live.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/sleight-live.lock' EXIT
node "$(dirname "$0")/blocked-live.mjs" "$1"
