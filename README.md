<p align="center"><img src="docs/logo/logo-color.svg" height="160" alt="SafariPilot"></p>

<p align="center"><a href="https://scorecard.dev/viewer/?uri=github.com/johnsusek/SafariPilotMCP"><img src="https://api.scorecard.dev/projects/github.com/johnsusek/SafariPilotMCP/badge" alt="OpenSSF Scorecard"></a></p>

# SafariPilot

**SafariPilot lets Claude work in your Safari, while you keep using your Mac.**

Just like Claude in Chrome: Open Safari tabs and work on them in the background, without taking over your cursor.

## Features

- **Your signed-in Safari.** Claude works in the Safari you already use, with your logins and cookies.
- **No cursor takeover.** Safari can stay in the background, your cursor doesn't move, and keystrokes go only to Safari. 
- **Real clicks and typing.** Clicks go through macOS Accessibility and keys are real key presses, so pages get trusted input. Forms and editors that ignore scripted events still work.
- **Optimized token usage.** Actions return what they changed on the page, avoiding reading the page again. Claude can also read only what's onscreen, or just one table or list of links as markdown.

## Security and trust

- **Approve every client.** Each new client asks for your approval first. Disconnect one in **Clients** and it must be approved again.
- **Tab isolation.** Claude sees only the tabs it opened and the popups they open.
- **Secrets stay hidden.** Passwords, card numbers, tokens and cookies stay hidden from Claude's page reads, URLs and network logs. Screenshots and `javascript` results are not filtered.
- **Secure local connection.** The Safari extension, the app and Claude talk locally, and every connection needs a secret token that changes each launch.

## Requirements

- macOS 26 or later
- Safari 27 (earlier versions are untested)

## Install

```bash
brew install --cask johnsusek/tap/safaripilot
```

Or download the DMG from [Releases](https://github.com/johnsusek/SafariPilotMCP/releases/latest) and drag SafariPilot to Applications.

Open SafariPilot. It lives in the menu bar; choose **Settings…** there to see its window. Then:

1. In Safari, open **Settings > Extensions** and turn on **SafariPilot**.
2. In SafariPilot's **General** pane, grant **Accessibility**.
3. In the **Clients** pane, choose **Claude Desktop** to add SafariPilot to its config, or **Claude Code** to copy a `claude mcp add` command.

### Build from source

Needs Xcode, Node.js and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
scripts/install.sh
```

This builds SafariPilot, installs it in `/Applications`, opens it and links the `safaripilot` CLI into `/opt/homebrew/bin`.

## How it compares

| | SafariPilot | [safari-mcp](https://github.com/achiya-automation/safari-mcp) | [MCPSafari](https://github.com/Epistates/MCPSafari) | [Apple's Safari MCP](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/) | [Claude in Chrome](https://claude.com/chrome) |
| --- | --- | --- | --- | --- | --- |
| Built on | Extension + Accessibility | AppleScript (+ extension) | Extension | WebDriver | Extension + DevTools protocol |
| Your signed-in Safari | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/no.svg" width="12" alt="No"> Own window | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Chrome only |
| Native clicks and keys | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Verified | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Native click fallback | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Opt-in keys | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Typing pastes | <img src="docs/marks/yes.svg" width="12" alt="Yes"> |
| Safari stays in background | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Not native input <sup>[1]</sup> | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Not native input <sup>[1]</sup> | Unknown | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Fronts its tab |
| Approval per client | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/no.svg" width="12" alt="No"> | <img src="docs/marks/no.svg" width="12" alt="No"> | <img src="docs/marks/no.svg" width="12" alt="No"> Global toggle | <img src="docs/marks/no.svg" width="12" alt="No"> Per site |
| Hides secrets | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Fields, URLs, network | <img src="docs/marks/no.svg" width="12" alt="No"> | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Fields, URLs | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Not page text | <img src="docs/marks/partial.svg" width="12" alt="Partly"> URL auth |
| Iframes | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Scripted | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Top frame native | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Act by position only |
| Alert and confirm dialogs | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Pre-armed <sup>[2]</sup> | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Pre-armed <sup>[2]</sup> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/no.svg" width="12" alt="No"> Stalls |
| Network request bodies | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Fetch, XHR | <img src="docs/marks/no.svg" width="12" alt="No"> | <img src="docs/marks/no.svg" width="12" alt="No"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/no.svg" width="12" alt="No"> |
| Hover and drag | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Drag only | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Hover only | <img src="docs/marks/yes.svg" width="12" alt="Yes"> |

<sup>[1]</sup> Native input brings Safari forward and moves the pointer.<br>
<sup>[2]</sup> Only when set up before the dialog opens.

## More

- [Architecture](docs/ARCHITECTURE.md): how it works inside, building and testing.

## Thanks

To [iMCP](https://github.com/mattt/iMCP), whose app UI and client approval flow inspired SafariPilot's.
