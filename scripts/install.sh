#!/bin/zsh
# Builds Release, replaces /Applications/SafariPilot.app, relaunches it, and links the CLI onto PATH.
set -euo pipefail

root="${0:A:h:h}"
derived="$root/build/DerivedData"
app="$derived/Build/Products/Release/SafariPilot.app"
bindir="${SAFARIPILOT_BINDIR:-/opt/homebrew/bin}"

cd "$root"
rm -rf "$app"
# xcodegen lists extension/ at generate time, so the bundles must exist first.
npm --prefix web install --silent && npm --prefix web run --silent build
xcodegen generate --quiet
xcodebuild -project SafariPilot.xcodeproj -scheme SafariPilot -configuration Release -sdk macosx -destination 'platform=macOS' -derivedDataPath "$derived" -allowProvisioningUpdates build | grep -E " error:| warning:|^\*\* BUILD" || true
[[ -d "$app" ]] || { echo "build failed: $app missing" >&2; exit 1; }

pkill -x SafariPilot 2>/dev/null || true
rm -rf /Applications/SafariPilot.app
ditto "$app" /Applications/SafariPilot.app
open /Applications/SafariPilot.app

mkdir -p "$bindir"
ln -sf /Applications/SafariPilot.app/Contents/SharedSupport/safaripilot "$bindir/safaripilot"
echo "installed /Applications/SafariPilot.app; CLI at $bindir/safaripilot"
