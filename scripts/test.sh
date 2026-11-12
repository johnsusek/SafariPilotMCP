#!/bin/zsh
# Runs the web and Swift tests, then unregisters the Debug app the Swift run built, so Safari keeps running the installed extension.
set -euo pipefail

root="${0:A:h:h}"
derived="$root/build/TestData"
app="$derived/Build/Products/Debug/SafariPilot.app"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

cd "$root"
npm --prefix web run --silent build
npm --prefix web test --silent
xcodegen generate --quiet
result=0
xcodebuild test -project SafariPilot.xcodeproj -scheme SafariPilot -destination 'platform=macOS' -derivedDataPath "$derived" 2>&1 | grep -E " error:|failed|Test run with|^\*\* TEST" || result=$?

pluginkit -r "$app/Contents/PlugIns/SafariPilotExtension.appex" 2>/dev/null || true
"$lsregister" -u "$app" 2>/dev/null || true
pluginkit -a /Applications/SafariPilot.app/Contents/PlugIns/SafariPilotExtension.appex 2>/dev/null || true
exit $result
