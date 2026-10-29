#!/bin/zsh
# Build, ad-hoc sign under the real bundle identifier, install to /Applications, relaunch.
#
# electron-builder is told `identity: null` (no Developer ID), which leaves Electron's build-time
# linker signature in place: identifier "Electron". macOS Notification Center, TCC and friends key
# an app by its signing identifier, so "briefly" never appeared in System Settings → Notifications.
# An ad-hoc signature with --identifier com.owentsao.briefly fixes that and is all a local install needs.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=dist/mac-arm64/briefly.app
ID=com.owentsao.briefly

if [[ "${1:-}" != "--no-build" ]]; then
  npm run package
fi

# Nested code first (frameworks, helpers, dylibs), each under its own identifier; then the app.
find "$APP/Contents/Frameworks" -depth \( -name '*.framework' -o -name '*.app' -o -name '*.dylib' -o -name '*.node' \) -print0 \
  | while IFS= read -r -d '' f; do codesign --force --sign - "$f" 2>/dev/null; done
codesign --force --sign - --identifier "$ID" "$APP"
codesign --verify --deep --strict "$APP"
echo "signed: $(codesign -dv "$APP" 2>&1 | grep '^Identifier=')"

# pkill lets Electron linger (single-instance lock then just focuses the old copy); be blunt.
pkill -9 -x briefly 2>/dev/null || true
sleep 1
rm -rf /Applications/briefly.app
cp -R "$APP" /Applications/briefly.app
open /Applications/briefly.app
sleep 3
echo "running: $(ps -o lstart= -p "$(pgrep -x briefly | head -1)")"
