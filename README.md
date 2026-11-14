<p align="center"><img src="docs/logo/logo-color.svg" width="128" alt="SafariPilot"></p>

# SafariPilot

Let Claude use Safari on your Mac, just like Claude in Chrome.

Claude works in its own tabs, in the background. It doesn't take over the cursor, doesn't bring Safari to the front, and the tabs you already have open stay private.

## Requirements

- macOS 26 or later
- Safari 27 (earlier versions are untested)

## Install

Download the DMG from [Releases](https://github.com/johnsusek/SafariPilotMCP/releases/latest), drag SafariPilot to Applications and open it. Then:

1. In Safari, open **Settings > Extensions** and turn on **SafariPilot**. Allowing it on every website saves a prompt per site.
2. In SafariPilot's **General** pane, grant **Accessibility** (used to click and type).
3. In the **Clients** pane, choose **Claude Desktop** to add SafariPilot to its config, or **Claude Code** to copy a `claude mcp add` command.
4. Turn on **Launch at Login** if you want Claude to find it every time.

SafariPilot needs to be running for Claude to reach Safari.

### Build from source

Needs Xcode, Node.js and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
scripts/install.sh
```

This builds SafariPilot, installs it in `/Applications`, opens it and links the `safaripilot` CLI into `/opt/homebrew/bin`.

## Security and trust

Handing a browser to an AI is a real grant of power. SafariPilot is built to keep that grant small and visible.

- **You approve every client.** The first command from a new client opens an "Allow ... to use Safari?" dialog. Allow it once for this run, or trust it for good. Trusted clients can be removed one at a time or all at once, and connecting without a dialog still posts a notification.
- **Clients prove who they are.** Setup gives each client its own credential. A client that shows none, or one SafariPilot didn't create, is flagged in the dialog, so another app can't borrow Claude's name.
- **Claude sees only its own tabs.** It works in tabs it opened, plus popups those tabs open. Your other tabs, windows, history and bookmarks are out of reach.
- **Secrets stay in the page.** Passwords, one-time codes, card numbers and similar fields read as `[hidden]`. Tokens and keys in URLs, cookies and secret headers or body fields are hidden in everything Claude gets back, network logs included.
- **Keys go only to Safari.** Keystrokes are sent to Safari alone, never to whatever app is in front, and Safari shortcuts like cmd+W are refused.
- **Local only.** Everything stays on your Mac. The app listens on loopback with a fresh secret each launch, and nothing is sent anywhere but to the client you approved.
- **Every step is logged.** The Activity pane lists each command and its result. Typed text shows only its length.

What it doesn't hide: the text of the page itself, which is what Claude is there to read, and whatever is visible in a screenshot. Pages are treated as untrusted data, and Claude is told so, but a page can still try to talk an AI into things. Keep an eye on the Activity pane when Claude is on sites you don't trust.

## How it compares

| | SafariPilot | [Apple's Safari MCP](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/) (`safaridriver --mcp`) | [safari-mcp](https://github.com/achiya-automation/safari-mcp) | [MCPSafari](https://github.com/Epistates/MCPSafari) |
| --- | --- | --- | --- | --- |
| Built on | Safari extension and Accessibility | WebDriver and WebKit text extraction | AppleScript, optional extension | Safari extension |
| Your signed-in Safari | Yes | No, its own agent window | Yes | Yes |
| Native (trusted) clicks and keys | Every click and key, checked after | Engine-dispatched; typing pastes | Scripted; click falls back to native | Opt-in keys; clicks are scripted |
| Safari can stay in the background | Yes, typing included | Not documented | Yes, except native input, which fronts the tab and moves the cursor | Yes, except native input, which fronts Safari and moves the pointer |
| Approval per client | Yes, with credentials | No, one Safari setting | No | No |
| Tabs it can reach | Its own and their popups | Reportedly its own window | Its own; lists all; yours by opt-in | Every tab on sites you granted |
| Hides secrets | Fields, URLs, cookies, headers, bodies | Field values in page text | No; snapshots show field values | Fields and URLs |
| Iframes | Read and act in | Read and act in | Script, frame list, scripted actions | Read and act in; native input top frame only |
| Alert and confirm dialogs | Yes | Yes | Only when set up before they open | Only when set up before they open |
| Network request bodies | Fetch and XHR | All request types | No; headers and timing | No; URL, status, timing |
| File upload | Yes | No | Yes | Yes |
| Hover and drag | Drag, scripted | Hover; no drag | Scripted; opt-in native hover | Yes |
| Install | Signed DMG | Built into Safari 27 | npm or Homebrew | Homebrew, notarized |
| Requires | macOS 26, Safari 27 | Safari 27 | Node.js 20 | macOS 14, Safari 17 |

In short: Apple's server is built for testing your own site in its own window. safari-mcp and MCPSafari install from npm or Homebrew and run on older systems, but act mostly through scripted events, leave client approval to you, and hide few or no secrets. SafariPilot is for letting Claude work in your real, signed-in Safari while you keep using your Mac, with every click and key sent as real input, each client approved, and secrets hidden.

Comparison as of November 2026, from each project's source and documentation. Details and sources are in [docs/COMPETITORS.md](docs/COMPETITORS.md).

## More

- [Architecture](docs/ARCHITECTURE.md): how it works inside, building and testing.
- [DECISIONS.md](DECISIONS.md): why it works that way.
