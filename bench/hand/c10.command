#!/bin/zsh
# Run in Terminal with Screen Recording permission: zsh bench/hand/c10.command --owner-away
# Voice plays one sentence at the current output volume. Physical controls stay on the attended list.
# C10_WAIT_CAP_MS sets the hold/lock wait cap (default 10800000 ms, 3 h).
# Exit: 0 measured/attended, 1 failure/cleanup, 2 usage, 4 owner, 5 wait cap, 6 telemetry, 129/130/143 signals.
# Resume repeats the command. --fresh starts a new evidence bank. --dry-run starts no children.
cd "${0:A:h:h:h}" || exit 2
C10_CLAUDE=$(mktemp -d /tmp/lane-claude-XXXXXX) || exit 2
trap 'rmdir "$C10_CLAUDE" 2>/dev/null' EXIT
# The runner first starts its normal-priority child service, then nices only itself.
CLAUDE_CONFIG_DIR=$C10_CLAUDE node bench/hand/c10-night.mjs "$@"
