#!/bin/sh
# Schedules scripts/watch.sh with launchd, weekly (Mondays at 9:00) or daily (9:00).
#   scripts/watch-install.sh            install or update the weekly job
#   scripts/watch-install.sh --daily    install or update it daily
#   scripts/watch-install.sh --remove   remove it
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.landoclusters.sleight-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

WHEN='<key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer>'
SAID="on Mondays at 9:00"
if [ "${1:-}" = "--daily" ]; then
  WHEN='<key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer>'
  SAID="daily at 9:00"
fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/sleight"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$ROOT/scripts/watch.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict>$WHEN</dict>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/sleight/watch.stderr.log</string>
</dict>
</plist>
EOF
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL: runs $ROOT/scripts/watch.sh $SAID"
