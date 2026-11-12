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

# Safari runs whichever registered copy of the extension LaunchServices picks; leave only the installed one.
# Any derived data path under build/ counts, since test runs use their own.
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

for stale in "$root"/build/**/SafariPilot.app(N) ~/Library/Developer/Xcode/DerivedData/SafariPilot-*/Build/Products/*/SafariPilot.app(N); do
  # Both exit nonzero for a copy that is already unregistered.
  pluginkit -r "$stale/Contents/PlugIns/SafariPilotExtension.appex" 2>/dev/null || true
  "$lsregister" -u "$stale" 2>/dev/null || true
done

"$lsregister" -f -R /Applications/SafariPilot.app
pluginkit -a /Applications/SafariPilot.app/Contents/PlugIns/SafariPilotExtension.appex
open /Applications/SafariPilot.app

mkdir -p "$bindir"
ln -sf /Applications/SafariPilot.app/Contents/SharedSupport/safaripilot "$bindir/safaripilot"
echo "installed /Applications/SafariPilot.app; CLI at $bindir/safaripilot"
