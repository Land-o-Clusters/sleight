#!/bin/sh
set -eu
# Run from any directory. Node and Git are the only export prerequisites.
exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/export-guest.mjs" "$@"
