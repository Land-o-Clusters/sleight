#!/bin/sh
# Builds the drag probe into .dev/DragProbe.app (ad hoc signed).
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
APP="$ROOT/.dev/DragProbe.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -o "$APP/Contents/MacOS/DragProbe" "$ROOT/bench/drag-probe/DragProbe.swift"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.landoclusters.sleight.dragprobe</string>
  <key>CFBundleName</key><string>DragProbe</string>
  <key>CFBundleExecutable</key><string>DragProbe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP"
echo "$APP"
