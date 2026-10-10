#!/bin/sh
# Typecheck the mod. tsc is the pinned devDependency; the tsconfig extends
# plugins/sleight/.claude-plugin/types/tsconfig.json, which Claude Code writes
# when it loads the mod (gitignored, so a fresh clone starts without it).
set -e
cd "$(dirname "$0")/.."
if [ ! -f plugins/sleight/.claude-plugin/types/tsconfig.json ]; then
  echo "npm run typecheck needs plugins/sleight/.claude-plugin/types/, which Claude Code writes when it loads the mod (it is gitignored)." >&2
  echo "Load the mod once in a session (SLEIGHT_TRACE=1 claude --plugin-dir plugins/sleight), then run npm run typecheck again." >&2
  exit 1
fi
if [ ! -x node_modules/.bin/tsc ]; then
  echo "npm run typecheck needs the pinned typescript devDependency. Run npm install first." >&2
  exit 1
fi
exec node_modules/.bin/tsc -p plugins/sleight/tsconfig.json
