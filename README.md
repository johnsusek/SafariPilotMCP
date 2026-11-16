<p align="center"><img src="docs/logo/logo-color.svg" height="160" alt="SafariPilot"></p>

<p align="center"><a href="https://scorecard.dev/viewer/?uri=github.com/johnsusek/SafariPilotMCP"><img src="https://api.scorecard.dev/projects/github.com/johnsusek/SafariPilotMCP/badge" alt="OpenSSF Scorecard"></a> <a href="https://github.com/johnsusek/SafariPilotMCP/actions/workflows/ci.yml"><img src="https://github.com/johnsusek/SafariPilotMCP/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <a href="https://github.com/johnsusek/SafariPilotMCP/actions/workflows/codeql.yml"><img src="https://github.com/johnsusek/SafariPilotMCP/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a></p>

# SafariPilot

**SafariPilot is an MCP server for Safari on macOS. It lets agents work in your Safari while you keep using your Mac.**

## Features

- **Your signed-in Safari.** Your agent works in the Safari you already use, with your logins and cookies.
- **No cursor takeover.** Safari can stay in the background, your cursor doesn't move, and keystrokes go only to Safari.
- **Real clicks and typing.** Plain clicks go through macOS Accessibility and keys are real key presses, so pages get trusted input. Forms and editors that ignore scripted events still work.
- **Fewer page reads.** Each action returns what it changed on the page, so the agent doesn't read the page again.

## Requirements

- macOS 26 or later
- Safari 27 (earlier versions are untested)
- A user logged in to the Mac's desktop. The app and Safari need a GUI session.
  
> **Local macOS software required:** SafariPilot controls Safari on the same
> Mac as the MCP client. It is not a standalone remote or cloud browser.

## Install

```bash
brew install --cask johnsusek/tap/safaripilot
```

Or download the DMG from [Releases](https://github.com/johnsusek/SafariPilotMCP/releases/latest) and drag SafariPilot to Applications. Releases are built, signed and notarized in GitHub Actions; to check that a DMG came from this repo's workflow:

```bash
gh attestation verify SafariPilot-*.dmg --repo johnsusek/SafariPilotMCP
```

Open SafariPilot. It lives in the menu bar; choose **Settings…** there to see its window. Then:

1. In Safari, open **Settings > Extensions** and turn on **SafariPilot**.
2. In SafariPilot's **General** pane, grant **Accessibility**.
3. In the **Clients** pane, set up a client: Claude Desktop, Claude Code, ChatGPT and Codex, Cursor, VS Code or LM Studio. **Other Clients** copies a standard `mcpServers` entry.

### Manual configuration

The **Other Clients** configuration includes a
`SAFARIPILOT_CREDENTIAL` that identifies the client across restarts.
A client using this credential needs approval only once.
If the credential is removed, the connection still works, but the client
must be approved again each time it starts.

```json
{
  "mcpServers": {
    "safaripilot": {
      "command": "/Applications/SafariPilot.app/Contents/SharedSupport/safaripilot",
      "args": ["mcp"]
    }
  }
}
```

### Updates

SafariPilot checks for updates itself and offers to install them. **Check for Updates…** in its menu checks now, and the **General** pane turns automatic checks off. Homebrew installs can also update with:

```bash
brew upgrade --cask safaripilot
```

### Build from source

Needs Xcode, Node.js and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
scripts/install.sh
```

This builds SafariPilot, installs it in `/Applications`, opens it and links the `safaripilot` CLI into `/opt/homebrew/bin`.

## Tools

The tools mirror those of [Claude in Chrome](https://claude.com/chrome).

- **Tabs:** `tabs_list`, `tab_create`, `tab_select`, `tab_close`, `navigate`
- **Read:** `read_page`, `find`, `get_page_text`, `screenshot`, `wait`
- **Act:** `click`, `form_input`, `key`, `drag`, `scroll`, `scroll_to`, `file_upload`, `handle_dialog`, `resize_window`
- **Inspect:** `javascript`, `read_console_messages`, `read_network_requests`, `page_fetch`
- **Batch:** `browser_batch` runs several calls in one round trip.

The **Tools** pane in the app shows each tool's full description.

## Security and trust

- **Approve every client.** Each new client needs approval first. Disconnect one in **Clients** and it must be approved again.
- **Tab isolation.** An agent sees only the tabs it opened and the popups they open.
- **Secrets stay hidden.** Passwords, card numbers, tokens and cookies stay hidden from agents' page reads, URLs and network logs. Screenshots and `javascript` results are not filtered.
- **Secure local connection.** The Safari extension, the app and the agent talk locally, and every connection needs a secret token that changes each launch.

## Limits

- No hover: the CSS `:hover` pseudo-class is never applied. Double, triple, right and modifier clicks and `drag` are synthetic events, which some pages ignore.
- `key` refuses Cmd shortcuts, since Safari takes them as its own.

## Troubleshooting

In SafariPilot's window, **General > Status** shows Accessibility, the Safari extension and its connection, and **Activity** lists each call with the error code of any that failed.

| Error code | Fix |
| --- | --- |
| `approval_required` | Approve the client in SafariPilot's dialog. |
| `accessibility_denied` | Grant **Accessibility** in SafariPilot's **General** pane. |
| `site_access_prompt`, `site_access_denied` | Allow the site from the SafariPilot button in Safari's toolbar. |
| `no_content_script` | Turn on the extension in **Safari Settings > Extensions**, then open a new tab. |
| `safari_unavailable` | Open Safari. |
| `build_mismatch` | Safari is running the extension from another copy of SafariPilot. Remove the other copy, or run `scripts/install.sh` when building from source. |
| `app_unavailable` | Open SafariPilot from `/Applications`. |

## Why SafariPilot

- **Instead of [safari-mcp](https://github.com/achiya-automation/safari-mcp):** real clicks and keys without bringing Safari forward, approval per client, and secrets hidden from the agent.
- **Instead of [MCPSafari](https://github.com/Epistates/MCPSafari):** real clicks and keys without bringing Safari forward, approval per client, and network request bodies.
- **Instead of [Apple's Safari MCP](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/):** it works in your signed-in Safari, where Apple's opens a separate window without your logins.

## How it runs

The MCP client starts `safaripilot mcp`, a stdio MCP server inside the app. That server passes each tool call to the SafariPilot menu bar app, which controls Safari through the SafariPilot extension and macOS Accessibility APIs. The server opens the app if it isn't running.

## More

- [Architecture](docs/ARCHITECTURE.md): how it works inside, building and testing.
- [Security policy](SECURITY.md): reporting a vulnerability.
- [License](LICENSE): MIT.

## Thanks

To [iMCP](https://github.com/mattt/iMCP), whose app UI and client approval flow inspired SafariPilot's.
