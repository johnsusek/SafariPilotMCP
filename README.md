<p align="center"><img src="docs/logo/logo-color.svg" height="160" alt="SafariPilot"></p>

# SafariPilot

**SafariPilot lets Claude work in your Safari, while you keep using your Mac.**

Just like Claude in Chrome, SafariPilot opens its own tabs and works there in the background: Safari stays behind your other windows, no cursor takeover, and no access to other tabs you have open.

## Features

- **Your signed-in Safari.** Claude works in the Safari you already use, with your logins and cookies.
- **Real clicks and typing.** Clicks go through macOS Accessibility and keys are real key presses, so pages get trusted input. Forms and editors that ignore scripted events still work.
- **Out of your way.** Safari can stay in the background, your cursor doesn't move, and keystrokes go only to Safari. 
- **Its own tabs only.** Claude sees only the tabs it opened and the popups they open. 
- **The whole page.** Iframes, cross-origin ones included, are read and acted in. Claude can answer an alert that is already open, upload files without the file picker, drag, and read console and network logs with request bodies.
- **You approve every client.** Nothing connects without your say, since each new client asks for your approval first.
- **Secrets stay hidden.** Passwords, card numbers, tokens and cookies stay hidden from everything Claude reads in pages, URLs and network logs.

## Requirements

- macOS 26 or later
- Safari 27 (earlier versions are untested)

## Install

Download the DMG from [Releases](https://github.com/johnsusek/SafariPilotMCP/releases/latest), drag SafariPilot to Applications and open it. It lives in the menu bar; choose **Settings…** there to see its window. Then:

1. In Safari, open **Settings > Extensions** and turn on **SafariPilot**. Allowing it on every website saves a prompt per site.
2. In SafariPilot's **General** pane, grant **Accessibility** (used to click and type).
3. In the **Clients** pane, choose **Claude Desktop** to add SafariPilot to its config, or **Claude Code** to copy a `claude mcp add` command.
4. Turn on **Launch at Login** to skip the second or two Claude waits when it has to start SafariPilot itself.

### Build from source

Needs Xcode, Node.js and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
scripts/install.sh
```

This builds SafariPilot, installs it in `/Applications`, opens it and links the `safaripilot` CLI into `/opt/homebrew/bin`.

## How it compares

| | SafariPilot | [safari-mcp](https://github.com/achiya-automation/safari-mcp) | [MCPSafari](https://github.com/Epistates/MCPSafari) | [Apple's Safari MCP](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/) (`safaridriver --mcp`) |
| --- | --- | --- | --- | --- |
| Built on | Safari extension and Accessibility | AppleScript, optional extension | Safari extension | WebDriver and WebKit text extraction |
| Your signed-in Safari | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/no.svg" width="12" alt="No"> Its own agent window |
| Native (trusted) clicks and keys | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Every click and key, checked after | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Scripted; click falls back to native | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Opt-in keys; clicks are scripted | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Engine-dispatched; typing pastes |
| Safari can stay in the background | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Typing included | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Except native input, which fronts the tab and moves the cursor | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Except native input, which fronts Safari and moves the pointer | Not documented |
| Approval per client | <img src="docs/marks/yes.svg" width="12" alt="Yes"> With credentials | <img src="docs/marks/no.svg" width="12" alt="No"> | <img src="docs/marks/no.svg" width="12" alt="No"> | <img src="docs/marks/no.svg" width="12" alt="No"> One Safari setting |
| Hides secrets | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Fields, URLs, cookies, headers, bodies | <img src="docs/marks/no.svg" width="12" alt="No"> Snapshots show field values | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Fields and URLs | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Field values in page text |
| Iframes | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Read and act in | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Script, frame list, scripted actions | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Native input top frame only | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Read and act in |
| Alert and confirm dialogs | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Only when set up before they open | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Only when set up before they open | <img src="docs/marks/yes.svg" width="12" alt="Yes"> |
| Network request bodies | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Fetch and XHR | <img src="docs/marks/no.svg" width="12" alt="No"> Headers and timing | <img src="docs/marks/no.svg" width="12" alt="No"> URL, status, timing | <img src="docs/marks/yes.svg" width="12" alt="Yes"> All request types |
| File upload | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/no.svg" width="12" alt="No"> |
| Hover and drag | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Drag only, scripted | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Scripted; opt-in native hover | <img src="docs/marks/yes.svg" width="12" alt="Yes"> Scripted; opt-in native | <img src="docs/marks/partial.svg" width="12" alt="Partly"> Hover only |
| Pure Swift | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/no.svg" width="12" alt="No"> Node.js | <img src="docs/marks/yes.svg" width="12" alt="Yes"> | <img src="docs/marks/yes.svg" width="12" alt="Yes"> |

## More

- [Architecture](docs/ARCHITECTURE.md): how it works inside, building and testing.

## Thanks

To [iMCP](https://github.com/mattt/iMCP), whose app UI and client approval flow inspired SafariPilot's.
