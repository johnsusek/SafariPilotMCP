#!/bin/zsh
# Builds Release (or Debug with --debug, which keeps the dev CLI commands), replaces /Applications/SafariPilot.app, relaunches it, and links the CLI onto PATH.
# The build number is the commit count, as in release.sh, so Sparkle offers a local build only releases newer than its commit.
set -euo pipefail

root="${0:A:h:h}"
config=Release
[[ ${1:-} == --debug ]] && config=Debug
derived="$root/build/DerivedData"
app="$derived/Build/Products/$config/SafariPilot.app"
bindir="${SAFARIPILOT_BINDIR:-/opt/homebrew/bin}"

cd "$root"
rm -rf "$app"
# xcodegen lists extension/ at generate time, so the bundles must exist first.
npm --prefix web install --silent && npm --prefix web run --silent build
xcodegen generate --quiet
xcodebuild -project SafariPilot.xcodeproj -scheme SafariPilot -configuration $config -sdk macosx -destination 'platform=macOS' -derivedDataPath "$derived" -allowProvisioningUpdates CURRENT_PROJECT_VERSION=$(git rev-list --count HEAD) build | grep -E " error:| warning:|^\*\* BUILD" || true
[[ -d "$app" ]] || { echo "build failed: $app missing" >&2; exit 1; }

pkill -x SafariPilot 2>/dev/null || true
rm -rf /Applications/SafariPilot.app
ditto "$app" /Applications/SafariPilot.app

"$root/scripts/unregister-stale.sh"
open /Applications/SafariPilot.app

mkdir -p "$bindir"
ln -sf /Applications/SafariPilot.app/Contents/SharedSupport/safaripilot "$bindir/safaripilot"
echo "installed $config /Applications/SafariPilot.app; CLI at $bindir/safaripilot"
