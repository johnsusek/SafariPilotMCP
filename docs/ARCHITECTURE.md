# Architecture

How SafariPilot works inside. For what it does and how to use it, see the [README](../README.md). Why each choice was made is in [DECISIONS.md](../DECISIONS.md).

## Parts

| Part | Where | Role |
| --- | --- | --- |
| App | `App/` | Dock app. Hosts the loopback listener, approval gate, command queue, Accessibility engine and activity log. |
| Safari Web Extension | `Appex/`, `web/src/` built to `extension/` | MV3 event-page background, isolated-world content script (`content.js`) and main-world capture script (`main.js`) in every frame. |
| CLI and MCP server | `CLI/` | `safaripilot mcp` speaks MCP over stdio (official `modelcontextprotocol/swift-sdk`). Release builds run only `mcp` and `status`. |
| Shared | `Shared/` | Wire types, contract, redaction, error codes, viewport and window matching. |

```
Claude ──stdio──▶ safaripilot mcp ──TCP 127.0.0.1:47821──▶ SafariPilot.app ◀──native messaging──▶ extension background ──▶ content scripts
                                                                │
                                                                └── Accessibility (AXPress, AXValue) and pid-targeted key events ──▶ Safari
```

## Transport

- One JSON line each way over loopback TCP on `127.0.0.1:47821`.
- The extension background long-polls the app through `sendNativeMessage` (the app answers within 20 s with a command or null). A `connectNative` port wakes it when a command is queued and no poll is open, and a keepalive on that port each minute stops Safari unloading the event page.
- Every connection starts with a per-launch 32-byte token, compared in constant time. It is written to the app group container (read by the app extension) and `~/Library/Application Support/SafariPilot/token`, mode 0600 (read by the CLI).
- MCP clients also need an approved session key from the gate (below). Sessions end when the client process exits.
- Commands run one at a time in arrival order (`CommandQueue`), except `status` and `handle_dialog`.

## Input

- Plain clicks are `AXPress` on the Accessibility element whose frame best matches the content script's element rect (intersection over union of at least 0.7). They produce trusted `mousedown`, `mouseup` and `click`, with Safari in the background.
- Text is set with `AXValue` after a page-side `focus()`. Keys are `CGEvent`s posted to Safari's pid only, never the global HID tap, so they never reach another app. `cmd` chords are refused because Safari acts on them before the page.
- Double, triple, right and modifier clicks, drags, color inputs and file uploads are synthetic, untrusted page events, and replies say so.
- Nothing moves the real cursor or brings Safari forward. If Safari activates during a command, the activity log records it.
- Every action is verified: click counts trusted clicks in the target frame, key counts trusted keydowns, form_input reads the value back. A miss fails with `input_unconfirmed`.
- After an action, a settle step waits up to 15 s for a page load the action started and reports where the tab landed.

## Pages

- Refs come from the content script on first sight per frame, stored in a WeakMap, and numbered from a random base per document so a stale ref fails instead of hitting another element.
- Iframes, same- and cross-origin, are read inline and actionable. Refs inside frames are paths such as `5:12`. See [iframes.md](iframes.md).
- Alert, confirm and prompt dialogs stop the whole extension, so the app finds them through Accessibility and answers them with `AXPress`.
- Console capture and fetch/XHR body capture run in the page's main world. Request metadata comes from `webRequest`, logged for pilot tabs only.

## Isolation and redaction

- The MCP server sees only tabs it opened plus their popups (by `openerTabId`). All sessions share one SafariPilot window.
- Secret fields (passwords, OTP, card numbers and secret-named fields, rules in `web/src/content/sensitive.ts`) never leave the content script; they show as `value=[hidden]`.
- URL credentials and secret query or fragment parameters are hidden in every reply (`web/src/shared/redact.ts` and `Shared/Redaction.swift`, sharing `redactUrl.cases.json`). Cookie, Set-Cookie and secret headers and body fields are hidden in network logs.
- The activity log shows typed text by size, never in clear.

## Errors

Every failure ends with `error code=CODE retryable=BOOL next=STEP`, drawn from 18 codes and 8 next steps fixed in `web/src/shared/errorCodes.json` and checked on both sides by tests.

## Build and test

```bash
scripts/install.sh
```

Builds Release, replaces `/Applications/SafariPilot.app`, unregisters stale copies (Safari otherwise runs whichever copy LaunchServices picks), relaunches and links `safaripilot` into `/opt/homebrew/bin`. `--debug` installs the build with dev commands.

```bash
scripts/test.sh
```

Runs the web and Swift tests headless.

```bash
scripts/smoke.sh
```

Runs live checks against real sites and an MCP stdio session. Sites change, so a failure means look, not necessarily a regression.

```bash
scripts/release.sh X.Y.Z
```

Sets the version, builds a Developer ID signed DMG, notarizes and staples it, then commits, tags `vX.Y.Z`, pushes and publishes a GitHub release with `docs/releases/X.Y.Z.md` as its notes. `--no-publish` stops after the DMG. Needs notary credentials saved once with `xcrun notarytool store-credentials SafariPilot`.

Every build gets a unique identity; the app refuses commands when Safari runs an extension from a different build, naming the stale copy's path.
