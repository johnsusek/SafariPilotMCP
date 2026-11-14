# Competitors

How SafariPilot compares with other ways to let an AI drive Safari, read from each project's source on 2026-11-14. The short version is the table in the [README](../README.md#how-it-compares). File references are to the commit named in each section.

## Apple's Safari MCP (`safaridriver --mcp`)

Checked: Safari 27 on macOS 27 (the local `safaridriver` binary, its tools/list reply and strings in the shared cache), WebKit at 54f142b2, the [WebKit blog post](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/), [Connecting an AI agent to Safari](https://developer.apple.com/documentation/safari-developer-tools/connecting-an-ai-agent-to-safari) and [About WebDriver for Safari](https://developer.apple.com/documentation/webkit/about-webdriver-for-safari).

- **Source:** the MCP layer lives in Safari's private WebDriver.framework and is closed. The in-page engine is WebCore's open-source Text Extraction; WebKit commits 12b2b07ee6 and ec62b60d6c name Safari MCP.
- **Session:** a WebDriver automation session marked as controlled by an external agent, in its own window with a banner naming the client (from MCP clientInfo) and a Stop button. Apple says it cannot reach AutoFill or browsing activity. If the server launched Safari, it quits Safari when the client disconnects.
- **Input:** clicks go through WebCore's EventHandler, with a programmatic click when the hit test misses (TextExtraction.cpp:2474, 2646); keys are synthetic keydown and keyup (:3461); typing is `pasteAsPlainText` (:3552). Nothing goes through the OS, so it likely works with Safari in the background, but that is not documented or verified.
- **Authorization:** anything that can run `/usr/bin/safaridriver --mcp` gets in once Developer > "Allow remote automation and external agents" is on. No per-client prompt found.
- **Secrets:** page text marks password fields secure and leaves out text field values (TextExtractionToStringConversion.cpp:1156-1172, 1513). JavaScript, console and network output are not filtered.
- **Tools (17):** list_tabs, create_tab, switch_tab, close_tab, navigate_to_url, wait_for_navigation, page_info, get_page_content (textTree, markdown, html, json or plainText; subframes; event listeners), page_interactions (batched click, type, keyPress, scroll, selectText, selectMenuItem, hover, highlightText; targets by UID, find-in-page text or point; returns a page diff), evaluate_javascript (frameId), screenshot (to a file; full page), set_viewport_size, set_emulated_media, browser_console_messages (level filter, clear on read), list_network_requests and get_network_request (all request types, text bodies, filters by method, status range, URL and time), browser_dialogs.
- **Has that SafariPilot lacks:** hover from inside the engine, page diffs after actions, full-page screenshots, print media emulation, markdown, HTML and JSON page output, find-in-page targeting, network filters, nothing to install.
- **Lacks:** the signed-in profile, file upload, drag, per-client approval, secret redaction beyond page text, waiting for text or a selector, real key presses.
- **Intended use:** debugging, compatibility, performance and accessibility checks of your own pages.
- **Unverified:** cookie isolation under MCP, background use, whether MCP windows block user input like classic WebDriver's glass pane, the minimum macOS.

## safari-mcp

Checked: [achiya-automation/safari-mcp](https://github.com/achiya-automation/safari-mcp) at fe10fb8 (2026-11-11), v2.23.0.

- **Architecture:** Node MCP server over stdio, or a shared HTTP daemon on port 9225. Two engines: an optional unsigned Safari extension that long-polls Node on 127.0.0.1:9224 with a shared token file, and a fallback Swift helper running AppleScript `do JavaScript` in the page's main world (safari.js:1-4, 2389). The extension must be built in Xcode and "Allow unsigned extensions" turned on again after every Safari restart.
- **Input:** `safari_click` is scripted, compares a page fingerprint before and after, and switches to a native click when nothing changed (safari.js:2449-2504). Native clicks try an AX press at a screen point, then CGEvents. Native input selects the tab in the user's window and the pinned path brings Safari forward and moves the cursor, then restores both (safari.js:1730-1775, 2685-2730). `safari_native_keyboard` allows cmd shortcuts; `safari_native_type` pastes through the clipboard.
- **Tabs:** owned tabs are tracked by a `window.name` marker and saved to `~/.safari-mcp/owned-tabs.json`, expiring after 30 minutes (12 hours with a receipt). `safari_list_tabs` returns titles and URLs of the user's tabs too; acting on them needs `SAFARI_MCP_ALLOW_USER_TABS`. At most 6 tabs per session, oldest closed first.
- **Authorization:** none on stdio; the HTTP daemon checks only that Host and Origin are loopback.
- **Secrets:** none hidden. Snapshots print every input value, passwords included (safari.js:5826-5828).
- **Dialogs:** `window.alert`, `confirm` and `prompt` are replaced before the dialog appears (safari.js:4989-5006); an open dialog cannot be answered.
- **Network:** fetch and XHR wrapped in the page; status, timing and fetch response headers, no bodies, though the tool description promises POST bodies (safari.js:6251-6279).
- **Tools (98, all `safari_*`):** beyond SafariPilot's set: back, forward and reload; cookie, localStorage, sessionStorage and IndexedDB access with export and import; route mocking and network throttling; device and geolocation emulation; PDF export; clipboard; table, meta, image and link extractors; CSS coverage, PWA and WebKit compatibility checks; React-select helpers; snapshot diffs; a doctor tool; a `SAFARI_MCP_TOOLS=core` subset.
- **Lacks:** client approval, secret redaction, trusted input without fronting Safari, refusing cmd shortcuts, answering an open dialog, network bodies, frame-qualified refs, an activity log, signed releases.
- **Health:** 244 stars, MIT, one main author, 129 npm versions since March (about 15 in October), 4,468 npm downloads last month, CI on Node 20, 22 and 24 with 79 test files. Open bugs include #29 (CGEvents not reaching Safari on macOS 26).

## MCPSafari

Checked: [Epistates/MCPSafari](https://github.com/Epistates/MCPSafari) at 13ba540 (2026-11-06). Its README and docs describe unreleased 0.4.0 (profiles, HMAC handshake, wider redaction); Homebrew installs v0.3.2 (2026-09-14), whose redaction covered only password and autocomplete fields and about six URL parameter names.

- **Architecture:** each MCP client launches its own `mcp-safari` over stdio, which listens on a loopback WebSocket (ports 8089 to 8098). The extension connects to every port with a token file, authenticated by an HMAC challenge-response; non-extension origins are refused.
- **Input:** synthetic DOM events by default, with a hit test that fails as `target_covered`. Opt-in native input (keys, hover, drag; not click, ToolCatalog.swift:192-205) posts CGEvents to the session tap, so it needs Safari frontmost, Accessibility focus in the web area and Safari's window under the pointer, and it moves the real pointer (NativeInput.swift:300-355, 402-419). A cross-process lock stops two servers typing at once; a keyboard-layout-aware blocklist refuses dangerous chords.
- **Tabs:** lists every tab in every Safari profile and acts on any tab whose site you granted, your own included. `screenshot` activates the tab and `tabs_create` opens an active tab in your window.
- **Authorization:** the token authenticates server to extension only; any process that can launch `mcp-safari` gets full access.
- **Secrets:** field values in snapshots and URLs. Not hidden: read_page HTML, JavaScript results, console output. No headers, cookies or bodies are captured.
- **Dialogs:** replaced in the page's main world after `handle_dialog` arms them, top frame only, for 30 s; an open dialog cannot be handled.
- **Network:** fetch and XHR in the top frame; method, URL, status, duration and size, no headers or bodies (network-interceptor.js:115-127).
- **Tools (27):** status, tabs_context, tabs_create, close_tab, select_tab, navigate (goto, back, forward, reload), snapshot, read_page (text, HTML or snapshot), find, click, type_text, form_input, select_option, scroll, press_key, hover, drag, upload_file, drop_file, handle_dialog, screenshot (element crop, to a file), javascript_tool (falls back to the isolated world under a strict CSP), read_console, read_network, resize_window, run_steps, wait. Actions take `includeSnapshot`, `waitForSelector` and `waitForText`, and target by ref, CSS selector, text or point.
- **Lacks:** trusted clicks, background native input, client approval, own-tabs-only scope, answering an open dialog, network bodies, cookie and header redaction, scroll_to, an activity log.
- **Health:** 65 stars, MIT, mostly one maintainer, 14 releases through v0.3.2 and none since. About 590 Node and 330 Swift test cases; CI on Xcode 27.1 and 26.6 with CodeQL, Gitleaks and OSV; releases signed and notarized. 0.4.0 waits on a release gate of live Safari checks, all still pending.

## Worth borrowing

1. **Page diff after an action** (Apple's page_interactions, safari-mcp's snapshot diff): return what changed after click, form_input and key instead of a separate read_page.
2. **Extension location check** (MCPSafari Diagnostics.swift:360-373): warn when PlugInKit loads the extension from outside /Applications, the stale-copy problem scripts/install.sh works around.
3. **Strict arguments** (MCPSafari ToolArguments.swift:97-104): refuse unknown, mistyped or out-of-range arguments before anything runs.
4. **Hover:** all three have it. Apple's comes from inside the engine, so CSS :hover may apply, which untrusted events cannot do.
5. **Smaller tools:** full-page screenshots, back, forward and reload, `drop_file` for drop zones without a file input, targeting by visible text, console level filter and clear on read, network filters by method, status and time.
6. **Native input guards:** fail fast while the screen is locked (safari-mcp safari.js:1447-1462); never resend an action whose page navigated before replying (MCPSafari `reply_lost`).
7. **Release gate:** require recorded live Safari checks before tagging, as MCPSafari's release-qualification.json does, for the many "not verified live" items here.
