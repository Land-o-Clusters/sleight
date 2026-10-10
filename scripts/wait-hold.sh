#!/bin/sh
# Another project on this Mac runs timed measurements and asks for a quiet box. While it does,
# sleight-arch keeps /tmp/sleight-hold, and checks wait here instead of loading the Mac.
# SLEIGHT_IGNORE_HOLD=1 skips the wait.
[ -n "$SLEIGHT_IGNORE_HOLD" ] && exit 0
waited=0
while [ -e /tmp/sleight-hold ]; do
  [ "$waited" -eq 0 ] && echo "sleight: /tmp/sleight-hold exists, waiting before the check: $(head -1 /tmp/sleight-hold)" >&2
  sleep 30; waited=$((waited + 30))
  if [ "$waited" -ge 7200 ]; then echo "sleight: still held after 2 hours, giving up" >&2; exit 1; fi
done
exit 0
