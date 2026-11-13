#!/bin/sh
set -eu
: "${SLEIGHT_TEST_CHROMIUM_EXECUTABLE:?test Chromium executable required}"
# Chromium and its children keep ordinary test-host access, except for the
# services that can open another application. No global settings are changed.
# lsopen denies the request itself. Chromium still needs Launch Services
# registration during startup, so denying all service lookups would abort it.
# exec preserves Playwright's process handle and its normal owned-child cleanup.
exec /usr/bin/sandbox-exec -p '(version 1)
(allow default)
(deny lsopen)
(deny appleevent-send)
(deny mach-lookup (global-name "com.apple.lsd.open"))
(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))' \
  "$SLEIGHT_TEST_CHROMIUM_EXECUTABLE" "$@"
