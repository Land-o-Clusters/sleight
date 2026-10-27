#!/bin/zsh
# Run later in a Terminal that already has Screen Recording: capture.command --owner-away
# --dry-run opens nothing. Repeat to resume; --fresh starts another evidence bank.
cd "${0:A:h:h:h}" || exit 2
DM1_CLAUDE=$(mktemp -d /tmp/lane-claude-XXXXXX) || exit 2
trap 'rmdir "$DM1_CLAUDE" 2>/dev/null' EXIT
CLAUDE_CONFIG_DIR=$DM1_CLAUDE node bench/demo/capture.mjs "$@"
