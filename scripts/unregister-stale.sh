#!/bin/zsh
# Safari runs whichever registered copy of the extension LaunchServices picks, so unregister every SafariPilot copy outside /Applications, wherever it was built.
set -uo pipefail

installed=/Applications/SafariPilot.app
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

appexes=("${(@f)$(pluginkit -mAvvv -p com.apple.Safari.web-extension | awk '/^[ \t]+[^ \t]+\(/{hit = ($1 ~ /^net\.johnsolo\.SafariPilot\.Extension\(/)} hit && /Path = /{sub(/^[ \t]*Path = /, ""); print}')}")
apps=("${(@f)$("$lsregister" -dump | sed -n -E 's/^path: +(.*\/SafariPilot\.app) \(0x[0-9a-f]+\)$/\1/p' | sort -u)}")

for appex in ${appexes:#$installed/*}; do
  pluginkit -r "$appex" 2>/dev/null
done

for app in ${apps:#$installed}; do
  "$lsregister" -u "$app" 2>/dev/null
done

[[ -d $installed ]] || exit 0
"$lsregister" -f -R $installed
pluginkit -a $installed/Contents/PlugIns/SafariPilotExtension.appex
