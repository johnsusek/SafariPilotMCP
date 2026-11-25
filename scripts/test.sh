#!/bin/zsh
# Runs the web and Swift tests, then unregisters the Debug app the Swift run built (and any other stray copy), so Safari keeps running the installed extension.
set -euo pipefail

root="${0:A:h:h}"
derived="$root/build/TestData"

cd "$root"
npm --prefix web run --silent build
npm --prefix web test --silent
xcodegen generate --quiet
result=0
xcodebuild test -project SafariPilot.xcodeproj -scheme SafariPilot -destination 'platform=macOS' -derivedDataPath "$derived" -allowProvisioningUpdates 2>&1 | grep -E " error:|failed|Test run with|^\*\* TEST" || result=$?

"$root/scripts/unregister-stale.sh"
exit $result
