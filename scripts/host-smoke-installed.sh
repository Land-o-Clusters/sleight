#!/bin/sh
# After every release (LAWS): the host smoke against the installed copy. Extra flags (--config, --out) pass through.
exec node "$(dirname "$0")/host-smoke.mjs" --plugin-dir "$HOME/Projects/sleight/plugins/sleight" "$@"
