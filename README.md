<p align="center"><img src="docs/logo/logo-color.svg" width="128" alt="SafariPilot"></p>

# SafariPilot

Let Claude use Safari on your Mac, just like Claude in Chrome.

Claude works in its own tabs, in the background. It doesn't take over the cursor, doesn't bring Safari to the front, and the tabs you already have open stay private.

Other ways to hand Safari to an AI each give something up. Apple's built-in server runs in a window of its own, apart from your browsing, and is made for testing your own site. Open-source servers reach your signed-in Safari, but they mostly act through scripted events that many sites ignore, take over the cursor or bring Safari forward for real input, and let any app on your Mac connect without asking.

SafariPilot gives up none of that. Every click and key is real input, sent while you keep using your Mac. Each new client needs your approval, and passwords, card numbers, tokens and cookies are hidden from what Claude reads in pages, URLs and network logs.

## Features

- **Your signed-in Safari.** Claude works in the Safari you already use, with your logins and cookies. It can reach your email, dashboards and anything else behind a sign-in, and you never hand it a password.
- **Real clicks and typing.** Clicks go through macOS Accessibility and keys are real key presses, so pages get trusted input. Forms and editors that ignore scripted events still work. Each action is checked after it lands, and a miss is reported, never assumed.
- **Out of your way.** Safari can stay in the background, your cursor doesn't move, and keystrokes go only to Safari. You keep working while Claude does.
- **Its own tabs only.** Claude sees the tabs it opened and the popups they open. Your other tabs, windows, history and bookmarks are out of reach.
- **The whole page.** Iframes, cross-origin ones included, are read and acted in. Claude can answer an alert that is already open, upload files without the file picker, drag, and read console and network logs with request bodies.
- **Errors Claude can act on.** Every failure says what went wrong, whether retrying is safe, and what to do next. Claude recovers instead of repeating a click that already happened.
- **Quick setup.** A signed, notarized app. One click adds it to Claude Desktop or copies the command for Claude Code.

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

| | SafariPilot | [safari-mcp](https://github.com/achiya-automation/safari-mcp) | [MCPSafari](https://github.com/Epistates/MCPSafari) | [Apple's Safari MCP](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/) (`safaridriver --mcp`) |
| --- | --- | --- | --- | --- |
| Built on | Safari extension and Accessibility | AppleScript, optional extension | Safari extension | WebDriver and WebKit text extraction |
| Your signed-in Safari | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/no.svg" width="12" alt="No"> Its own agent window |
| Native (trusted) clicks and keys | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Every click and key, checked after | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Scripted; click falls back to native | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Opt-in keys; clicks are scripted | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Engine-dispatched; typing pastes |
| Safari can stay in the background | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Typing included | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Except native input, which fronts the tab and moves the cursor | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Except native input, which fronts Safari and moves the pointer | Not documented |
| Approval per client | <img src="docs/marks/yes.svg" width="12" alt="Yes"> With credentials | <img src="docs/marks/no.svg" width="12" alt="No"> | <img src="docs/marks/no.svg" width="12" alt="No"> | <img src="docs/marks/no.svg" width="12" alt="No"> One Safari setting |
| Tabs it can reach | Its own and their popups | Its own; lists all; yours by opt-in | Every tab on sites you granted | Its own window |
| Hides secrets | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Fields, URLs, cookies, headers, bodies | <img src="docs/marks/no.svg" width="12" alt="No"> Snapshots show field values | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Fields and URLs | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Field values in page text |
| Iframes | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Read and act in | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Script, frame list, scripted actions | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Native input top frame only | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Read and act in |
| Alert and confirm dialogs | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Only when set up before they open | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Only when set up before they open | <img src="docs/marks/yes.svg" width="12" alt="Yes"> |
| Network request bodies | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Fetch and XHR | <img src="docs/marks/no.svg" width="12" alt="No"> Headers and timing | <img src="docs/marks/no.svg" width="12" alt="No"> URL, status, timing | <img src="docs/marks/yes.svg" width="12" alt="Yes"> All request types |
| File upload | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/no.svg" width="12" alt="No"> |
| Hover and drag | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Drag only, scripted | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Scripted; opt-in native hover | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Scripted; opt-in native | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Hover only |
| Install | Signed DMG | npm or Homebrew | Homebrew, notarized | Built into Safari 27 |
| Requires | macOS 26, Safari 27 | Node.js 20 | macOS 14, Safari 17 | Safari 27 |

Comparison as of November 2026, from each project's source and documentation. Details and sources are in [docs/COMPETITORS.md](docs/COMPETITORS.md).

## More

- [Architecture](docs/ARCHITECTURE.md): how it works inside, building and testing.
- [DECISIONS.md](DECISIONS.md): why it works that way.
