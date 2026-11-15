#!/bin/zsh
# Usage: scripts/release.sh X.Y.Z
# Bumps the version, commits it, tags vX.Y.Z and pushes; the Release workflow then builds, notarizes and publishes it with docs/releases/X.Y.Z.md as its notes and bumps the johnsusek/tap cask.
set -euo pipefail

version=${1:?usage: scripts/release.sh X.Y.Z}
root="${0:A:h:h}"
notes="docs/releases/$version.md"

fail() { echo "$1" >&2; exit 1; }

cd "$root"
[[ $version =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]] || fail "version must be X.Y.Z"
[[ $(git branch --show-current) == main ]] || fail "release from main"
git diff --quiet HEAD || fail "commit or stash tracked changes first"
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && fail "tag v$version already exists"
git cat-file -e "HEAD:$notes" 2>/dev/null || fail "commit release notes at $notes first"

build=$(( $(git rev-list --count HEAD) + 1 ))
sed -i '' -E "s/^(    MARKETING_VERSION: ).*/\1\"$version\"/; s/^(    CURRENT_PROJECT_VERSION: ).*/\1\"$build\"/" project.yml
sed -i '' -E "s/^(  \"version\": ).*/\1\"$version\",/" extension/manifest.json

git commit -q -m "Release $version" -- project.yml extension/manifest.json
git tag -a "v$version" -m "SafariPilot $version"
git push -q origin main "v$version"
echo "pushed v$version; follow it with: gh run watch \$(gh run list -w Release -L 1 --json databaseId -q '.[0].databaseId')"
