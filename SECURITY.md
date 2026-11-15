# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/johnsusek/SafariPilotMCP/security/advisories/new). Please don't open a public issue.

Include the SafariPilot version, macOS and Safari versions, and steps to reproduce. You'll get a reply within a week.

## Supported versions

Only the latest release gets security fixes. The app updates itself through Sparkle, and `brew upgrade --cask safaripilot` updates Homebrew installs.

## Scope

In scope: anything that lets a page, another app or an unapproved client read or act on tabs it shouldn't, bypass client approval, see hidden secrets, or reach the local connection without its token.

Out of scope: what an approved client does with the access you granted it, including screenshots and `javascript` results, which are not filtered.
