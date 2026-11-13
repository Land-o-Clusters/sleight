#!/bin/sh
# Daily check that a ChatGPT update hasn't broken sleight, run by launchd (scripts/watch-install.sh).
# It runs `node bench/compat.mjs --watch`: the doctor every day, and when the engine version changed,
# the launch-shape check (config, Node option arity and file metadata) beside the API docs diff, then
# the engine compatibility checks, with the live checks too when installed with --live. Results go to
# ~/Library/Logs/sleight (watch.log, compat.jsonl and a report per run), and a macOS notification
# says when the engine changed or a check failed.
#   scripts/watch.sh            check now
#   scripts/watch.sh --force    run the engine checks even if the version didn't change
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/Library/Logs/sleight"
# launchd starts jobs with a bare PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
exec node "$ROOT/bench/compat.mjs" --watch "$@"
